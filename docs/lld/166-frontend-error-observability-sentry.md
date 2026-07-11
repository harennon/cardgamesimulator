# LLD 166: Frontend error/observability capture (Sentry SDK) as a queryable artifact for triage/ship-batch, with shared correlation key

## Scope

Ships as **one atomic unit** — the shared correlation key threads all five parts, so partial delivery is not permitted.

**In scope:**

1. **Frontend capture** — `@sentry/vue` initialised in `src/frontend/main.ts` before `app.mount`, guarded behind `VITE_SENTRY_DSN` (a no-op when unset). Auto-captures uncaught exceptions, unhandled promise rejections, and default breadcrumbs.
2. **Source-map upload** — `@sentry/vite-plugin` in `vite.config.js`, gated on build-time env, uploads maps then deletes them via `filesToDeleteAfterUpload` so source is never published.
3. **Socket.IO failure breadcrumbs** — explicit `Sentry.addBreadcrumb` calls in the existing `connect_error`/`disconnect` handlers of `src/frontend/composables/useSocket.ts`, throttled to 1 breadcrumb per `reason` per 10 s (with a suppressed count) so a flapping client cannot burn the free-tier quota.
4. **Shared correlation key** — a `cx_<8-char nanoid>` minted per session in a new `useCorrelation` composable (co-located with `useFeedbackContext.ts`), rebound to the `gameId` on game join. Stamped on all three surfaces: Sentry (tag + context), the feedback row (via `buildMetadata()` in `FeedbackWidget.vue`, stored in existing `feedback.metadata` JSONB — no migration), and every backend log line.
5. **Backend structured logging** — replace the ~26 ad-hoc `console.*` calls in `src/backend/` with a thin `pino` JSON logger (stdout). Log lines carry correlation id / gameId / requestId. **Hard constraint (architecture-principle #2):** never log full game state or any player's hand — identifiers and event types only.
6. **Queryable artifact** — `scripts/errors.mjs`, mirroring `scripts/feedback.mjs`, authenticates to the Sentry REST API (token in `.env.admin`) and emits captured errors as a JSON array on stdout. Supports `--json`, a recency filter (`--since`/`--recent`), and lookup by `--correlation-id` / `--game-id`.

**Explicitly NOT in scope:**

- The consumption process (feedback validation via `triage-feedback`, or error-driven issue creation) — a separate decision.
- Sentry session replay, distributed tracing (`trace_id` does not survive WebSockets — do **not** wire it), or any paid Sentry tier.
- Migrating the backend to Sentry — the pino logger is stdout-only; the DSN swap to self-host later is a one-line follow-up.
- Any change to game-engine code (principle #4: engine stays pure, no logging).

## Approach

### Provider choice
`@sentry/vue` → Sentry hosted **free (Developer)** tier: 5,000 errors/mo, 30-day retention, 1 seat. Chosen over GlitchTip free (1,000-event cap) and self-hosted GlitchTip (ops burden). Wire-compatible, so a future backend/self-host migration is a DSN swap. Rejected homegrown `window.onerror` → Supabase (loses source-maps + breadcrumbs). **Re-verify Sentry free-tier quotas at implementation time** (pricing captured 2026-07).

### Correlation key — one key, rebound (not two)
A **single** correlation id is minted per browser session as `cx_<8-char nanoid>` (nanoid alphabet, url-safe). On game join it is **rebound** to include the gameId rather than minting a second independent key. Concretely, `useCorrelation` holds one reactive `correlationId` (session-stable) plus a reactive `gameId` (set on join, cleared on leave). Sentry receives both as a tag/context pair; the feedback row and backend logs receive both fields. This gives one linkable key per session and a secondary gameId filter, without the ambiguity of two overlapping session keys.

Why not Sentry distributed tracing: `trace_id` propagates over HTTP headers but **not** over the WebSocket frames Socket.IO uses, so a trace would fragment at the socket boundary. The explicit correlation id is transport-agnostic and works across REST + WebSocket + feedback uniformly.

### Frontend init (guarded)
`main.ts` calls a new `initObservability(app, router)` helper. When `import.meta.env.VITE_SENTRY_DSN` is unset/empty the helper returns immediately — **no SDK init, no network, no global handlers** — so local dev and CI are byte-for-byte unaffected. When set, it calls `Sentry.init` with `browserTracingIntegration` disabled (no tracing), `tracesSampleRate: 0`, `replaysSessionSampleRate: 0`, the Vue integration bound to `app`, and sets the session correlation tag. The Vue integration auto-installs `app.config.errorHandler`, `window.onerror`, and `unhandledrejection` capture.

### Source maps
`@sentry/vite-plugin` added to `vite.config.js` plugins, gated on `process.env.SENTRY_AUTH_TOKEN` being present (build machine only; a normal `vite build` without the token still succeeds and simply skips upload). Config: `sourcemaps.filesToDeleteAfterUpload: ["**/*.map"]` so maps are uploaded to Sentry then removed from `build/frontend` — source is never served to clients. `build.sourcemap` is set to `"hidden"` so maps generate without a `//# sourceMappingURL` reference in the shipped JS.

### Socket breadcrumbs + throttle
The throttle is written **before** wiring so a flap cannot burn quota. A module-level `Map<reason, { lastEmit: number; suppressed: number }>` gates emission: the first breadcrumb for a `reason` emits immediately; further breadcrumbs for the same `reason` within 10 s only increment `suppressed`; the next emit after the window includes `suppressedSince` in the breadcrumb data. Breadcrumbs (not events) are used so they ride along with the *next real error* rather than each consuming an event from the 5k/mo quota. `connect_error` with `SERVER_FULL` is a distinct terminal breadcrumb (not throttled — it is rare and high-signal).

### Backend logger (thin pino)
A single `src/backend/util/logger.ts` exports a configured pino instance and a `withContext({ correlationId?, gameId?, requestId? })` child-logger helper. All ~26 `console.*` sites are replaced 1:1 with `logger.info/warn/error`. A `requestId` (nanoid) is minted per HTTP request in a small middleware and per socket connection; the client-supplied correlation id is read from the socket handshake auth / an `x-correlation-id` header and attached to the child logger. **Information-hiding rule is a hard fail condition:** log call sites pass only identifiers, event-type strings, and error messages/stacks — never `PlayerView`, hands, deck contents, or full game state. A lint/review checklist item enforces this.

### errors.mjs artifact
Mirrors `feedback.mjs` structure: loads `.env.admin`, reads `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT`, calls the Sentry REST API (`GET /api/0/projects/{org}/{project}/issues/` with a `query` param, and `/events/` for breadcrumb/tag detail), maps each issue to the fixed field set below, and prints a JSON array (with `--json`) or a formatted digest. It is a read-only consumer — the actual deliverable of this LLD.

## Interfaces / Types

### Frontend — `useCorrelation` (new composable, co-located with `useFeedbackContext.ts`)

```ts
export interface UseCorrelationReturn {
  /** Session-stable id, format `cx_<8-char nanoid>`. Never changes for the tab's lifetime. */
  correlationId: DeepReadonly<Ref<string>>;
  /** Current gameId, or undefined outside a game. */
  gameId: DeepReadonly<Ref<string | undefined>>;
  /** Bind the correlation context to a game (called on join). Rebinds, does not mint a new key. */
  bindGame(gameId: string): void;
  /** Clear the game binding (called on leave / unmount). */
  unbindGame(): void;
}

// Module-singleton state (mirrors useFeedbackContext.ts pattern: module-scoped refs).
// correlationId is generated ONCE at module load.
export function useCorrelation(): UseCorrelationReturn;
```

- `correlationId` is generated once at module scope: `` `cx_${nanoid(8)}` `` using the existing/added `nanoid` dep.
- `bindGame`/`unbindGame` update the shared `gameId` ref AND push the pair to Sentry via `Sentry.setTag("correlation_id", id)` / `Sentry.setTag("game_id", gameId)` and `Sentry.setContext("correlation", { correlationId, gameId })` (guarded — no-op when Sentry uninitialised).

### Frontend — observability init helper (new, e.g. `src/frontend/observability/sentry.ts`)

```ts
/** No-op unless VITE_SENTRY_DSN is set. Installs Vue + browser error capture. */
export function initObservability(app: App, router: Router): void;

/** Guarded breadcrumb helper — safe to call whether or not Sentry is initialised. */
export function recordBreadcrumb(b: {
  category: string;          // e.g. "socket"
  message: string;           // e.g. "connect_error"
  level?: "info" | "warning" | "error";
  data?: Record<string, unknown>;
}): void;
```

### Frontend — socket throttle (inside `useSocket.ts`)

```ts
// module scope
const _socketBreadcrumbThrottle = new Map<string, { lastEmit: number; suppressed: number }>();
const SOCKET_BREADCRUMB_WINDOW_MS = 10_000;

// called from connect_error / disconnect handlers
function recordSocketFailure(reason: string, data: Record<string, unknown>): void;
// emits recordBreadcrumb({ category: "socket", message: reason,
//   data: { correlationId, gameId, reason, ...data, suppressedSince? } })
// at most once per `reason` per SOCKET_BREADCRUMB_WINDOW_MS.
```

### Backend — logger (new `src/backend/util/logger.ts`)

```ts
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // stdout JSON; no transport/pretty in prod (Railway captures stdout)
});

export interface LogContext {
  correlationId?: string;
  gameId?: string;
  requestId?: string;
}

/** Returns a child logger bound to the given identifiers. */
export function withContext(ctx: LogContext): pino.Logger;
```

- HTTP: a tiny middleware mints `requestId = nanoid()`, reads `x-correlation-id` header, attaches `req.log = withContext(...)`.
- Socket: on connection, read `socket.handshake.auth.correlationId` (client adds it alongside `token`) and mint a per-connection `requestId`; socket handlers log via a child logger carrying `{ correlationId, gameId, requestId }`.

### CLI — `scripts/errors.mjs` output shape (per issue)

```jsonc
{
  "correlationId": "cx_ab12cd34",   // from issue tags, may be null if untagged
  "gameId": "…",                    // from issue tags, may be null
  "title": "TypeError: …",
  "type": "error",                  // issue level/type
  "count": 12,                      // times seen
  "firstSeen": "2026-07-10T…Z",
  "lastSeen": "2026-07-11T…Z",
  "permalink": "https://sentry.io/…/issues/123/",
  "breadcrumbSummary": ["socket connect_error (x3)", "navigation /game/…"]
}
```

Fields are exactly: `correlationId, gameId, title, type, count, firstSeen, lastSeen, permalink, breadcrumbSummary`. **Raw stack frames are intentionally excluded** (available via the permalink). CLI flags: `--json`, `--recent <N>` / `--since <ISO>`, `--correlation-id <id>`, `--game-id <id>`.

## State Model

**Correlation id (client, in-memory only):** minted once per tab at module load, lives for the tab's lifetime. Not persisted to localStorage/cookie (a reload = a new session = a new key, which is acceptable and simpler). Held in module-scoped refs in `useCorrelation`, matching the existing `useFeedbackContext` singleton pattern.

**gameId binding (client, in-memory):** set on `game:join`, cleared on leave/unmount. Pushed to Sentry scope as a tag so all subsequent events in that session carry it.

**Where the key is written (three surfaces):**

| Surface | Mechanism | Persistence |
| --- | --- | --- |
| Sentry | `setTag`/`setContext` on the global scope | Sentry-side, 30-day retention |
| Feedback row | added to `buildMetadata()` return → `feedback.metadata` JSONB | Postgres (existing column, no migration) |
| Backend logs | child-logger fields on each log line | stdout → Railway logs, ~7-day retention |

**Socket breadcrumb throttle (client, in-memory):** `Map<reason, {lastEmit, suppressed}>` at module scope in `useSocket.ts`. Not persisted; reset on reload. Breadcrumbs live in the Sentry SDK's in-memory ring buffer and are only transmitted when a real error event is captured.

**Backend logger:** stateless; pino writes JSON to stdout. Child loggers are per-request/per-connection and garbage-collected with the request/socket. No new persistent storage.

**Nothing here touches game state or the engine.** No new DB tables, columns, or migrations. Server-authority, information-hiding, and pure-engine principles are unaffected.

## Frontend Design

Frontend decision: **all defaults ok** (owner-confirmed). No new user-visible UI.

- **Feedback widget stays visually identical.** `buildMetadata()` gains `correlationId` and `gameId` fields, but there is **no** user-visible reference line, no new copy, no layout change in `FeedbackWidget.vue`. The template and styles are untouched.
- **No user-facing error UI** is added by this LLD — Sentry capture is entirely passive/background. The existing reconnecting banner (LLD 162/165) and connection-state UX are unchanged; we only *observe* socket events, we do not alter the banner behaviour.
- **Debug overlay (`?debug`)** may optionally surface the current `correlationId` for local triage convenience, but this is dev-only (already tree-shaken from prod) and non-blocking; implement only if trivial.
- **No new routes, components, or composable-driven UI.** `useCorrelation` is state/plumbing only.

## Edge Cases

## Edge Cases

| # | Case | Handling |
| --- | --- | --- |
| E1 | `VITE_SENTRY_DSN` unset (local/CI/dev) | `initObservability` returns immediately; `recordBreadcrumb`, `setTag` calls are guarded no-ops. Zero network, zero global handler install. Existing tests unaffected. |
| E2 | Sentry `init` throws (bad DSN, blocked network) | Wrap `Sentry.init` in try/catch; on failure log a single `console.warn` and continue — the app must never fail to mount because of observability. |
| E3 | Socket flapping (rapid connect_error/disconnect) | Throttle to 1 breadcrumb per `reason` per 10 s; suppressed count reported on next emit. Protects the 5k/mo quota. |
| E4 | `SERVER_FULL` connect_error | Emitted as a distinct, un-throttled breadcrumb (rare, high-signal) with `reason: "server_full"`; existing terminal-banner logic in `useSocket.ts` is unchanged. |
| E5 | Feedback submitted before any game join | `gameId` is `undefined` in metadata; `correlationId` still present. No error. |
| E6 | Correlation id missing on a backend log (e.g. health check, pre-auth) | `withContext` omits absent fields; log line still valid JSON. Fields are optional. |
| E7 | Client omits `x-correlation-id` / handshake `correlationId` (old client, direct curl) | Backend logs `correlationId: undefined`; no crash. Backend does **not** mint a substitute (would not link to anything). |
| E8 | Source-map upload runs without `SENTRY_AUTH_TOKEN` | Plugin is gated on the token; a normal `vite build` skips upload and still produces a working (map-less-reference) bundle. |
| E9 | Source maps accidentally shipped | Prevented by `build.sourcemap: "hidden"` + `filesToDeleteAfterUpload`. Add a build-artifact check (grep for `.map` in `build/frontend`) to the review checklist. |
| E10 | A log call site is tempted to log game state / a hand | **Fail condition.** Reviewer rejects. Only ids + event-type strings + error message/stack are permitted. |
| E11 | Sentry REST token invalid/expired in `errors.mjs` | Mirror `feedback.mjs`: print a clear error to stderr and `process.exit(1)`. |
| E12 | `errors.mjs` issue has no correlation/game tag | Emit the issue with `correlationId: null` / `gameId: null` rather than dropping it. |
| E13 | Free-tier monthly quota exhausted | Sentry drops events server-side; client is unaffected (fire-and-forget). Breadcrumb throttle is the primary mitigation. Note for ops: watch the Sentry usage page. |
| E14 | Unhandled rejection with a non-Error value | Vue/Sentry default integration captures it; no special handling. |
| E15 | PII in breadcrumbs (userAgent, route with ids) | `sendDefaultPii: false`; route/gameId are acceptable identifiers, not PII. Do not add email/display name to Sentry scope. |

## Dependencies

**External / accounts (must exist before implementation):**
- A Sentry hosted account (free Developer tier) with a project → provides `VITE_SENTRY_DSN` (frontend), `SENTRY_ORG`, `SENTRY_PROJECT`, and a REST auth token (`SENTRY_AUTH_TOKEN`, scope: `project:read`, `event:read`; a separate write-scoped token is needed for the vite-plugin source-map upload — `project:releases`).
- **Re-verify free-tier quotas** (errors/mo, retention, seats) at implementation time.

**npm packages:**
- `@sentry/vue` (frontend, prod dep)
- `@sentry/vite-plugin` (dev dep)
- `pino` (backend, prod dep)
- `nanoid` — confirm whether already present; if not, add (used both frontend for `cx_` id and backend for `requestId`).

**Env vars to add to `.env.example`:**
- Frontend: `VITE_SENTRY_DSN` (empty by default → no-op).
- Build: `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` (build machine / CI only).
- Backend: `LOG_LEVEL` (optional, default `info`).
- `.env.admin` (gitignored, for `errors.mjs`): `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`.

**Existing code touched:**
- `src/frontend/main.ts` — call `initObservability(app, router)` before `.mount`.
- `src/frontend/composables/useSocket.ts` — add throttled `recordSocketFailure` calls in `connect_error`/`disconnect` handlers; bind gameId on join elsewhere.
- `src/frontend/composables/useFeedbackContext.ts` (or new sibling) — `useCorrelation`.
- `src/frontend/component/FeedbackWidget.vue` — extend `buildMetadata()` only.
- Socket join client code — call `bindGame(gameId)`; pass `correlationId` in `io(...)` `auth`.
- `src/backend/*` — 26 `console.*` sites → `logger`/child loggers; add HTTP `requestId` middleware; read handshake `correlationId` in socket auth/connection.
- `vite.config.js` — add gated `@sentry/vite-plugin`; set `build.sourcemap: "hidden"`.
- `scripts/errors.mjs` (new), `package.json` — add `"errors": "node scripts/errors.mjs"` script.

**No upstream LLD blocks this**, but per the issue it is sequenced behind the Tonk end-to-end chain. Builds on the feedback pipeline (LLD 153/163) and connection-state work (LLD 162/165) without modifying their behaviour.

## Test Requirements

Per testing-principles: bias to automated tests; SDK/library internals are not re-tested. Sentry is mocked — **no live network in tests**.

**Unit (frontend):**
- `useCorrelation`: `correlationId` matches `/^cx_[A-Za-z0-9_-]{8}$/` and is stable across multiple `useCorrelation()` calls; `bindGame` sets `gameId`; `unbindGame` clears it; Sentry `setTag`/`setContext` invoked with expected args (mock `@sentry/vue`).
- Guarded no-op: with `VITE_SENTRY_DSN` unset, `initObservability` performs no SDK init and `recordBreadcrumb` is a no-op (assert mock not called).
- Socket throttle: first `recordSocketFailure(reason)` emits; second within 10 s does not; after the window a third emits carrying a `suppressedSince`/suppressed count. Use fake timers.
- `buildMetadata()` includes `correlationId` and `gameId` (from bound game) and no other change to existing fields.

**Unit (backend):**
- `withContext` produces a child logger; log output (captured via a pino test stream) is valid JSON containing only the supplied identifier fields.
- **Information-leakage test (security, hard requirement):** given a representative log call in socket/game handlers, assert the serialized log line does NOT contain hand/card/PlayerView data — e.g. feed a state object and assert only ids/event types are emitted. Mirrors testing-principle #7.

**Integration / CLI:**
- `scripts/errors.mjs` against a mocked Sentry REST response: `--json` emits a JSON array with exactly the specified field set; `--correlation-id` and `--game-id` filter; `--recent`/`--since` filter by `lastSeen`; missing tags yield `null` (E12); invalid token exits non-zero (E11).
- Build artifact check: after a build with a token, `build/frontend` contains no `*.map` files (E9). (Can be a scripted assertion, not a Vitest case.)

**Manual (minimal — genuinely needs a live Sentry project):**
- Throw an error + trigger an unhandled rejection in a DSN-configured build → both appear as Sentry issues with source-mapped stack traces.
- Force a socket `connect_error`/`disconnect` → structured breadcrumb with correlation id + gameId appears on the next captured error; repeated failures are rate-limited.
- Submit feedback in a session that also produced a Sentry event → feedback `metadata.correlationId` matches the Sentry event's `correlation_id` tag and appears in backend log lines for that session.

