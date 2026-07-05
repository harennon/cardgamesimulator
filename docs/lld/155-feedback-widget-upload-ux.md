# LLD 155: FeedbackWidget Upload UX — File Picker, Drop Zone, Clipboard Paste, and Client-Side Downscale

Parent: #97 (slice 2 of 3). Depends on the storage foundation (slice 1 / LLD 153, merged as commit `42e1185`, migration 013). This is a **frontend-only** slice: it wires image attachments into the existing Send Feedback modal and uploads them through the already-shipped backend path. It touches **no** schema and **no** backend upload code.

> **Mockup is approved — do not re-run the mockup gate.** The visual source of truth is `feedback-widget-upload-ux.html` (LLD 151) plus the owner's `Frontend decision: proceed` on issue #171. This LLD is written to match that mockup.

## Scope

**In scope (frontend only):**

- Add an **attachment block** to `src/frontend/component/FeedbackWidget.vue`, between Description and the action buttons, matching the approved mockup.
- **Three entry points, one pipeline:** file picker (click zone → native dialog), drag-and-drop onto the modal, and clipboard paste (`Ctrl+V`, the primary "screenshot → paste" flow). The paste hint is always visible.
- **Thumbnail previews** with a per-thumb remove control; a `count / max` header.
- **Client-side downscale** before upload: longest edge capped at **1600 px**, re-encoded at **JPEG quality 0.8** via an offscreen `<canvas>`.
- **Deferred upload:** attachments are held in memory until Submit. On Submit the modal POSTs the feedback row (unchanged path), then uploads each downscaled blob to the slice-1 endpoint, linking to the returned feedback `id`.
- **Client-side max-count guard** (max 3) for UX only; the server remains authoritative.
- **Upload states:** `queued → uploading → done | error` per file, with spinner + progress bar (uploading), green check (done), and inline error (rejection/failure). All errors preserve the typed description and other thumbnails.
- **Extract the pipeline into a testable module** (`useFeedbackAttachments` composable) so the validation / downscale / base64 / upload logic is unit-testable in the project's node test environment (no jsdom, no `@vue/test-utils`).

**Explicitly NOT in scope:**

- The auto-capture-a-screenshot-of-this-page button (deferred).
- Triage-side rendering of attachments (slice 3 / #172 — `blocked:human` on the `.claude/` write gate).
- Any change to the backend upload path, storage service, RLS, migration, or shared request/response types (all shipped in LLD 153).
- Raising the global `express.json()` limit or the attachment route's body-parser limit (backend concern, already set).

## Approach

### Key decisions

1. **Backend contract is fixed — call it, don't reshape it.** Verified against the merged code (`src/backend/api/feedback/submitFeedback.ts`, `src/shared/model.ts`):
   - `POST /api/feedback` (existing) → `201 { id, createdAt }`.
   - `POST /api/feedback/:id/attachments`, body `SubmitAttachmentRequest = { image: string /* base64, no data-URI prefix */, mimeType: string }` → `201 SubmitAttachmentResponse = { attachmentId, key }`.
   - Server caps: `maxPerReport = 3`, `allowedMimeTypes = ["image/png","image/jpeg","image/webp"]`, `maxBytesPerFile = 5 MB` (decoded). Errors: `400` (bad type/size/count/data), `403` (not owner), `404` (unknown id), `413` (raw body too large).
   - Auth is automatic: the existing axios request interceptor (`src/frontend/service/http.ts`) attaches the bearer token, so ownership resolves to the current guest/registered principal with no extra work.
   - The frontend **mirrors** these caps (`FEEDBACK_ATTACHMENT_LIMITS` below) for UX, but treats every server response as authoritative — a client-passed file that slips through still gets a server 4xx surfaced inline.

2. **Two-phase submit: create the row, then upload attachments.** The row is POSTed first (unchanged). Only on success do we upload each queued attachment to `/:id/attachments`. This matches the merged two-step design and keeps a description-only submit **byte-for-byte identical to today** (the attachment loop is skipped when the queue is empty).

3. **Deferred, per-file upload (not upload-on-add).** Files are validated + downscaled on add (fast, local) but uploaded only on Submit, sequentially. Rationale: (a) the endpoint is **non-idempotent** — LLD 153 E12 warns against blind retry, so we upload once per Submit and never auto-retry; (b) the user can remove a queued file before it ever hits the network; (c) a description-only report never touches Storage.

4. **Downscale always runs, even for already-small images.** The canvas re-encode to JPEG@0.8 both caps dimensions and strips the original container/EXIF (privacy-adjacent, and shrinks payloads). If the source is smaller than 1600 px on its longest edge we still re-encode at scale 1.0 (no upsampling). Output mime is **always `image/jpeg`** post-downscale, so the uploaded `mimeType` is `"image/jpeg"` regardless of input type — this is within the server's allowed set and simplifies the magic-byte contract. (Transparency loss on PNGs is acceptable for screenshot feedback; noted in Edge Cases.)

5. **Extract the pipeline into `useFeedbackAttachments` composable.** The project's frontend tests run in a **node environment with no jsdom and no `@vue/test-utils`** (see `vitest.config.ts` and `feedbackBuildMetadata.test.ts`). Pure DOM-free logic (validation, base64 conversion, the upload sequencer, state transitions) lives in the composable and is unit-tested directly. The canvas downscale is **injected** as a function so tests can substitute a deterministic stub (the real canvas path needs a browser and is covered by manual verification, per testing-principles §5/§10 bias-against-manual only where DOM is unavoidable). The `.vue` file stays a thin renderer wiring events → composable → template.

6. **`accept` on the file input + client type check are UX filters, not security.** The `<input accept>` and the `allowedMimeTypes` check reject obvious non-images before downscale. Security is the server's job (magic-byte sniff on the decoded buffer). We don't re-implement magic-byte sniffing client-side.

### Pipeline (all three entry points converge)

```
picker / drop / paste → File[]
   → for each file (stop at max-count):
        validate mime ∈ allowed        (else inline error, skip file)
        downscale(file)                 (canvas: cap 1600px longest edge, JPEG@0.8)
           → Blob | null (decode fail → inline error, skip file)
        push AttachmentItem { id, name, previewUrl(objectURL), blob,
                              origBytes, scaledBytes, status: "queued" }
   → render thumbnails + count + downscale meta

Submit:
   POST /api/feedback  → { id }         (existing; on failure → form error, keep everything)
   for each queued item, sequentially:
        item.status = "uploading"
        base64 = await blobToBase64(item.blob)
        POST /api/feedback/{id}/attachments { image: base64, mimeType: "image/jpeg" }
           201 → item.status = "done"
           4xx/5xx/network → item.status = "error", item.error = message (keep thumbnail)
   if all queued items are "done" → close modal + success toast
   else → keep modal open, description + failed thumbnails intact, allow re-Submit of only the failed/queued items
```

## Interfaces / Types

### New composable `src/frontend/composables/useFeedbackAttachments.ts`

```ts
export const FEEDBACK_ATTACHMENT_LIMITS = {
  maxCount: 3,
  maxEdgePx: 1600,
  jpegQuality: 0.8,
  // Mirrors the server (LLD 153) — UX pre-filter only; server is authoritative.
  allowedInputMimeTypes: ["image/png", "image/jpeg", "image/webp"],
  outputMimeType: "image/jpeg", // everything is re-encoded to JPEG post-downscale
} as const;

export type AttachmentStatus = "queued" | "uploading" | "done" | "error";

export interface AttachmentItem {
  id: string;            // client-side uuid (crypto.randomUUID)
  name: string;          // source filename ("pasted-image.png" for clipboard)
  previewUrl: string;    // object URL of the downscaled blob (revoked on remove/close)
  blob: Blob;            // downscaled JPEG bytes to upload
  origBytes: number;     // source File.size (for the "X → Y" downscale meta)
  scaledBytes: number;   // downscaled blob.size
  status: AttachmentStatus;
  error?: string;        // inline per-thumb message when status === "error"
}

// Injected so tests can stub the canvas path (see Test Requirements).
export type Downscaler = (file: File) => Promise<Blob | null>;

export interface UseFeedbackAttachments {
  items: Ref<readonly AttachmentItem[]>;
  count: ComputedRef<number>;
  isFull: ComputedRef<boolean>;                 // count >= maxCount
  lastError: Ref<string>;                       // transient attach-level rejection message
  totalOrigBytes: ComputedRef<number>;          // for the downscale meta line
  totalScaledBytes: ComputedRef<number>;

  addFiles(files: FileList | File[]): Promise<void>; // validate → downscale → push (respects max)
  remove(id: string): void;                     // revokes objectURL, splices
  clear(): void;                                 // revoke all + reset (on modal close / after success)
  hasQueued: ComputedRef<boolean>;

  // Uploads every queued|error item for the given feedback id, sequentially.
  // Returns true iff all attempted uploads reached "done".
  uploadAll(feedbackId: string): Promise<boolean>;
}

export function useFeedbackAttachments(deps?: {
  downscale?: Downscaler;                       // defaults to the canvas implementation
  uploadOne?: (feedbackId: string, item: AttachmentItem) => Promise<void>; // defaults to axios POST
}): UseFeedbackAttachments;
```

### Helper functions (exported for unit tests, DOM-free)

```ts
// Validation: returns null if acceptable, else a user-facing message.
export function rejectReason(
  file: { type: string; name: string },
  currentCount: number,
): string | null;
// - count >= maxCount → "You can attach at most 3 images."
// - type ∉ allowedInputMimeTypes → "{name} — only PNG, JPG and WebP images can be attached."

// Blob → base64 string WITHOUT the "data:...;base64," prefix (server wants raw base64).
export function blobToBase64(blob: Blob): Promise<string>;

// Maps an upload failure (axios error / status) to a per-thumb message.
export function uploadErrorMessage(err: unknown): string;
// - 413 or oversize 400 → "Image is too large — try a smaller screenshot."
// - other 4xx → server-provided message if present, else "This image was rejected."
// - network / 5xx → "Upload failed — check your connection and retry."
```

### Canvas downscaler (default `Downscaler`, DOM-dependent — thin, not unit-tested)

```ts
// Draws the source image onto an offscreen <canvas> scaled so the longest edge
// is <= maxEdgePx (never upscales), then toBlob("image/jpeg", 0.8).
// Resolves null if the image cannot be decoded (E: corrupt/undecodable file).
async function canvasDownscale(file: File): Promise<Blob | null>;
```

### `FeedbackWidget.vue` — new reactive state and template additions

- Instantiate `const attach = useFeedbackAttachments();` in `<script setup>`.
- Template block (mirrors mockup markup/classes): `.attach` section with `.attach__head` (label + `{{ attach.count }} / {{ maxCount }}` counter, `is-max` when full), `.thumbs` (v-for over `attach.items`, each `.thumb` with `<img :src="item.previewUrl">`, `.thumb__remove` button, and status-conditional overlays: `.thumb__overlay--uploading` + `.spinner` + `.thumb__bar`, `.thumb__check`, `.thumb__overlay--error` with a Retry affordance), `.attach__meta` downscale line (shown when any item has `scaledBytes`), `.dropzone` (`is-dragover` / `is-disabled` classes), a hidden `<input type="file" accept="image/png,image/jpeg,image/webp" multiple>`, and `.attach__error` transient rejection banner bound to `attach.lastError`.
- Add `data-testid` hooks for QA/e2e later: `feedback-dropzone`, `feedback-file-input`, `feedback-thumb`, `feedback-thumb-remove`, `feedback-attach-error`.
- **No changes** to `SubmitFeedbackRequest`, `SubmitAttachmentRequest`, or the metadata/category/description fields.

## State Model

- **All attachment state is in-memory and transient**, scoped to one open-modal session. Nothing is persisted client-side. The `AttachmentItem[]` lives in the composable's reactive `items` ref.
- **Object URLs** (`previewUrl`) are created per item and **revoked** on `remove`, on `clear` (modal close / cancel / after successful submit), to avoid leaks.
- **Downscaled blobs** are held in memory until upload; discarded when the modal closes.
- **Upload state machine per item:** `queued → uploading → (done | error)`. `error` items can transition back to `uploading` on Submit/Retry. `done` items are never re-uploaded.
- **Server is the source of truth** for whether an attachment was accepted; the client `done` state is set only on a `201`.
- **Description text is never derived from attachment state** — it lives in the existing `description` ref and is only cleared by `closeModal()` on a *fully successful* submit (existing behavior), never by an attachment error.

### Submit outcomes

| Outcome | Modal | Description | Thumbnails | Toast |
| --- | --- | --- | --- | --- |
| No attachments, row OK | closes | cleared | n/a | shown (today's behavior, unchanged) |
| Attachments all `done` | closes | cleared | discarded | shown |
| Row POST fails | stays open | preserved | preserved (still `queued`) | not shown; form-level error |
| Row OK, ≥1 upload `error` | stays open | preserved | failed ones marked `error`, done ones marked `done` | not shown; per-thumb inline errors; user may re-Submit |

## Edge Cases

- **CE1 — Description-only submit (no attachments).** `hasQueued` is false → skip the upload loop entirely → identical to today. Guarded so this stays a pure additive change.
- **CE2 — Over count on add.** Adding beyond `maxCount` (via any entry point, including a multi-file drop/paste) stops at the cap and sets `lastError` = "You can attach at most 3 images." Files already added are kept.
- **CE3 — Disallowed type on add.** Non-image or GIF/other → skipped, per-file `lastError` naming the file; other files in the same batch still process.
- **CE4 — Dropzone disabled at max.** At `maxCount` the dropzone shows `is-disabled`, the click handler no-ops, and drop/paste are ignored (with the max-count message). Removing any thumb re-enables it.
- **CE5 — Undecodable / corrupt image.** `canvasDownscale` resolves `null` (img `onerror`) → skipped with "{name} — could not read this image." Never pushes a broken item.
- **CE6 — Paste with no image on clipboard.** Paste handler filters `clipboardData.items` to `type.startsWith("image/")`; if none, it does nothing and does **not** `preventDefault` (so pasting text into the textarea still works). Only when image items are present does it `preventDefault` and route to `addFiles`.
- **CE7 — Paste while focus is in the textarea.** The paste listener is attached at the modal root and only intercepts when the clipboard carries an image; text paste into the description is unaffected (CE6).
- **CE8 — Upload failure (network / 5xx / server 4xx).** The item goes to `error` with a mapped message; the thumbnail and its Retry affordance remain; the description and sibling thumbnails are untouched. Re-Submit retries only `queued`/`error` items (never re-uploads `done`).
- **CE9 — Row POST succeeds but page unloads mid-upload.** Some attachments may be linked, some not; the feedback row still exists (text saved). Accepted — matches LLD 153 E7/E12 (non-idempotent endpoint, text-first durability). We do **not** auto-retry.
- **CE10 — Duplicate submit clicks.** Submit is disabled (`submitting` flag) while a submit is in flight, preventing a second row POST or concurrent upload waves.
- **CE11 — Downscaled blob still > 5 MB.** Rare (huge source), but the server enforces the 5 MB cap and returns 400; surfaced inline as "Image is too large — try a smaller screenshot." No client-side hard block needed beyond the count guard (server authoritative).
- **CE12 — Cancel / overlay-click close mid-queue.** `closeModal()` calls `attach.clear()` (revokes object URLs, drops blobs). In-flight uploads are not awaited; the modal is dismissed. (Uploads already `done` remain linked server-side; that is acceptable.)
- **CE13 — PNG transparency lost on JPEG re-encode.** Accepted for screenshot feedback; documented. If transparency fidelity ever matters, revisit output mime selection (would require the server to still allow the type, which it does for PNG/WebP).
- **CE14 — `crypto.randomUUID` availability.** Available in all supported secure-context browsers; the app already relies on modern APIs. No polyfill.

## Dependencies

- **LLD 153 (slice 1, merged `42e1185`, migration 013)** — provides `POST /api/feedback/:id/attachments`, the private bucket, server-side caps, and ownership enforcement. **Direct upstream.** This slice must not modify any of it.
- **Existing `POST /api/feedback`** (`submitFeedback.ts`) — unchanged; returns the `{ id }` this slice uploads against.
- **`src/frontend/service/http.ts`** — the axios instance whose request interceptor already attaches the guest/registered bearer token; both submit and attachment POSTs go through it, so ownership resolves automatically.
- **Shared types** `SubmitAttachmentRequest` / `SubmitAttachmentResponse` and `SubmitFeedbackResponse` (`src/shared/model.ts`) — consumed as-is; **not** modified.
- **Browser APIs:** `FileReader`, `URL.createObjectURL/revokeObjectURL`, `<canvas>.toBlob`, `HTMLImageElement`, `ClipboardEvent`, DataTransfer, `crypto.randomUUID`. All standard in supported browsers.
- **No new npm dependencies.**

## Test Requirements

Frontend tests run in the project's **node environment (no jsdom, no `@vue/test-utils`)**, so tests target the DOM-free composable/helpers directly with injected doubles (mirrors `feedbackBuildMetadata.test.ts`). The canvas downscale and template rendering are covered by manual verification (they require a real browser and are the documented exception per testing-principles §10.6).

### Unit — `tests/frontend/feedbackAttachments.test.ts`

Validation / add path:
- `rejectReason` returns null for each allowed mime; a type message for a non-image (e.g. `video/mp4`) and for `image/gif`; the max-count message when `currentCount >= 3`.
- `addFiles` with a stub `Downscaler` pushes one `queued` item per accepted file with `status: "queued"`, correct `origBytes`/`scaledBytes`, and a preview URL.
- `addFiles` stops at `maxCount`: adding 4 files (or a 4-file batch) yields exactly 3 items and sets `lastError` to the max-count message.
- `addFiles` skips a disallowed type mid-batch but still adds the valid siblings (CE3).
- `addFiles` skips a file whose downscaler returns `null` and sets the "could not read" message (CE5), without pushing an item.
- `remove(id)` splices the item and (assert via a spy) revokes its object URL; `clear()` empties `items` and revokes all URLs.
- `isFull` / `count` / `totalOrigBytes` / `totalScaledBytes` computeds track `items` correctly.

Upload path (inject `uploadOne` double):
- **Picker/paste/drop converge:** the same `addFiles` produces identical `queued` items regardless of source (assert by calling `addFiles` with an array vs a `FileList`-shaped object).
- `uploadAll(id)` transitions each item `queued → uploading → done` and resolves `true` when all succeed; asserts `uploadOne` called once per queued item with the given `feedbackId`.
- On one `uploadOne` rejection: that item ends `error` with a mapped message, siblings still reach `done`, `uploadAll` resolves `false`, and no exception propagates (CE8).
- Re-invoking `uploadAll` after a partial failure retries only `error`/`queued` items and never re-calls `uploadOne` for `done` items (CE8).
- `blobToBase64` returns a raw base64 string with **no** `data:` prefix (feed a small `Blob`, assert round-trip decode).
- `uploadErrorMessage` maps: a 413-shaped error and an oversize-400 to the "too large" message; a generic network error to the connection message; a 4xx with a server message surfaces that message.

### Unit — submit orchestration (mirror `FeedbackWidget.submit()` logic, DOM-free)

Following the `feedbackBuildMetadata.test.ts` pattern (extract the load-bearing submit logic into a testable function that takes injected `postFeedback` / `attachments`):
- **CE1:** with zero queued attachments, submit calls `postFeedback` once and **does not** call `uploadAll` — behaves exactly as today (assert no attachment call, modal-close path taken).
- With queued attachments: submit calls `postFeedback`, then `uploadAll(returnedId)`; on full success takes the close+toast path.
- **Row POST failure:** `postFeedback` rejects → sets the form error, does **not** call `uploadAll`, does **not** clear the description (assert description ref unchanged).
- **Partial upload failure:** `uploadAll` resolves `false` → modal stays open, description preserved, no success toast.
- Double-submit guard: while a submit promise is pending, a second `submit()` invocation is a no-op (CE10).

### Manual verification (documented exception — requires a real browser)

Run `docker compose up` (or `npm run dev`) and open the feedback modal:
1. Attach via file picker, drag-and-drop, and `Ctrl+V` paste (screenshot) — each produces a thumbnail; the paste hint is always visible.
2. Downscale meta shows `orig → scaled` and the uploaded image is visibly capped at 1600 px.
3. Remove a thumbnail; exceed 3 (dropzone dims/disables at max, re-enables after remove).
4. Submit succeeds → toast; force an upload failure (offline) → inline per-thumb error + Retry, description preserved.
5. Description-only submit still works exactly as before.

### Explicitly not tested here

- Backend upload/validation/RLS (owned and tested by LLD 153).
- Triage rendering (slice 3 / #172).
- Real canvas pixel output / EXIF stripping (browser-only; manual check above).
