# LLD 157: Expose feedback attachments as short-lived signed URLs in admin `GET /feedback` and the feedback CLI

Parent: #172 (Order 3 of 3 under epic #97). This slice is **Order 1 of 2** under #172; the sibling sub-issue (the `triage-feedback` workflow schema change under `.claude/workflows/`) ships separately and is **out of scope here**.

This slice closes the user-visible loop: a triager can see and open the images a user attached, via the two read surfaces that live in application code — the admin `GET /feedback` handler and `scripts/feedback.mjs`.

## Scope

**In scope (two read surfaces only):**

- Admin `GET /feedback` (`src/backend/api/feedback/submitFeedback.ts`, `FeedbackHandler.get`): resolve each entry's `attachmentKeys` into **short-lived signed read URLs** via the existing `FeedbackAttachmentService.getSignedUrl(key, ttlSeconds)` path, and include them in the response so a triager can open the image directly in a browser.
- `scripts/feedback.mjs`: print attachment link(s) for entries that have them, in **both** the default human-readable output **and** the `--json` output. Entries with no attachments print exactly as today.

**Explicitly NOT in scope:**

- A dedicated in-app admin gallery UI (matches LLD 9's "no admin UI in v1" precedent and #172's exclusion). No frontend/Vue code.
- The `triage-feedback` workflow schema change (`.claude/workflows/triage-feedback.js`) — deliberately carved out as the sibling sub-issue. **Do not touch that file.**
- Any new signed-read code path or storage call — reuse the existing `getSignedUrl` (#170/PR #182, merged).
- Any new REST route (no `GET /feedback/:id/attachments/:key` route; the admin list already carries the URLs).
- The 90-day retention sweep (LLD 153 follow-up).

## Approach

### Key decisions

1. **Sign at read time in the `GET /feedback` handler; do not persist URLs.** Signed URLs are ephemeral by design (§Privacy). The handler already reads each row's `attachmentKeys` and returns them (line ~78). We add a resolution step that maps each key to a signed URL via `attachmentService.getSignedUrl(key)`. The service and storage abstraction (`createSignedUrl`) already exist — this slice adds **no** new signing primitive, only a caller.

2. **Augment, do not silently replace, on the wire — but never emit the raw key as an openable substitute.** The current response field is `attachmentKeys: string[]` (bare storage paths). A bare key is **not** openable (private bucket), so returning it alone is dead weight and — per the hard privacy requirement — must never be presented as the thing a triager clicks. Decision: **replace** `attachmentKeys` with a new field `attachments: AttachmentLink[]`, where each element carries the signed `url` (and the `key` for reference/debugging only, never as a fallback link). Rationale: there is no existing frontend or external consumer of `attachmentKeys` (verified: no references in `src/frontend`, no shared response type — the shape is an inline object literal in the handler and the only consumer is `scripts/feedback.mjs`, updated in this same slice). Replacing avoids shipping an unusable field. Entries with zero attachments get `attachments: []`.

   > Alternative considered: keep `attachmentKeys` and add `attachmentUrls: string[]` alongside. Rejected — it leaves the unusable raw-key field on the wire (privacy noise) and there is no consumer that needs it. If a future need for the raw key arises, `AttachmentLink.key` already carries it in a clearly non-clickable position.

3. **Default TTL (60 s) from `getSignedUrl`.** `FeedbackAttachmentService.getSignedUrl(key, ttlSeconds = 60)` already defaults to 60 s, consistent with LLD 153's retention/short-lived decision. The handler calls `getSignedUrl(key)` with **no explicit TTL** so it inherits that default; if the click-through window proves too tight in practice, raising it is a one-argument change localized to the handler (still short-lived — target ≤ a few minutes, never hours/permanent). **Never** emit a public URL or a long-lived URL.

4. **Per-entry parallel signing; keep it simple for v1.** Resolving N keys for one entry issues N `createSignedUrl` calls, and there are M entries → up to M×N calls per `GET /feedback`. Feedback volume is small (LLD 9: < 20 playtesters, cap of 3 attachments/report). Keep v1 simple but avoid an obvious serial hotspot: sign the keys **within a single entry in parallel** (`Promise.all` over that entry's `attachmentKeys`). Entries themselves are also mapped with a single `Promise.all` over the list. No batching/caching/pagination — YAGNI at this scale (architecture-principles §10). Most entries have **zero** attachments, so `Promise.all([])` resolves immediately and adds no latency.

5. **Signing failure: omit the failed link, never leak the key, never fail the whole list.** If `getSignedUrl` throws for a given key (e.g., object was swept/deleted, transient Storage error), that key is **omitted** from the entry's `attachments` array (it is not emitted as a raw-key "fallback"). The rest of the entry's links and all other entries are unaffected — one dead object must not blank the triager's entire queue. The failure is logged server-side (`console.warn` with the key and error, matching the codebase's existing logging style) so it is diagnosable. Net: `attachments.length` may be **less than** `attachmentKeys.length` when some objects are unreachable; that is the intended, privacy-safe degradation. (This is a deliberate divergence from `getSignedUrl`'s throw-on-error contract: the handler catches per key rather than propagating.)

6. **CLI renders whatever the API returns; it does no signing.** `scripts/feedback.mjs` is a thin admin client over `GET /feedback`. It receives `attachments` already-signed from the API and just prints `entry.attachments[].url`. `--json` output is the API response verbatim (already true today — it prints `filtered` as-is), so the new `attachments` field flows through automatically; the only CLI change needed for `--json` is that it now naturally includes the field (no code change beyond the shape coming from the server). The **default human-readable** branch is updated to print the link(s).

### Flow

```
scripts/feedback.mjs ──► GET /feedback (admin, Bearer token)
                                 │
FeedbackHandler.get:             │
  admin check (unchanged) ───────┤ non-admin → 403 (unchanged)
  getAllFeedback() ──────────────┤
  for each row (Promise.all):    │
    urls = Promise.all(          │
      row.attachmentKeys.map(k =>│
        attachmentService          ──► getSignedUrl(k)  ──► storage.createSignedUrl(k, 60)
          .getSignedUrl(k)         ◄── signed url  |  throws → omit + console.warn
      ))                         │
    → { …fields, attachments }   │
  200 [ …entries ]  ◄────────────┘

CLI:
  --json  → prints API response verbatim (attachments included automatically)
  default → prints each entry; if entry.attachments.length > 0, prints link line(s)
```

## Interfaces / Types

### Shared model addition (`src/shared/model.ts`)

A typed response for the admin list (today it is an untyped inline object literal). Adding the type documents the wire shape for the CLI and any future consumer.

```ts
export interface AttachmentLink {
  key: string; // storage path — for reference/debugging ONLY, never an openable substitute
  url: string; // short-lived signed read URL (default TTL 60s)
}

export interface AdminFeedbackEntry {
  id: string;
  category: FeedbackCategory;
  description: string;
  metadata: unknown; // FeedbackMetadata | null; kept loose to match existing handler shape
  userId: string | null;
  createdAt: string; // ISO 8601
  attachments: AttachmentLink[]; // REPLACES the former `attachmentKeys` field; [] when none
}
```

> `AdminFeedbackEntry` is a shared type only if convenient; the handler MAY return the shape inline (as today) as long as it matches this contract. The `attachments` field replacing `attachmentKeys` is the binding change.

### Handler change (`FeedbackHandler.get`, `src/backend/api/feedback/submitFeedback.ts` ~lines 69–80)

Replace the synchronous `feedback.map(...)` returning `attachmentKeys: f.attachmentKeys` with an async resolution:

```ts
const entries = await Promise.all(
  feedback.map(async (f) => ({
    id: f.id,
    category: f.category,
    description: f.description,
    metadata: f.metadata,
    userId: f.userId,
    createdAt: f.createdAt.toISOString(),
    attachments: await this.resolveAttachments(f.attachmentKeys),
  })),
);
response.status(200).json(entries);
```

New private helper on `FeedbackHandler` (signs one entry's keys in parallel; omits failures):

```ts
private async resolveAttachments(keys: string[]): Promise<AttachmentLink[]> {
  // keys is [] for the vast majority of entries → resolves immediately.
  const results = await Promise.all(
    keys.map(async (key) => {
      try {
        return { key, url: await this.attachmentService.getSignedUrl(key) };
      } catch (err) {
        console.warn(`Failed to sign attachment key ${key}:`, err);
        return null; // omit — never leak the raw key as a substitute link
      }
    }),
  );
  return results.filter((r): r is AttachmentLink => r !== null);
}
```

`this.attachmentService` already exists on `FeedbackHandler` (constructed in the ctor, lines 42–48). No new wiring.

### CLI change (`scripts/feedback.mjs`)

- **`--json` branch (line ~86–89):** no code change — it already prints `filtered` verbatim, so the new `attachments` field is emitted automatically. (Call this out in the test: assert the JSON contains `attachments`.)
- **Default human-readable branch (line ~93–103):** after the existing `route/user/id` line, if `row.attachments?.length` add link line(s), e.g.:

```
  attachments (N):
    <signed-url-1>
    <signed-url-2>
```

Print nothing extra when `row.attachments` is empty or absent (defensive optional chaining: an older/other API shape without the field renders exactly as today).

## State Model

- **Nothing new is persisted.** Signed URLs are generated per request and never stored. Postgres still holds only `attachment_keys TEXT[]` (from LLD 153, unchanged).
- **Transient:** the signed URL exists only in the `GET /feedback` response body and the CLI's stdout. TTL is enforced by Supabase Storage (default 60 s); after expiry the URL 4xxs and the triager re-runs the query to get fresh links.
- **Access remains server-only:** the bucket is private (LLD 153); the backend `service_role` signs the URL; the admin auth check on `GET /feedback` (unchanged) gates who can obtain URLs at all.

## Edge Cases

- **E1 — Entry with zero attachments.** `attachmentKeys = []` → `resolveAttachments([])` returns `[]` immediately (no signing calls). CLI prints the entry exactly as today. **Acceptance criterion: byte-for-byte unaffected on both surfaces.**
- **E2 — Entry with one or more attachments.** Each key resolved to a signed `url`; response `attachments` has one element per successfully-signed key; CLI prints a link line per URL.
- **E3 — Signing fails for one key (object swept, deleted, or transient Storage error).** That key is **omitted** from `attachments` (not emitted as a raw key); other keys/entries unaffected; a `console.warn` is logged. `attachments.length < attachmentKeys.length` in this case.
- **E4 — All keys for an entry fail to sign.** `attachments = []` for that entry; the entry still appears in the list with its text/metadata. `GET /feedback` still returns 200.
- **E5 — Large list / many attachments.** M×N signing calls; acceptable at current volume (§Approach #4). No pagination. If volume grows this is the first thing to revisit — noted, not built.
- **E6 — Non-admin caller.** Unchanged: `GET /feedback` returns 403 before any signing occurs (admin check runs first, lines 63–67).
- **E7 — Legacy row where `attachmentKeys` is null/undefined.** LLD 153's column is `NOT NULL DEFAULT '{}'`, so the array is always present. Defensive: `resolveAttachments(keys ?? [])` treats a missing array as empty (belt-and-suspenders; no expected occurrence).
- **E8 — CLI receives an API response without `attachments` (version skew).** `row.attachments?.length` optional-chaining → prints entry as today; no crash.

## Dependencies

- **LLD 153 / #170 (merged, PR #182)** — provides `feedback.attachment_keys`, `FeedbackAttachmentService.getSignedUrl(key, ttlSeconds = 60)`, `SupabaseAttachmentStorage.createSignedUrl`, the private bucket, and `FeedbackHandler.attachmentService`. This slice only adds a caller. Direct upstream.
- **#171 (merged)** — upload UX; means real attachments now exist to render (not a code dependency, a "there is data to show" dependency).
- **LLD 9 (Feedback Widget)** — the admin `GET /feedback` handler and `scripts/feedback.mjs` CLI this slice edits.
- **No new npm dependency, no migration, no migration-safety wiring** (no schema change).

## Test Requirements

### Unit (no DB, no network) — extend `tests/service/feedbackAttachmentService.test.ts` and/or a new `tests/api/feedbackHandlerGet.test.ts`

Test the resolution logic with an in-memory `AttachmentStorage` double + fake `FeedbackRepository` (same doubles LLD 153's unit tests already use):

- **Entry with attachments:** row with 2 keys → response entry has `attachments` of length 2, each with a `url` produced by `getSignedUrl` and the matching `key`. Assert the URL is the signed value the storage double returns (proves it's the signed path, not the raw key).
- **Entry with none:** row with `attachmentKeys = []` → `attachments = []`; assert `getSignedUrl`/`createSignedUrl` was **not** called; assert all other fields (`id`, `category`, `description`, `metadata`, `userId`, `createdAt`) are unchanged vs. the row.
- **Signing failure (E3):** storage double throws for one of two keys → resulting `attachments` has length 1 (the good one), the failed key is **absent**, and the raw failed key never appears as a `url`. Assert a warning was logged (spy on `console.warn`) and the handler still resolves (no throw).
- **Parallelism/no-leak invariant:** across a mixed list (one entry with keys, one without), the empty entry issues zero signing calls and the non-empty entry issues exactly `keys.length` calls.
- **TTL:** assert `getSignedUrl` is invoked such that the resulting TTL is the short-lived default (60 s) — i.e., the handler passes no explicit long TTL. (Spy on the service or storage double and assert the ttl argument, or assert `getSignedUrl` called with a single arg.)

### Integration (local `supabase start`) — extend `tests/integration/feedback.test.ts`

- **Admin `GET /feedback` with an attached entry:** `POST /feedback` → `POST /feedback/:id/attachments` (small real PNG, reuse the `pngBase64()` helper from `feedbackAttachment.test.ts`) → `GET /feedback` as admin → the entry's `attachments[0].url` matches `^https?://` and is **fetchable** (`fetch(url).ok === true`), proving it's a real signed URL, not a raw key. Assert the URL is **not** equal to the bare storage key.
- **Admin `GET /feedback` with a no-attachment entry:** the entry has `attachments: []` and does not carry an `attachmentKeys` field (the field was replaced). Confirms zero-attachment entries are unaffected apart from the empty array.
- **Short-lived TTL:** prefer asserting the response URL contains Supabase's signed-URL token/expiry query params over waiting for expiry (do not sleep 60 s in CI). Optionally assert no public-object URL form is emitted.
- **Non-admin unchanged:** `GET /feedback` still 403 for non-admin (regression guard that the async change didn't alter auth ordering).

### CLI rendering — `tests/scripts/feedbackCli.test.ts` (new; unit-style, no network)

The CLI's fetch/auth is environment-coupled, so test the **rendering** by extracting or exercising the print logic against a stubbed API response (two entries: one with `attachments`, one with `[]`). If the render logic is not easily importable, refactor the print loop into a small exported pure function `renderFeedback(rows, { json }) -> string` in the script (or a sibling module) and test that:

- **Default output, entry with attachments:** output contains each signed `url` on its own line under an "attachments" label.
- **Default output, entry without attachments:** output for that entry is identical to the pre-slice format (no attachment lines). Snapshot or exact-string assert.
- **`--json` output:** the emitted JSON includes the `attachments` array for the attached entry and `[]` for the other; byte-shape matches the API response passed in.

### Explicitly not tested here

- No frontend/E2E (no UI in this slice).
- No `.claude/workflows/` changes (sibling sub-issue).
- No re-test of the signing primitive itself (covered by LLD 153's tests).
