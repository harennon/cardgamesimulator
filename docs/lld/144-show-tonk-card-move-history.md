# LLD 144: Show card/move history in Tonk (like Big2), including the final move

## Scope

Surface Tonk's move history in two places where it is currently missing, reusing existing components and helpers:

1. **Desktop board side rail** — add a segmented `Tallies / Game Log` switch to the side rail (`grid-area: log`) in `TonkBoard.vue`. The active view fills the full rail height. **Tallies stays the default**; the log is one click away. The log auto-scrolls to the latest entry (already handled by `TonkLog.vue`).
2. **Game-over screen** — add a Tonk **"Final Move"** block to `GameOverView.vue`, mirroring Big2's "Final Play" block. It shows the terminal move (TONK call or stock-out) plus the trick outcome (reason + per-seat revealed hand values and tally deltas), driven off the newest log entry's `trickResult`.

**Explicitly NOT covered:**

- No server/engine changes. All data already lives in `TonkPublicState.log` (`TonkLogEntry[]` with `trickResult`). This is UI wiring only.
- No changes to `TonkLog.vue`, `TonkTallyPanel.vue`, or `tonkDisplay.ts` internals — they are reused as-is (`logActionText`, `trickResultSummary`).
- No changes to mobile Tonk behavior. The existing hamburger log drawer (`isMobile` branch, teleported `.tonk-log-drawer`) is preserved unchanged.
- No changes to Big2's board, game-over "Final Play", or the Big2 `SHOW_FINAL_PLAY` reveal overlay.
- No shared-type changes (`tonk-types.ts`, `big2-types.ts`, `engine-types.ts` untouched).

## Approach

**Desktop side rail (Option A — segmented toggle).** Today `TonkBoard.vue` unconditionally renders `TonkTallyPanel` in `.tonk-board__log` (lines 63–69). Replace the panel's direct mount with a small local view-switch:

- Add a local reactive `sideView: Ref<"tallies" | "log">`, default `"tallies"`.
- Render a segmented control (two buttons) at the top of `.tonk-board__log`, then render `TonkTallyPanel` when `sideView === "tallies"` and `TonkLog` when `sideView === "log"`. Both already fill height (`height: 100%`) and carry their own header; the segmented control sits above them inside the same grid cell.
- The switch is **desktop-only**: it lives inside `.tonk-board__log`, which is already `display: none` on mobile (line 388). Mobile continues to use the drawer. `TonkLog` is therefore mounted in two places on desktop-vs-mobile but never simultaneously visible; that is acceptable and matches how Big2 mounts `GameLog` twice (side rail + drawer).
- Auto-scroll: when the user switches to the log view, `TonkLog`'s existing `watch(() => scrollEl.value, ...)` fires on mount and scrolls to the latest entry. The length-watch keeps it pinned as new entries arrive while the view is active. No new scroll logic is needed. (Note: if the log view is not currently mounted, entries appended while `Tallies` is shown are scrolled into view the next time the user opens the log, because the ref-watch runs on mount — acceptable per acceptance criteria.)

Rationale: a toggle keeps both views full-height and legible in the narrow 280px rail, keeps Tallies as the default (no regression for existing users), and reuses both panels verbatim. A split (stacked half-height) view was rejected because 280px-wide half-panels would truncate both the tally bars and the log entries.

**Game over (Option 1 — minimal "Final Move" block).** `GameOverView.vue` currently derives its final-play block from Big2-only props (`finalPlay: Big2Play | null`, `playHistory: Big2HistoryEntry[]`). `GameView.vue` derives those as `undefined`/`null` for Tonk (lines 279–316) and a comment at 229–232 notes "Tonk has no final-play concept."

Approach: add a **new, optional, Tonk-specific prop** to `GameOverView.vue` rather than overloading the Big2 `finalPlay` prop (which is a `Big2Play` shape and semantically different). The two blocks are mutually exclusive by game type and never both render.

- New prop `tonkFinalMove?: TonkFinalMove | null` (shape below), derived in `GameView.vue` from the newest `TonkPublicState.log` entry.
- `GameOverView.vue` renders the Tonk "Final Move" block iff `tonkFinalMove` is present; renders the Big2 "Final Play" block iff `finalPlay` is present (unchanged). A single game only ever supplies one of the two.
- The block reuses `logActionText` (for the terminal action line, e.g. "called TONK") and `trickResultSummary` (for the outcome line) from `tonkDisplay.ts`. No new rendering logic.

Rationale: keeping the props type-distinct avoids widening `Big2Play` to a union (which would ripple into the Big2 path and its tests) and keeps each block's derivation self-contained. It satisfies "extend so Tonk supplies its final-move data without breaking the Big2 path."

## Interfaces / Types

### `GameView.vue` — new derived value

Derive the Tonk final move from the last log entry. The "final move" is the terminating action (the TONK call, or the discard/draw that emptied the stock) plus the trick result appended to that same entry.

```ts
// New frontend-only view type (declared in GameView.vue or a small local module;
// NOT added to shared types — it is a presentational projection of TonkLogEntry).
interface TonkFinalMove {
  entry: TonkLogEntry;                 // the newest log entry (its trickResult is the outcome)
  players: readonly PlayerPublicInfo[]; // for trickResultSummary name resolution
}

const tonkFinalMove = computed<TonkFinalMove | null>(() => {
  if (gameState.value?.gameType !== "tonk") return null;
  const publicState = gameState.value.gameSpecificPublicState as
    | TonkPublicState
    | undefined;
  const log = publicState?.log;
  if (!log || log.length === 0) return null;
  const entry = log[log.length - 1];
  // Only surface a "Final Move" when the last entry actually closed the trick;
  // otherwise there is nothing terminal to show (defensive — see E3).
  if (!entry.trickResult) return null;
  return { entry, players: gameState.value.players };
});
```

Pass it to `GameOverView`:

```html
<GameOverView
  ...
  :final-play="finalPlay"          <!-- Big2 only; null for Tonk -->
  :tonk-final-move="tonkFinalMove" <!-- Tonk only; null for Big2 -->
  ...
/>
```

### `GameOverView.vue` — new prop + computeds

```ts
import type { TonkLogEntry } from "@shared/tonk-types";
import { logActionText, trickResultSummary } from "@/component/game-ui/tonkDisplay";

interface TonkFinalMove {
  entry: TonkLogEntry;
  players: readonly PlayerPublicInfo[];
}

const props = defineProps<{
  // ...existing props unchanged...
  finalPlay?: Big2Play | null;         // existing (Big2)
  tonkFinalMove?: TonkFinalMove | null; // NEW (Tonk)
}>();

const hasTonkFinalMove = computed(() => !!props.tonkFinalMove);

const tonkFinalMoveAction = computed(() =>
  props.tonkFinalMove ? logActionText(props.tonkFinalMove.entry) : "",
);
const tonkFinalMoveBy = computed(
  () => props.tonkFinalMove?.entry.displayName ?? "",
);
const tonkFinalMoveOutcome = computed(() =>
  props.tonkFinalMove
    ? trickResultSummary(props.tonkFinalMove.entry, props.tonkFinalMove.players) ?? ""
    : "",
);
```

Template (new block, placed where the Big2 `game-over__final-play` block is; both are `v-if`-gated and mutually exclusive):

```html
<div
  v-if="hasTonkFinalMove"
  class="game-over__final-play"
  data-testid="game-over-tonk-final-move"
>
  <div class="game-over__final-play-label">Final Move</div>
  <div class="game-over__final-play-meta">
    {{ tonkFinalMoveBy }} {{ tonkFinalMoveAction }}
  </div>
  <div class="game-over__final-play-meta">{{ tonkFinalMoveOutcome }}</div>
</div>
```

No new CSS classes are required — reuse the existing `game-over__final-play*` styles.

### `TonkBoard.vue` — side-rail toggle

```ts
type SideView = "tallies" | "log";
const sideView = ref<SideView>("tallies");
```

Template — replace the current `.tonk-board__log` body (lines 63–69):

```html
<div class="tonk-board__log">
  <div class="tonk-side-switch" role="tablist" data-testid="tonk-side-switch">
    <button
      role="tab"
      :aria-selected="sideView === 'tallies'"
      :class="{ 'tonk-side-switch__btn--active': sideView === 'tallies' }"
      data-testid="tonk-side-switch-tallies"
      @click="sideView = 'tallies'"
    >
      Tallies
    </button>
    <button
      role="tab"
      :aria-selected="sideView === 'log'"
      :class="{ 'tonk-side-switch__btn--active': sideView === 'log' }"
      data-testid="tonk-side-switch-log"
      @click="sideView = 'log'"
    >
      Game Log
    </button>
  </div>
  <div class="tonk-board__log-body">
    <TonkTallyPanel
      v-if="sideView === 'tallies'"
      :players="gameState.players"
      :tallies="tonkState.tallies"
      :trick-number="tonkState.trickNumber"
    />
    <TonkLog
      v-else
      :entries="tonkState.log"
      :players="gameState.players"
    />
  </div>
</div>
```

`.tonk-board__log` becomes a column flexbox: fixed-height switch on top, `.tonk-board__log-body { flex: 1; min-height: 0 }` holding the active full-height panel. `TonkLog` is already imported (line 127); the mobile drawer keeps using it.

## State Model

- **All state is presentational and derived from `TonkPublicState`**, which the server already sends via `getPlayerView`/`getSpectatorView`. No new persisted state, no new socket events, no engine change.
- `sideView` is **ephemeral, per-client, in-memory** component state in `TonkBoard.vue`. It does not persist across reloads or navigation and is never sent to the server. Default `"tallies"`.
- `tonkFinalMove` in `GameView.vue` is a **pure computed** over the already-received `gameState`. It is recomputed reactively; at `COMPLETED` the last log entry carries the terminal `trickResult`.
- Information hiding is preserved by construction: the block only reads `TonkLogEntry` fields, which are already public (revealed hands at trick end are intentionally public per `tonk-types.ts` — they are the same `revealedHands` shown in the log during play). No hidden data (stock contents, live opponent hands) is introduced.

## Edge Cases

1. **Log empty at game over (no trick ever completed).** `tonkFinalMove` returns `null` → the Final Move block does not render; the winner + scores still show. (Should not happen for a normal completion, but defensive.)
2. **Last log entry has no `trickResult` (e.g. a mid-trick discard/draw is somehow the last entry).** Guard returns `null` → block hidden. Only a trick-closing entry surfaces a "Final Move."
3. **`trickResultSummary` returns `null`.** Falsy-coalesced to `""` → the outcome line renders empty (the action line still shows). No crash.
4. **Tonk board while log is empty (trick 1, no moves yet).** Switching to Game Log shows `TonkLog` with zero entries (its `v-for` renders nothing, header still shows). No crash; matches existing mobile-drawer behavior.
5. **Spectator view (`myPlayerIndex === -1`).** The side-rail toggle and both panels render from public state only; spectators can use the toggle. The game-over Final Move block reads public log data → renders identically for spectators.
6. **Mobile.** `.tonk-board__log` is `display: none` on mobile, so the new switch never appears there; the hamburger drawer (`TonkLog`) is untouched. The game-over Final Move block is inside `GameOverView` and renders on both breakpoints (its meta text wraps; existing mobile CSS already handles the panel width).
7. **Big2 game over.** `tonkFinalMove` is `null` (guarded on `gameType !== "tonk"`), so the Tonk block never renders for Big2; the existing Big2 "Final Play" block is unchanged.
8. **Both props somehow set.** Not possible from `GameView.vue` (each is `null` for the other game type), but the two `v-if` blocks are independent, so even if both were set, each renders once — no crash. Derivation guarantees mutual exclusivity.
9. **Switching side view mid-game does not lose scroll position on return.** `TonkLog` re-mounts on switch and its ref-watch scrolls to the latest entry — the intended behavior (always show newest), not a bug.

## Dependencies

- **Existing components reused as-is:** `TonkLog.vue`, `TonkTallyPanel.vue` (`src/frontend/component/game-ui/`).
- **Existing helpers reused as-is:** `logActionText`, `trickResultSummary` from `src/frontend/component/game-ui/tonkDisplay.ts`.
- **Existing types (unchanged):** `TonkPublicState`, `TonkLogEntry`, `TonkTrickResult` from `src/shared/tonk-types.ts`; `PlayerPublicInfo` from `src/shared/engine-types.ts`.
- **Files modified:** `src/frontend/component/game/TonkBoard.vue`, `src/frontend/component/game/GameOverView.vue`, `src/frontend/component/game/GameView.vue`.
- No upstream LLD is blocking. Builds on LLD 88 (Tonk board/log/tally components) and LLD 73 (Big2 game-over Final Play block, the pattern being mirrored). No migration, no backend, no new socket event.

## Frontend Design

**Approved direction: Option A (segmented Tallies/Game Log toggle in the desktop side rail) + Option 1 (minimal "Final Move" block on game over).** This is UI wiring only — reuse `TonkLog.vue`, `TonkTallyPanel.vue`, and `tonkDisplay.ts` as-is; do not duplicate rendering; do not touch the engine or shared types.

**Desktop side rail (Option A).** One panel in the existing 280px `grid-area: log` cell, with a `Tallies / Game Log` segmented switch pinned at the top:

- **Tallies is the default** (one click away), so existing users see no change on load; the log is opt-in.
- The **active view takes the full rail height** below the switch (`.tonk-board__log-body { flex: 1; min-height: 0 }`); each panel keeps its own header and internal scroll.
- The switch styling matches the felt/gold theme (reuse `--gold-accent`, `--panel-bg`, `--table-rim-light` tokens): two equal-width buttons, the active one filled/gold-underlined, the inactive one muted. Buttons expose `role="tab"` + `aria-selected` for accessibility.
- The **Game Log auto-scrolls to the latest entry** via `TonkLog`'s existing watchers — no new logic.
- Rejected alternative — split (stacked half-height tallies + log): both panels truncate badly at 280px. Toggle preserves full legibility of each.

**Mobile (unchanged).** `.tonk-board__log` is `display: none` on mobile; the hamburger button + teleported log drawer stay exactly as they are. The new switch is desktop-only by virtue of living in the hidden cell.

**Game over (Option 1).** A compact "Final Move" block mirroring Big2's "Final Play," placed in the same position in `GameOverView.vue` and reusing the `game-over__final-play*` styles:

- **Label:** "Final Move".
- **Line 1 (the terminal action):** `<displayName> <logActionText(entry)>` — e.g. "Bob called TONK" or "Cara drew from stock" (the move that ended the round).
- **Line 2 (the outcome):** `trickResultSummary(entry, players)` — e.g. "Trick 3 ended — TONK called. Me: 12 (+12), Bob: 4 (+4), Cara: 20 (+20)".
- No card sprites are required (Tonk's terminal action is a call/stock-out, not a played combination); the block is text-only and reuses the existing meta styling. It renders on both desktop and mobile breakpoints.
- Rejected alternative — a richer block rendering the full revealed hands as card rows (Option 2): more visual weight than the reported need ("see what the last move was") and duplicates rendering the log already covers. Option 1 satisfies the acceptance criterion with the least surface area.

## Test Requirements

All tests follow the project's isolated `<script setup>`-transcription pattern (node env, no DOM mount), matching `tonkBoard.test.ts` and `gameOverFinalPlay.test.ts`.

### Unit — `GameView.vue` `tonkFinalMove` derivation (new test file, e.g. `tests/frontend/tonkFinalMove.test.ts`)

- Returns `null` when `gameType !== "tonk"` (Big2 path).
- Returns `null` when the Tonk log is empty.
- Returns `null` when the last log entry has no `trickResult`.
- Returns `{ entry, players }` with the **newest** entry when the last entry carries a `trickResult` (assert it picks `log[log.length - 1]`, not an earlier trick-result entry).

### Unit — `GameOverView.vue` Tonk Final Move gating + labels (extend/add alongside `gameOverFinalPlay.test.ts`)

- `hasTonkFinalMove` is `true` iff `tonkFinalMove` is present; `false` when `null`/`undefined`.
- `tonkFinalMoveAction` equals `logActionText(entry)` for a `callTonk` entry ("called TONK") and for a `draw` entry ("drew from stock"/"from discard").
- `tonkFinalMoveBy` equals the entry's `displayName`.
- `tonkFinalMoveOutcome` equals `trickResultSummary(entry, players)`; coalesces to `""` when the summary is `null` (no crash).
- **Mutual exclusivity:** with a Big2 `finalPlay` set and `tonkFinalMove` null, the Tonk block does not render (`hasTonkFinalMove === false`) and the Big2 block is unaffected — and vice versa.

### Unit — `TonkBoard.vue` side-view switch (extend `tonkBoard.test.ts`)

- `sideView` defaults to `"tallies"`.
- Toggling `sideView` to `"log"` selects the log branch and to `"tallies"` selects the tally branch (assert the computed/branch that gates which child renders).
- The switch logic is independent of `isMobile` (the cell is CSS-hidden on mobile; assert the toggle state machine itself, not the media query).

### Not required (rationale)

- No new engine/invariant/information-leakage tests: no engine or shared-type change; the data surface (`TonkPublicState.log`) is unchanged and already covered by LLD 88 tests, and the block reads only already-public fields.
- No new tests for `TonkLog.vue` auto-scroll or `trickResultSummary`/`logActionText` output shape — those are pre-existing and covered by `tonkDisplay.test.ts` and the existing log component; this LLD only re-mounts/reuses them.

### Manual (visual only — cannot be asserted headlessly)

- Desktop Tonk: toggling `Tallies ⇄ Game Log` swaps the full-height panel; the log auto-scrolls to the newest entry on open and stays pinned as moves arrive. Tallies is the default on load.
- Game over (live Tonk completion and refresh-into-completed): the "Final Move" block shows the terminal action + outcome above the scores, on both desktop and mobile widths.
- Mobile Tonk: the hamburger drawer still opens/closes the log unchanged; no segmented switch appears.
