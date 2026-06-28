# LLD 55: Show Previous Played Cards on the Table

## Scope

**Covers:** A Big2-only "trick pile" UI in the table area showing the plays (and passes) made during the **current trick**, so players can see what came before `lastPlay` without opening the log drawer.

- Collapsed state: a stacked card pile sitting beside the centered current play, with a gold count badge.
- Expanded state: a click/tap overlay fanning every play in the current trick in play order, with passes represented inline.
- The pile resets when a new trick starts.
- A new server-authoritative field `trickStartIndex` on `Big2PublicState` (index into `playHistory` where the current trick began). The current trick is `playHistory.slice(trickStartIndex)` — an exact, deterministic slice, not a derived heuristic. This resolves the previously-escalated OPEN POINT (see Approach): frontend-only derivation was shown to be non-deterministic against the real engine semantics, so the engine now publishes the boundary directly.

**Does NOT cover:**

- A universal cross-game history component. This is scoped to Big2. (Tonk's discard pile is a different concept and is explicitly out of scope — rejected.)
- Showing prior **tricks** (full-game history). That remains in `GameLog` / the mobile log drawer.
- Changing the existing `lastPlay` rendering in `PlayArea` (the centered current play stays as-is).
- Spectator view (`EnrichedSpectatorView`). See Edge Cases for why it is deferred, not built here.
- Any change to game rules, scoring, or turn flow. `trickStartIndex` is a pure bookkeeping index; it does not affect any decision the engine makes.

## Approach

**Decision (resolves the previously-escalated OPEN POINT): the engine publishes the trick boundary; the frontend slices it.** The earlier draft tried to derive the current trick client-side from `playHistory` alone. Review (verified against `big2-engine.ts`) showed this is **not deterministic**: the engine produces `pass → play` transitions *inside* a trick on the common path (a player passes, the next player beats the current play), so no structural "boundary = pass-then-play" rule can distinguish a mid-trick pass→play from a true new-trick lead. The only state that knows where a trick truly begins is the engine itself. Therefore we add one bookkeeping field, `trickStartIndex`, and the frontend derivation collapses to a single exact operation:

> **`currentTrick = playHistory.slice(trickStartIndex)`** — the contiguous suffix of `playHistory` since the in-progress trick began. No heuristic, no anchor-and-extend, no fallback.

**Why this is correct and cheap.** A Big2 trick begins at exactly two points in the engine, and both are unambiguous in source:

1. **Game start** (`Big2Engine.initialize`, big2-engine.ts ~line 47): `playHistory` is empty and `isFreePlay = true`. The first trick begins at index `0`.
2. **Trick close** (`Big2Engine.handlePass`, the `newConsecutivePasses >= activePlayerCount - 1` branch, big2-engine.ts ~line 417): the closing pass is appended to `playHistory`, then `isFreePlay` is reset to `true` and the trick winner leads. The *next* entry appended will be the new trick's leading play. So the new trick starts at the index that entry will occupy = the length of `playHistory` **after** the closing pass is appended.

These are the *only* places the engine sets `isFreePlay = true` after the initial state. `trickStartIndex` is set in lockstep with those two points and nowhere else. It is never read by the engine to make a decision — it is pure published bookkeeping, so it cannot change game behavior.

**Engine change (precise):**

- In `initialize`, set `trickStartIndex: 0` in the initial `Big2State`.
- In `handlePass`, in the trick-close branch only, set `trickStartIndex: newPlayHistory.length` where `newPlayHistory = [...big2State.playHistory, historyEntry]` (i.e. the index of the entry that will be appended *next*, after the closing pass). The other `handlePass` branch and both `handlePlayCards` branches keep `trickStartIndex` unchanged via the existing `...big2State` spread.
- Publish `trickStartIndex` in the `Big2PublicState` built by both `getPlayerView` and `getSpectatorView` (alongside the existing `playHistory`/`isFreePlay`).

**Invariant the engine must uphold (assert in tests):** `0 <= trickStartIndex <= playHistory.length` at all times, and `playHistory.slice(0, trickStartIndex)` never changes once written (history is append-only and the boundary only moves forward). When `trickStartIndex === playHistory.length`, the current trick is empty (a fresh trick just opened, no one has led yet).

**Where the UI lives.** A new presentational component `TrickPile.vue` rendered inside `PlayArea.vue`, positioned beside the existing centered `play-area__cards`. `PlayArea` already receives `Big2PublicState`-derived props from `GameBoard.vue`; we pass it `playHistory` and `trickStartIndex` (see Interfaces). The component computes `currentTrick = playHistory.slice(trickStartIndex)` and renders from that.

**Visual direction (approved mockup — do not re-litigate).** Collapsed = a **stacked** card pile (layered/fanned cards reading as a physical pile), NOT a fading horizontal trail and NOT scattered cards (both rejected). The **top** of the collapsed pile shows the **most recently played** play (reviewer's nonblocking suggestion, adopted). A gold count badge shows the number of plays in the current trick. Clicking/tapping expands an overlay fanning every play in the current trick in play order, passes shown inline.

**No new socket events and no new round-trips.** `Big2PublicState` is already delivered in `EnrichedPlayerView.gameSpecificPublicState`; we add one number field to the existing payload.

## Interfaces / Types

### Shared type change (`src/shared/big2-types.ts`)

Add one field to `Big2PublicState`:

```ts
export interface Big2PublicState {
  readonly lastPlay: Big2Play | null;
  readonly consecutivePasses: number;
  readonly isFreePlay: boolean;
  readonly isFirstPlayOfGame: boolean;
  readonly playHistory: readonly Big2HistoryEntry[];
  readonly finishedPlayerIndices: readonly number[];
  /** Index into playHistory where the current (in-progress) trick begins.
   *  currentTrick === playHistory.slice(trickStartIndex). Set by the engine
   *  at game start (0) and on every trick close. Append-only history means
   *  0 <= trickStartIndex <= playHistory.length. */
  readonly trickStartIndex: number;
}
```

### Engine state change (`src/backend/engine/big2/big2-types.ts`)

Add the same field to `Big2State` so it can be persisted/restored as part of `gameSpecificState`:

```ts
export interface Big2State {
  // ...existing fields...
  readonly trickStartIndex: number;
}
```

`Big2State` is `InternalGameState.gameSpecificState`; it round-trips through the DB unchanged. Existing serialized states (if any) that lack the field are addressed in Edge Cases #14.

### Engine logic (`src/backend/engine/big2/big2-engine.ts`)

No new methods. Three touch points, all specified in Approach:

- `initialize`: add `trickStartIndex: 0` to the initial `Big2State`.
- `handlePass` trick-close branch: add `trickStartIndex: [...big2State.playHistory, historyEntry].length` (equivalently `big2State.playHistory.length + 1`).
- `getPlayerView` and `getSpectatorView`: add `trickStartIndex: big2State.trickStartIndex` to the published `Big2PublicState`.

All other branches inherit the prior `trickStartIndex` through the existing `...big2State` spread (verify the `handlePlayCards` branches that build `newBig2State` without the spread also carry it — those construct the object field-by-field and MUST copy `trickStartIndex: big2State.trickStartIndex`).

### New frontend component: `src/frontend/component/game-ui/TrickPile.vue`

Props:

```ts
defineProps<{
  // Full cumulative history from Big2PublicState.playHistory
  playHistory: readonly Big2HistoryEntry[];
  // Boundary published by the engine; currentTrick = playHistory.slice(trickStartIndex)
  trickStartIndex: number;
}>();
```

`displayName` and `handType` are already carried on each `Big2HistoryEntry`, so no `players` or `lastPlay` prop is needed for derivation. (`lastPlay` stays where it is — on the centered `play-area__cards` in `PlayArea`.)

Component-local computed values:

- `currentTrick: readonly Big2HistoryEntry[]` — `playHistory.slice(trickStartIndex)`, in play order (oldest → newest).
- `playEntries: Big2HistoryEntry[]` — `currentTrick.filter(e => e.action === "play")`.
- `badgeCount: number` — `playEntries.length` (number of plays this trick; passes are surfaced only in the expanded overlay — see Edge Case #5).
- `expanded: ref<boolean>` — collapsed vs. expanded overlay state.

Component emits: none. Self-contained toggle state.

### `PlayArea.vue` changes

- Accept and forward `playHistory` and `trickStartIndex` (in addition to existing props). `GameBoard.vue` already holds `big2State`; add `:play-history="big2State?.playHistory ?? []"` and `:trick-start-index="big2State?.trickStartIndex ?? 0"`.
- Render `<TrickPile>` beside `play-area__cards`.

Reuse existing `GameCard.vue` (`size="small"` for the pile, `size="medium"` in the expanded overlay) — do not create new card-rendering code. Reuse `HAND_TYPE_LABELS` and `SUIT_SYMBOLS` patterns already present in `PlayArea`/`GameLog`.

## State Model

- **Persisted (server-authoritative):** `Big2State.trickStartIndex` lives in `InternalGameState.gameSpecificState` and round-trips through the DB exactly like the other Big2 state fields. It is computed by the engine, never by the client.
- **Published:** `trickStartIndex` is included in `Big2PublicState` (player view and spectator view). It carries no hidden information — it is an index into the already-public `playHistory`.
- **No new socket events.** It rides on the existing `Big2PublicState` already in `EnrichedPlayerView.gameSpecificPublicState`.
- **Derived, ephemeral, client-only:** `currentTrick = playHistory.slice(trickStartIndex)`, recomputed reactively whenever `playHistory` or `trickStartIndex` change. `expanded` is local UI state.

**Engine boundary maintenance (the only logic that moves `trickStartIndex`):**

1. **`initialize`** → `trickStartIndex = 0`. (`playHistory` is `[]`; the first trick starts at index 0.)
2. **`handlePass`, trick-close branch only** (`newConsecutivePasses >= activePlayerCount - 1`) → after appending the closing pass, set `trickStartIndex = playHistory.length + 1` (the index the *next* appended entry — the new leader's play — will occupy). All other action paths leave `trickStartIndex` unchanged.

**Client derivation (single exact step, no heuristic, no fallback):**

```
currentTrick = playHistory.slice(trickStartIndex)
```

- If `trickStartIndex === playHistory.length` → `currentTrick === []`: a fresh trick just opened and no one has led yet. Pile hidden; the centered area shows the existing "New Trick" prompt.
- Otherwise `currentTrick` is the in-progress trick in play order. Because the engine never resets the boundary mid-trick (it only resets when the trick actually closes), the slice contains *every* play and pass since the current leader led — including mid-trick pass→play sequences — and excludes the previous trick's entries entirely. This is exactly the case the prior heuristic got wrong.

**Reactivity:** `currentTrick`, `playEntries`, `badgeCount` are computed. Force-collapse the overlay when the trick resets: watch `trickStartIndex`; when `currentTrick` becomes `[]` (new trick), set `expanded = false`.

## Edge Cases

1. **Empty history (game just started, first play not yet made):** `playHistory = []`, `trickStartIndex = 0` → `slice(0)` is `[]` → pile hidden. Centered area shows existing "New Trick — Play any combination".
2. **Fresh trick, no plays yet (someone just won a trick):** the engine set `trickStartIndex = playHistory.length` on the trick close → `slice` is `[]` → pile hidden. Centered area shows the lead prompt. (No reliance on `lastPlay`/`isFreePlay` for derivation; they remain only for the centered play's existing rendering.)
3. **Single play in trick (only the leader has played):** pile shows 1 card stack; badge count = 1; expanding shows just that play. Pile is still rendered (it conveys "1 play so far"). Acceptable; it is visually distinct from the centered current play because the centered play already shows the same cards — see #4.
4. **Pile vs. centered `lastPlay` duplication:** the most recent play is shown BOTH as the centered current play and as the **top** of the collapsed pile. This is intentional per the approved mockup (top of pile = most recent). The expanded overlay also includes it. Do not dedupe.
5. **Passes in the trick:** passes are NOT cards, so they do not appear as cards in the collapsed stack. They are represented **inline in the expanded overlay** (e.g., a "Pass — {name}" chip in play order). Collapsed badge: show **count of plays** (cards) by default; if the trick contains passes, optionally annotate (decision: badge = number of plays; passes visible only when expanded — keeps the collapsed badge unambiguous as "N cards/sets played this trick").
6. **Long trick (4 players, many plays):** collapsed stack caps visible layered cards (e.g., max 4–5 offset layers; deeper plays simply stack under). Expanded overlay must scroll/wrap if it overflows the viewport (especially mobile). Specify max-height with overflow handling.
7. **Trick reset mid-view:** if the overlay is expanded and a new trick starts (`currentTrick` becomes `[]`), force-collapse and hide the pile (no stale overlay).
8. **Player finishes mid-trick:** finished players' earlier plays remain in `currentTrick` until the trick resets — correct, they are part of this trick's history. No special handling.
9. **Reconnection / late join:** `playHistory` is full and authoritative on (re)connect; derivation runs on whatever history is present. No special handling.
10. **Mobile layout:** the collapsed pile must fit the constrained `table` grid cell (see `GameBoard.vue` mobile grid). Pile should shrink (smaller cards / fewer offset layers) and remain tappable (min 44×44 tap target on the toggle, per existing mobile conventions). The expanded overlay should present full-width-ish with scroll.
11. **Spectator view:** `getSpectatorView` now publishes `trickStartIndex` in its `Big2PublicState` too (engine change above), so the data is present, but `GameBoard.vue` here is the player board only. Spectator integration is **out of scope** for this LLD (deferred); the spectator board can later reuse `TrickPile` unchanged (it is purely presentational from public state).
12. **Reduced motion:** expand/collapse and any pile transition must respect `prefers-reduced-motion: reduce` (disable transitions), matching the existing pattern in `GameBoard.vue`.
13. **Mid-trick pass→play sequences (the case the old heuristic broke):** a long trick such as A plays / B passes / C plays / D passes / A passes (closes) / C leads produces `playHistory = [play(A), pass(B), play(C), pass(D), pass(A), play(C)]` with `trickStartIndex = 5`. `slice(5)` correctly yields only `[play(C)]` — the new trick — and excludes all of trick 1. Mid-trick `pass(B)` and `pass(D)` stay inside trick 1's slice when trick 1 is the current trick. No special handling: the slice is correct by construction because the engine, not the client, owns the boundary. This edge case has an explicit test (see Test Requirements).
14. **Restoring a serialized state without `trickStartIndex` (backward compat):** any `Big2State` persisted before this change lacks the field. When such a state is loaded, `trickStartIndex` is `undefined`. The engine must coalesce a missing value to a safe default on read: treat `undefined` as `0` so `slice(0)` shows the full `playHistory` as the "current trick" rather than throwing. This is mildly wrong (an old in-flight game may show prior tricks until its next trick close, after which the boundary self-corrects), and is acceptable because (a) in practice games are short-lived in-memory and rarely span this deploy, and (b) it degrades to a visible-but-harmless superset, never to a crash or to hidden data. Specify the coalescing in one place (the public-state builder and `Big2State` load path). If the team prefers, a one-line state-migration that sets `trickStartIndex = 0` on load is equivalent.

## Dependencies

- **No upstream LLD blocking.** All touched code exists today.
- **Modified (shared + backend):**
  - `src/shared/big2-types.ts` — add `trickStartIndex` to `Big2PublicState`.
  - `src/backend/engine/big2/big2-types.ts` — add `trickStartIndex` to `Big2State`.
  - `src/backend/engine/big2/big2-engine.ts` — set the field in `initialize` and the `handlePass` trick-close branch; copy it through the `handlePlayCards` branches; publish it in `getPlayerView` and `getSpectatorView`.
- **Modified (frontend):**
  - `src/frontend/component/game-ui/PlayArea.vue` — host component; accepts and forwards `playHistory` + `trickStartIndex`, renders `<TrickPile>`.
  - `src/frontend/component/game/GameBoard.vue` — passes `big2State.playHistory` / `big2State.trickStartIndex` into `PlayArea`.
- **Reused as-is:**
  - `src/shared/engine-types.ts` — `Card`, `PlayerId` (types only).
  - `src/frontend/component/game-ui/GameCard.vue` — `size` prop already supports `small`/`medium`.
  - `src/styles/game-variables.css` — existing CSS tokens (`--gold-accent`, `--card-*`, etc.).
- **Approved mockup:** the committed "click-to-expand trick pile" mockup (frontend reviewer approved). Build exactly that; mockup step is satisfied.
- **DB:** no schema change. `trickStartIndex` lives inside the existing serialized `gameSpecificState` JSON; backward compat is handled by Edge Case #14.

## Test Requirements

Per `docs/testing-principles.md`: the engine is a pure function (deterministic given a seed), so the boundary logic is tested directly on engine output; the frontend slice is trivial but still asserted; visual-only properties stay manual.

**Unit (engine — `trickStartIndex` correctness, the core risk now lives here):**
Extend the existing `tests/engine/big2/game-flow.test.ts` / `full-game.test.ts` style (real `Big2Engine`, fixed seed or seeded `Big2State`).

- **Initial state:** `initialize` → `trickStartIndex === 0`.
- **Plays within a trick do not move the boundary:** lead play then a beating play → `trickStartIndex` unchanged from trick start; `playHistory.slice(trickStartIndex)` contains both plays in order.
- **Non-closing pass does not move the boundary:** a pass that does NOT reach `activePlayerCount - 1` leaves `trickStartIndex` unchanged and the pass appears inside the slice.
- **Trick close moves the boundary to the next index:** drive a full trick to the close branch; assert `trickStartIndex === playHistory.length` immediately after the close (slice is empty), and after the next leader plays, `slice` contains exactly that lead.
- **MANDATORY interleaved fixture (the case that broke the old spec):** play out A plays / B passes / C plays (beats) / D passes / A passes (closes trick) / C leads. Assert: (a) before A's closing pass, `slice(trickStartIndex)` equals `[play(A), pass(B), play(C), pass(D)]` — i.e. **all** of trick 1's entries, including the mid-trick `pass→play` at B→C; (b) after the close and C's lead, `slice(trickStartIndex)` equals exactly `[play(C)]` and **excludes every** trick-1 entry. This directly verifies the engine boundary is correct where the previous `pass→play` heuristic fired mid-trick.
- **Player finishes mid-trick:** a player empties their hand on a play (boundary unchanged); their play remains inside the current slice until the trick closes.
- **Invariant:** across an entire seeded full game, assert at every step `0 <= trickStartIndex <= playHistory.length` and that `playHistory.slice(0, trickStartIndex)` is stable (never rewritten) — i.e. the boundary only advances.
- **Published in views:** `getPlayerView` and `getSpectatorView` both include `trickStartIndex` matching the internal `Big2State`.
- **Backward compat (Edge Case #14):** loading/serving a `Big2State` with `trickStartIndex === undefined` coalesces to `0` in the published `Big2PublicState` (no throw, full history shown).

**Unit (frontend component logic — derivation is now a one-liner, assert it directly):**

- `playHistory = []`, `trickStartIndex = 0` → `currentTrick = []`, pile hidden, badge hidden.
- `trickStartIndex === playHistory.length` (fresh trick, no lead yet) → `currentTrick = []`, pile hidden.
- Single play → `currentTrick` length 1; `badgeCount = 1`; top of pile = that play.
- Multiple plays in a trick → `currentTrick` ordered oldest→newest; collapsed top = most recent (last) entry.
- Interleaved passes within the current trick → passes excluded from the collapsed card stack but present in the expanded overlay in order; `badgeCount = number of plays`.
- Same interleaved fixture as the engine test, fed as a prop pair `(playHistory, trickStartIndex)` → `currentTrick === playHistory.slice(trickStartIndex)`; assert it contains all of the current trick and none of the prior trick.

**Unit (rendering / interaction):**

- Collapsed pile renders N layered `GameCard`s (one per play, capped) with most-recent on top.
- Clicking/tapping the pile toggles `expanded`; overlay fans all plays in order with pass chips inline.
- A `trickStartIndex` change that empties `currentTrick` while expanded force-collapses the overlay.
- Badge shows `playEntries.length` and is hidden when `currentTrick` is empty.

**Integration (component within GameBoard, using EnrichedPlayerView fixtures):**

- `GameBoard` forwards `playHistory` + `trickStartIndex` to `PlayArea` → `TrickPile`; pile reflects state across a simulated sequence of plays and a trick reset (drive fixtures through the real engine so `trickStartIndex` is engine-produced, not hand-authored).
- Across a multi-trick sequence, the pile shows only the current trick at each step and clears on every trick close.

**Security / information hiding:**

- Extend `tests/engine/big2/information-hiding.test.ts`: assert `trickStartIndex` exposes no hidden data — it is an index into already-public `playHistory`; the published `Big2PublicState` still contains no hand/hidden fields.
- Assert `TrickPile` consumes only `playHistory` + `trickStartIndex` (public) and never references any hand/hidden field.

**Manual (visual only — cannot be asserted in DOM):**

- Stacked-pile visual reads as a physical pile (not a trail, not scattered) on desktop and mobile.
- Expanded overlay layout/scroll on a small mobile viewport.
- `prefers-reduced-motion` disables transitions.

## Frontend Design

Approved design = the committed **"click-to-expand trick pile"** mockup (frontend reviewer approved). Build exactly this; the visual direction is settled and must not be re-litigated.

- **Collapsed pile:** a **stacked** pile of cards (layered/fanned, reading as one physical pile) sitting **beside** the centered current play in the table area (left side / corner per mockup). The **TOP card of the pile is the MOST RECENTLY played play** — this is the reviewer's one nonblocking suggestion, adopted (not the first card of the trick). Earlier plays stack beneath with a small offset. Explicitly NOT a fading horizontal trail and NOT scattered cards (both prior directions were rejected by the user).
- **Gold count badge:** a small gold badge on the pile showing the number of plays in the current trick (passes surfaced in the expanded view, not the badge).
- **Expanded overlay:** clicking/tapping the pile opens an overlay that **fans every play in the CURRENT trick in play order**, with **passes represented inline** (e.g., a muted "passed" chip with the player's name positioned in sequence). Tapping outside / a close affordance / Escape collapses it (match the existing log-drawer Escape handling pattern in `GameBoard.vue`).
- **Reset behavior:** the pile and badge **reset when a new trick starts** (derived: `currentTrick` becomes empty). When empty, the pile is hidden and the centered area keeps showing the existing "New Trick" prompt.
- **Reuse + tokens:** reuse `GameCard.vue` (`size="small"` collapsed, `size="medium"` expanded) and existing CSS variables (`--gold-accent`, `--card-*`, `--panel-bg`, `--text-muted`). Match the felt/gold visual language already in `PlayArea`/`GameBoard`.
- **Responsiveness:** pile fits the desktop `table` grid cell and shrinks gracefully in the mobile grid (`GameBoard.vue` mobile media query); toggle is a ≥44px tap target; overlay scrolls if it overflows on mobile.
- **Motion:** transitions respect `prefers-reduced-motion: reduce`.
- **Scope:** Big2 only. No universal cross-game component (rejected — Tonk's discard pile is a different concept).
