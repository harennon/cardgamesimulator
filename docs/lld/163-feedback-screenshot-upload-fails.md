# LLD 163: Feedback screenshot upload fails

## Scope

**Covers:** Aligning the nginx request-body size limit with the backend's route-level `ATTACHMENT_BODY_LIMIT` (`7mb`) so that feedback screenshot uploads reach Express instead of being rejected by nginx with a `413` before the backend ever sees them. Verifying that the frontend surfaces a friendly, user-facing error if an upload does fail (including a `413`) rather than a raw nginx HTML page.

**Root cause (confirmed):** Every `/api/` request is proxied through nginx. Neither `nginx/production.conf` (`location /api/`) nor `src/frontend/nginx.conf` (`location /api/`) sets `client_max_body_size`, so nginx applies its default of **1 MB**. The attachment endpoint `POST /api/feedback/{id}/attachments` receives a base64-encoded image (frontend caps the scaled image at 5 MB; base64 inflates ~33%). The backend already accommodates this with `ATTACHMENT_BODY_LIMIT = "7mb"` (`src/backend/api/feedback/submitFeedback.ts`) and `server.ts` skips the global 100 kB `express.json()` for this route. But any base64 body over 1 MB is rejected by nginx with `413 Request Entity Too Large` before reaching Express. A typical 1600px JPEG exceeds ~750 KB, whose base64 form exceeds 1 MB — so most real game screenshots fail every time.

**Does NOT cover:**
- Any change to the attachment feature itself (downscaling logic, caps, storage, validation, retry UX).
- Raising or lowering the frontend 5 MB image cap or the backend 7 MB body limit.
- Global nginx body-size changes — the new limit is scoped to `location /api/` only.
- Socket.IO or static-asset request handling.

## Approach

**Decision 1 — Add `client_max_body_size 7m;` scoped to `location /api/` in BOTH nginx configs.**

The value `7m` matches the backend `ATTACHMENT_BODY_LIMIT = "7mb"` so the two layers agree: nginx no longer rejects a body the backend would accept, and the backend remains the single authority that returns a structured `400` for a genuinely oversized/invalid image. Scoping to `location /api/` (not the `server` or `http` block) keeps the raised limit off static-asset and SPA routes, which have no reason to accept large bodies. This is the minimal, surgical fix that satisfies the root cause.

Both files must be changed together and kept in sync:
- `nginx/production.conf` — the production reverse proxy (Railway/managed deploy).
- `src/frontend/nginx.conf` — the Docker Compose frontend container proxy.

Fixing only one leaves the other environment broken. The two configs already mirror each other's `location /api/` block, so the same directive is added to both.

**Decision 2 — Keep the two layers tracking.** The intent is that the nginx cap equals the backend cap. Both files get an inline comment noting the value must match `ATTACHMENT_BODY_LIMIT` in `src/backend/api/feedback/submitFeedback.ts`, so a future change to one prompts a change to the other. (No shared config mechanism exists across the nginx layer and the Node process; a comment is the pragmatic sync mechanism and matches the existing cross-reference comments in `server.ts` and `submitFeedback.ts`.)

**Decision 3 — Graceful error on genuine oversize / any upload failure (verification, likely no code change).**

`useFeedbackAttachments.uploadAll()` wraps each `uploadAttachment` call in `try/catch` and, on any thrown error, sets that attachment's status to `"error"` and returns `false`. `FeedbackWidget.vue` then shows the friendly message `"Some attachments failed to upload. Retry or remove them."` This path is transport-agnostic: an axios rejection from a `413` (nginx returns a small HTML body, which axios surfaces as a non-2xx rejection) is caught exactly like any other failure. The raw nginx `413` HTML page is never rendered to the user — it is only the rejected response body, which the code ignores. Therefore the "graceful user-facing error" acceptance criterion is **already satisfied** by existing code; this LLD only requires confirming it via test, not new error-handling code.

After the fix, a genuinely oversized image (base64 body between ~1 MB and 7 MB but a decoded image the backend rejects, or a body over 7 MB) still fails gracefully: over-7 MB bodies get nginx `413`, over-backend-limit bodies get Express `413`/`400`, both caught by the same `catch`.
## Interfaces / Types

No TypeScript interfaces or types change. This is an infrastructure-config change plus a verification test.

**`nginx/production.conf` — `location /api/` block, add one directive:**

```nginx
location /api/ {
    # Must match ATTACHMENT_BODY_LIMIT in
    # src/backend/api/feedback/submitFeedback.ts (feedback screenshot uploads).
    client_max_body_size 7m;
    proxy_pass http://localhost:3000/;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

**`src/frontend/nginx.conf` — `location /api/` block, add the same directive:**

```nginx
location /api/ {
    # Must match ATTACHMENT_BODY_LIMIT in
    # src/backend/api/feedback/submitFeedback.ts (feedback screenshot uploads).
    client_max_body_size 7m;
    proxy_pass http://backend:${BACKEND_PORT}/;
    proxy_set_header Host $http_host;
}
```

Only the `client_max_body_size 7m;` line (and its comment) is added; all existing directives stay unchanged.

## State Model

No application state changes. `client_max_body_size` is a per-request nginx directive evaluated at request time against the `Content-Length` / streamed body of each `/api/` request. Nothing is persisted. The backend's in-memory request handling and the frontend's reactive attachment state (`useFeedbackAttachments`) are unaffected.

## Edge Cases

1. **Base64 body between ~1 MB and 7 MB (the reported failure).** Previously rejected by nginx `413`. After fix: passes nginx, reaches Express (route limit 7 MB), uploads successfully. Primary acceptance criterion.
2. **Scaled image at the 5 MB frontend cap.** Base64 ≈ 6.7 MB, under the 7 MB nginx and Express limits. Uploads successfully end-to-end.
3. **Body just over 7 MB (should not occur — frontend caps at 5 MB, but e.g. a hand-crafted request).** Rejected by nginx `413` first. Frontend `uploadAll` catches the axios rejection, marks the attachment `"error"`, shows the friendly message. No raw nginx page shown to the user.
4. **Body under 7 MB but decoded image fails backend validation (bad magic bytes, disallowed mime, oversized decode).** Passes nginx, reaches Express, backend returns structured `400`. Frontend catches it identically. Behavior unchanged by this LLD.
5. **Non-`/api/` large request (e.g. a large POST to a static route).** Still subject to nginx's default 1 MB limit — the raised cap is scoped to `location /api/` only. No regression; nothing else in the app posts large bodies.
6. **Environment divergence.** If only one nginx config were changed, one deploy target would stay broken. Both files are changed in the same commit to prevent this.

## Dependencies

- LLD 153 / 154 (feedback attachment feature) — this fixes an omission introduced there (backend limit raised, fronting nginx limit not). No behavioral dependency beyond the existing endpoint and frontend composable.
- Existing files: `nginx/production.conf`, `src/frontend/nginx.conf`, `src/backend/api/feedback/submitFeedback.ts` (source of the `7mb` value), `src/frontend/composables/useFeedbackAttachments.ts` and `src/frontend/component/FeedbackWidget.vue` (existing graceful-error path).
- No new packages, migrations, or env vars.

## Test Requirements

**Config verification (manual / integration, since nginx is not exercised by the unit suite):**
- With the full stack running (`docker compose up`), submit feedback with a real ~1600px game screenshot (scaled body > 1 MB, < 7 MB). Verify: `201` from `POST /api/feedback/{id}/attachments`, thumbnail reaches `"done"`, no `413` in nginx logs. This is the core regression check.
- Submit with an image near the 5 MB frontend cap. Verify successful upload (no `413`).
- Confirm both `nginx/production.conf` and `src/frontend/nginx.conf` contain `client_max_body_size 7m;` inside `location /api/` and nowhere at `server`/`http` scope (grep assertion is acceptable).

**Frontend unit (graceful-error path — assert existing behavior is preserved):**
- `useFeedbackAttachments.uploadAll`: when the injected `uploadAttachment` rejects (simulating a `413` axios rejection), the target attachment ends in status `"error"` and `uploadAll` returns `false`. (May already exist; ensure coverage.)
- `FeedbackWidget`: when `uploadAll` returns `false`, `attachError` shows the friendly message and no raw response body is rendered.

**Not required:** No new backend unit tests — the backend limit and validation are unchanged. No engine tests (no game logic touched).
## Dependencies
## Test Requirements
