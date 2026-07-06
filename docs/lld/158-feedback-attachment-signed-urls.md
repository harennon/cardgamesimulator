# LLD 158: Expose feedback attachments as short-lived signed URLs in admin GET /feedback and the feedback CLI

Parent: #172 (Order 3 of 3 under epic #97). Order 1 of 2 within #172; the sibling sub-issue (the `triage-feedback` workflow schema change under `.claude/workflows/`) ships separately.

This is the final slice that closes the attachment feature loop end-to-end: a triager can now **see and open** the images a user attached. It builds directly on the read path shipped in LLD 153/#170 and does **not** add a new signing mechanism.

## Scope

**In scope:**

- In the admin `GET /feedback` handler (`src/backend/api/feedback/submitFeedback.ts`), resolve each entry's `attachmentKeys` into **short-lived signed read URLs** using the existing `FeedbackAttachmentService.getSignedUrl(key, ttl)` path, and return them in a new response field.
- Update `scripts/feedback.mjs` to print attachment link(s) per entry that has them, in **both** the default human-readable output and the `--json` output.
- Preserve byte-for-byte behavior on both surfaces for entries with zero attachments.

**Explicitly NOT in scope:**

- A dedicated in-app admin gallery UI (matches LLD 9's no-admin-UI precedent and #172's exclusion). The CLI + browser-openable URL is the whole triager surface.
- The `triage-feedback` workflow schema change (edits `.claude/workflows/`) — sibling sub-issue.
- Changing the retention policy, TTL default, bucket privacy, or any storage/migration behavior from LLD 153 (#170).
- Any change to the raw `attachmentKeys` link column, the upload path (#171), or `DELETE`/cleanup behavior.

## Approach

### Key decisions

1. **Reuse the existing signed-read path; do not build a new one.** The handler already constructs a `FeedbackAttachmentService` (`this.attachmentService`). This slice calls its existing `getSignedUrl(key, ttlSeconds)` (default 60 s), which delegates to `SupabaseAttachmentStorage.createSignedUrl`. No new service method, no new route, no new signing logic.

2. **Add a new `attachments` field to each GET entry; keep `attachmentKeys` unchanged in shape but do NOT emit raw keys as a browser-openable substitute.** Two options were considered:
   - **(A) Replace `attachmentKeys` with signed URLs in place** — reuses the existing field name, but the field's name now lies (it's URLs, not keys) and any consumer expecting bare keys breaks.
   - **(B, recommended) Keep `attachmentKeys` (bare keys) and add a parallel `attachments: string[]` of signed URLs.** The signed URL is derived, request-scoped, and short-lived; the key is the durable identifier. Keeping both is honest about what each is, and the CLI reads the openable `attachments` field. The bare key is not itself openable against the private bucket, so exposing it to an already-authenticated admin over the admin-only GET is not a privacy regression — but per the privacy requirement the CLI/UI must present the **signed URL**, never the raw key, as the thing to open.

   Recommend **(B)**. It is the minimal, non-breaking change and cleanly separates the durable key from the ephemeral openable URL. (If a reviewer prefers not to keep both, (A) is acceptable but requires renaming the field to `attachments` to avoid a misnamed field.)

3. **Resolve URLs server-side, concurrently, per request.** For each entry, map its `attachmentKeys` through `getSignedUrl` and `await Promise.all`. Signing is a fast local HMAC in the Supabase SDK (no network round-trip for `createSignedUrl` against Supabase Storage's signed-URL endpoint — but treat it as async I/O). Resolve all entries' keys concurrently so a triager listing N reports with attachments doesn't serialize N×M sign calls.

4. **TTL: use the service default (60 s), do not override.** LLD 153 §State Model fixed the read TTL default at 60 s and named it the retention-consistent short-lived value. A 60 s URL is long enough to open in a browser immediately after the CLI prints it, short enough to bound leakage. Do **not** lengthen it. If a triager needs to re-open later, they re-run the CLI (cheap, re-signs). This keeps the "never emit long-lived URLs" requirement true by construction — there is no code path that passes a large TTL.

5. **CLI renders from the response, adds no signing of its own.** `feedback.mjs` is a thin client: it prints whatever `attachments` the server returned. It never touches Supabase Storage or keys directly. `--json` output already prints the full row objects verbatim (`JSON.stringify(filtered, ...)`), so the new `attachments` field appears there automatically once the server emits it — the only `--json` change to verify is that no post-processing strips it. The human-readable branch gets an explicit per-entry render of links.

### Flow

```
CLI (feedback.mjs)          Backend GET /feedback (admin)         FeedbackAttachmentService / Storage
  GET /feedback ──────────► admin check (FEEDBACK_ADMIN_IDS)
                            getAllFeedback() ──────────────────► SELECT feedback (service_role)
                            for each entry, for each key:
                              getSignedUrl(key, 60) ───────────► createSignedUrl(key, 60s) [private bucket]
                            entry.attachments = [signedUrl, ...]
                         ◄─ 200 [{ ...entry, attachmentKeys, attachments }]
  render:
    --json  → prints row verbatim (attachments included)
    default → prints "attachment: <url>" line(s) per entry with attachments;
              entries with none print exactly as today
```

## Interfaces / Types

### Handler (`src/backend/api/feedback/submitFeedback.ts`, `FeedbackHandler.get`)

The existing `get` maps each `f` to a response entry with `attachmentKeys: f.attachmentKeys`. Add resolution of signed URLs:

```ts
// Per entry (conceptual — resolve all entries concurrently):
const attachments = await Promise.all(
  f.attachmentKeys.map((key) => this.attachmentService.getSignedUrl(key)),
);
// entry becomes: { id, category, description, metadata, userId, createdAt,
//                  attachmentKeys: f.attachmentKeys, attachments }
```

- `attachments` is `string[]` of short-lived signed URLs, index-aligned with `attachmentKeys`.
- An entry with `attachmentKeys: []` yields `attachments: []` (empty array preserved — no `undefined`, no key iteration, no sign call).
- Resolution happens inside the existing admin-gated `get`; no signing occurs for non-admin callers (they still get 403 before any storage access).

### Shared model (`src/shared/model.ts`)

There is no existing typed shape for the admin `GET /feedback` response (the handler returns an inline object literal). Add one so the new field is typed and the CLI contract is documented:

```ts
export interface AdminFeedbackEntry {
  id: string;
  category: FeedbackCategory;
  description: string;
  metadata: FeedbackMetadata | null;
  userId: string | null;
  createdAt: string; // ISO 8601
  attachmentKeys: string[]; // durable storage keys (not browser-openable)
  attachments: string[]; // short-lived signed read URLs, index-aligned with attachmentKeys
}
```

Type the handler's `response` as `Response<AdminFeedbackEntry[] | { error: string }>`. `FeedbackMetadata` is currently defined in the `Feedback` entity; if it is not exported from `@shared/model`, either export a shared copy or type `metadata` as the existing shared metadata type used elsewhere — do not introduce a divergent duplicate. (Implementer: confirm where `FeedbackMetadata` lives before importing; keep one source of truth.)

### CLI (`scripts/feedback.mjs`)

- **`--json` branch:** unchanged code path — `JSON.stringify(filtered, null, 2)` already serializes the full row including the new `attachments` field. Verify nothing filters it out.
- **Default human-readable branch:** after the existing `route/user/id` line, if `row.attachments?.length` print one line per URL, e.g.:

  ```
    attachment: <signed-url>
  ```

  For entries with no attachments (`attachments` absent or empty), print nothing extra — output is identical to today.

## State Model

- **No new persisted state.** Nothing is written by this slice.
- **Signed URLs are transient, request-scoped, and short-lived (60 s).** Generated on each `GET /feedback`, never stored, never cached. Each CLI run re-signs.
- **`attachmentKeys` (durable) vs. `attachments` (ephemeral):** the key is the identity persisted in Postgres (LLD 153); the signed URL is a derived, expiring accessor to the private-bucket object. The private bucket (LLD 153 decision 2) means neither the key nor an expired URL is openable — only a live signed URL within its TTL.

## Edge Cases

- **E1 — Entry with zero attachments.** `attachmentKeys` empty → `attachments: []`, no `getSignedUrl` call. CLI prints exactly as today on both surfaces. (Acceptance criterion: byte-for-byte unchanged.)
- **E2 — Entry with 1–3 attachments.** Each key resolved to a signed URL; `attachments` index-aligned with `attachmentKeys`. CLI prints one link line per URL (default) / includes the array (`--json`).
- **E3 — `getSignedUrl` throws for one key** (e.g., object missing after a partial delete, or a Storage transient error). `createSignedUrl` throws on SDK error. Two options:
  - **(recommended) Fail the whole GET with the thrown 5xx.** Simplest, matches the existing handler (no per-key try/catch today); the triager retries. A missing object is an anomaly worth surfacing, not silently hiding.
  - Alternatively, resolve failures to a sentinel (e.g., `null`) per key so one bad object doesn't blank the whole list. Only adopt if operational experience shows orphaned keys are common; not warranted now (YAGNI). Document the choice; recommend the first.
- **E4 — Non-admin caller.** Unchanged: 403 before `getAllFeedback` and before any signing. No signed URL is ever produced for a non-admin.
- **E5 — Large backlog (many entries × keys).** Resolve concurrently (`Promise.all` across all keys of all entries) so latency stays ~one sign-batch, not N×M serial. Keys per report are capped at 3 (LLD 153 `maxPerReport`), so total sign calls are bounded and small.
- **E6 — Old rows created before the attachments column existed.** `attachmentKeys` defaults to `[]` (migration 013 `NOT NULL DEFAULT '{}'`) and `mapFeedback` coalesces null → `[]`; these behave as E1.
- **E7 — CLI run against a backend that predates this change** (field absent). `row.attachments?.length` is falsy → default branch prints nothing extra; `--json` prints whatever the server sent. No crash. (Not a supported cross-version scenario, but the optional-chaining guard makes it safe.)

## Dependencies

- **LLD 153 / #170 (Attachment Storage Foundation)** — direct upstream. Provides `FeedbackAttachmentService.getSignedUrl(key, ttl = 60)`, `SupabaseAttachmentStorage.createSignedUrl`, the private `feedback-attachments` bucket, `Feedback.attachmentKeys`, and `feedbackRepo.getAllFeedback()` returning rows with `attachmentKeys`. **Must be merged/deployed first** (it is: PR #180 / migration 013). No new migration, no schema change in this slice.
- **LLD 9 (Feedback Widget)** — the admin `GET /feedback` handler, `FEEDBACK_ADMIN_IDS` gating, and `scripts/feedback.mjs`. This slice extends both.
- **#171 (upload UX)** — merged; means real attachments exist to render (not a code dependency).
- **No new npm dependencies.** No new env vars.

## Test Requirements

### Unit — `tests/api/feedback` (or extend existing feedback handler tests)

Test the GET response mapping in isolation using a fake `FeedbackAttachmentService` (or a stubbed `getSignedUrl`) and a fake repo returning constructed `Feedback` rows — no DB, no network (testing-principles §1, §3, self-contained):

- **Entry with attachments:** row with `attachmentKeys: ["k1","k2"]` → response entry has `attachments` of length 2, each the (fake) signed URL, index-aligned with `attachmentKeys`; `getSignedUrl` called once per key.
- **Entry with none:** row with `attachmentKeys: []` → `attachments: []`; `getSignedUrl` never called.
- **Default TTL:** assert `getSignedUrl` is invoked with no explicit TTL (relies on the 60 s service default) — proves no long-lived URL path exists (privacy requirement).
- **Signed, not raw:** assert the emitted `attachments` values are the signed-URL form from the double, and that the raw storage key is **not** placed in `attachments`.

### Integration (local `supabase start`) — extend `tests/integration/feedback.test.ts`

- **Round trip:** `POST /feedback` → `POST /feedback/:id/attachments` (small real PNG) → admin `GET /feedback` returns that entry with a non-empty `attachments[0]` that is a signed URL, and fetching it returns the uploaded bytes (proves it is genuinely openable). Assert `attachmentKeys` is still present and holds the bare key.
- **No-attachment entry unchanged:** an entry created without attachments returns `attachments: []` and is otherwise identical to the pre-change response shape (assert the other fields are unchanged; assert no raw key leaks into `attachments`).
- **Admin gating unchanged:** non-admin → 403 (no signing), unauth → 401 (existing tests still pass).
- **Short-lived:** prefer asserting the TTL passed to the SDK is the 60 s default over waiting for expiry (mirrors LLD 153's signed-URL test approach). Optionally assert a signed URL carries an expiry query param.

### CLI rendering

Bias to automated where cheap; a small unit test over the render logic is preferred to a manual step (testing-principles §decision-heuristics).

- If `feedback.mjs`'s human-readable rendering is extracted into a testable pure function (recommended — a `formatEntry(row)`/`renderRows(rows)` that returns a string), unit-test: an entry **with** `attachments` includes an `attachment: <url>` line per URL; an entry **without** produces output byte-for-byte identical to today. Also assert `--json` output includes `attachments` for entries that have them.
- If extraction is deemed out of proportion for a script, a single manual check is acceptable: run `node scripts/feedback.mjs` and `--json` against a backend with one attachment-bearing and one attachment-free entry, confirm links render for the former and the latter is unchanged. Prefer the automated route.

### Explicitly not tested here

- No frontend/E2E (no in-app admin UI in scope). No re-test of upload/delete/migration paths (LLD 153 owns those). No `triage-feedback` workflow tests (sibling sub-issue).
