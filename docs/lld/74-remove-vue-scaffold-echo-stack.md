# LLD 74: Remove leftover Vue scaffold: HelloWorld / /echo route + EchoHandler

## Scope

Removes the leftover `npm create vue` echo scaffold — a self-contained end-to-end slice (frontend component + route, backend handler + REST route, shared types, and two test references). Nothing in the live UI links to it, and `HelloWorld.vue` POSTs to `/api/authNedEcho`, a backend route that no longer exists.

**In scope (full echo stack):**

- Frontend: `src/frontend/component/HelloWorld.vue` + its `/echo` route and import in `src/frontend/routes.ts`.
- Backend: `src/backend/api/echo.ts` (`EchoHandler`) + the `/echo` registration and import in `src/backend/server.ts`.
- Shared: `EchoRequest` / `EchoResponse` in `src/shared/model.ts` (only referenced by the two files being deleted).
- Tests: the `HelloWorld.vue` mock in `tests/frontend/joinRouteGuard.test.ts` and the `/echo` registration + import in `tests/integration/helpers/testServer.ts`.
- E2E config: repoint the backend readiness probe in `playwright.config.ts` off `/echo`.

**Explicitly NOT in scope:**

- No changes to the `Handler` base class, `ServeAppHandler`, the `/health` endpoint logic, or any other route.
- No refactoring of adjacent scaffold (e.g. `AboutView`, `HomeView`) — surgical removal only.
- No change to auth middleware, the route guard logic, or any game/lobby behavior.

## Approach

Straightforward dead-code deletion. The echo stack is unreferenced by any real feature; the only non-obvious coupling is the E2E readiness probe.

**Key decisions:**

1. **Delete the shared types too.** `EchoRequest` / `EchoResponse` in `src/shared/model.ts` are imported only by `HelloWorld.vue` and `echo.ts`, both of which are deleted. Leaving them would be the same orphaned dead weight this issue exists to remove. Confirmed via grep: no other importers.

2. **Repoint the Playwright probe to `/health`, do not just delete it.** `playwright.config.ts:35` sets the backend `webServer.url` to `http://localhost:3000/echo` as the readiness probe — Playwright polls it until the server responds, then starts the suite. Removing `/echo` without repointing breaks the **entire** E2E suite (backend never reports ready). Repoint to the existing no-auth `GET /health` endpoint (`server.ts:74`), which returns `200 { status: "ok", ... }`. This is the correct probe target anyway: it is the purpose-built health check used by Railway + monitoring.
   - Note: the current probe is a `GET /echo`, but `EchoHandler` only implements `put`/`post`. Playwright treats any HTTP response as "server up," so the GET works incidentally today. `/health` is a real `200 GET` — a strictly better probe.

3. **`/echo` is NOT a deploy/health-check probe in app code.** The issue's note asks to confirm this before removal. Verified: the only health/readiness probe is `GET /health` (server.ts:74, used by Railway + monitoring per its comment). The single consumer of `/echo` as a probe is `playwright.config.ts` (handled by decision 2). Therefore the backend handler can be removed in full; no need to keep the endpoint.

4. **No new abstractions, no replacement scaffold.** This is a pure removal.

## Interfaces / Types

No new interfaces. The following are **removed**:

```ts
// src/shared/model.ts — DELETE both
export interface EchoRequest {
  string: string;
}
export interface EchoResponse {
  string: string;
}
```

```ts
// src/backend/api/echo.ts — DELETE entire file (class EchoHandler)
```

```vue
<!-- src/frontend/component/HelloWorld.vue — DELETE entire file -->
```

Edits (not deletions):

- `src/backend/server.ts`: remove `import { EchoHandler } from "@/api/echo";` (line 10) and the `["/echo", EchoHandler.INSTANCE]` entry (line 85). The handler `Map` then contains only the conditional `["/", ServeAppHandler.INSTANCE]` entry — verify the `Map`/`forEach` block still compiles when the map starts empty (it does: `new Map<string, Handler>([])` then conditionally `.set(...)`).
- `src/frontend/routes.ts`: remove `import HelloWorld from "@/component/HelloWorld.vue";` (line 11) and the `{ path: "/echo", component: HelloWorld, meta: { requiresAuth: true } }` route (line 47).
- `tests/integration/helpers/testServer.ts`: remove `import { EchoHandler } from "../../../src/backend/api/echo.js";` (line 6) and the `["/echo", EchoHandler.INSTANCE]` entry (line 89), leaving `["/", ServeAppHandler.INSTANCE]` as the sole entry in that map.
- `tests/frontend/joinRouteGuard.test.ts`: remove the `vi.mock("@/component/HelloWorld.vue", ...)` line (line 9).
- `playwright.config.ts`: change `url: "http://localhost:3000/echo"` (line 35) to `url: "http://localhost:3000/health"`.

## State Model

No runtime state. Echo was a stateless request→response passthrough (it echoed the request body). Removing it has zero impact on game state, in-memory cache, persistence, or player views. Nothing is persisted or cached by the echo path.

## Edge Cases

1. **Empty handler `Map` after removal (backend).** `server.ts` builds `new Map<string, Handler>([["/echo", ...]])` then conditionally `.set("/", ...)`. After removing the `/echo` seed entry, the map literal must be `new Map<string, Handler>([])` (or constructed empty). Verify the conditional `.set` and `.forEach` still type-check and run with an initially-empty map. (In `testServer.ts` the `/` entry remains, so its map is non-empty.)

2. **Dangling import of deleted shared types.** After deleting `EchoRequest`/`EchoResponse`, confirm `vue-tsc` (frontend) and `tspc` (backend) report no unresolved references. Grep confirmed only `HelloWorld.vue` and `echo.ts` import them; both are deleted.

3. **E2E suite readiness probe.** Covered by Approach decision 2 — repoint to `/health`. After the change, run the full E2E suite to confirm the backend `webServer` is detected as ready.

4. **`/echo` referenced as a documented/deploy probe.** Verified not the case (only `/health` is). If a future reader assumes `/echo` was the health check, the repoint to `/health` preserves the only real consumer (Playwright).

5. **`requiresAuth: true` route removal.** The `/echo` route was the only `requiresAuth: true` route pointing at scaffold; its removal does not affect the global `router.beforeEach` auth guard, which keys off `to.meta.requiresAuth` per-route and is unchanged.

## Frontend Design

Frontend decision: **approved** (no UI mockup needed). This change removes a developer-only scaffold screen (`/echo` → `HelloWorld.vue`) that is not linked from any user-facing flow and is absent from `docs/customer-experience.md`. There is no visible UI surface change for end users, no new layout, and no component to mock up. The "Vite + Vue 3" greeting card and the two echo buttons disappear entirely; no replacement view is introduced. The `frontend-architect` mockup step is not applicable because no customer-facing UI is added or altered.

## Dependencies

None. This is leaf-level dead-code removal with no upstream LLD prerequisites. It depends only on the current state of the listed files (verified at time of writing). No other LLD or feature consumes the echo stack.

## Test Requirements

This LLD removes code rather than adding behavior; the "tests" are existing-suite-still-green plus the two test-file edits. No new test cases are warranted (per testing-principle: don't test framework behavior, don't test removed code).

**Unit / build (must pass):**

- `npm run build` (both `vue-tsc` frontend type-check and `tspc` backend compile) passes with zero errors — confirms no dangling imports of `HelloWorld.vue`, `EchoHandler`, or `EchoRequest`/`EchoResponse`.
- `npm run lint:fix` reports no unused-import or unused-variable errors in `server.ts`, `routes.ts`, `testServer.ts`, or `joinRouteGuard.test.ts`.
- `npm test` (Vitest) passes. Specifically:
  - `tests/frontend/joinRouteGuard.test.ts` still passes after the `HelloWorld.vue` mock line is removed (the import of `routes.ts` must still resolve — `routes.ts` no longer imports `HelloWorld.vue`, so the mock is unnecessary, not merely removable).
  - Integration tests using `createTestServer` still boot and pass after the `/echo` registration + `EchoHandler` import are removed from `testServer.ts`.

**Integration (must pass):**

- Existing integration suite (`tests/integration/**`) is green — confirms the test server boots with the `/echo` route gone and no test depended on echoing.

**E2E (must pass — critical):**

- Full Playwright E2E suite (`e2e/**`) passes after repointing the `webServer` probe to `/health`. This is the load-bearing verification: it confirms (a) the backend readiness probe still works, and (b) nothing in the running app referenced the echo stack. Run headless locally before pushing (CI is headless).

**Negative / leakage:** N/A — echo handled no game state or hidden information, so no information-leakage assertions apply.

**Manual:** None required. There is no visual/UX surface to verify (scaffold screen had no production use).
