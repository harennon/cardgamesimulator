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
- **Retention policy**: documented below (§State Model → Retention). Cleanup mechanism is a stated follow-up; the policy itself is decided here.
- Migration-safety: name-agnostic/idempotent SQL, drift-gate + postcondition + destructive-DDL gate wiring.

**Explicitly NOT in scope:**

- Any UI or frontend code (slice 2).
- Surfacing attachments to the triage admin view / a read route (slice 3).
- The auto-capture-a-screenshot button (deferred).
- Virus/malware scanning, image re-encoding/thumbnailing, EXIF stripping (can be a later hardening slice; not required for the acceptance criteria).

## Approach

### Key decisions

1. **Bucket + RLS provisioned by SQL migration, not the Storage API.** Supabase Storage buckets are rows in `storage.buckets`; object-access rules are RLS policies on `storage.objects`. Both are ordinary Postgres objects reachable by our existing migration + postcondition tooling (`supabase db push`, `verify-postconditions.mjs`). Creating the bucket via `INSERT INTO storage.buckets ... ON CONFLICT DO NOTHING` keeps provisioning **idempotent, name-agnostic, versioned, and machine-verifiable** — consistent with LLDs 008/011. This avoids a bootstrap script that races the backend and cannot be gated. New migration: `012_create_feedback_attachments_bucket.sql`.

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
     { image: base64, mime } ─► validate (mime/size/count)
                                upload buffer via service_role ─► storage.objects (private)
                                append key to feedback.attachment_keys
                             ◄─ 201 { attachmentId, key }
  (slice 3 triage) ──────────►  getSignedAttachmentUrl(key)   ─► createSignedUrl(TTL)
                             ◄─ short-lived signed URL
```

## Interfaces / Types

### Migration `012_create_feedback_attachments_bucket.sql` (shape, not final text)

```sql
-- 012: First use of Supabase Storage. Create a PRIVATE bucket for feedback
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

### Postcondition `012_create_feedback_attachments_bucket.postcondition.sql` (shape)

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
  allowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
} as const;

export class FeedbackAttachmentService {
  constructor(
    private readonly feedbackRepo: FeedbackRepository,
    private readonly storage: AttachmentStorage,
  ) {}

  // Validates mime/size/count, uploads to Storage, appends key to feedback row.
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

### Repository addition (`FeedbackRepository` / `SupabaseDB`)

```ts
// Append a storage key to an existing feedback row's attachment_keys.
appendAttachmentKey(feedbackId: string, key: string): Promise<void>;
```

Implemented with a read-modify-write or `array_append` update on the `feedback` row via `service_role`.

### Route (extends existing feedback router)

```
POST /feedback/:id/attachments
  Auth: same middleware as POST /feedback (authenticated OR guest — guests can attach)
  Body: { image: string (base64), mimeType: string }   // dedicated bounded body parser
  201 → { attachmentId, key }
  400 → { error } for: unknown/non-image mime; decoded size > cap; count > max;
                       malformed base64; feedback id not found / not owned
  413 → oversized raw body rejected by the route's body-parser limit
```

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
- **When the feedback row is deleted** (existing admin `DELETE /feedback/:id`), its attachments must also be deleted (delete the `feedback-attachments/{id}/` prefix). This slice **should** wire that prefix-delete into the existing delete path since it is trivial and prevents orphaned PII; if it proves non-trivial it may be a fast follow, but the delete path must not silently leave orphans.
- **The 90-day sweep is a stated follow-up** (a scheduled job / cron using `removeByPrefix` over rows older than 90 days). Not built in this slice; the policy is decided here so slice 2/3 and ops can rely on it. `removeByPrefix` is included in the storage interface so the follow-up needs no interface change.

## Edge Cases

- **E1 — File too large.** Decoded byte length > `maxBytesPerFile` (5 MB) → 400 with a clear message. Independently, the route's body-parser `limit` (set slightly above 5 MB to allow base64's ~33% inflation, e.g. 7 MB) rejects an oversized raw body with 413 before decode, so a huge payload never buffers unbounded. The global `express.json()` limit is **not** changed.
- **E2 — Too many attachments.** Appending would make `attachment_keys.length > maxPerReport` (3) → 400, no upload performed.
- **E3 — Non-image / disallowed type.** `mimeType` not in `allowedMimeTypes` → 400. Client-declared type is not trusted alone (see E4).
- **E4 — Declared vs. actual type mismatch.** Sniff the decoded buffer's magic bytes and require it to match the declared image mime (a minimal signature check for PNG/JPEG/WebP/GIF; no full decode). Mismatch → 400. Prevents a client mislabeling a non-image as `image/png`.
- **E5 — Malformed base64.** Decode failure → 400 "Invalid image data".
- **E6 — Unknown / not-owned feedback id.** `:id` does not exist, or (for a non-admin) is not the caller's own feedback row → 404/403; no upload. Prevents attaching to someone else's report.
- **E7 — Storage upload fails after validation.** Do **not** append the key; surface 5xx; the feedback row simply has no attachment (feedback text already persisted, so the user's report is not lost). No partial/dangling key.
- **E8 — Key collision.** `attachmentId` is a UUID; collision is negligible. `upload` uses non-upsert mode so an accidental collision errors rather than overwriting.
- **E9 — Guest submitter.** Guests can submit feedback today; they can also attach. The route uses the same auth middleware; ownership check (E6) uses `feedback.user_id` which may be null for guests — a guest may attach only to a feedback row created in the same guest session flow (backend links by the just-returned id; no cross-user attach). Confirm the ownership rule for null-user rows during implementation; default to "the id must have been created by this request's principal or, for guests, match the session" — if that cannot be cleanly enforced, restrict guest attach and flag to Architect.
- **E10 — Empty image.** Zero-byte decoded buffer → 400.

## Dependencies

- **LLD 1 (Supabase Migration)** — migration + gate tooling, `service_role` client, RLS model (002/008/011 patterns). Direct upstream.
- **Existing feedback stack** — `feedback` table (001), `FeedbackService`, `SupabaseDB.createFeedback`, `POST /feedback` route (server.ts:136), `Feedback` entity.
- **Migration-safety harness** — `verify-drift.mjs` + `expected-diff.allowlist.json`, `verify-postconditions.mjs` + `postconditions/`, `verify-no-destructive-ddl.mjs` + `destructive-ddl.allowlist.json`, `prodShapedFixture` test helper.
- **`@supabase/supabase-js` `^2.107`** — Storage API (`.storage.from().upload/createSignedUrl/remove`) is available in this version.
- **No new npm dependency** required (base64 JSON transport; magic-byte sniff is a few bytes of comparison, no library).

### Migration-safety wiring (MUST all be done, or CI reddens)

1. Add `012_create_feedback_attachments_bucket.sql` and its `.postcondition.sql` (1:1 coverage enforced by `verify-postconditions.mjs`).
2. Add `"012_create_feedback_attachments_bucket.sql"` to `expected-diff.allowlist.json` `expectedPending` **and** to `scripts/fixtures/clean-diff.json` `pending` (and, if the diff engine attributes the `feedback.attachment_keys` add / bucket insert as observed drift on the run that applies it, add the corresponding `expectedFromPending`/`objects` entries) — else the gate fails "Stale/missing expectedPending". Follow the exact lockstep the file `$comment`s describe.
   - **Storage-schema caveat:** the drift gate diffs the `public` schema. The `ALTER TABLE feedback ADD COLUMN attachment_keys` is a `public`-schema change the gate **will** see and must account for. The `storage`-schema bucket/policy changes may be invisible to `supabase db diff` (storage is a managed schema); the **postcondition** is the authoritative check for those. The implementer must verify what the linked-diff adapter emits for this migration on a dry run and wire the allowlist/fixture to match (do not guess).
3. `destructive-ddl.allowlist.json`: no entry needed — `INSERT`, `CREATE POLICY`, and `ADD COLUMN IF NOT EXISTS` destroy no data. (If the delete-path prefix cleanup in §Retention is implemented with a `DELETE`, that lives in application code, not a migration, so the DDL gate is unaffected.)
4. Release order (DEVELOPMENT.md "Prod Migration Release"): `supabase db push` → `verify-postconditions.mjs` against prod (pooler, `PGSSLMODE=no-verify`) → then merge/deploy the backend code that reads/writes attachments. Schema leads code.

## Test Requirements

### Unit (no DB, no network) — `tests/service/feedbackAttachmentService.test.ts`

- Rejects mime not in `allowedMimeTypes` (E3); accepts each allowed type.
- Rejects decoded size > `maxBytesPerFile` (E1) and zero-byte (E10).
- Rejects when appending would exceed `maxPerReport` (E2).
- Rejects malformed base64 (E5) and declared/actual mime mismatch via magic-byte sniff (E4).
- On valid input: calls `storage.upload` with the expected `{feedbackId}/{uuid}.{ext}` key and appends exactly that key to the row (use an in-memory `AttachmentStorage` double + fake repo).
- On `storage.upload` rejection: does NOT append a key (E7).
- `getSignedUrl` delegates to the storage double with the expected TTL (default 60 s).

### Integration (local `supabase start`) — `tests/integration/feedbackAttachment.test.ts`

- **Acceptance-criteria round trip (no UI):** `POST /feedback` → `POST /feedback/:id/attachments` with a small real PNG buffer → 201; then via the service `getSignedUrl(key)` fetch the object and assert the bytes match. Confirms upload → link → signed read.
- Feedback row's `attachment_keys` contains the returned key; the `feedback` row stores **no** binary (assert column is the key string only).
- Rejections server-side: oversized (400/413), over-count (400), non-image (400), mismatched-magic-bytes (400).
- Guest can attach to their own feedback (E9); cannot attach to another principal's feedback id (E6 → 403/404).
- Signed URL is time-limited: after TTL the URL no longer authorizes the fetch (may be marked slow/optional if TTL waiting is impractical — prefer asserting a short TTL is passed to the SDK instead).

### Migration-safety — `tests/integration/migration-012.test.ts` (prod-shaped, name-agnostic)

> `prodShapedFixture` uses a throwaway `public`-like schema and cannot host the fixed `storage` schema. Split the assertions: run the `public`-schema part (`feedback.attachment_keys` add) through the fixture; run the `storage`-schema part (bucket + policies) against the **real local `supabase start` `storage` schema** (which has `storage.buckets`/`storage.objects`), cleaning up the test bucket in `finally`. State this split in the test header.

- After applying 012: bucket exists and `public = false` (**security assertion**).
- `anon` and `authenticated` cannot read or write an object in the bucket via the anon/auth key (deny-by-construction); `service_role` can (bypasses RLS). Mirror `rls.test.ts` "Security test" style.
- `feedback.attachment_keys` column exists, is an array, defaults to `{}`.
- Idempotency: applying 012 twice → exactly the intended bucket + policy set (no duplicate policy, no error) — the fresh-like idempotency assertion 011 uses.
- The **012 postcondition passes** on the applied schema and **RAISEs** when the bucket is public / missing or the deny policies are absent (postcondition has teeth), mirroring `migration-011.test.ts`.

### Gate wiring — `tests/scripts/drift-gate.test.ts` (extend)

- With 012 pending and correctly allowlisted (+ fixture updated), the gate passes; with 012 pending but missing from `expectedPending`, it fails "missing from expectedPending" (proves the lockstep is enforced).

### Explicitly not tested here

- No frontend/E2E (slice 2). No triage read route (slice 3). No malware scanning / image re-encode (out of scope).
