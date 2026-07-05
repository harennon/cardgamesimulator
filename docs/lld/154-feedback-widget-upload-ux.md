# LLD 154: FeedbackWidget Upload UX — File Picker, Drop Zone, Clipboard Paste, and Client-Side Downscale

Parent: #97 (slice 2 of 3). **Frontend-only.** Depends on the storage foundation (LLD 153 / shipped as LLD 150, PR #180) which provides the backend upload path and server-authoritative caps.

> **Approach constraint (from selection).** This is a frontend-only change. Do **NOT** add or touch backend routes or migrations — upload against the already-shipped contract: `POST /api/feedback/:id/attachments` accepting `{ image: base64, mimeType }`. Reuse the existing `FeedbackWidget.vue` modal shell **verbatim** (title / category / description / actions) and slot the attachment block **between** Description and the action buttons. The approved mockup (`feedback-widget-upload-ux.html`, served on 8090) is **one direction, not A/B**. The owner replied "Frontend decision: proceed" without picking among the three open questions, so the stated **defaults** are locked (see §Approach).

## Scope

### In scope

- Three entry points in the feedback modal, all feeding one `addFiles()` handler: **file picker** (click drop zone → native dialog), **drag-and-drop** onto the modal, and **clipboard paste** (screenshot → Ctrl+V).
- **Client-side downscale** via an offscreen `<canvas>` before upload: longest edge capped at **1600px**, re-encoded at **~0.8** quality.
- **Thumbnail previews** of attached image(s) with a per-thumb **remove** control and a per-thumb status (`queued → uploading → done | error`).
- **Client-side UX caps that mirror the server** (max 3 files; PNG/JPEG/WebP; 5 MB per file *after* downscale) — for UX only; the server (LLD 153) remains authoritative.
- **Deferred upload wired into the existing submit flow**: on Submit, POST the feedback row first (unchanged `POST /api/feedback`), then upload each downscaled blob per-file to the slice-1 path, linking to the returned feedback `id`.
- **Upload states**: in-progress, success, and inline error on rejection (type / size / count) or network failure — **without losing the typed description**. A failed upload keeps its thumbnail with a **Retry** affordance.
- Refactor the load-bearing logic (validation, downscale, upload orchestration) into a plain, DOM-injectable composable so it is unit-testable in the project's node test environment.

### Explicitly NOT in scope

- The **auto-capture-a-screenshot-of-this-page** button (deferred).
- **Triage-side rendering** of attachments (slice 3 / #172).
- Any backend, route, migration, or shared-model change (all shipped in LLD 153/150). The shared types `SubmitAttachmentRequest` / `SubmitAttachmentResponse` already exist and are consumed as-is.
- Multi-file *parallel* progress bars beyond a simple per-file spinner/indeterminate state (real byte-level progress is not required; see E-Progress).

## Approach

### Locked defaults (owner said "proceed" without choosing)

1. **Downscale:** longest-edge cap **1600px** at quality **0.8**. Re-encode to `image/jpeg` (smallest for photos/screenshots; the server accepts JPEG). Images already smaller than the cap are still re-encoded (strips metadata, normalizes size). If re-encoding a PNG to JPEG *grows* the byte size, keep the smaller of the two — see E-Reencode.
2. **Layout:** thumbnail row sits **inline, above** the drop zone (within the attachment block, between Description and the actions).
3. **Upload timing:** **deferred** — files are held in memory and uploaded on Submit, not eagerly on add. Cancel therefore loses nothing that was ever sent.

### Key decisions

1. **Reuse the modal shell verbatim; add one attachment block.** No structural change to title / category / description / actions. The new block is inserted between the Description `<label>` and the `.feedback-widget__actions` div, matching the approved mockup exactly (§Frontend Design).

2. **Extract logic into `useFeedbackAttachments.ts`; keep the component thin.** Project frontend tests run in a **node environment without jsdom / @vue/test-utils** (confirmed: `vitest.config.ts` `environment: "node"`; `roomCodeChip.test.ts` / `feedbackBuildMetadata.test.ts` mirror logic rather than mount). Testability is the primary risk called out in selection, so all load-bearing logic — file validation, count enforcement, downscale, and the deferred-upload state machine — lives in a composable that takes its DOM/browser dependencies (an image-decode+canvas `downscale` function and the axios poster) via **injection**, defaulting to real implementations. Tests inject fakes; production uses the real canvas path. The `.vue` file only wires DOM events (`click`, `change`, `drop`, `paste`) to the composable and renders its reactive state.

3. **Deferred, sequential-per-file upload after the feedback row exists.** Submit orchestration: (a) `POST /api/feedback` → get `{ id }`; (b) for each attachment with status `queued`, `POST /api/feedback/:id/attachments` with the downscaled blob as base64 + `mimeType`, transitioning `queued → uploading → done | error`. Uploads run sequentially (bounded, ≤3 files, avoids hammering the free-tier backend and keeps ordering deterministic for tests). This matches LLD 153's warning that the attach endpoint is **not idempotent** (E12 there) — we never blind-retry; Retry is user-initiated.

4. **The feedback row is created even if attachments fail.** Because text is POSTed first, a later attachment failure never loses the report. On any attachment error we surface an inline message, mark that thumbnail `error` with a Retry control, and **do not** close the modal or clear the description (hard requirement). Successful thumbnails stay `done`.

5. **Client caps are UX-only, never trusted.** `MAX_FILES = 3`, `ALLOWED_TYPES = [image/png, image/jpeg, image/webp]`, `MAX_BYTES = 5 MB` mirror `ATTACHMENT_LIMITS` in LLD 153 to give instant feedback, but the server re-validates and is authoritative (architecture-principles §1). We treat a server 4xx on upload as an error state, not an assertion failure.

6. **base64 transport, matching the shipped contract.** The downscaled `Blob` is read to a base64 string (via `FileReader.readAsDataURL`, stripping the `data:...;base64,` prefix) and sent as `{ image, mimeType: "image/jpeg" }`. No multipart; matches LLD 153 decision 3.

### Submit flow

```
User clicks Submit (description non-empty; 0..3 attachments queued)
  │
  ├─ POST /api/feedback  { category, description, metadata }   (UNCHANGED)
  │     fail → inline form-error, KEEP description + thumbnails, re-enable Submit, STOP
  │     ok   → { id }
  │
  ├─ if no queued attachments → success: close modal, show toast (EXACTLY AS TODAY)
  │
  └─ for each queued attachment (sequential):
        status = uploading
        POST /api/feedback/{id}/attachments { image: base64, mimeType }
          ok   → status = done
          fail → status = error (thumbnail kept, Retry shown), record inline error
     after loop:
        all done            → close modal, show toast
        any error remaining  → KEEP modal open, description intact, Submit re-enabled;
                               Retry re-uploads only the errored file(s) to the SAME id
```

The feedback `id` from step 1 is retained in component state so Retry (and resubmit after fixing) reuse it rather than creating a duplicate feedback row.

## Interfaces / Types

No shared-model or backend changes. New frontend files only.

### `src/frontend/composables/useFeedbackAttachments.ts`

```ts
export type AttachmentStatus = "queued" | "uploading" | "done" | "error";

export interface Attachment {
  id: string;              // client-generated (crypto.randomUUID); for list keys + remove
  name: string;            // original filename (paste → "pasted-image.png"); shown in errors
  previewUrl: string;      // object URL of the DOWNSCALED blob (revoked on remove/close)
  blob: Blob;              // downscaled image, image/jpeg — the upload payload
  origBytes: number;       // pre-downscale size (for the "2.1 MB → 0.4 MB" meta line)
  scaledBytes: number;     // post-downscale size (== blob.size)
  status: AttachmentStatus;
}

export interface DownscaleResult { blob: Blob; }

// Injectable dependencies (real defaults; tests pass fakes).
export interface FeedbackAttachmentDeps {
  // Decodes a File/Blob, caps longest edge to maxEdge, re-encodes at quality.
  // Returns null if the file is not a decodable image. Default: canvas impl.
  downscale: (file: Blob, maxEdge: number, quality: number) => Promise<DownscaleResult | null>;
  // Uploads one attachment; resolves on 2xx, rejects on any 4xx/5xx/network.
  // Default: axiosInstance.post to /api/feedback/:id/attachments.
  uploadAttachment: (feedbackId: string, image: string, mimeType: string) => Promise<void>;
  createObjectURL: (b: Blob) => string;   // default URL.createObjectURL
  revokeObjectURL: (u: string) => void;   // default URL.revokeObjectURL
  blobToBase64: (b: Blob) => Promise<string>; // default FileReader.readAsDataURL + strip prefix
}

export const ATTACH_CAPS = {
  maxFiles: 3,
  maxBytes: 5 * 1024 * 1024,
  allowedTypes: ["image/png", "image/jpeg", "image/webp"] as const,
  maxEdge: 1600,
  quality: 0.8,
} as const;

export interface UseFeedbackAttachments {
  attachments: Ref<Attachment[]>;
  attachError: Ref<string>;         // last inline (attachment-level) rejection message
  isFull: ComputedRef<boolean>;     // attachments.length >= maxFiles
  canAddMore: ComputedRef<boolean>; // !isFull

  addFiles(files: FileList | File[]): Promise<void>;  // validate → downscale → push queued
  remove(id: string): void;                            // revoke URL + drop from list
  reset(): void;                                       // revoke all URLs + clear (on modal close)

  // Deferred upload for a given feedback id. Uploads all `queued` (or, if
  // `onlyIds` given, those) sequentially; sets per-file status; returns true iff
  // every targeted file ended `done`. Never throws.
  uploadAll(feedbackId: string, onlyIds?: string[]): Promise<boolean>;
}

export function useFeedbackAttachments(
  deps?: Partial<FeedbackAttachmentDeps>,
): UseFeedbackAttachments;
```

**`addFiles` algorithm (pure enough to unit-test with injected `downscale`):**

```
for each file in files:
  if attachments.length >= maxFiles: attachError = "You can attach at most 3 images."; break
  if file.type not in allowedTypes:  attachError = `${file.name} — only PNG, JPG and WebP images can be attached.`; continue
  result = await downscale(file, maxEdge, quality)
  if result is null:                 attachError = `${file.name} — could not read this image.`; continue
  if result.blob.size > maxBytes:    attachError = `${file.name} — still over 5 MB after resizing.`; continue   // E-StillTooBig
  push { id, name, previewUrl: createObjectURL(result.blob), blob: result.blob,
         origBytes: file.size, scaledBytes: result.blob.size, status: "queued" }
```

Count is checked **before** downscale (cheap) and the loop breaks on overflow so extra pasted/dropped files don't silently downscale-then-discard.

### `src/frontend/composables/useFeedbackAttachments.ts` — default `downscale` (canvas)

Mirrors the mockup's `downscale()`: `new Image()` from an object URL, on load draw to a `<canvas>` sized to the capped dimensions, `canvas.toBlob(cb, "image/jpeg", quality)`; resolve `null` on `img.onerror`. This is the one genuinely DOM-bound piece and is why `downscale` is injectable — tests never exercise the real canvas.

### Component: `src/frontend/component/FeedbackWidget.vue` (modified)

New reactive wiring only. `submitting` extends to cover the two-phase submit. New handlers: `onDropzoneClick` (→ hidden `<input type=file>.click()` when `canAddMore`), `onFileChange`, drag handlers on the modal (`is-dragover` toggle), and a `paste` listener registered while the modal is open. `submit()` is rewritten per §Submit flow. `closeModal()` additionally calls `attachments.reset()`.

## State Model

- **In-memory only (component + composable), never persisted client-side beyond the modal session:**
  - `attachments: Attachment[]` — each holds the downscaled `Blob`, an object URL, and status.
  - `feedbackId` — the id returned by step-1 `POST /api/feedback`, retained across Retry/resubmit so no duplicate feedback row is created.
  - `description`, `category` — unchanged; **must survive** any attachment error.
- **Object-URL lifecycle:** created per attachment on add; revoked on `remove(id)` and on `reset()` (modal close / successful submit). Prevents blob leaks.
- **Server-side (out of this LLD, per LLD 153):** feedback row + `attachment_keys TEXT[]`; image bytes in the private `feedback-attachments` bucket. The client only ever sends base64 and receives `{ attachmentId, key }` (which it does not need to store).
- **Randomness:** `crypto.randomUUID()` for client list ids is UI-only (not game logic) — architecture-principles §8 does not apply.

## Edge Cases

- **E1 — Wrong file type.** `file.type` not in `allowedTypes` → inline error, file not added, others unaffected. (Covers dropping/pasting a `.mp4`, `.gif`, PDF.)
- **E2 — Over count.** Adding beyond `maxFiles` → inline error, loop breaks; already-added files kept. Drop zone dims/disables and counter turns gold at exactly `maxFiles` (§Frontend Design). Removing one re-enables.
- **E-StillTooBig — Over size after downscale.** Downscaled blob still > 5 MB (rare; huge dimensions) → inline error, not added. Prevents a guaranteed server 400.
- **E-Reencode — PNG→JPEG grows.** If the JPEG re-encode is larger than the original (e.g. a small flat-color PNG), keep the smaller representation. If the smaller one is the original PNG, upload it with its original `mimeType`; else upload the JPEG. Keeps payloads minimal and mime honest for the server's magic-byte check (LLD 153 E4).
- **E3 — Undecodable / corrupt image.** `downscale` returns `null` (`img.onerror`) → inline "could not read this image", not added.
- **E4 — Description empty on Submit.** Submit stays disabled when `description.trim()` is empty, exactly as today; attachments alone cannot submit. (Matches existing behavior; attachments are optional, description is required.)
- **E5 — Description-only submit (no attachments).** Works exactly as today: POST feedback → close → toast. No attachment step runs. **Hard requirement, explicitly tested.**
- **E6 — `POST /api/feedback` fails (step 1).** Inline form-error ("Failed to submit. Please try again."), description + thumbnails preserved, Submit re-enabled, no attachment uploads attempted, `feedbackId` not set.
- **E7 — One attachment upload fails (network or server 4xx/5xx).** That thumbnail → `error` with a Retry affordance; inline attachment error names the file; description and other (done) thumbnails preserved; modal stays open. **Hard requirement, explicitly tested.**
- **E8 — Retry.** Retry re-uploads only the `error` file(s) to the **same** `feedbackId` (reusing step-1 id). On success → `done`; if all done → close + toast. A fresh `attachmentId` is minted server-side per attempt (LLD 153 E12), so a duplicate object is possible if a prior attempt actually succeeded but its response was lost; acceptable and bounded by the server count cap. We do not auto-retry.
- **E9 — Remove during/after upload.** Remove is allowed for `queued`, `done`, and `error` files. Removing a `done` file only drops it from the client list (the server object remains until retention sweep, LLD 153); acceptable. Remove is disabled/ignored for a file currently `uploading`.
- **E10 — Paste with non-image clipboard content.** `paste` handler filters `clipboardData.items` to `image/*`; non-image pastes (plain text into the textarea) are ignored and do **not** `preventDefault`, so normal text paste into Description still works. Only image items trigger `addFiles`.
- **E11 — Paste while focus is in the textarea.** The paste listener is registered on the modal/document while open; an image paste is intercepted regardless of focus, but a **text** paste is left to the browser (E10). Verified by the item-type filter, not by focus target.
- **E12 — Drag events flicker (`dragleave` on child elements).** Drag highlight is toggled at the modal level; `dragleave` is ignored when `relatedTarget` is still inside the modal (mockup pattern) so the highlight doesn't flicker over inner elements.
- **E13 — Guest session expires between step 1 and upload.** Server returns 401 on the attach (LLD 153 E9); handled as E7 (error thumbnail + inline message). Feedback text already saved.
- **E14 — Duplicate/rapid Submit clicks.** `submitting` disables Submit for the whole two-phase flow (mockup disables Cancel too during in-flight uploads); only one flow runs.
- **E-Progress — No real byte progress.** The per-file indicator is an indeterminate spinner (+ optional CSS shimmer bar); we do not wire XHR upload progress events. Sufficient for ≤3 small images and keeps the axios path simple. (The mockup's animated bar is illustrative.)

## Dependencies

- **LLD 153 / 150 (Feedback Attachment Storage Foundation)** — MUST be merged and deployed first. Provides `POST /api/feedback/:id/attachments`, `ATTACHMENT_LIMITS`, ownership rule, and the shared types `SubmitAttachmentRequest`/`SubmitAttachmentResponse` (already in `src/shared/model.ts`). Direct upstream. This LLD sends the exact `{ image, mimeType }` body and mirrors the caps.
- **LLD 9 (Feedback Widget)** — the modal shell, `submit()`, `buildMetadata()`, `useFeedbackContext`, toast, and `data-testid`s this LLD extends. Direct upstream.
- **Existing infra (unchanged):** `axiosInstance` (`@/service/http` — auth interceptor already attaches the guest/registered token; the attach route is under `/api/feedback` so the same interceptor applies), `useFeedbackContext`, `vitest.config.ts` (node env), the frontend-test extraction pattern.
- **Browser APIs:** `HTMLCanvasElement.toBlob`, `Image`, `URL.createObjectURL/revokeObjectURL`, `FileReader`, `DataTransfer`/`ClipboardEvent`, `crypto.randomUUID`. All standard in supported browsers; no new npm dependency.

## Frontend Design

Frontend decision: **proceed** — the approved mockup (`feedback-widget-upload-ux.html`, served on 8090) is the single direction to implement. Palette/typography use existing CSS variables (`--gold-accent`, `--table-rim-light`, `--text-muted`, `--error-text`, `--success-text`, `--font-ui`). Structure (matching the mockup states 1–6):

- **Placement:** an attachment block (`.feedback-widget__attach`) between the Description `<label>` and `.feedback-widget__actions`. The modal shell (title/category/description/actions) is unchanged.
- **Header row:** a "Screenshots (optional)" label with a small image icon, and a right-aligned **counter** `N / 3`. At `N === 3` the counter turns gold (`.is-max`).
- **Thumbnail row (inline, above the drop zone):** 74×74 rounded thumbnails, `object-fit: cover`, each with a top-right circular **× remove** button. Per-status overlays: `uploading` → dark scrim + spinner (+ optional bottom shimmer bar); `done` → small green check badge (bottom-left); `error` → red-tinted scrim with "Upload failed" + underlined **Retry**, and a red thumbnail border.
- **Drop zone:** dashed-border box with an upload-arrow icon, `Click to upload or drag & drop`, and a hint line `…or paste with Ctrl+V · PNG, JPG, WebP · up to 3`.
  - **Drag-over:** solid gold border, gold-glow wash, subtle `scale(1.01)` (`.is-dragover`), toggled at modal level.
  - **Max reached:** dimmed, `not-allowed`, dotted border, hint replaced with `Maximum of 3 images reached — remove one to add another` (`.is-disabled`).
- **Downscale meta line (below thumbs):** `Auto-resized to 1600px max · 2.1 MB → 0.4 MB before upload`, shown once at least one file is downscaled.
- **Errors:** attachment-level rejections/failures render as an inline `.feedback-widget__attach-error` (icon + message) inside the block; step-1 feedback POST failures reuse the existing `.feedback-widget__error` form-error. Neither ever clears the textarea.
- **Actions:** unchanged. During in-flight uploads Submit shows a mini-spinner + "Sending…" and both buttons disable (mockup state 3).

`data-testid` hooks to add (for QA / any future DOM tests): `feedback-dropzone`, `feedback-file-input`, `feedback-thumb` (per thumb), `feedback-thumb-remove`, `feedback-thumb-retry`, `feedback-attach-count`, `feedback-attach-error`.

## Test Requirements

Frontend tests run in the **node** environment (no jsdom/@vue/test-utils). Following the project pattern (`roomCodeChip.test.ts`, `feedbackBuildMetadata.test.ts`), tests exercise the **real `useFeedbackAttachments` composable** with **injected fakes** for `downscale`, `uploadAttachment`, and the object-URL/base64 helpers — never mounting the `.vue`. This makes the validation, count, downscale-orchestration, and upload state machine genuinely covered. Testability is the priority risk; cover it thoroughly.

### Unit — `tests/frontend/useFeedbackAttachments.test.ts`

**Entry-path shaping (paste + picker feed one handler):**
- **Picker path:** `addFiles` with a `File[]` of two valid PNGs (fake `downscale` returns a small blob) → two `queued` attachments, correct `name`/`origBytes`/`scaledBytes`, one `createObjectURL` per file. (Covers the file-picker path.)
- **Paste path:** a helper mirroring the component's paste filter — given a fake `ClipboardEvent.items` list containing one `image/png` item and one `text/plain` item, only the image is passed to `addFiles`; a text-only clipboard produces **no** `addFiles` call and does **not** `preventDefault` (E10/E11). (Covers the paste path.)

**Rejection / oversize / over-count (all required):**
- Wrong type (`file.type = "video/mp4"`) → inline error set, not added (E1).
- Over count: add 3, then a 4th → error, loop breaks, length stays 3 (E2); `isFull`/`canAddMore` flip correctly.
- Oversize after downscale: fake `downscale` returns a blob > `maxBytes` → error, not added (E-StillTooBig).
- Undecodable: fake `downscale` returns `null` → "could not read" error, not added (E3).
- `remove(id)` revokes the object URL and drops the entry; `reset()` revokes all URLs and clears.

**Upload state machine (`uploadAll`):**
- All succeed: fake `uploadAttachment` resolves for each → every file `done`, returns `true`, uploads sequential (assert call order).
- One fails: fake rejects for the 2nd file → 1st/3rd `done`, 2nd `error`, returns `false`; other files' status/blobs intact (E7).
- Retry: after a failure, `uploadAll(id, [erroredId])` re-attempts only that file against the same id → `done`, returns `true` (E8).
- Correct payload: `uploadAttachment` receives the base64 from `blobToBase64` and `mimeType === "image/jpeg"` (or original mime for the E-Reencode PNG-kept case).

### Unit — `tests/frontend/feedbackSubmitFlow.test.ts`

Mirror `submit()` orchestration as an injectable function (deps: `postFeedback`, the attachments composable) — same extraction style as `feedbackBuildMetadata.test.ts`:
- **Description-only submit works exactly as today** (E5): no queued attachments → `postFeedback` called once, `uploadAll` **not** called, modal closes, toast shown.
- **Happy path with attachments:** `postFeedback` → id, then `uploadAll(id)` → all done → close + toast.
- **Step-1 failure preserves description** (E6): `postFeedback` rejects → form-error set, `uploadAll` not called, `description`/attachments untouched, Submit re-enabled, modal open. **Assert description is preserved.**
- **Attachment failure preserves description** (E7): `postFeedback` ok, `uploadAll` returns `false` → modal stays open, `description` unchanged, at least one thumbnail `error`, inline attachment error present, Submit re-enabled. **Assert description is preserved** (the description-preserved-on-error case called out in acceptance).
- **No duplicate feedback row on Retry:** after an attachment failure, a subsequent retry/resubmit reuses the stored `feedbackId` and does not call `postFeedback` again.

### Manual (visual only — cannot be asserted in node env)

Bias is against manual tests (testing-principles §Decision Heuristics 6); these are the genuinely visual cases:
- Drag-over highlight (gold border/glow/scale) appears while dragging a file over the modal and clears on drop/leave (E12).
- Real clipboard paste of an OS screenshot in a browser adds a thumbnail; real canvas downscale produces a visibly smaller file; disabled drop zone dims at 3.

### Explicitly not tested here

- Backend upload validation, ownership, storage, signed URLs (LLD 153 covers these). No integration/E2E of the network round trip in this slice; the composable's `uploadAttachment` boundary is faked. No triage rendering (slice 3).
