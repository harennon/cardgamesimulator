# LLD 116: Stats time-range UI selector (lifetime / 30d / YTD toggle)

Frontend follow-up to LLD 101. LLD 101 shipped the time-windowed stats **backend**
(migration 010 `game_history`, `GET /stats?window=…`, `trackingSince`) and
explicitly deferred the UI selector — "step 4 of #40". The backend is live in
prod (`cards.danbing.app`), but the stats page still hardcodes lifetime, so the
windowed capability is unreachable. This LLD wires the UI to it.

## Scope

### In scope

- Add a `window` argument to `fetchStats()` in `src/frontend/service/statsService.ts`.
  Lifetime keeps its exact current request (`GET /api/stats`, no query string);
  only `30d`/`ytd` append `?window=`.
- Add a segmented time-range selector (Lifetime | Last 30 days | Year to date) to
  `src/frontend/component/StatsView.vue`. Default **Lifetime**, rendering
  pixel-identical to today's #40 page.
- On selection change, re-fetch for that window and re-render the same stats card
  list.
- Render a "Tracking since &lt;date&gt;" note for `30d`/`ytd` when `trackingSince`
  is non-null; never on Lifetime (LLD 101 §E1, A4).
- A distinct **empty-window** state (user has lifetime history but no games in the
  selected window) separate from the **never-played** empty state.
- Reuse the existing loading / error / guest states. A failed windowed fetch reuses
  the error state.
- **Mobile swipe** left/right between the three windows (owner requirement, now a
  first-class AC — not just tap).

### Explicitly NOT in scope

- Any backend change. The `GET /stats` contract (`window` + `trackingSince`) is
  live and frozen (LLD 101). This LLD touches **exactly two** source files
  (`statsService.ts`, `StatsView.vue`) plus net-new tests.
- New stat metrics, per-game-type window selection, or aggregation-across-game-types.
  **One** window applies to the whole page (both Big2 and Tonk entries) — owner-confirmed.
- Backfill of pre-migration windowed data (LLD 101 established there is none;
  `trackingSince` is exactly how that is communicated).
- New route, new pure module, `HomeView` entrypoint changes (all shipped in LLD 90).

## Approach

### A1. `fetchStats(window)` — lifetime path byte-for-byte unchanged

`fetchStats` gains one optional-in-effect parameter. Lifetime must issue the
**identical** request it does today so the shipped fast path and any request-URL
assertions are untouched:

- `window === "lifetime"` → `GET /api/stats` (no query string).
- `window === "30d" | "ytd"` → `GET /api/stats?window=<window>`.

Signature: `fetchStats(window: StatsWindow): Promise<GetStatsResponse>`. The
caller in `StatsView.vue` always passes the current window; there is exactly one
call site, so no default parameter is needed (keeping it explicit avoids a silent
"lifetime unless told otherwise" footgun). Return/throw shape is unchanged: it
returns `response.data` and lets HTTP/network errors propagate to the caller's
error branch. Build the URL by conditional string concat, not by always passing a
`params` object (an axios `params: {}` would still be a no-query request, but an
explicit branch keeps the lifetime request provably identical and is trivially
unit-testable).

> `StatsWindow` values (`"30d"`, `"ytd"`) are already URL-safe; no encoding needed.
> The backend validates and 400s unknown windows (LLD 101 §E5), and the frontend
> only ever sends the three known literals, so no client-side validation is added.

### A2. `StatsView.vue` — extend the state machine, not replace it

The component keeps its discriminated `PageState` union and adds the currently
selected window as separate reactive state (the window survives across
loading/error transitions; it is orthogonal to load status, so it is not folded
into the union). The `ready` variant carries `trackingSince` so the note and
empty-window branch can read it:

- On mount: unchanged — `getSession()`; guest short-circuits with no request
  (LLD 90); otherwise `load(currentWindow)` with the default `"lifetime"`.
- On selecting a window: set `selectedWindow`, then `load(selectedWindow)`.
- `load(window)` sets `loading`, calls `fetchStats(window)`, and on success sets
  `ready` with `games` **and** `trackingSince` from the response.
- Retry (error state) re-runs `load(selectedWindow)` — retries the currently
  selected window, not lifetime.

The selector is always visible for a signed-in user (loading / ready / empty /
empty-window / error). It is **not** rendered in the guest state (guests never
fetch; a window toggle would be meaningless). While a windowed fetch is in flight
the control stays interactive so a user can re-select; the latest selection wins
(see E-race below).

### A3. Distinguishing empty-window from never-played

Two empty cases must look different (AC):

- **Never played** (`games.length === 0` on the **lifetime** window): the existing
  "You haven't finished any games yet." message **with** the Create a Game CTA
  (`router-link` to `/create-game`). Unchanged from #40.
- **Empty window** (`games.length === 0` on `30d`/`ytd`): a distinct message —
  "No games finished in this range yet. Try Lifetime to see all your games." — and
  **no** Create-a-Game CTA (the user demonstrably has games; the CTA would be
  wrong). If `trackingSince` is non-null it still renders the tracking-since note
  above/with this message.

The discriminator is the **selected window**, not the presence of history: on
lifetime, `games.length === 0` unambiguously means never-played; on a window it
means no games in range. (`trackingSince` alone can't distinguish them — a
never-played user returns `trackingSince: null` on a window, but so could data
quirks; the window is the reliable signal.)

### A4. Test infra — follow the existing pattern; do NOT add tooling

**Decision (resolves the flagged infra question):** The selection note assumed the
repo has zero frontend tests and no Vue component-test tooling. That is **stale** —
`tests/frontend/` contains ~35 test files including `StatsView.test.ts`,
`statsService.test.ts`, and `statsView.test.ts`. The established project convention
(documented in-repo, e.g. `roomCodeChip.test.ts:6`, `feedbackBuildMetadata.test.ts:8-9`,
`StatsView.test.ts:5-7`) is: **vitest `node` environment, no jsdom/happy-dom, no
`@vue/test-utils`, no component mounting.** `.vue` behaviour is covered by
transcribing the load-bearing `<script setup>` logic into a pure harness and
asserting one outcome per branch; structural CSS/template contracts are covered by
reading the `.vue` source as a string and asserting on it (e.g. `gameLobbyScroll.test.ts`);
runtime layout/animation is covered by Playwright E2E.

Therefore: **do not** stand up `@vue/test-utils` or a DOM env. Extend the existing
node-env harnesses. This keeps the batch to two source files + net-new/extended
tests, matches every neighbouring test, and avoids a scoped infra addition the
project has deliberately avoided. Swipe-gesture *runtime* behaviour and the
sliding-thumb *visual* are E2E/QA-manual concerns (see Test Requirements), not
node-env unit concerns.

## Frontend Design

**Approved direction: Direction A — segmented pill with a sliding gold thumb**
(owner chose this over Direction B). Owner refinements are **required**, not optional.

**Control layout.** A single rounded "pill" track containing three equal-width
segments: `Lifetime` · `Last 30 days` · `Year to date`. A gold "thumb" (filled
pill using `--gold-accent`) sits behind the active segment's label and slides
horizontally to the selected segment on change.

- **Thumb inset (required refinement 1):** the thumb must **not** butt flush against
  the segment edges. Inset the thumb by a few px inside its segment cell (e.g. the
  track has inner padding and the thumb fills `segment width − 2×gap`), so there is
  visible track spacing around the gold pill on all sides. Specify this as a small
  fixed gap (implementer picks the exact px to match the existing radius/padding
  tokens), not zero.
- **Slide animation:** the thumb translates via CSS `transform` (position it with
  `left`/`translateX` keyed off the selected index) with a short transition
  (~150–200ms). **Respect `prefers-reduced-motion: reduce`** — disable the thumb
  slide transition and the list-swap fade under that query (the component already
  has a `prefers-reduced-motion` block for the spinner; extend it).
- **List-swap fade (required behaviour):** when the stats list re-renders for the
  new window, apply a short fade (opacity) on the list region so the numbers don't
  hard-cut. Also gated by `prefers-reduced-motion`.

**Mobile swipe (required refinement 2 — real AC).** On the stats list / card region,
a horizontal swipe left advances to the next window (Lifetime → 30d → YTD) and
swipe right goes back; at the ends it clamps (no wrap). Implement with pointer/touch
events (`pointerdown`/`pointermove`/`pointerup` or `touchstart`/`touchend`) measuring
horizontal delta past a threshold (e.g. ~40px) while ignoring predominantly-vertical
gestures so page scroll is unaffected. A swipe changes `selectedWindow` and triggers
the same `load()` as a tap. Swipe is additive to tapping, not a replacement.

**Accessibility.** The control is keyboard-operable with visible focus:

- Use a `role="tablist"` with three `role="tab"` buttons (or a radio group); the
  selected tab has `aria-selected="true"` (or `aria-checked`). Arrow-left/right move
  selection (matching the swipe direction) and Enter/Space activate. Native
  `<button>` elements are preferred so focus and keyboard come for free.
- **`:focus-visible` outline** on each segment (do not remove the default outline
  without replacing it) — required.
- The "Tracking since" note is plain text near the control/list; associate it so
  screen readers announce it after a window change (e.g. an `aria-live="polite"`
  region on the note, optional but recommended).

**Caption.** Today's caption reads "Lifetime totals across all your games." On the
lifetime tab it stays exactly that (no regression). On `30d`/`ytd`, either reword to
match the window ("Your last 30 days." / "Your year so far.") **or** keep a static
caption and let the tab + tracking-since note carry the meaning — implementer's
choice, but the lifetime-tab caption text must be unchanged.

**Styling.** Reuse existing tokens/utilities (`--gold-accent`, `--text-muted`,
`--input-bg`, `--card-panel-border`, `--font-ui`, `flow-page`, card styles). All new
styles `scoped` in `StatsView.vue`. No new global CSS. Match the existing
`stats-card` visual language (the selector sits between the caption and the list).

**No-regression hard constraint.** With Lifetime selected (the default on load), the
page must be pixel-identical to the current #40 page apart from the newly-added
selector control sitting above the list. The title, caption text, card list markup,
empty/guest/error/loading states, and the lifetime request are all unchanged.

## Interfaces / Types

No shared-type changes. `StatsWindow`, `GetStatsResponse` (with `window` +
`trackingSince`), and `GameStatsEntry` already exist in `@shared/model` (added by
LLD 101). No new pure module — `statsView.ts` already holds the formatting logic and
needs no additions for this feature (window labels are static UI strings local to
the component; add them to `statsView.ts` **only** if the implementer wants them
unit-tested, in which case a `WINDOW_TABS: {window: StatsWindow; label: string}[]`
constant is the clean seam — optional).

**`src/frontend/service/statsService.ts`:**

```ts
import type { GetStatsResponse, StatsWindow } from "@shared/model";

// GET /api/stats[?window=30d|ytd] — auth token attached by the axiosInstance
// interceptor. Lifetime issues the identical no-query request as before.
// Throws on network/HTTP error (caller maps to the error state).
export async function fetchStats(window: StatsWindow): Promise<GetStatsResponse>;
```

**`src/frontend/component/StatsView.vue`** (thin renderer; extended state):

```ts
type PageState =
  | { status: "loading" }
  | { status: "guest" }
  | { status: "error" }
  | { status: "ready"; games: GameStatsEntry[]; trackingSince: string | null };

const selectedWindow = ref<StatsWindow>("lifetime");
```

Date formatting for the tracking-since note uses the browser locale
(`new Date(trackingSince).toLocaleDateString()`), guarded for a null/invalid value
(render nothing if unparseable). Keep it simple; no new date library.

## State Model

Nothing persisted. All state is in-memory for the view's lifetime (LLD 90).

- **`selectedWindow`** (reactive `StatsWindow`, default `"lifetime"`): the active tab;
  drives the thumb position, the request, and the empty-window vs never-played branch.
- **`state`** (reactive `PageState`): unchanged discriminated union, with
  `trackingSince` added to the `ready` variant.

Flow:

1. Mount → `getSession()`. No session → `guest` (no request). (Unchanged, LLD 90.)
2. Session present → `load("lifetime")` (default).
3. `load(window)`: set `loading` → `fetchStats(window)`.
   - success → `ready` with `games` and `trackingSince` from the response.
   - failure → `error`.
4. Select a window (tap / arrow key / swipe) → set `selectedWindow` → `load(window)`.
5. Retry (error state) → `load(selectedWindow)`.

The server is the sole source of the numbers (architecture principle 1). The client
neither computes nor caches stats across window changes — each window is a fresh
fetch (no memoization; the volume is tiny and staleness would mislead).

## Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | **Lifetime default render** | Pixel-identical to #40 apart from the added selector; `fetchStats("lifetime")` issues the no-query request; `trackingSince` ignored (backend returns `null` on lifetime) → note not shown. |
| 2 | **Switch to 30d/YTD, has data** | Re-fetch with `?window=`; render that window's cards; show tracking-since note if `trackingSince` non-null. |
| 3 | **Empty window** (`games:[]` on 30d/ytd) | Distinct "No games finished in this range yet. Try Lifetime…" message; **no** Create-a-Game CTA; tracking-since note still shown if `trackingSince` present. |
| 4 | **Never played** (`games:[]` on lifetime) | Existing "You haven't finished any games yet." + Create-a-Game CTA. Unchanged. |
| 5 | **`trackingSince` null on a window** | Note is omitted (new user, or backend returned null). Empty-window / populated rendering is otherwise unaffected. |
| 6 | **Windowed fetch fails** | Reuse the `error` state (message + Retry). Retry re-fetches the **selected** window, not lifetime. |
| 7 | **Guest** | Selector not rendered; guest CTA state unchanged; no request; `requiresAuth` route guard still redirects a signed-out deep-link (LLD 90). |
| 8 | **Rapid window switches / in-flight race** | Guard against a stale response overwriting a newer selection: capture the window at call time and ignore a resolved response whose window ≠ current `selectedWindow` (a request-token/latest-wins check). Prevents an older 30d response clobbering a newer YTD view. |
| 9 | **Swipe at the ends** | Clamp — swipe-right on Lifetime and swipe-left on YTD are no-ops (no wrap-around). |
| 10 | **Swipe vs. vertical scroll** | Only horizontal-dominant gestures past the threshold change the window; vertical/ambiguous gestures fall through to normal page scroll. |
| 11 | **`prefers-reduced-motion: reduce`** | Thumb slides instantly (no transition) and the list-swap fade is disabled. Selection still works. |
| 12 | **Invalid/unparseable `trackingSince`** | Render no note rather than "Invalid Date". |
| 13 | **401 mid-session on a windowed fetch** | Treated as `error` (LLD 90 E7); retry re-attempts. Do not blank the page. |
| 14 | **Unknown window can't be sent** | The UI only emits the three known literals; the backend's 400 path (LLD 101 E5) is unreachable from this UI but, if hit, surfaces as the `error` state. |

## Dependencies

| Dependency | Status | Why |
|------------|--------|-----|
| `GET /stats?window=…` returning `window` + `trackingSince` | Shipped (LLD 101, `0434921`, live in prod) | The endpoint this UI drives. Frozen — no change. |
| `StatsWindow` / `GetStatsResponse` / `GameStatsEntry` in `src/shared/model.ts` | Shipped (LLD 101) | Types consumed directly; no additions. |
| `src/frontend/service/statsService.ts` (`fetchStats`) | Shipped (LLD 90) | Gains the `window` param; lifetime request unchanged. |
| `src/frontend/component/StatsView.vue` | Shipped (LLD 90) | Gains the selector, swipe, tracking-since note, empty-window state. |
| `src/frontend/component/statsView.ts` (pure formatting) | Shipped (LLD 90) | Reused as-is; window-label constant optional. |
| `axiosInstance` + auth interceptor (`src/frontend/service/http.ts`); `getSession()` (`authService.ts`); `/stats` route + `requiresAuth` guard | Shipped (LLD 90) | Unchanged transport/auth/routing. |
| Existing `tests/frontend/` node-env harness pattern (no jsdom / `@vue/test-utils`) | Shipped | The test convention this LLD follows (A4). No new test tooling. |

No CEO escalation. The CX doc's stats screen implies exactly this time-range control;
this completes the deferred #40 step with no CX conflict. No architecture-principle
conflict (client stays a thin renderer; all numbers are server-authoritative).

## Test Requirements

Follow the project convention (A4): **vitest `node` env, no component mounting, no new
tooling.** Extend the three existing files; add none that require a DOM. Existing
`StatsView` / `statsService` / `statsView` tests must still pass.

### Unit — `tests/frontend/statsService.test.ts` (extend)

- `fetchStats("lifetime")` calls `GET /api/stats` with **no** query string
  (assert the exact argument is `"/api/stats"` — guards the no-regression path).
- `fetchStats("30d")` calls `GET /api/stats?window=30d`; `fetchStats("ytd")` calls
  `GET /api/stats?window=ytd`.
- Returns the parsed `GetStatsResponse` (including `window` + `trackingSince`);
  propagates HTTP errors to the caller (rejects). (Keep the existing two cases;
  update them to pass a `window`.)

### Unit — `tests/frontend/StatsView.test.ts` (extend the load()/state harness)

Transcribe the extended `load(window)` + window/empty-branch logic into the existing
node-env harness (keep it in lockstep with `<script setup>`):

- Default window is `"lifetime"`; initial `load` calls `fetchStats` with
  `"lifetime"`.
- Selecting `"30d"` / `"ytd"` calls `fetchStats` with that window and produces a
  `ready` state carrying that window's `games` and `trackingSince`.
- **Empty-window vs never-played discriminator** (pure branch function): given
  `games: []` + window `"lifetime"` → never-played branch (Create CTA); given
  `games: []` + window `"30d"`/`"ytd"` → empty-window branch (no CTA). Assert the two
  branches are distinct.
- **Tracking-since visibility rule** (pure predicate): shown iff window ≠ lifetime
  **and** `trackingSince` non-null. Cover: lifetime + non-null → hidden;
  30d + null → hidden; 30d + non-null → shown.
- **Latest-wins race guard** (E8): simulate a stale (earlier-window) response
  resolving after a newer selection; assert the stale response does not overwrite the
  newer window's `ready` state.
- Retry (error state) re-invokes `fetchStats` with the **selected** window, not
  lifetime.
- Guest short-circuit unchanged: `fetchStats` not called.

### Structural — `tests/frontend/StatsView.test.ts` or a co-located source-read test

Following the `gameLobbyScroll.test.ts` string-assertion idiom (read `StatsView.vue`
as text) for contracts that node-env can't render:

- The selector markup exists with three segments labelled Lifetime / Last 30 days /
  Year to date, uses `role="tab"`/`role="tablist"` (or radio) semantics, and has a
  `:focus-visible` rule (assert the selector/class is present).
- A `prefers-reduced-motion: reduce` block disables the thumb transition and the
  list-swap fade (assert the media query governs those rules).
- The lifetime caption string "Lifetime totals across all your games." is still
  present (no-regression guard).

### E2E / QA-manual (runtime-only — cannot be node-env unit-tested)

Add to the Playwright stats spec (or specify for QA if no such spec exists yet):

- Selecting each tab re-fetches and renders that window's numbers; the gold thumb
  slides to the selected segment with the required inset (not flush to edges).
- Mobile **swipe** left/right advances/retreats the window (clamped at the ends) and
  does not hijack vertical scroll.
- Keyboard: arrow keys move selection, Enter/Space activate, focus-visible outline is
  shown.
- Lifetime view is visually unchanged vs. the current page (regression check).
- Empty-window message renders distinctly from the never-played state; tracking-since
  note appears only on 30d/YTD when present.

No new backend/integration/security tests: no new network surface, no new
information-leakage surface (the page shows only the caller's own stats, already
scoped to `request.userId` server-side).
