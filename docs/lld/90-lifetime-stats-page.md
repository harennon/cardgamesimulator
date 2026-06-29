# LLD 90: Add Lifetime Stats Page

## Scope

A frontend-only, read-only page where a signed-in player views their cumulative
lifetime stats, broken down per game type, sourced from the existing
`GET /stats` endpoint.

**In scope:**

- New route `/stats` rendering a `StatsView` component.
- Per-game-type breakdown (one card/row per `GameStatsEntry`): win rate, total
  games, total score (and games won/lost as supporting detail).
- An entrypoint to `/stats` from `HomeView` for signed-in users (nav link/button).
- All page states: registered user with stats, registered user with empty
  stats, guest (no cross-session stats), loading, error.
- A frontend API service wrapper and a pure formatting module, with unit tests.

**Explicitly NOT in scope:**

- Any backend change. The `GET /stats` contract, guest filtering, and empty
  handling already exist (LLD 07b, LLD 66). This LLD must not touch
  `src/backend/**`, migrations, or the route registration.
- Time-windowed / "last 30 days" stats — deferred, backend-led (issue #96).
- Aggregating across game types into a single lifetime total (the backend
  returns per-`(user_id, game_type)` rows per LLD 66; we render them as-is).
- Leaderboards, historical game log, per-match drill-down.

## Approach

**Frontend direction:** Direction A mockup is approved — match it. The page is a
simple stat view; data is per game type because the backend already returns
`GameStatsEntry[]` (LLD 66). Scope is lifetime-only (the only data the endpoint
returns today).

**Data source.** Reuse the shipped `GET /stats` endpoint. The frontend hits it
via the `/api` prefix (`/api/stats`), which both the Vite dev proxy and nginx
strip before forwarding to the backend `/stats` route. The shared
`axiosInstance` request interceptor attaches the auth token automatically — no
per-call auth wiring.

**Response shape (already defined in `@shared/model`, do not redefine):**

```ts
interface GetStatsResponse {
  userId: string;
  games: GameStatsEntry[]; // one entry per game type played; [] if none
}
interface GameStatsEntry {
  gameType: GameType; // "big2" | "tonk"
  gamesPlayed: number;
  gamesWon: number;
  gamesLost: number;
  totalScore: number;
  winRate: number; // gamesWon/gamesPlayed (0 if none), rounded to 3 dp
  lastPlayedAt: string | null; // ISO 8601
}
```

`winRate` is already computed server-side as a 0–1 fraction. The frontend only
formats it for display (e.g. `Math.round(winRate * 100)` → `"73%"`). Do not
recompute win rate from `gamesWon/gamesPlayed` on the client — display what the
server sent (server-authoritative; principle 1).

**Guest detection.** Guests have no Supabase session — `getSession()` returns
`null` and their `guest_token` cookie is scoped to a single game. The page must
detect "not a registered user" by `getSession() === null` and render the guest
message/CTA **without calling `/api/stats`**. (The backend would accept a
guest's game-scoped token and return `games: []`, but that is incidental; the
page decides up front based on session presence — simpler and avoids a wasted
request. Outside an active game a guest typically has no token at all.)

**Component vs. pure logic split** (matches the `gameOverStats.ts` pattern,
testing principle 1). All display-formatting logic lives in a plain `.ts`
module with pure functions, unit-tested directly. The `.vue` file is a thin
renderer: fetch → branch on state → render.

**No client-side game rules.** This page only formats already-computed numbers;
it contains zero game logic, consistent with the thin-client principle.

## Frontend Design

Direction A (approved mockup). One addition beyond the mockup: the mockup shows
only the `/stats` page itself, not how the user reaches it. This LLD adds a
home-screen entrypoint (issue #40 lists this in scope).

**Layout (`StatsView`):**

- Page title: "Your Stats".
- Subtitle/caption clarifying these are lifetime totals (no time window).
- One card (or row) per `GameStatsEntry`, each showing:
  - Game-type display name (`gameTypeLabel(gameType)` → `"Big 2"`, `"Tonk"`).
  - **Win rate** as a percentage (primary stat).
  - **Total games** (`gamesPlayed`).
  - **Total score** (`totalScore`).
  - Games won / games lost as supporting detail.
- States rendered (exactly one at a time):
  1. **Loading** — spinner/placeholder while the request is in flight.
  2. **Error** — failed request: friendly message + a retry affordance.
  3. **Guest** — message that stats are saved only for registered accounts,
     with a CTA to sign up / log in (`router-link` to `/signup` and/or
     `/login`). No data request is made.
  4. **Empty** — registered user, `games.length === 0`: "You haven't finished
     any games yet" with a CTA to Create/Join a game (`router-link` to
     `/create-game`).
  5. **Populated** — registered user with one or more entries: render the cards.

**Entrypoint (`HomeView`):** For signed-in users only (`signedIn === true`),
add a link/button to `/stats` in the existing `home__actions` block (alongside
Create Game / Join Game). A `router-link` styled `btn-secondary` matching the
existing buttons. Exact placement/ordering is the implementer's call; it must
not appear for the signed-out auth-prompt branch. Add a `data-testid`
(`stats-link`) for QA. Do **not** add it to the global `App.vue` nav (that nav
is shared with signed-out users and other flows; keep this change minimal and
home-scoped, per issue #40).

**Styling:** Reuse existing design tokens / utility classes already in the app
(`flow-page`, `btn-primary`, `btn-secondary`, card styles seen in
`form-card`, CSS vars like `--gold-accent`, `--text-muted`). No new global
styles beyond what the mockup requires; keep component styles `scoped`.

## Interfaces / Types

No shared-type changes. Reuse `GetStatsResponse` / `GameStatsEntry` / `GameType`
from `@shared/model`.

**New frontend service** — `src/frontend/service/statsService.ts`:

```ts
import type { GetStatsResponse } from "@shared/model";
// GET /api/stats — auth token attached by the axiosInstance interceptor.
// Throws on network/HTTP error (caller maps to the error state).
export async function fetchStats(): Promise<GetStatsResponse>;
```

**New pure formatting module** — `src/frontend/component/statsView.ts`
(co-located with the view, mirroring `gameOverStats.ts`):

```ts
import type { GameType, GameStatsEntry } from "@shared/model";

// "big2" -> "Big 2", "tonk" -> "Tonk". Unknown -> the raw value.
export function gameTypeLabel(gameType: GameType): string;

// 0..1 fraction -> integer-percent string, e.g. 0.732 -> "73%".
export function formatWinRate(winRate: number): string;

// Display rows for a single entry, in render order.
export interface StatRow {
  readonly label: string;
  readonly value: string;
}
export function statRowsFor(entry: GameStatsEntry): StatRow[];
```

**New component** — `src/frontend/component/StatsView.vue` (thin renderer; no
exported logic — all logic imported from `statsView.ts`).

**Route** — add to `src/frontend/routes.ts`:

```ts
{ path: "/stats", component: StatsView, meta: { requiresAuth: true } }
```

Using `requiresAuth: true` means the existing global `beforeEach` guard
redirects unauthenticated visitors (including guests, who have no Supabase
session) to `/login?redirect=/stats`. This is the desired behaviour for a
direct URL hit. The in-component guest branch (state 3 above) is still required
because the redirect only covers direct navigation; document the interaction in
Edge Cases.

> Decision — guest handling, two valid approaches:
> **(A) `requiresAuth: true`** — guests/anon are redirected to login on direct
> navigation; the in-component guest message is a fallback. Simple, consistent
> with `/create-game`.
> **(B) `requiresAuth: false`** — page is reachable by anyone and the
> in-component guest state always shows the sign-up CTA.
> **Recommendation: (A).** It matches the existing pattern for registered-only
> pages (`/create-game`, `/join-game`) and the entrypoint only renders for
> signed-in users anyway. The guest CTA state remains specified for robustness
> and to satisfy the approved mockup's state coverage.

## State Model

Nothing is persisted by this feature. All state is in-memory in the component
for the lifetime of the view.

Component reactive state (single discriminated status flag, not multiple
booleans):

```ts
type PageState =
  | { status: "loading" }
  | { status: "guest" }
  | { status: "error" }
  | { status: "ready"; games: GameStatsEntry[] }; // empty handled in template via games.length
```

Flow on mount:

1. `getSession()`.
2. If no session → `status = "guest"` (no request).
3. Else `status = "loading"` → `fetchStats()`.
   - success → `status = "ready"` with `response.games`.
   - failure → `status = "error"`.
4. Retry (error state) re-runs step 3.

The server is the sole source of truth for the numbers (principle 1); the client
neither computes nor caches stats beyond this view instance.

## Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | Registered user, no completed games | `status: "ready"`, `games: []` → render empty state with Create/Join CTA. |
| 2 | Registered user with stats | Render one card per entry. |
| 3 | Guest navigates via in-app link | Link is not shown to guests on `HomeView`; if reached otherwise, `requiresAuth` guard redirects to `/login?redirect=/stats`. |
| 4 | Anyone deep-links `/stats` while signed out | `requiresAuth` guard → redirect to `/login?redirect=/stats`. |
| 5 | In-component guest fallback (session check race / future `requiresAuth:false`) | `status: "guest"` → show sign-up/login CTA, no data request. |
| 6 | `/api/stats` network failure or 5xx | `status: "error"` → friendly message + retry button. |
| 7 | `/api/stats` 401 (token expired mid-session) | Treated as error state; retry re-attempts (interceptor re-reads token). Do not silently blank the page. |
| 8 | `winRate` formatting at boundaries | `0` → `"0%"`; `1` → `"100%"`; rounding via `Math.round(winRate*100)`. |
| 9 | Division-by-zero win rate | Not possible client-side — server returns `0` for zero games; just format it. |
| 10 | Unknown/new `gameType` value | `gameTypeLabel` falls back to the raw string so the row still renders (forward-compatible with new engines). |
| 11 | `lastPlayedAt === null` | If displayed, render a placeholder ("—") rather than "Invalid Date". (Implementer's call whether to surface it; not required by the mockup.) |
| 12 | Multiple entries (big2 + tonk) | Render all; stable order — sort by `gameType` or by `gamesPlayed` desc (implementer's choice, must be deterministic). |

## Dependencies

**Must already exist (all shipped):**

- `GET /stats` endpoint returning `GetStatsResponse` — `src/backend/api/stats/getStats.ts` (LLD 07b).
- Per-game-type stats contract — `GameStatsEntry` in `src/shared/model.ts` (LLD 66).
- `axiosInstance` with auth interceptor — `src/frontend/service/http.ts`.
- `getSession()` — `src/frontend/service/authService.ts`.
- `/api` proxy stripping in `vite.config.js` and `src/frontend/nginx.conf` /
  `nginx/production.conf`.
- Vue Router with the `requiresAuth` `beforeEach` guard — `src/frontend/routes.ts`.

**No upstream LLD blocks this.** It is purely additive and read-only.

## Test Requirements

Frontend tests live in `tests/frontend/` (Vitest). Bias toward pure-function
unit tests over component mounting (testing principle 1, 4); test the `.vue`
shell only for state branching.

**Unit — `tests/frontend/statsView.test.ts` (pure `statsView.ts`):**

- `gameTypeLabel`: `"big2"` → `"Big 2"`, `"tonk"` → `"Tonk"`, unknown value →
  returns the raw string.
- `formatWinRate`: `0` → `"0%"`, `1` → `"100%"`, `0.732` → `"73%"`, `0.005`
  rounds correctly. (No NaN/Infinity handling needed — input is server-bounded.)
- `statRowsFor`: produces the expected labels/values for a representative
  `GameStatsEntry` (win rate, total games, total score, won/lost). Verify it
  does not recompute win rate (passes through the server `winRate`, not
  `gamesWon/gamesPlayed`).

**Unit — `tests/frontend/statsService.test.ts`:**

- `fetchStats` calls `GET /api/stats` via the mocked `axiosInstance` and returns
  the parsed `GetStatsResponse`.
- Propagates errors to the caller (rejects) on HTTP failure.
  (Do not test that axios works — test our wrapper's URL + return/throw shape.)

**Component-state — `tests/frontend/StatsView.test.ts`** (mount with mocked
`getSession` and `fetchStats`), one assertion per state:

- Guest (`getSession` → `null`): shows guest CTA, `fetchStats` is **not** called.
- Registered + populated: renders one card per entry; win-rate/totals visible.
- Registered + empty (`games: []`): shows empty-state CTA, no error.
- Loading: shows loading indicator before the request resolves.
- Error (`fetchStats` rejects): shows error message + retry; clicking retry
  re-invokes `fetchStats`.

**Component — `HomeView` entrypoint** (extend existing HomeView test if present,
else add):

- Signed-in: `stats-link` (`data-testid`) is present and points to `/stats`.
- Signed-out: `stats-link` is absent.

**No new backend/integration/security tests.** The endpoint's auth, guest
filtering, and empty-handling are covered by existing tests
(`tests/integration/player-stats.test.ts`, `tests/service/statsService.test.ts`).
No information-leakage surface is added: the page only displays the caller's own
stats, which the server already scopes to `request.userId`.

**Manual (QA, visual only):** Verify the page matches the Direction A mockup on
desktop and mobile widths, and that loading/empty/guest/error states render
legibly. Everything else is covered by automated tests.
