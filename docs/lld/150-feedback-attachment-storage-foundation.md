# LLD 150: Feedback Attachment Storage Foundation — Private Bucket, Storage RLS, Signed Upload/Read Path

Parent: #97 (slice 1 of 3). Ships **first** — it is the foundation slices 2 (UI) and 3 (triage surfacing) build on, and it carries the entire prod-migration risk of the feature (the project's **first** use of Supabase Storage).

## Scope

**In scope (backend / infra only, no UI):**

- Provision a **private** Supabase Storage bucket (`feedback-attachments`) via a migration — no public read.
- Add `storage.objects` RLS policies scoped to that bucket so `anon`/`authenticated` cannot read or write it directly; only the backend `service_role` can.
- Backend **upload path**: extend the feedback submit flow with a new endpoint that accepts an image, validates it server-side, writes it to Storage under a per-submission key, and links the key(s) to a feedback record.
- Backend **read path**: a service method that issues short-lived **signed** read URLs for an attachment key (consumed later by slice 3 triage — not exposed via a route in this slice).
- **Server-side enforcement**: accepted MIME types (images only), per-file byte cap, and max images per report. Reject violations with a clear 4xx.
- Data model: link attachments to the `feedback` row by key/path. **No binary in Postgres.**
- **Retention policy**: documented below (§State Model → Retention). Deleting a feedback row **must** delete its attachments in the same operation (in scope — one `removeByPrefix` call). The scheduled 90-day sweep is a stated follow-up; the policy itself is decided here.
- Migration-safety: name-agnostic/idempotent SQL, drift-gate + postcondition + destructive-DDL gate wiring.

**Explicitly NOT in scope:**

- Any UI or frontend code (slice 2).
- Surfacing attachments to the triage admin view / a read route (slice 3).
- The auto-capture-a-screenshot button (deferred).
- Virus/malware scanning, image re-encoding/thumbnailing, EXIF stripping (can be a later hardening slice; not required for the acceptance criteria).

## Approach

### Key decisions

1. **Bucket + RLS provisioned by SQL migration, not the Storage API.** Supabase Storage buckets are rows in `storage.buckets`; object-access rules are RLS policies on `storage.objects`. Both are ordinary Postgres objects reachable by our existing migration + postcondition tooling (`supabase db push`, `verify-postconditions.mjs`). Creating the bucket via `INSERT INTO storage.buckets ... ON CONFLICT DO NOTHING` keeps provisioning **idempotent, name-agnostic, versioned, and machine-verifiable** — consistent with LLDs 008/011. This avoids a bootstrap script that races the backend and cannot be gated. New migration: `013_create_feedback_attachments_bucket.sql` (renumbered 012→013 on merge: `main` shipped `012_prune_game_history.sql` (LLD 149) first).

2. **Bucket is private + no client policies = server-only, by construction.** `storage.buckets.public = false` disables the public CDN path. RLS on `storage.objects` is already `ENABLE`d by Supabase's own migrations. We add **only** SELECT/INSERT policies scoped to `bucket_id = 'feedback-attachments'` that are impossible for `anon`/`authenticated` to satisfy — mirroring the `games` table pattern in migration 002 ("no direct client mutation; all access via service_role, which bypasses RLS"). Net effect: every client-side read/write of this bucket is denied; the backend `service_role` key bypasses RLS and is the sole accessor. This is the server-authoritative principle (architecture-principles §1) applied to blob storage. See §Interfaces for the exact policy shape and the "deny by construction" rationale.

3. **Upload transport: base64 JSON on a dedicated route, not multipart.** The app already parses JSON globally (`express.json()`), has no multipart middleware (no `multer`/`busboy` in deps), and images here are small (single-file cap, few files). Adding a raw/base64 body on a **dedicated** route with an explicit size limit avoids introducing a new multipart dependency and matches the existing JSON-everywhere handler style. The global `express.json()` default 100 kb limit is **too small** and must not be raised globally (that would widen the attack surface on every route); the attachment route mounts its own body parser with a bounded limit. See Edge Cases E1.

4. **Two-step submit, attachments reference the feedback row.** Feedback is created first (existing flow, unchanged), then attachments are uploaded referencing that `feedback.id`. The storage object key embeds the feedback id: `feedback-attachments/{feedbackId}/{attachmentId}.{ext}`. The link is stored as a `attachment_keys TEXT[]` column on `feedback` (see §5 for the alternative considered). This keeps the write atomic per-attachment and makes cleanup trivial (delete the `feedback/{id}/` prefix).

5. **Link column vs. join table.** Chosen: a `attachment_keys TEXT[]` column on `feedback` (max length enforced in the backend, not the DB). Rationale: attachments are a small, bounded, always-fetched-with-the-parent list owned 1:1 by a feedback row; a join table adds a migration, a second RLS surface, and a query for no current benefit (YAGNI, CLAUDE.md §2). Alternative — a `feedback_attachments(feedback_id, key, mime, bytes, created_at)` join table — is more normalized and would hold per-file metadata (useful if slice 3 wants size/type in triage). **Recommendation: the array column now**; if slice 3 needs per-file metadata, promote to a join table then. Documented so slice 3 can revisit.

### Flow

```
Client (slice 2)                Backend                         Supabase
  POST /feedback  ───────────►  create feedback row  ─────────► INSERT feedback
       (existing)               returns { id }
  POST /feedback/:id/attachments
     { image: base64, mime } ─► getFeedbackById(:id)          ─► SELECT feedback (own row?)
                                owner check: row.userId===userId
                                   (or admin)  else 403/404
                                validate (mime/size/count)
                                upload buffer via service_role ─► storage.objects (private)
                                appendAttachmentKey → keys[]
                                   (len<=max else remove+400)
                             ◄─ 201 { attachmentId, key }
  DELETE /feedback/:id (admin) ► getFeedbackById(id)           ─► SELECT feedback (exists? keys?)
                                   null → 404 (unchanged)
                                removeByPrefix(".../{id}/")    ─► delete all objects FIRST
                                   throws → 500 (row still present → retry re-cleans)
                                deleteFeedback(id)             ─► DELETE feedback row (last)
                             ◄─ 200 { deleted: id }
  (slice 3 triage) ──────────►  getSignedUrl(key)             ─► createSignedUrl(TTL)
                             ◄─ short-lived signed URL
```

## Interfaces / Types

### Migration `013_create_feedback_attachments_bucket.sql` (shape, not final text)

```sql
-- 013: First use of Supabase Storage. Create a PRIVATE bucket for feedback
-- attachments and RLS on storage.objects so clients cannot read/write it
-- directly; only the backend service_role (bypasses RLS) can. Idempotent &
-- name-agnostic (008/011 idiom): safe on fresh `supabase start` AND on prod.

-- 1. Private bucket (public=false disables the anon CDN read path). Idempotent.
INSERT INTO storage.buckets (id, name, public)
VALUES ('feedback-attachments', 'feedback-attachments', false)
ON CONFLICT (id) DO NOTHING;

-- 2. RLS on storage.objects is already enabled by Supabase's own migrations.
--    Add SELECT + INSERT policies SCOPED to this bucket that no anon/authenticated
--    client can satisfy (deny-by-construction). service_role bypasses RLS, so the
--    backend is unaffected. Guard each CREATE on pg_policies (CREATE POLICY IF NOT
--    EXISTS does not exist) so re-running is a clean no-op (011 idiom).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'feedback_attachments_no_client_read'
  ) THEN
    CREATE POLICY feedback_attachments_no_client_read
      ON storage.objects FOR SELECT
      USING (bucket_id = 'feedback-attachments' AND false);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'feedback_attachments_no_client_write'
  ) THEN
    CREATE POLICY feedback_attachments_no_client_write
      ON storage.objects FOR INSERT
      WITH CHECK (bucket_id = 'feedback-attachments' AND false);
  END IF;
END $$;

-- 3. Link column on feedback (idempotent; no binary in Postgres — keys only).
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS attachment_keys TEXT[] NOT NULL DEFAULT '{}';
```

Notes:
- The `AND false` predicate makes these policies **explicitly deny** for any role bound by RLS. They exist (rather than being omitted) so the postcondition can assert a scoped, intentional deny for this bucket rather than relying on the *absence* of a policy — and so a future author cannot accidentally add a permissive policy without the postcondition/drift gate noticing the change. Omitting policies entirely would also deny (default-deny), but an explicit, named, bucket-scoped deny is auditable and self-documenting.
- The migration author must confirm against the local stack that `storage.buckets` has a PK/unique on `id` for `ON CONFLICT (id)`; if the constraint is named/absent differently, use `WHERE NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = ...)` guard instead (still idempotent, name-agnostic).

### Postcondition `013_create_feedback_attachments_bucket.postcondition.sql` (shape)

Shape-based, name-agnostic where it can be, idempotent, read-only; accumulates `bad[]` and RAISEs once (011 idiom). Asserts:
1. Bucket `feedback-attachments` exists in `storage.buckets`.
2. Bucket is **private** (`public = false`) — the security-critical assertion.
3. `feedback.attachment_keys` column exists and is an array type.
4. RLS is enabled on `storage.objects` (`pg_class.relrowsecurity`).
5. At least the two bucket-scoped policies exist (by shape: `schemaname='storage' AND tablename='objects'` with the bucket id referenced in the qual/with_check). Optionally assert no *permissive* client policy grants access to the bucket.

### Backend service (`src/backend/service/feedbackAttachmentService.ts`)

```ts
export interface AttachmentInput {
  feedbackId: string;
  requesterId: string; // req.userId (guest guestId OR registered sub); NEVER null on this route
  isAdmin: boolean;    // req.userId ∈ FEEDBACK_ADMIN_IDS (admins may attach to any row)
  data: Buffer;        // decoded from base64 by the handler
  mimeType: string;    // client-declared; validated + cross-checked (E4)
}

export interface AttachmentResult {
  attachmentId: string;
  key: string;         // storage.objects path
}

export const ATTACHMENT_LIMITS = {
  maxBytesPerFile: 5 * 1024 * 1024, // 5 MB — decision, see Edge Cases E1
  maxPerReport: 3,                  // decision, see Edge Cases E2
  allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
} as const;
// GIF is intentionally excluded: this is a screenshot-attach use case, and every
// platform screenshot tool emits PNG/JPEG/WebP. Excluding GIF narrows the accepted
// surface, keeps the magic-byte sniff to three signatures, and avoids animated-GIF
// payload concerns. If a real need for GIF appears, add "image/gif" here AND extend
// the E4 sniff to accept both GIF87a and GIF89a headers.

export class FeedbackAttachmentService {
  constructor(
    private readonly feedbackRepo: FeedbackRepository, // needs getFeedbackById + appendAttachmentKey
    private readonly storage: AttachmentStorage,
  ) {}

  // Ordered checks (fail closed, cheapest/security-first, upload last):
  //   1. Load row via feedbackRepo.getFeedbackById; not found → NotFoundError (E6).
  //   2. Ownership: unless isAdmin, require row.userId === requesterId; else → AccessDeniedError (E6/E9).
  //   3. mime allowed (E3), base64 decodes (E5), size in (0, cap] (E1/E10),
  //      magic bytes match declared mime (E4), current key count < maxPerReport (E2).
  //   4. Upload buffer to Storage (E7 — no key appended if this throws).
  //   5. appendAttachmentKey; enforce returned length <= maxPerReport (E2/E11).
  addAttachment(input: AttachmentInput): Promise<AttachmentResult>;

  // Slice 3 will call this; issues a short-lived signed read URL.
  getSignedUrl(key: string, ttlSeconds?: number): Promise<string>;
}
```

### Storage abstraction (`AttachmentStorage`) — pluggable storage (architecture-principles §7)

```ts
export interface AttachmentStorage {
  upload(key: string, data: Buffer, mimeType: string): Promise<void>;
  createSignedUrl(key: string, ttlSeconds: number): Promise<string>;
  removeByPrefix(prefix: string): Promise<void>; // for retention/cleanup follow-up
}
```

Concrete impl `SupabaseAttachmentStorage` wraps `SupabaseDB`'s client `.storage.from('feedback-attachments')` (`.upload`, `.createSignedUrl`, `.remove`). Kept behind an interface so tests can use an in-memory double and the engine/service layer never couples to the Storage SDK (mirrors the repository pattern already used for the DB).

### Repository additions (`FeedbackRepository` / `SupabaseDB`)

The interface today is only `createFeedback` / `getAllFeedback` / `deleteFeedback` (`database.ts:74`). The ownership check (E6/E9) needs a read-by-id, and linking needs a keyed update. **Both must be added to the interface — they do not exist yet:**

```ts
// Read a single feedback row by id (null if not found). Needed for the
// ownership check before an attachment is accepted.
getFeedbackById(id: string): Promise<Feedback | null>;

// Append a storage key to an existing feedback row's attachment_keys.
// Returns the new keys array so the service can enforce maxPerReport against
// the authoritative post-append length. Errors if the row does not exist.
appendAttachmentKey(feedbackId: string, key: string): Promise<string[]>;
```

- `getFeedbackById` — `.from("feedback").select("*").eq("id", id).maybeSingle()` via `service_role`, mapped by the existing `mapFeedback` helper. `mapFeedback` must be extended to read the new `attachment_keys` column onto `Feedback.attachmentKeys` (add `attachmentKeys: string[]` to the `Feedback` entity, defaulting to `[]`).
- `appendAttachmentKey` — a single atomic `array_append` update on the `feedback` row via `service_role` (`update({ attachment_keys: <expr> })` using PostgREST's `array_append`, or an RPC), returning the updated `attachment_keys`. Read-modify-write is acceptable but the count check (E2) MUST be enforced against the value returned by the write, not a separately-read snapshot, to avoid a check-then-append race (see E2/E11).

### Route (extends existing feedback router)

```
POST /feedback/:id/attachments
  Auth: same middleware as POST /feedback (authMiddleware — authenticated OR guest).
        req.userId is ALWAYS set on this route (guest → guestId, registered → sub);
        the route never runs unauthenticated.
  Body: { image: string (base64), mimeType: string }   // dedicated bounded body parser
  201 → { attachmentId, key }
  400 → { error } for: unknown/non-image mime; decoded size > cap; count > max;
                       malformed/empty base64
  403 → caller does not own the feedback row (and is not an admin)   [ownership]
  404 → feedback :id does not exist
  413 → oversized raw body rejected by the route's body-parser limit
```

**Ownership rule (Gap 1 — the security boundary this slice introduces):** The
`feedback` route sits behind `authMiddleware`, which sets `req.userId` for **both**
principals — a guest's stable per-session `guestId` (`authMiddleware.ts:118`) and a
registered user's `sub` (`:146`). `createFeedback` already persists that value to
`feedback.user_id` (`supabaseDb.ts:238`), so **`feedback.user_id` is non-null for
guest-created rows too** (it is the `guestId`, not null — this corrects the review's
premise). The enforceable rule is therefore uniform across guests and registered users:

> A caller may attach to `:id` **iff** `getFeedbackById(id).userId === req.userId`,
> **or** `req.userId ∈ FEEDBACK_ADMIN_IDS` (the same admin set used by GET/DELETE).
> Otherwise 403 (row exists, not owned) or 404 (row absent). No `service_role` /
> RLS trickery required — the check is a single application-level equality on a row
> the backend reads with its `service_role` key.

Because the guest `guestId` is stable for the life of the session and the guest token
is HMAC-verified per request, a guest cannot spoof another guest's id, and thus cannot
attach to another guest's (or a registered user's) feedback row. This is a concrete,
testable check — no rule is deferred to implementation. (Session expiry edge: see E9.)

`GET`/signed-URL route is intentionally **absent** in this slice (slice 3 adds triage read).

### Shared model additions (`src/shared/model.ts`)

```ts
export interface SubmitAttachmentRequest { image: string; mimeType: string; }
export interface SubmitAttachmentResponse { attachmentId: string; key: string; }
```

## State Model

- **Persisted (Postgres `feedback` row):** `attachment_keys TEXT[]` — storage paths only. **No binary.**
- **Persisted (Supabase Storage, private bucket):** the image bytes, keyed `feedback-attachments/{feedbackId}/{attachmentId}.{ext}`. `{attachmentId}` is a server-generated UUID; `{ext}` derived from the validated mime.
- **In-memory / transient:** the decoded `Buffer` during a single request. Never cached.
- **Access:** reads happen only via backend-issued **signed URLs** (default TTL **60 s**, sufficient for a triage view to load; caller may override). Bucket is private so URLs cannot be guessed or hot-linked.

### Retention (DECISION)

- **Attachments are retained for 90 days from the feedback row's `created_at`, then deleted.** Rationale: a screenshot can contain PII; attaching is user-initiated/opt-in, but that must be paired with a bounded lifetime rather than indefinite storage (privacy principle in #97). 90 days is long enough to triage and act on a report, short enough to bound PII exposure.
- **Delete-on-DELETE is IN SCOPE (not a follow-up).** The existing admin `DELETE /feedback/:id` handler (`submitFeedback.ts:49-64`) must delete the row's attachments in the same request via `storage.removeByPrefix("feedback-attachments/" + id + "/")` — a **single call** on the interface already defined here. Hedging it as "if non-trivial, fast-follow" contradicts this LLD's own bounded-PII rationale: leaving orphaned screenshots in Storage after the operator deletes the report is exactly the indefinite-PII outcome the retention policy forbids.

  **Ordering — objects FIRST, then the row (a deliberate reversal of the naive "row first" order).** The existing handler short-circuits on a missing row: `deleteFeedback(id)` returns `false` → the handler responds **404 and returns** before any other work (`submitFeedback.ts:57-61`). If we deleted the row first and the subsequent object delete threw (transient Storage error → 500), the operator's retry would hit that 404 branch — the row is already gone — and **never reach `removeByPrefix`**, orphaning the screenshot (PII) indefinitely. The retry could not recover the cleanup because the prefix is only knowable while the row still identifies the feedback. To make the retry path actually re-attempt object cleanup, the handler is reordered so the object delete happens in a request that does **not** depend on the row already being gone:

  1. `getFeedbackById(id)` — if `null`, respond **404** and return (preserves the existing not-found contract; nothing to clean).
  2. `storage.removeByPrefix("feedback-attachments/" + id + "/")` — delete all objects under the prefix **while the row still exists**. `removeByPrefix` is idempotent (deleting an already-absent/partly-absent prefix is a no-op success). If this **throws**, log and respond **500 without deleting the row** — the row is intentionally left intact so the operator's retry re-enters at step 1, re-reads the same `id`, and re-issues the same idempotent prefix delete until it succeeds. No orphan can outlive a successful DELETE.
  3. `deleteFeedback(id)` — delete the row **only after** objects are confirmed gone. On the (now near-impossible) race where the row vanished between step 1 and step 3, `deleteFeedback` returns `false`; respond 404 — objects were already removed in step 2, so there is still nothing orphaned.

  Net invariant: **the feedback row is never deleted while its objects remain**, so a 200 guarantees no orphaned attachments and a 500 guarantees the row (and therefore the recoverable prefix) is still present for a retry. This is covered by an integration test, including the transient-failure retry case (see Test Requirements → Integration).
- **The 90-day sweep is a stated follow-up** (a scheduled job / cron). **It is DB-driven:** object keys carry **no** timestamp (`feedback-attachments/{feedbackId}/{attachmentId}.{ext}`), so the sweep must query `feedback WHERE created_at < now() - interval '90 days' AND array_length(attachment_keys,1) > 0`, then call `removeByPrefix("feedback-attachments/" + id + "/")` per row (and null out the row's `attachment_keys`). The follow-up author must **not** assume a listable object timestamp. Not built in this slice; the policy and the join-key mechanism are decided here so slice 2/3 and ops can rely on it. `removeByPrefix` is in the storage interface so the follow-up needs no interface change.

## Edge Cases

- **E1 — File too large.** Decoded byte length > `maxBytesPerFile` (5 MB) → 400 with a clear message. Independently, the route's body-parser `limit` (set slightly above 5 MB to allow base64's ~33% inflation, e.g. 7 MB) rejects an oversized raw body **before** decode. `body-parser` throws an `entity.too.large` error carrying both `.status` and `.statusCode` = **413** and a `.message`. The project's custom `errorHandler` (`server.ts:142` / `middleware/errorHandler.ts`) routes any error matching `instanceOfErrorWithStatus` (has `status` + `message`) through `res.status(err.status)` — so a body-parser oversize **already surfaces as 413, not 500** with no handler change. The implementer must **confirm** this with the explicit integration assertion below (a regression guard, since it depends on `errorHandler` reading `.status`); if a future `errorHandler` change breaks it, add a branch mapping `entity.too.large` → 413. The global `express.json()` limit is **not** changed.
- **E2 — Too many attachments.** If the row already holds `maxPerReport` (3) keys → 400, no upload performed. A pre-upload count check on the freshly-read row rejects the common case cheaply; the authoritative guard is the post-append length returned by `appendAttachmentKey` (E11).
- **E3 — Non-image / disallowed type.** `mimeType` not in `allowedMimeTypes` → 400. Client-declared type is not trusted alone (see E4).
- **E4 — Declared vs. actual type mismatch.** Sniff the decoded buffer's magic bytes and require it to match the declared image mime — a minimal signature check for the three allowed types: PNG (`89 50 4E 47`), JPEG (`FF D8 FF`), WebP (`52 49 46 46 …. 57 45 42 50`, i.e. RIFF container + `WEBP` at offset 8); no full decode. Mismatch, or a signature not in this set, → 400. Prevents a client mislabeling a non-image as `image/png`. (If GIF is ever added to `allowedMimeTypes`, also accept `GIF87a`/`GIF89a` here.)
- **E5 — Malformed base64.** Decode failure → 400 "Invalid image data".
- **E6 — Unknown / not-owned feedback id.** `getFeedbackById(:id)` returns null → **404**, no upload. Row exists but `row.userId !== req.userId` and caller is not an admin → **403**, no upload. This is the ownership boundary defined in §Route; it prevents attaching to someone else's report. Return 404 (not 403) for the absent-row case so a non-owner cannot probe which ids exist beyond what they already own.
- **E7 — Storage upload fails after validation.** Do **not** append the key; surface 5xx; the feedback row simply has no attachment (feedback text already persisted, so the user's report is not lost). No partial/dangling key.
- **E8 — Key collision.** `attachmentId` is a UUID; collision is negligible. `upload` uses non-upsert mode so an accidental collision errors rather than overwriting.
- **E9 — Guest submitter.** Guests attach through the **same** ownership rule as registered users: `authMiddleware` sets `req.userId = session.guestId` (`authMiddleware.ts:118`), `createFeedback` persisted that same value to `feedback.user_id`, so `row.userId === req.userId` holds for the guest's own rows and fails for anyone else's. No null-user special case exists — the review's assumption that guest rows carry `user_id = null` is not what the code does; the guest row carries the `guestId`. **Session-expiry edge:** a guest's session is in-memory (`guestSessionStore`); if it expires or the server restarts between `POST /feedback` and `POST /feedback/:id/attachments`, `authMiddleware` rejects the guest token with 401 before the handler runs (the guest cannot present a valid `req.userId` at all), so there is no window in which an expired guest can attach — the report text is already saved; only the attach is lost, which is acceptable. No rule is deferred; nothing is restricted beyond the ownership equality.
- **E10 — Empty image.** Zero-byte decoded buffer → 400.
- **E12 — Client retry after a succeeded-but-unacked upload (duplicate copy).** Each request mints a fresh `attachmentId` UUID, so a client that retries after a response was lost (upload + append actually succeeded server-side) uploads a **second** distinct object and appends a **second** key — a duplicate that counts against `maxPerReport`. This is accepted, not prevented, in this slice: the endpoint is **not** idempotent, retries are the client's responsibility, and the count cap (E2/E11) bounds the blast radius to `maxPerReport` copies. Rationale: an idempotency key would require the client (slice 2, no UI yet) to supply and reuse one, which is out of scope here; documenting the semantics is sufficient for the foundation slice. Slice 2 SHOULD avoid blind auto-retry of a non-idempotent attach, or pass a client-generated idempotency token that a future slice can honor. (No dedup logic is built here.)
- **E11 — Concurrent attach race (count).** Two in-flight requests for the same `:id` could each pass the pre-upload count check (E2) when the row holds `maxPerReport - 1` keys, then both append → `maxPerReport + 1`. Handling: `appendAttachmentKey` returns the post-append array; the service asserts `returnedLength <= maxPerReport` and, if exceeded, **removes the just-uploaded object** (`storage.removeByPrefix` of its exact key) and returns 400. Prevents exceeding the cap under concurrency without a DB-level constraint. Low-severity (self-attach only), but specified so the implementer does not rely on the read-then-check alone.

## Dependencies

- **LLD 1 (Supabase Migration)** — migration + gate tooling, `service_role` client, RLS model (002/008/011 patterns). Direct upstream.
- **Existing feedback stack** — `feedback` table (001), `FeedbackService`, `SupabaseDB.createFeedback`, `POST /feedback` route + admin `DELETE /feedback/:id` handler (`submitFeedback.ts:49-64`, reordered here to `getFeedbackById` → `removeByPrefix` → `deleteFeedback` so a transient object-delete failure leaves the row intact for a recoverable retry — see §Retention), `FeedbackRepository` interface (`database.ts:74` — extended with `getFeedbackById`/`appendAttachmentKey`; `getFeedbackById` is reused by the delete path), `Feedback` entity (extended with `attachmentKeys`).
- **`authMiddleware`** (`middleware/authMiddleware.ts`) — sets non-null `req.userId` for guests (`guestId`) and registered users (`sub`); the ownership rule (§Route) depends on this. Also `req.isGuest` and the `FEEDBACK_ADMIN_IDS` admin set (`submitFeedback.ts:10`) for the admin bypass.
- **Custom `errorHandler`** (`middleware/errorHandler.ts`) — already routes `instanceOfErrorWithStatus` errors through `res.status(err.status)`; body-parser's `entity.too.large` (`.status = 413`, `.message`) satisfies that shape, so E1 oversize surfaces as 413 with no handler change. The 413 integration test is the regression guard.
- **Migration-safety harness** — `verify-drift.mjs` + `expected-diff.allowlist.json`, `verify-postconditions.mjs` + `postconditions/`, `verify-no-destructive-ddl.mjs` + `destructive-ddl.allowlist.json`, `prodShapedFixture` test helper.
- **`@supabase/supabase-js` `^2.107`** — Storage API (`.storage.from().upload/createSignedUrl/remove`) is available in this version.
- **No new npm dependency** required (base64 JSON transport; magic-byte sniff is a few bytes of comparison, no library).

### Migration-safety wiring (MUST all be done, or CI reddens)

1. Add `013_create_feedback_attachments_bucket.sql` and its `.postcondition.sql` (1:1 coverage enforced by `verify-postconditions.mjs`).
2. Add `"013_create_feedback_attachments_bucket.sql"` to `expected-diff.allowlist.json` `expectedPending` (alongside main's pending `012_prune_game_history.sql`) **and** to `scripts/fixtures/clean-diff.json` `pending` (and, if the diff engine attributes the `feedback.attachment_keys` add / bucket insert as observed drift on the run that applies it, add the corresponding `expectedFromPending`/`objects` entries) — else the gate fails "Stale/missing expectedPending". Follow the exact lockstep the file `$comment`s describe.
   - **Storage-schema caveat:** the drift gate diffs the `public` schema. The `ALTER TABLE feedback ADD COLUMN attachment_keys` is a `public`-schema change the gate **will** see and must account for. The `storage`-schema bucket/policy changes may be invisible to `supabase db diff` (storage is a managed schema); the **postcondition** is the authoritative check for those. The implementer must verify what the linked-diff adapter emits for this migration on a dry run and wire the allowlist/fixture to match (do not guess).
3. `destructive-ddl.allowlist.json`: no entry needed — `INSERT`, `CREATE POLICY`, and `ADD COLUMN IF NOT EXISTS` destroy no data. The in-scope delete-path prefix cleanup (§Retention) is a Storage-API `remove` call in **application code**, not a SQL migration, so the DDL gate is unaffected by it.
4. Release order (DEVELOPMENT.md "Prod Migration Release"): `supabase db push` → `verify-postconditions.mjs` against prod (pooler, `PGSSLMODE=no-verify`) → then merge/deploy the backend code that reads/writes attachments. Schema leads code.

## Test Requirements

### Unit (no DB, no network) — `tests/service/feedbackAttachmentService.test.ts`

- Rejects mime not in `allowedMimeTypes` (E3); accepts each allowed type.
- Rejects decoded size > `maxBytesPerFile` (E1) and zero-byte (E10).
- Rejects when appending would exceed `maxPerReport` (E2).
- Rejects malformed base64 (E5) and declared/actual mime mismatch via magic-byte sniff (E4), including WebP RIFF-container detection.
- **Ownership (E6/E9):** `getFeedbackById` returns null → `NotFoundError` (→404), never calls `storage.upload`. Row owned by a different `requesterId` and `isAdmin=false` → `AccessDeniedError` (→403), no upload. Row owned by the same `requesterId` (guest OR registered) → allowed. `isAdmin=true` on any row → allowed. (Use a fake repo returning rows with chosen `userId`.)
- On valid input: calls `storage.upload` with the expected `{feedbackId}/{uuid}.{ext}` key and appends exactly that key via `appendAttachmentKey` (use an in-memory `AttachmentStorage` double + fake repo).
- On `storage.upload` rejection: does NOT append a key (E7).
- **Count race (E11):** when `appendAttachmentKey` returns an array longer than `maxPerReport`, the service calls `storage.removeByPrefix` for the just-uploaded key and returns a 400-mapped error (uses a fake repo whose `appendAttachmentKey` returns an over-length array).
- `getSignedUrl` delegates to the storage double with the expected TTL (default 60 s).

### Integration (local `supabase start`) — `tests/integration/feedbackAttachment.test.ts`

- **Acceptance-criteria round trip (no UI):** `POST /feedback` → `POST /feedback/:id/attachments` with a small real PNG buffer → 201; then via the service `getSignedUrl(key)` fetch the object and assert the bytes match. Confirms upload → link → signed read.
- Feedback row's `attachment_keys` contains the returned key; the `feedback` row stores **no** binary (assert column is the key string only).
- Rejections server-side: decoded-oversize → **400**; raw-body-oversize → **413** (assert the status is 413, not 500 — proves E1 error mapping through the custom `errorHandler`); over-count → **400**; non-image mime → **400**; mismatched-magic-bytes → **400**.
- **Ownership (E6/E9):** a guest attaches to its own feedback row → 201; a **second** guest (different session/`guestId`) attaching to the first guest's `:id` → **403**; a registered user attaching to a guest's `:id` → **403**; a non-existent `:id` → **404**; an admin attaching to any row → 201. (Exercises the corrected non-null `user_id` ownership rule for both principal types.)
- **Delete-path cleanup (Gap 3 — firm requirement):** create a feedback row, attach an object, `DELETE /feedback/:id` as admin → 200; then assert the object is **gone from Storage** (a subsequent `getSignedUrl`/download of the key fails / the prefix lists empty). Proves no orphaned PII survives row deletion.
- **Delete-path transient-failure retry (proves the recovery narrative):** with an object attached, make `storage.removeByPrefix` throw once (inject a storage double / stub that fails the first call, succeeds after). First `DELETE /feedback/:id` → **500** and the **feedback row still exists** (assert via `getFeedbackById`/`GET`), so the prefix is still recoverable. Retry `DELETE /feedback/:id` → **200**, object **gone**, row gone. Confirms the reordered handler re-attempts cleanup on retry rather than 404-short-circuiting into an orphan (the exact failure the review flagged).
- Signed URL is time-limited: after TTL the URL no longer authorizes the fetch (may be marked slow/optional if TTL waiting is impractical — prefer asserting a short TTL is passed to the SDK instead).

### Migration-safety — `tests/integration/migration-013.test.ts` (prod-shaped, name-agnostic)

> `prodShapedFixture` uses a throwaway `public`-like schema and cannot host the fixed `storage` schema. Split the assertions: run the `public`-schema part (`feedback.attachment_keys` add) through the fixture; run the `storage`-schema part (bucket + policies) against the **real local `supabase start` `storage` schema** (which has `storage.buckets`/`storage.objects`), cleaning up the test bucket in `finally`. State this split in the test header.

- After applying 013: bucket exists and `public = false` (**security assertion**).
- `anon` and `authenticated` cannot read or write an object in the bucket via the anon/auth key (deny-by-construction); `service_role` can (bypasses RLS). Mirror `rls.test.ts` "Security test" style.
- `feedback.attachment_keys` column exists, is an array, defaults to `{}`.
- Idempotency: applying 013 twice → exactly the intended bucket + policy set (no duplicate policy, no error) — the fresh-like idempotency assertion 011 uses.
- The **013 postcondition passes** on the applied schema and **RAISEs** when the bucket is public / missing or the deny policies are absent (postcondition has teeth), mirroring `migration-011.test.ts`.

### Gate wiring — `tests/scripts/drift-gate.test.ts` (extend)

- With 013 pending and correctly allowlisted (+ fixture updated), the gate passes; with 013 pending but missing from `expectedPending`, it fails "missing from expectedPending" (proves the lockstep is enforced).

### Explicitly not tested here

- No frontend/E2E (slice 2). No triage read route (slice 3). No malware scanning / image re-encode (out of scope).
