# LLD 91: Capture rendered view context (game phase + auth state) in feedback metadata, not just route

## Scope

**Covers:** Extending the data the feedback widget captures so triage can reconstruct the screen the user actually saw, not infer it from `route.fullPath` + prose. Two additive metadata fields:

1. `gamePhase` — `"lobby" | "in-progress" | "game-over" | undefined`, derived from the **live game state** when on `/game/:gameId`, `undefined` everywhere else.
2. `authState` — `"authenticated" | "anonymous"`, reflecting which auth variant of the route rendered. A **different axis** from the existing `userType` (guest vs registered account); both are kept.

**Explicitly does NOT cover:**
- The verification/triage side (rendering signed-in state during triage) — that is #67, out of scope here.
- Any change to backend validation, the `POST /api/feedback` contract, or the `feedback` table schema. `metadata` is an opaque `JSONB` blob (verified — see Dependencies); these fields are additive and require **no migration**.
- Removing, renaming, or collapsing any existing metadata field (`route`, `gameId`, `userType`, `browser`, `viewport`, `timestamp`).
- Refactoring `FeedbackWidget.vue`, the feedback service, or `useGameState`.
- Capturing finer game sub-states (e.g. `SHOW_FINAL_PLAY`) — that final-play ribbon is grouped under `in-progress` for triage purposes (see Edge Cases).

## Approach

### Why not derive phase from the route

`/game/:gameId` renders lobby, active play, the final-play ribbon, and the game-over screen as **conditional sub-views inside `GameView.vue`** (`displayPhase` ref: `CREATED | IN_PROGRESS | SHOW_FINAL_PLAY | COMPLETED`), all under one route. The route string cannot distinguish them — that collision is the bug. The metadata must read the **same reactive source `GameView.vue` uses to choose which sub-view to render**, so the captured phase matches what was on screen.

### The coupling problem and chosen solution

`FeedbackWidget.vue` is mounted in `App.vue` as a **sibling of `<router-view>`**. It has no parent/child relationship to `GameView.vue`, so it cannot read `GameView`'s component-local `displayPhase`. Note also that `useGameState()` is **not a singleton** — each call creates fresh local refs (verified in `src/frontend/composables/useGameState.ts`), so the widget calling `useGameState()` would get a disconnected, always-`null` instance. The widget needs a shared handle to the *currently rendered* phase.

**Options considered:**

- **Option 1 — Shared module-level reactive store (`useFeedbackContext`). RECOMMENDED.** A tiny new composable backed by module-scoped reactive refs. `GameView.vue` publishes its current phase to it (via a `watch` on `displayPhase`) and clears it on unmount. `FeedbackWidget.vue` reads it inside `buildMetadata()`. One writer, one reader, no prop drilling, no router coupling. Cost: one new ~15-line file + ~4 lines in `GameView.vue`.
- **Option 2 — `provide`/`inject` from `App.vue`.** `App.vue` provides a reactive ref; `GameView` injects+writes it, widget injects+reads it. Works, but `App.vue` is the wrong owner of game phase, and it spreads the change across three files instead of two. Rejected.
- **Option 3 — Re-derive phase in the widget from a shared game-state store.** Heavier: requires making game state a singleton and re-implementing the `status → displayPhase` mapping (including the `SHOW_FINAL_PLAY` transition logic) in a second place. Duplicates logic and risks drift from what actually rendered. Rejected.

Option 1 keeps the change surgical and keeps the single source of truth for "what rendered" in `GameView.vue`, merely *publishing* it for the widget to read.

### authState

`authState` is read directly in `buildMetadata()` from the auth session — the same `!!session` check `App.vue` already uses to pick the authenticated vs public nav variant (`src/frontend/component/App.vue:32`). Capturing it in the widget (rather than threading it through the shared store) keeps it co-located with the other session-derived field (`userType`) and reads the live auth state at submit time. `getSession()` is async; `buildMetadata()` becomes async (see Interfaces).

### Keep both axes

`userType` answers "what kind of identity is this user" (guest token vs registered Supabase account). `authState` answers "which auth variant of the route rendered" (signed-in layout vs logged-out layout). These diverge: a registered user who is signed out renders the anonymous variant. Both are retained, unchanged in meaning.

## Interfaces / Types

### New composable: `src/frontend/composables/useFeedbackContext.ts`

Module-scoped shared reactive state. The phase vocabulary is the **triage-facing** vocabulary (`lobby | in-progress | game-over`), mapped from `GameView`'s internal `DisplayPhase`.

```ts
import { ref, readonly } from "vue";
import type { Ref, DeepReadonly } from "vue";

export type FeedbackGamePhase = "lobby" | "in-progress" | "game-over";

const gamePhase = ref<FeedbackGamePhase | undefined>(undefined);

export function useFeedbackContext(): {
  gamePhase: DeepReadonly<Ref<FeedbackGamePhase | undefined>>;
  setGamePhase(phase: FeedbackGamePhase | undefined): void;
  clearGamePhase(): void;
} {
  return {
    gamePhase: readonly(gamePhase),
    setGamePhase: (phase) => { gamePhase.value = phase; },
    clearGamePhase: () => { gamePhase.value = undefined; },
  };
}
```

### Extended metadata contract: `src/backend/database/entities/Feedback.ts`

The widget sends an untyped object literal; the backend treats `metadata` as opaque. `FeedbackMetadata` is the only typed contract and lives backend-side. Extend it additively:

```ts
export interface FeedbackMetadata {
  route: string;
  gameId?: string;
  gameStatus?: string;            // pre-existing, unused by widget — leave as-is, do not remove
  gamePhase?: "lobby" | "in-progress" | "game-over"; // NEW — undefined off /game/:gameId
  userType: "guest" | "registered";
  authState: "authenticated" | "anonymous";          // NEW
  browser: string;
  viewport: { width: number; height: number };
  timestamp: string;
}
```

Note: `authState` is declared **required** (the widget always sets it). `gamePhase` is optional (absent off the game route). Pre-existing rows lack both keys; the admin read path (`GET /api/feedback`) returns `metadata` verbatim, so old rows simply omit the new keys — no backfill, no read breakage.

### Changed function: `buildMetadata()` in `src/frontend/component/FeedbackWidget.vue`

Becomes `async` (auth lookup). Returned object gains `gamePhase` and `authState`; all existing keys unchanged.

```ts
async function buildMetadata() {
  const session = await getSession();          // from @/service/authService
  const guestSession = restoreGuestSession();
  const { gamePhase } = useFeedbackContext();
  return {
    route: route.fullPath,
    gameId: (route.params.gameId as string) || undefined,
    gamePhase: gamePhase.value,                 // NEW
    userType: guestSession ? "guest" : "registered",
    authState: session ? "authenticated" : "anonymous", // NEW
    browser: navigator.userAgent.slice(0, 200),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    timestamp: new Date().toISOString(),
  };
}
```

`submit()` already `await`s `buildMetadata()`'s result inside the `axiosInstance.post` payload via the call site; change the call to `await buildMetadata()`.

> Implementer note: `userType` currently keys off `restoreGuestSession()` (unchanged). `authState` keys off the Supabase `getSession()` — these are independent calls. Do not merge them.

### Changed component: `src/frontend/component/game/GameView.vue`

Publish the rendered phase to the shared store. Map the internal `DisplayPhase` to the triage vocabulary:

| `displayPhase` (internal) | `FeedbackGamePhase` (published) |
| ------------------------- | ------------------------------- |
| `CREATED`                 | `lobby`                         |
| `IN_PROGRESS`             | `in-progress`                   |
| `SHOW_FINAL_PLAY`         | `in-progress`                   |
| `COMPLETED`               | `game-over`                     |

Add a `watch(displayPhase, …, { immediate: true })` calling `setGamePhase(mapped)`, and `clearGamePhase()` in the existing `onUnmounted`. No other `GameView` logic changes.

## State Model

- **`gamePhase` (shared store):** in-memory only, module-scoped, single source. Written by `GameView.vue` whenever `displayPhase` changes; cleared on `GameView` unmount (route leave / rematch remount). Read by the widget at submit time. Never persisted client-side.
- **`authState`:** not stored anywhere; computed fresh at submit time from the live Supabase session.
- **Persisted:** only the final metadata blob, written once per submission into `feedback.metadata` (`JSONB`). Round-tripped opaquely by `SupabaseDB.createFeedback`/`mapFeedback` and `GET /api/feedback` — no per-field column mapping, confirming the additive fields need no backend data-layer change.

Lifecycle: user navigates to `/game/:id` → `GameView` mounts, `watch(immediate)` sets phase to `lobby` → game starts → phase `in-progress` → game ends → phase `game-over`. User opens feedback widget at any point → `buildMetadata()` reads the current phase + live auth state → submits. User leaves the game route → `onUnmounted` → `clearGamePhase()` → phase back to `undefined`.

## Edge Cases

1. **Feedback opened off `/game/:gameId`** (home, login, profile): `GameView` never mounted (or already unmounted), store is `undefined` → `gamePhase` omitted from payload. Correct.
2. **`SHOW_FINAL_PLAY` (final-play ribbon over the board):** still the in-game board, so published as `in-progress`. The user is looking at cards on the table, not the results screen. Triage treats the ribbon as part of in-progress.
3. **Rematch navigation** (`/game/<old>` → `/game/<new>`): `App.vue`'s `routeViewKey` forces a `GameView` remount, so `onUnmounted` (clear) then re-mount + `watch(immediate)` (set `lobby`) fire. Store ends correct for the new game.
4. **Direct landing on a `COMPLETED` game URL:** `GameView` mounts, fetches state, `effectiveStatus` resolves to `COMPLETED`, `displayPhase` → `COMPLETED` → published `game-over`. Captured correctly even though the user never saw lobby/in-progress.
5. **Pre-socket / loading state on the game route** (`displayPhase` still defaults to `CREATED` before `game:state` arrives): published as `lobby`. Acceptable — the visible screen is either the lobby or the "Connecting…" spinner, both pre-play. Not worth a distinct value.
6. **`getSession()` throws/rejects** (auth backend hiccup at submit time): `buildMetadata()` must not block submission. Wrap the session lookup so a failure yields `authState: "anonymous"` rather than rejecting — feedback submission is best-effort and must never fail on a metadata lookup. (Same defensiveness the existing `submit()` already has around the POST.)
7. **Stale store after unmount via an unexpected teardown path:** `onUnmounted` clears it; Vue guarantees `onUnmounted` runs on route leave. If a future code path bypasses it, worst case is a stale `gamePhase` on a non-game route — low harm, and the `route`/`gameId` fields already disambiguate that the user is off the game route. No extra guard needed for this low-priority change.
8. **Registered-but-signed-out user:** `userType: "registered"`-equivalent is driven by guest session presence (`userType` stays `registered` when no guest session), while `authState: "anonymous"`. This divergence is exactly the signal #66 needed and is captured correctly.

## Frontend Design

**Decision: Option A — capture silently; optionally surface the captured context as expandable, read-only "context" for transparency.**

The user does not and should not need to curate what metadata is attached — `gamePhase`/`authState` are diagnostic context, captured automatically like `browser` and `viewport` already are. There is **no new required input** and **no change to the submit flow**.

For transparency, the modal **may** include a collapsed, non-editable disclosure (e.g. a `<details>`/"What we include" affordance) listing the auto-captured context (route, screen/phase, auth state, browser, viewport). This is optional polish, not load-bearing for the issue's "Done when" criteria. If included:
- It is read-only — no toggles to include/exclude fields.
- It is collapsed by default so it does not compete with the description field.
- It must not introduce a blocking step or change button placement/behavior.

Because this is a no-visual-required, opt-in disclosure on an existing modal, a full mockup-review cycle is **not** required to capture the metadata (the core of this issue). If the implementer chooses to add the disclosure UI, that visual addition should go through the `frontend-architect` mockup step before implementation; the metadata capture can ship independently of it.

## Dependencies

**Must already exist (all verified present):**
- `FeedbackWidget.vue` `buildMetadata()` reading `route.params.gameId` — `src/frontend/component/FeedbackWidget.vue`.
- `GameView.vue` `displayPhase` ref + `onUnmounted` — `src/frontend/component/game/GameView.vue`.
- `getSession()` — `src/frontend/service/authService.ts`.
- `FeedbackMetadata` type — `src/backend/database/entities/Feedback.ts`.
- `feedback.metadata` is a `JSONB` column (`supabase/migrations/001_create_tables.sql:31`); backend stores/reads it opaquely (`SupabaseDB.createFeedback`/`mapFeedback`, `submitFeedback.ts` casts metadata to `any`). **Confirmed: no schema migration, no backend handler/validation change needed.** If a future implementer finds metadata stored as structured columns instead, STOP and flag — do not add a migration for this priority:low change.

**New artifact created by this LLD:** `src/frontend/composables/useFeedbackContext.ts`.

**No upstream LLD blocks this.** Related (informational only): LLD 9 (original feedback widget); issues #66 (auth-state gap this closes) and #67 (triage-side verification, separate).

## Test Requirements

Frontend unit tests (Vitest + Vue Test Utils, matching existing widget/composable test style). No backend tests required (no backend change).

**Unit — `useFeedbackContext`:**
- `setGamePhase` updates the shared ref; a second reader observes the new value (proves shared/singleton semantics, not per-call refs).
- `clearGamePhase` resets to `undefined`.
- Returned `gamePhase` is read-only (mutating it directly does not change the store).

**Unit — `buildMetadata()` in `FeedbackWidget.vue`:**
- On a game route with store phase `lobby` / `in-progress` / `game-over` → metadata `gamePhase` matches; the three are distinguishable. (Directly satisfies "game-over vs in-progress vs lobby distinguishable".)
- Off the game route (store `undefined`) → `gamePhase` is absent/`undefined`.
- Authenticated session present → `authState: "authenticated"`; no session → `authState: "anonymous"`. Distinguishable. (Satisfies the auth-variant "Done when".)
- `authState` and `userType` are independent: registered-but-signed-out yields `userType: "registered"`-path with `authState: "anonymous"` (assert both fields, both axes preserved).
- `getSession()` rejecting → `buildMetadata()` still resolves with `authState: "anonymous"` and does not throw (Edge Case 6).
- All pre-existing keys (`route`, `gameId`, `userType`, `browser`, `viewport`, `timestamp`) still present and unchanged.

**Unit — `GameView.vue` phase publishing:**
- Each `displayPhase` value maps to the correct `FeedbackGamePhase` per the mapping table, including `SHOW_FINAL_PLAY → in-progress`.
- Unmounting `GameView` calls `clearGamePhase()` (store returns to `undefined`).

**Integration (optional, lightweight):**
- Mount `App` shell with a stubbed game route, drive `displayPhase` to `COMPLETED`, open the widget, assert the submitted payload's `metadata.gamePhase === "game-over"`. End-to-end proof that the widget reads what `GameView` published.

**Not tested (out of scope / framework behavior):** the `POST /api/feedback` endpoint, JSONB persistence, and admin read path — unchanged and already covered by LLD 9 / 40 tests.
