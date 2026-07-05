# LLD 153: Feedback Attachment Storage Foundation — Private Bucket, Storage RLS, Signed Upload/Read Path

Parent: #97 (slice 1 of 3). Ships **first** — it is the foundation slices 2 (UI) and 3 (triage surfacing) build on, and it carries the entire prod-migration risk of the feature (the project's **first** use of Supabase Storage).

> **Landing note (already implemented).** This slice is built and in review as **PR #180** (branch `lld-150-feedback-attachment-storage-foundation`), MERGEABLE with `mergeStateStatus: CLEAN` and all CI green (unit / integration / e2e) after 3 review rounds. That branch also carries the equivalent design doc as `docs/lld/150-…`. This LLD 153 documents the **same shipped design keyed to the #153 issue** and reflects ground truth in that PR (not a fresh design). The correct action for #153 is to **land PR #180**, not re-implement. On merge: (a) `supabase db push` the migration to prod **before** the backend code deploys (Railway auto-deploys on merge but applies **no** migrations — schema must lead code, DEVELOPMENT.md "Prod Migration Release"); (b) follow-on slices stay human-gated: #171 (UI) needs a frontend-architect mockup approved on port 8090 before its LLD, #172 (triage surfacing) is `blocked:human` (touches the triage-feedback workflow).

## Scope

**In scope (backend / infra only, no UI):**

- Provision a **private** Supabase Storage bucket (`feedback-attachments`) via a migration — no public read.
- Add `storage.objects` RLS policies scoped to that bucket so `anon`/`authenticated` cannot read or write it directly; only the backend `service_role` can (it bypasses RLS).
- Backend **upload path**: a new route on the existing feedback router that accepts a base64 image, validates it server-side, writes it to Storage under a per-submission key, and links the key to a feedback record.
- Backend **read path**: a service method that issues short-lived **signed** read URLs for an attachment key (consumed later by slice 3 triage — not exposed via a route in this slice).
- **Server-side enforcement**: accepted MIME types (images only), per-file byte cap, and max images per report. Reject violations with a clear 4xx.
- Data model: link attachments to the `feedback` row by key/path. **No binary in Postgres.**
- **Retention policy**: documented below (§State Model → Retention). Deleting a feedback row **must** delete its attachments in the same operation (in scope). The scheduled 90-day sweep is a stated follow-up; the policy itself is decided here.
- Migration-safety: name-agnostic/idempotent SQL, drift-gate + postcondition + destructive-DDL gate wiring.

**Explicitly NOT in scope:**

- Any UI or frontend code (slice 2 / #171).
- Surfacing attachments to the triage admin view / a signed-URL read route (slice 3 / #172).
- The auto-capture-a-screenshot button (deferred).
- Virus/malware scanning, image re-encoding/thumbnailing, EXIF stripping (later hardening slice if needed).

## Approach

### Key decisions

1. **Bucket + RLS + link column provisioned by one SQL migration, not the Storage API.** Supabase Storage buckets are rows in `storage.buckets`; object-access rules are RLS policies on `storage.objects`. Both are ordinary Postgres objects reachable by the existing migration + postcondition tooling (`supabase db push`, `verify-postconditions.mjs`). Creating the bucket via `INSERT ... ON CONFLICT DO NOTHING` keeps provisioning **idempotent, name-agnostic, versioned, and machine-verifiable** — consistent with LLDs 008/011. New migration: **`013_create_feedback_attachments_bucket.sql`** (numbered 013, not 012: `main` shipped `012_prune_game_history.sql` (LLD 149) first).

2. **Bucket is private + only deny-scoped client policies = server-only, by construction.** `storage.buckets.public = false` disables the public CDN path. RLS on `storage.objects` is already `ENABLE`d by Supabase's own migrations. We add **only** SELECT/INSERT policies scoped to `bucket_id = 'feedback-attachments'` with a `... AND false` predicate — impossible for `anon`/`authenticated` to satisfy (deny-by-construction), mirroring the `games` "no direct client mutation" pattern in migration 002. The backend `service_role` key bypasses RLS and is the sole accessor. This applies architecture-principles §1 (server-authoritative) to blob storage. Explicit named deny policies (rather than omitting policies to rely on default-deny) make the intent auditable and let the postcondition assert a *scoped, intentional* deny.

3. **Upload transport: base64 JSON on a dedicated route, not multipart.** The app already parses JSON globally (`express.json()`) and has no multipart middleware (no `multer`/`busboy`). Images here are small (single-file cap, few files). A base64 body on a **dedicated** route with its own bounded body-parser limit avoids a new dependency and matches the JSON-everywhere handler style. The global `express.json()` 100 kb default is too small but must **not** be raised globally (that widens every route's attack surface); the attachment route gets its own ~7 MB parser (5 MB payload + base64's ~33% inflation).

4. **Two-step submit; attachments reference the feedback row.** Feedback is created first (existing `POST /feedback`, unchanged), then attachments are uploaded referencing that `feedback.id`. The object key embeds the feedback id: `{feedbackId}/{attachmentId}.{ext}` within the `feedback-attachments` bucket. The link is stored as an `attachment_keys TEXT[]` column on `feedback`. This keeps each attachment write atomic and makes cleanup a single prefix delete.

5. **Link column vs. join table — chose the array column.** `attachment_keys TEXT[]` on `feedback` (count enforced in the backend, not the DB). Attachments are a small, bounded, always-fetched-with-the-parent list owned 1:1 by a feedback row; a join table would add a migration, a second RLS surface, and a query for no current benefit (YAGNI). If slice 3 needs per-file metadata (size/type in triage), promote to a `feedback_attachments` join table then — documented so slice 3 can revisit.

6. **Atomic append via a SECURITY DEFINER RPC.** Appending a key uses an `append_feedback_attachment_key(p_feedback_id, p_key)` SQL function that does a single `array_append` UPDATE and `RETURNING attachment_keys`. Returning the authoritative post-append array lets the service enforce `maxPerReport` against the value the write produced (closes the check-then-append race, E11). The RPC is `SECURITY DEFINER` with `EXECUTE` **revoked from PUBLIC/anon/authenticated and granted only to `service_role`** — same grant discipline as `increment_player_stats` (003) and `get_windowed_stats` (010).

### Flow

```
Client (slice 2)                Backend                              Supabase
  POST /feedback  ───────────►  create feedback row  ──────────────► INSERT feedback
       (existing)               returns { id }
  POST /feedback/:id/attachments
     { image: base64, mimeType} ► authMiddleware sets req.userId
                                getFeedbackById(:id)  ──────────────► SELECT feedback (service_role)
                                  null → 404
                                ownership: isAdmin || row.userId===req.userId
                                  else → 403
                                validate: mime allowed, base64 decodes,
                                  0 < size <= cap, magic bytes match, count < max
                                storage.upload(key, buf) (service_role) ► storage.objects (private)
                                append_feedback_attachment_key RPC   ─► UPDATE feedback (array_append)
                                  post-append len > max → remove(key) + 400 (E11)
                             ◄─ 201 { attachmentId, key }
  DELETE /feedback/:id (admin) ► getFeedbackById(id)  ──────────────► SELECT feedback (exists?)
                                  null → 404 (nothing to clean)
                                removeByPrefix(id) (objects FIRST)   ─► list + delete objects
                                  throws → 500, row LEFT INTACT (retry re-cleans)
                                deleteFeedback(id) (row LAST)        ─► DELETE feedback row
                             ◄─ 200 { deleted: id }
  (slice 3 triage) ──────────►  getSignedUrl(key, ttl=60s)          ─► createSignedUrl(TTL)
                             ◄─ short-lived signed URL
```

## Interfaces / Types

### Migration `supabase/migrations/013_create_feedback_attachments_bucket.sql`

Four parts, all idempotent / name-agnostic (008/011 idiom):

1. **Private bucket** — `INSERT INTO storage.buckets (id, name, public) VALUES ('feedback-attachments', 'feedback-attachments', false) ON CONFLICT (id) DO NOTHING;`
2. **Two deny-by-construction policies** on `storage.objects`, each guarded by `IF NOT EXISTS (SELECT 1 FROM pg_policies …)` (there is no `CREATE POLICY IF NOT EXISTS`):
   - `feedback_attachments_no_client_read` — `FOR SELECT USING (bucket_id = 'feedback-attachments' AND false)`
   - `feedback_attachments_no_client_write` — `FOR INSERT WITH CHECK (bucket_id = 'feedback-attachments' AND false)`
3. **Link column** — `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS attachment_keys TEXT[] NOT NULL DEFAULT '{}';`
4. **Append RPC** — `CREATE OR REPLACE FUNCTION append_feedback_attachment_key(p_feedback_id UUID, p_key TEXT) RETURNS TEXT[] LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ UPDATE feedback SET attachment_keys = array_append(attachment_keys, p_key) WHERE id = p_feedback_id RETURNING attachment_keys; $$;` followed by `REVOKE EXECUTE … FROM PUBLIC; REVOKE EXECUTE … FROM anon, authenticated; GRANT EXECUTE … TO service_role;`

### Postcondition `supabase/migrations/postconditions/013_create_feedback_attachments_bucket.postcondition.sql`

Read-only, idempotent, shape-based; accumulates `bad[]` and RAISEs once (011 idiom). Asserts:
1. Bucket `feedback-attachments` exists in `storage.buckets`.
2. Bucket is **private** (`public = false`) — the security-critical assertion.
3. RLS is enabled on `storage.objects` (`pg_class.relrowsecurity`).
4. At least **2** policies on `storage.objects` reference the bucket id in their `qual`/`with_check` (shape, not name).
5. `feedback.attachment_keys` column exists and is an array type.
6. `append_feedback_attachment_key` exists, and `EXECUTE` is held by `service_role` **and revoked from** `anon`/`authenticated`/`public` (via `has_function_privilege`).

### Backend service (`src/backend/service/feedbackAttachmentService.ts`)

```ts
export interface AttachmentInput {
  feedbackId: string;
  requesterId: string; // req.userId — guest guestId OR registered sub; never null on this route
  isAdmin: boolean;    // req.userId ∈ FEEDBACK_ADMIN_IDS (admins may attach to any row)
  data: Buffer;        // decoded from base64 by the handler
  mimeType: string;    // client-declared; validated + magic-byte cross-checked (E4)
}
export interface AttachmentResult { attachmentId: string; key: string; }

export const ATTACHMENT_LIMITS = {
  maxBytesPerFile: 5 * 1024 * 1024, // 5 MB
  maxPerReport: 3,
  allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
} as const;
// GIF intentionally excluded (screenshot-attach use case; PNG/JPEG/WebP suffice).

export class AttachmentValidationError extends Error {} // → 400

export class FeedbackAttachmentService {
  constructor(feedbackRepo: FeedbackRepository, storage: AttachmentStorage);

  // Ordered, fail-closed (security-first, upload last):
  //  1. getFeedbackById → null → NotFoundError (→404).
  //  2. ownership: !isAdmin && row.userId !== requesterId → AccessDeniedError (→403).
  //  3. mime allowed (E3); size in (0, cap] (E1/E10); magic bytes match (E4);
  //     pre-upload count < maxPerReport (E2).
  //  4. storage.upload (no key appended if this throws — E7).
  //  5. appendAttachmentKey (RPC); if post-append len > max → storage.remove(key) + 400 (E11).
  addAttachment(input: AttachmentInput): Promise<AttachmentResult>;

  // Slice 3 read path — short-lived signed URL (default TTL 60 s).
  getSignedUrl(key: string, ttlSeconds?: number): Promise<string>;

  // Delete-path cleanup (retention): remove all objects under the feedback id prefix.
  removeStoragePrefix(feedbackId: string): Promise<void>;
}
```

### Storage abstraction (`src/backend/service/attachmentStorage.ts`) — pluggable storage (architecture-principles §7)

```ts
export interface AttachmentStorage {
  upload(key: string, data: Buffer, mimeType: string): Promise<void>;
  createSignedUrl(key: string, ttlSeconds: number): Promise<string>;
  remove(key: string): Promise<void>;          // exact key (no-op if absent)
  removeByPrefix(prefix: string): Promise<void>; // idempotent — for cleanup/retention
}
```

`SupabaseAttachmentStorage` wraps `.storage.from('feedback-attachments')` (`.upload` with `upsert: false`, `.createSignedUrl`, `.remove`, `.list`+`.remove` for prefix). It takes a **lazy client getter** (`() => SupabaseDB.INSTANCE.storageClient`) because the singleton is constructed at module load, before `SupabaseDB.initialize()` creates the client. `upload` uses non-upsert mode so an accidental key collision errors instead of overwriting (E8). Keeping this behind an interface lets tests use an in-memory double and the service never couples to the Storage SDK (mirrors the repository pattern).

### Repository additions (`FeedbackRepository` / `SupabaseDB`)

The interface today is `createFeedback` / `getAllFeedback` / `deleteFeedback`. Add:

```ts
getFeedbackById(id: string): Promise<Feedback | null>;         // .maybeSingle() via service_role
appendAttachmentKey(feedbackId: string, key: string): Promise<string[]>; // calls the RPC; returns updated keys
```

- `getFeedbackById` reuses `mapFeedback`, which is extended to read `attachment_keys` onto `Feedback.attachmentKeys` (add `attachmentKeys: string[] = []` to the `Feedback` entity).
- `appendAttachmentKey` invokes `append_feedback_attachment_key` via `service_role` and returns the RPC's `attachment_keys` result — the count check (E2/E11) is enforced against **this** value, not a separate read.
- `SupabaseDB` exposes a `storageClient` getter returning the initialized `SupabaseClient` for the storage wrapper.

### Route (extends the existing feedback router)

```
POST /feedback/:id/attachments
  Auth:  authMiddleware (authenticated OR guest). req.userId always set on this route.
  Body:  { image: string (base64), mimeType: string }   // dedicated ~7 MB body parser
  201 → { attachmentId, key }
  400 → unknown/non-image mime; decoded size > cap or empty; count > max; malformed base64; magic-byte mismatch
  403 → caller does not own the feedback row (and is not an admin)
  404 → feedback :id does not exist
  413 → oversized raw body rejected by the route's body-parser limit
```

**Ownership rule (the security boundary this slice introduces).** `authMiddleware` sets `req.userId` for **both** principals — a guest's stable per-session `guestId` and a registered user's `sub`. `createFeedback` already persists that value to `feedback.user_id`, so `feedback.user_id` is **non-null for guest-created rows too** (it is the `guestId`). The rule is therefore uniform:

> A caller may attach to `:id` **iff** `getFeedbackById(id).userId === req.userId`, **or** `req.userId ∈ FEEDBACK_ADMIN_IDS`. Otherwise 403 (row exists, not owned) or 404 (row absent).

The guest token is HMAC-verified per request and the `guestId` is stable per session, so a guest cannot spoof another principal's id. The signed-URL/GET route is intentionally **absent** in this slice (slice 3 adds triage read).

### Shared model additions (`src/shared/model.ts`)

```ts
export interface SubmitAttachmentRequest  { image: string; mimeType: string; }
export interface SubmitAttachmentResponse { attachmentId: string; key: string; }
```

## State Model

- **Persisted (Postgres `feedback` row):** `attachment_keys TEXT[]` — storage paths only. **No binary.**
- **Persisted (Supabase Storage, private bucket):** the image bytes, keyed `{feedbackId}/{attachmentId}.{ext}` in `feedback-attachments`. `{attachmentId}` is a server-generated UUID; `{ext}` derived from the validated mime (`png`/`jpg`/`webp`).
- **In-memory / transient:** the decoded `Buffer` for the lifetime of one request. Never cached.
- **Access:** reads happen only via backend-issued **signed URLs** (default TTL **60 s**; caller may override). The private bucket means URLs cannot be guessed or hot-linked.

### Retention (DECISION)

- **Attachments are retained for 90 days from the feedback row's `created_at`, then deleted.** A screenshot can contain PII; attaching is user-initiated/opt-in, but that must be paired with a bounded lifetime rather than indefinite storage (privacy principle in #97). 90 days is long enough to triage and act, short enough to bound PII exposure.
- **Delete-on-DELETE is IN SCOPE.** The admin `DELETE /feedback/:id` handler deletes the row's attachments in the same request via `removeStoragePrefix(id)` (a single storage call).

  **Ordering — objects FIRST, then the row.** The handler is reordered so a transient object-delete failure leaves a recoverable state:
  1. `getFeedbackById(id)` — `null` → **404** and return (nothing to clean; preserves the existing not-found contract).
  2. `removeByPrefix(id)` — delete all objects under the prefix **while the row still exists**. Idempotent. If it **throws**, respond **500 without deleting the row**, so the operator's retry re-enters at step 1 and re-issues the idempotent prefix delete until it succeeds.
  3. `deleteFeedback(id)` — delete the row **only after** objects are gone. If the row vanished in between, `deleteFeedback` returns `false` → 404, and objects were already removed in step 2.

  Net invariant: **the feedback row is never deleted while its objects remain** — a 200 guarantees no orphaned attachments; a 500 guarantees the row (and thus the recoverable prefix) is still present.
- **The 90-day sweep is a stated follow-up** (a scheduled job). It is **DB-driven**: object keys carry no timestamp, so the sweep queries `feedback WHERE created_at < now() - interval '90 days' AND array_length(attachment_keys,1) > 0`, then calls `removeByPrefix(id)` per row and nulls out `attachment_keys`. Not built here; the policy and join-key mechanism are decided so slice 2/3 and ops can rely on it. `removeByPrefix` is in the storage interface so the follow-up needs no interface change.

## Edge Cases

- **E1 — File too large.** Decoded byte length > 5 MB → **400**. Independently, the route's body-parser `limit` (~7 MB, above 5 MB to allow base64 inflation) rejects an oversized raw body before decode; `body-parser` throws `entity.too.large` carrying `.status = 413`, which the project's custom `errorHandler` surfaces as **413** (no handler change). An integration test asserts 413-not-500 as a regression guard. The global `express.json()` limit is unchanged.
- **E2 — Too many attachments.** Row already holds `maxPerReport` (3) keys → 400, no upload. Cheap pre-upload check on the freshly-read row; authoritative guard is the post-append length (E11).
- **E3 — Non-image / disallowed type.** `mimeType` not in `allowedMimeTypes` → 400.
- **E4 — Declared vs. actual type mismatch.** Sniff decoded magic bytes vs. declared mime: PNG (`89 50 4E 47`), JPEG (`FF D8 FF`), WebP (RIFF container + `WEBP` at offset 8). No full decode. Mismatch or unknown signature → 400.
- **E5 — Malformed / empty base64.** Decode failure or zero-length decode → **400** "Invalid image data" (handler-level, before the service).
- **E6 — Unknown / not-owned feedback id.** `getFeedbackById` null → **404**, no upload. Row exists but not owned and caller not admin → **403**, no upload. 404 (not 403) for absent rows so a non-owner cannot probe which ids exist.
- **E7 — Storage upload fails after validation.** Do **not** append a key; surface 5xx. Feedback text already persisted, so the report is not lost. No dangling key. If `appendAttachmentKey` itself throws after a successful upload, the service `remove(key)`s the just-uploaded object.
- **E8 — Key collision.** `attachmentId` is a UUID; `upload` is non-upsert so a collision errors rather than overwriting.
- **E9 — Guest submitter.** Guests attach through the same ownership equality: `req.userId = guestId`, and `createFeedback` persisted that same `guestId` to `feedback.user_id`. **Session-expiry edge:** if a guest's in-memory session expires/restarts between `POST /feedback` and the attach, `authMiddleware` rejects the token with **401** before the handler runs — no window for an expired guest to attach; only the attach is lost (text already saved). Acceptable.
- **E10 — Empty image.** Zero-byte decoded buffer → 400.
- **E11 — Concurrent attach race (count).** Two in-flight requests at `maxPerReport - 1` could both pass the pre-upload check. Guard: the append RPC returns the post-append array; if `length > maxPerReport`, the service `remove(key)`s the just-uploaded object and returns 400. Bounds the cap without a DB constraint.
- **E12 — Retry after a succeeded-but-unacked upload.** Each request mints a fresh `attachmentId`, so a client retry after a lost response creates a **second** distinct object/key (a duplicate counting toward `maxPerReport`). Accepted, not prevented: the endpoint is **not** idempotent; the count cap bounds the blast radius. Slice 2 should avoid blind auto-retry of a non-idempotent attach.

## Dependencies

- **LLD 1 (Supabase Migration)** — migration + gate tooling, `service_role` client, RLS model (002/008/011 patterns). Direct upstream.
- **LLD 9 (Feedback Widget)** — the `feedback` table, `FeedbackService`, `SupabaseDB.createFeedback`, `POST /feedback` + admin `DELETE /feedback/:id`, `FeedbackRepository`, `Feedback` entity. This slice extends all of these.
- **`authMiddleware`** — sets non-null `req.userId` for guests (`guestId`) and registered users (`sub`); the ownership rule depends on this. Plus `FEEDBACK_ADMIN_IDS` (from env) for the admin bypass used by GET/DELETE.
- **Custom `errorHandler`** — already routes errors with `.status` through `res.status(err.status)`; body-parser's `entity.too.large` (413) satisfies that shape, so E1 oversize surfaces as 413 with no handler change (413 test is the guard).
- **Migration-safety harness** — `verify-drift.mjs` + `expected-diff.allowlist.json`, `verify-postconditions.mjs` + `postconditions/`, `verify-no-destructive-ddl.mjs` + `destructive-ddl.allowlist.json`, `prodShapedFixture` helper.
- **`@supabase/supabase-js` ^2.107** — Storage API (`.storage.from().upload/createSignedUrl/remove/list`). **No new npm dependency** (base64 JSON transport; magic-byte sniff is a few byte comparisons).

### Migration-safety wiring (MUST all hold, or CI reddens)

1. `013_create_feedback_attachments_bucket.sql` + its `.postcondition.sql` (1:1 coverage enforced by `verify-postconditions.mjs`).
2. `"013_create_feedback_attachments_bucket.sql"` appears in **BOTH** `expected-diff.allowlist.json` `expectedPending` **AND** `scripts/fixtures/clean-diff.json` `pending` (alongside main's still-pending `012_prune_game_history.sql`). Updating only one reddens the gate as **"Stale expectedPending"**. The `feedback.attachment_keys` column add is a `public`-schema change `supabase db diff` sees → recorded in `clean-diff.json` `objects` + `expectedFromPending` as `column:public:feedback:attachment_keys`. The `storage`-schema bucket/policies are **not** emitted by `db diff` (managed schema); the **postcondition** is their authoritative check.
3. `destructive-ddl.allowlist.json`: **no entry needed** — `INSERT`, `CREATE POLICY`, `CREATE OR REPLACE FUNCTION`, `REVOKE`/`GRANT`, and `ADD COLUMN IF NOT EXISTS` destroy no data. The delete-path prefix cleanup is a Storage-API call in application code, not migration SQL.
4. Release order (DEVELOPMENT.md "Prod Migration Release"): `supabase db push` → `verify-postconditions.mjs` against prod (pooler, `PGSSLMODE=no-verify`) → **then** merge/deploy the backend code. Schema leads code; Railway applies no migrations.

## Test Requirements

### Unit (no DB, no network) — `tests/service/feedbackAttachmentService.test.ts`

- Rejects mime not in `allowedMimeTypes` (E3); accepts each allowed type.
- Rejects decoded size > cap (E1) and zero-byte (E10).
- Rejects when the pre-upload count already equals `maxPerReport` (E2).
- Rejects malformed base64 (E5) and declared/actual mime mismatch via magic-byte sniff (E4), including WebP RIFF-container detection.
- **Ownership (E6/E9):** `getFeedbackById` null → `NotFoundError`, never calls `storage.upload`; row owned by a different `requesterId` with `isAdmin=false` → `AccessDeniedError`, no upload; same-owner (guest OR registered) → allowed; `isAdmin=true` on any row → allowed. (Fake repo returning rows with chosen `userId`.)
- On valid input: calls `storage.upload` with the expected `{feedbackId}/{uuid}.{ext}` key and appends exactly that key (in-memory `AttachmentStorage` double + fake repo).
- On `storage.upload` rejection: does NOT append a key (E7).
- **Count race (E11):** when `appendAttachmentKey` returns an over-length array, the service calls `storage.remove` for the just-uploaded key and returns a 400-mapped error.
- `getSignedUrl` delegates to the storage double with the expected default TTL (60 s).

### Integration (local `supabase start`) — `tests/integration/feedbackAttachment.test.ts`

- **Acceptance-criteria round trip (no UI):** `POST /feedback` → `POST /feedback/:id/attachments` with a small real PNG → 201; then `getSignedUrl(key)` fetches the object and the bytes match. Confirms upload → link → signed read.
- `feedback.attachment_keys` contains the returned key; the row stores **no** binary (assert the column holds only the key string).
- Rejections server-side: decoded-oversize → **400**; raw-body-oversize → **413** (assert 413, not 500 — proves E1 mapping through `errorHandler`); over-count → **400**; non-image mime → **400**; mismatched magic bytes → **400**.
- **Ownership (E6/E9):** guest attaches to its own row → 201; a second guest (different `guestId`) → **403**; a registered user attaching to a guest's `:id` → **403**; non-existent `:id` → **404**; admin → 201.
- **Delete-path cleanup:** create row, attach, `DELETE /feedback/:id` as admin → 200; then assert the object is **gone from Storage**. Proves no orphaned PII survives row deletion.
- **Delete-path transient-failure retry:** with an object attached, make `removeByPrefix` throw once. First `DELETE` → **500** and the **row still exists**; retry `DELETE` → **200**, object gone, row gone. Confirms the reordered handler re-attempts cleanup rather than 404-short-circuiting into an orphan.
- Signed URL is time-limited (prefer asserting a short TTL is passed to the SDK over waiting for expiry).

### Migration-safety — `tests/integration/migration-013.test.ts` (prod-shaped, name-agnostic)

> `prodShapedFixture` uses a throwaway `public`-like schema and cannot host the fixed `storage` schema. Run the `public`-schema part (`feedback.attachment_keys` add + RPC lockdown) through the fixture; run the `storage`-schema part (bucket + policies) against the real local `storage` schema, cleaning up the test bucket in `finally`.

- After applying 013: bucket exists and `public = false` (**security assertion**).
- `anon`/`authenticated` cannot read or write an object in the bucket (deny-by-construction); `service_role` can (bypasses RLS). Mirrors `rls.test.ts` style.
- `feedback.attachment_keys` exists, is an array, defaults to `{}`.
- `append_feedback_attachment_key` is executable by `service_role` and **not** by `anon`/`authenticated`/`public`.
- Idempotency: applying 013 twice → exactly the intended bucket + policy set (no duplicate policy, no error).
- The **013 postcondition passes** on the applied schema and **RAISEs** when the bucket is public/missing, the deny policies are absent, or the RPC grant is loosened.

### Gate wiring — `tests/scripts/drift-gate.test.ts` (extend)

- With 013 pending and correctly allowlisted (+ fixture updated), the gate passes; with 013 pending but missing from `expectedPending`, it fails "missing from expectedPending" (proves the lockstep is enforced).

### Explicitly not tested here

- No frontend/E2E (slice 2 / #171). No triage read route (slice 3 / #172). No malware scanning / image re-encode (out of scope).
