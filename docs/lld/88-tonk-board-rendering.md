# LLD 88: Tonk board read-only rendering (TonkBoard.vue)

**Status:** Draft for review. Parent: #41 (Tonk end-to-end), order 3 of 5. Depends on: engine #57 / **LLD 69** (`docs/lld/69-tonk-game-engine.md`, merged via PR #80) and **LLD 65** (`docs/lld/65-tonk-rules-spec.md`, signed off 2026-06-28). Frontend direction **APPROVED** by the user (A1 + B1 + compact seats at 6; joker as icon; mobile compact tallies) — see §Frontend Design. Mockup: https://harennon.github.io/cardgamesimulator/tonk-board-rendering.html

This is a **read-only rendering** LLD. It proves we can correctly DISPLAY server-provided Tonk state before wiring up action controls (#59). It is purely a frontend/presentation change — no engine, transport, or shared-type changes.

---

## Scope

### Covers

- A new `src/frontend/component/game/TonkBoard.vue`, sibling to `GameBoard.vue`, reusing Big2's four-zone skeleton (opponent rail top, center table, hand bottom, right side panel) so the dispatch swap is seamless. The center is replaced with Tonk-specific piles.
- **Game-type dispatch** in `GameView.vue`: render `TonkBoard` when `gameState.gameType === "tonk"`, `GameBoard` for `"big2"`. The swap happens **only** at the component-dispatch layer — no Tonk branches are added to the generic WebSocket/state/composable plumbing.
- New Tonk-only presentational sub-components (under `src/frontend/component/game-ui/`):
  - `TonkPiles.vue` — discard top + separate cyan drawable-discard slot + face-down stock with count.
  - `TonkPhaseBanner.vue` — color-coded phase chip naming the player + phase + trick number (B1).
  - `TonkSeatRail.vue` — Tonk opponent rail: count + running-tally chip + phase tag, compact at ≥6, wrapping at ≥7. (Reuses Big2's pulse-dot affordance pattern; see §Frontend Design for why this is a new component rather than reusing `OpponentRow.vue` directly.)
  - `TonkTallyPanel.vue` — right-panel running tallies (lower is better) with 150-loss-line progress and current trick number.
  - `TonkLog.vue` — Tonk-shaped game log (the existing `GameLog.vue` is typed to `Big2HistoryEntry`; Tonk's `TonkLogEntry` differs, so a Tonk log renderer is needed — see §Approach).
  - `TonkHand.vue` — read-only local-hand renderer typed `readonly TonkCard[]` (the shared `PlayerHand.vue` is `readonly Card[]` and keys on `rank`/`suit`, which a `TonkJoker` lacks — see §Approach decision 3).
- Rendering of the player's own hand (incl. Jokers as an **icon**), discard top, drawable-discard indicator, face-down stock + count, opponent counts, color-coded turn+phase indicator, per-player tallies + trick number, and the log — **all from the Tonk public view only**.
- Responsive/mobile layout matching the approved mockup (compact tallies folded into seat pills, log behind a FAB, single-column stack).

### Explicitly does NOT cover

- **No action controls** (discard / draw-source / call-TONK). Those are #59. `validActions` is read but only used to drive the turn/phase **indicator**, never interactive buttons. This board is read-only.
- **No melds / spreads / runs / hitting / drop-knock** — they do not exist in this variant (LLD 65 §1). Do not render them.
- **No client-side rule computation.** No "is this card drawable", no hand-value math, no scoring. Everything displayed comes verbatim from the server view (`PlayerView`/`SpectatorView` → `gameSpecificPublicState: TonkPublicState`).
- **No new Tonk branches in `useGameState` / `useGameActions` / `useSocket` / `useCardSelection`** or any shared type. Dispatch is component-level only.
- **No spectator entry path wiring.** TonkBoard is designed to render correctly from public-only fields (so it is spectator-safe by construction), but `GameView.vue` joins only as `role: "player"` today and has no spectator rendering route. Wiring a spectator route for either game is pre-existing missing scope and is **out of scope here** — flagged in §Dependencies. The acceptance criterion "spectator view renders public info only" is satisfied at the **component contract** level (TonkBoard never reads `you.hand` for anyone but the local player and never reads stock contents), and is verified by unit test, not by an end-to-end spectator flow.
- **No `deckRoundsTarget` lobby control** (LLD 65 §8.8 / #60) and **no GameOver/results-component changes**. `displayPhase === "COMPLETED"` still routes to the existing `GameOverView` (see §Edge Cases E8 for what this LLD *does* change in `GameView.vue` — the ribbon gate — and the explicit GameOver follow-up flagged in §Dependencies). The one in-scope `GameView.vue` change beyond board dispatch is gating the Big2 final-play ribbon (decision 1b / E8); the ribbon markup and `GameOverView.vue` itself are not modified here.

---

## Approach

### Key decisions

1. **Dispatch by game type at the board layer, mirroring the existing branch points; and gate the final-play ribbon to Big2.** `GameView.vue` already branches its render tree on `displayPhase`; `GameBoard.vue` already narrows `gameSpecificPublicState` by `gameType === "big2"`. We make **two** changes in `GameView.vue`'s `IN_PROGRESS`/`SHOW_FINAL_PLAY` block:
   - **(a) Board dispatch:** `gameType === "tonk"` → `<TonkBoard>`; else → `<GameBoard>` (unchanged).
   - **(b) Ribbon gate:** wrap the existing final-play ribbon block (`game-view__final-play-ribbon`) so it renders **only** when `displayPhase === "SHOW_FINAL_PLAY" && gameState.gameType === "big2"`.

   **Why (b) is required (corrects the prior draft).** `SHOW_FINAL_PLAY` is **not** an engine phase — it is a GameView-local display state set by the `displayPhase` watcher (`GameView.vue:162-164`) on **any** game's generic `IN_PROGRESS → COMPLETED` status transition. Per LLD 65 §3.1 (line 59) and §4.1 (lines 143-146), a Tonk match **does** make that exact transition (status stays `IN_PROGRESS` across tricks, then flips to `COMPLETED`) and **does** set `state.winner` (the lowest-tally player, display-only). Therefore a completing Tonk game **will** enter `SHOW_FINAL_PLAY` for the brief interval before the user/auto-advance reaches `COMPLETED` → `GameOverView`. Without gate (b), the Big2 "`<winner> wins!`" ribbon (`GameView.vue:45-60`) would render over the Tonk board — both visually wrong and semantically wrong for Tonk's loss-centric model (there is no single "winner"; the displayed lowest-tally player did **not** "win" in any stats sense — LLD 65 §6.3). The ribbon also reads Big2-only fields (`lastPlay`/`finalPlay`) which are absent on a Tonk view.

   The watcher itself is **not** changed (it is generic and game-agnostic; touching it risks Big2 regression and violates the "no Tonk branches in generic plumbing" constraint). Instead, **during the transient Tonk `SHOW_FINAL_PLAY` step, `TonkBoard` renders normally and ribbon-free**, then the watcher's `COMPLETED` branch routes to `GameOverView` exactly as Big2 does. This keeps the change additive and Big2 untouched.

2. **TonkBoard reuses the Big2 zone skeleton, not its center.** TonkBoard owns the same CSS grid skeleton as `GameBoard.vue` (`opponents` / `table` / `hand` / `log` / `actions` areas, same desktop and mobile grid templates and felt/rim styling) so the two boards are visually consistent and the dispatch swap is seamless. The `actions` area renders **nothing interactive** (read-only); on Tonk it holds only the compact phase/turn status line (no buttons). The `table` area renders `TonkPiles` + `TonkPhaseBanner` instead of Big2's `PlayArea`/`TrickPile`.

3. **Reuse shared primitives where they fit; add Tonk-only where Big2's doesn't map.**
   - **`GameCard.vue`** — reused for the player's hand, the discard top, and the drawable slot. **Requires a small additive change** to render a Joker (see decision 5).
   - **`PlayerHand.vue` — NOT reused directly; a thin `TonkHand.vue` wrapper is added instead (decision resolved).** `PlayerHand`'s `cards` prop is typed `readonly Card[]` and it **keys each card on `` `${card.rank}-${card.suit}` ``** (`PlayerHand.vue:5`). A Tonk hand is `readonly TonkCard[]` (`Card | TonkJoker`), and `TonkJoker` has **no `rank`/`suit`** — only `{ joker: true; id: number }` (`tonk-types.ts:6-10`). Reusing `PlayerHand` directly would (a) require widening its shared prop to `readonly TonkCard[]` (coupling a Big2 component to Tonk), and (b) produce a broken/colliding `undefined-undefined` key for jokers. **Decision:** add a Tonk-only `TonkHand.vue` (sibling under `game-ui/`) that mirrors `PlayerHand`'s read-only layout (overlap, horizontal scroll, mobile behavior — copy the CSS) but types its prop `readonly TonkCard[]`, keys jokers by `` `joker-${card.id}` `` (and standard cards by `rank-suit`), passes `interactive={false}` with no selection, and delegates each card to the joker-aware `GameCard` (decision 5). This keeps the shared Big2 `PlayerHand`/`Card[]` contract intact. **Decision criterion** (for the record): reuse a shared Big2 primitive only when its prop contract already accepts the Tonk shape without widening; if it would require changing a shared type to a Tonk-inclusive union, fork a thin Tonk-only component that copies the CSS/behavior — same rule applied to `OpponentRow`/`GameLog`.
   - **`GameLog.vue`** — **not** directly reusable: it is typed to `Big2HistoryEntry` and renders Big2 hand-type labels. Tonk needs `TonkLog.vue` rendering `TonkLogEntry` (discard counts, draw source, TONK/trick results). The mobile log-drawer/FAB pattern and styling are copied from `GameBoard.vue`.
   - **`OpponentRow.vue`** — its seat affordance (pulse-dot, active border, count, disconnected state) is the model, but it renders a Big2 card-back fan and has no tally/phase-tag concept. `TonkSeatRail.vue` reuses the same visual language (the pulse-dot CSS, active-border, name/count) but adds the tally chip + phase tag and the compact/wrap behavior. See §Frontend Design for the reuse-vs-fork decision.

4. **All display data comes from `TonkPublicState`** (`src/shared/tonk-types.ts`, already shipped by #57). TonkBoard narrows `gameState.gameSpecificPublicState` to `TonkPublicState` exactly as `GameBoard` narrows to `Big2PublicState`. Fields consumed: `turnPhase`, `trickNumber`, `tonkGateOpen` (display only), `stockCount`, `discardTop`, `discardCount`, `lastDiscardCount`, `lastDiscardPlayerIndex`, `drawableDiscard`, `tallies`, `log`. Plus the generic `PlayerView` fields: `players` (counts), `you.hand`, `currentPlayerIndex`, `you.playerId`, `winner`, `scores`.

5. **Joker renders as an icon, via an additive `GameCard` change.** `GameCard.vue` currently takes `card: Card` and renders `rank` + suit symbol. Add an **optional** discriminator so it can render a Joker face (an icon, e.g. a stylized joker/star glyph, **not** the literal text "Joker"). The recommended minimal change: accept `card: Card | TonkJoker` and, when `isJoker(card)`, render a joker icon face (centered glyph, no suit). This is additive — Big2 always passes a `Card`, so its rendering is unchanged. The icon is a glyph/inline SVG (no new asset pipeline). See §Frontend Design for the exact visual and §Interfaces for the prop change.

6. **The 150 loss-line is presentational only.** The "progress toward 150" bar and "near 150" flag are computed in the component from `tallies[i]` and the constant `150` purely for display (a progress percentage and a threshold class). This is **not** a game rule — the server decides who lost; the bar is a visual gauge of the public tally. Document the `150` as a display constant sourced from LLD 65 §5.2, not a re-implementation of match-end logic (the board never decides game-over).

### Alternatives considered

- **Render Tonk inside `GameBoard.vue` behind a `gameType` switch** — rejected. `GameBoard` is already Big2-shaped (PlayArea, TrickPile, ActionPanel, Big2 log). Forking the center and the log inside one component bloats it and couples the two games; a sibling `TonkBoard.vue` keeps each board cohesive and matches the issue's "sibling to GameBoard" directive and the HLD's "new engine + game-specific UI, no framework change" extensibility claim.
- **Extend `OpponentRow.vue`/`GameLog.vue` with Tonk props instead of new components** — rejected for both. `OpponentRow` is `PlayerPublicInfo`-only with a Big2 card fan; `GameLog` is `Big2HistoryEntry`-typed. Bolting Tonk concepts (tallies, phase tags, `TonkLogEntry`) onto them would make shared Big2 components carry Tonk-specific props — a coupling smell. New Tonk-only components reuse the **CSS/visual language** (copy the pulse-dot, active-border, drawer/FAB) without coupling the data contracts.
- **Widen shared `Card`/`Rank` to include a joker** — rejected (LLD 65 §8.6, LLD 69). Keep the joker Tonk-local (`TonkCard = Card | TonkJoker`); `GameCard` accepts the union additively.

---

## Frontend Design

> Approved direction (user, on issue #41 sub-issue): **A1 + B1 + compact seats at 6**. Notes: "joke is better as an icon"; "mobile compact tallies look good!". The mockup at https://harennon.github.io/cardgamesimulator/tonk-board-rendering.html is the visual reference.

### Center piles — A1 (separate drawable-discard slot)

The center `table` zone renders three distinct objects in one row, left→right:

1. **Stock** — a single face-down card back (reuse `GameCard :face-down`) with a count label underneath, e.g. `23 left`, sourced from `stockCount`. Never renders contents.
2. **Discard** — the **live** pile top (`discardTop`), face up via `GameCard`, labeled with who just played it: `<name> just played` where `<name> = players[lastDiscardPlayerIndex].displayName`. When `lastDiscardCount > 1`, show a small multiplier badge (e.g. `×3`) on the discard to indicate a multi-discard (display only — sourced from `lastDiscardCount`). Empty pile (`discardTop === null`, trick 1) → render an empty pile placeholder ("empty").
3. **Drawable** — the turn-start snapshot (`drawableDiscard`), lifted out **beside** the discard pile, **cyan-ringed** and **labeled** (`drawable` / `from <preceding player>` when derivable; otherwise just `drawable`). This is rendered as a distinct object, **not** a card baked into a button (no buttons — read-only). When `drawableDiscard === null` (trick-1 first player) the slot renders a dimmed "no card to draw" placeholder so the absence is explicit.

Rationale (LLD 65 §3.3/§6.1): the live pile top (current player's own just-played card) and the turn-start `drawableDiscard` snapshot are genuinely different objects — showing them as one would be ambiguous. Cyan ring = "this is the discard you may draw," visually separated from the live top.

Cyan ring: use a dedicated CSS variable `--tonk-cyan: #3fd0d8` (add to `game-variables.css`; value approximate — pick a cyan that reads against the felt) applied as a `box-shadow`/`outline` ring on the drawable slot. Do not hardcode the hex in component scope; define the token once.

### Phase banner & active-seat tag — B1

- **Center banner** (`TonkPhaseBanner.vue`, top of the `table` zone): a single line naming the active player + a **color-coded phase chip** + the trick number. Examples:
  - Active = someone else: `Devon's turn` + chip `discard phase` (or `draw phase`) + `TRICK 3`.
  - Active = you: `Your turn` + chip + trick.
- **Phase chip color coding:** discard phase and draw phase use distinct chip colors via tokens:
  - `--tonk-phase-discard: #c97b3f` (warm/amber — "putting a card down")
  - `--tonk-phase-draw: #3f9dc9` (cool/blue — "taking a card")
  (Exact hexes are a `frontend-architect` call; define as tokens, keep them distinguishable and accessible on the felt. The mockup names the phases "discard phase" / "draw phase".)
- **Active-seat phase tag:** the active seat in `TonkSeatRail` repeats a short phase tag (`disc.` / `draw`) next to the player name, colored to match the chip, and reuses **Big2's pulse-dot** (`.opponent__turn-indicator` pattern from `OpponentRow.vue`) so the rail eye-line alone tells you whose turn and which phase.

### Seats — compact at ≥6, usable at 8 (3–8 supported)

`TonkSeatRail.vue` renders one seat per opponent (all players except the local player; for spectator-style rendering it renders all players — see §State Model). Per seat: name (ellipsized), card **count**, a **running-tally chip** (`tallies[seatIndex]`), and (when active) the phase tag + pulse-dot.

- **< 6 players:** show a small card-back fan (like `OpponentRow`) + count + tally chip.
- **≥ 6 players (compact):** **drop the card-back fan**; keep count + tally chip only (the mockup: fan shrinks to a stub/count). This keeps 6–8 seats from overflowing.
- **≥ 7 players:** the rail **wraps to two rows** (flex-wrap) so 7–8 seats remain readable. Seating must be usable at the max of **8** (LLD 65 §9.1, 3–8 supported).

### Tallies & 150 loss-line

`TonkTallyPanel.vue` (right side panel): a ranked list of all players by tally ascending (lower is better), each row = rank, name, tally, and a thin **progress bar toward 150**. Header: `Tallies — lower wins`; footer note: `Game ends when anyone reaches 150`. A row whose tally is near the line (e.g. ≥ ~120, a display threshold) gets a `near-150` warning class (amber/red tint). The current **trick number** is shown in this panel (and the banner): `TRICK <n>`.

### Joker as icon

In `GameCard.vue`, a Joker (`isJoker(card)`) renders a centered joker **icon** (a glyph/inline SVG — e.g. a stylized jester/star), with no rank/suit, on the standard card face. **Never** the literal text "Joker". Worth-0 is a rule detail, not shown on the card.

### Mobile (≤ 767px)

Single-column stack like Big2 mobile (reuse the same grid override approach as `game-board--mobile`):

- **Rail** collapses to compact **pill rows**; **tallies fold into the seat pills** (count + score in the pill), so the right `TonkTallyPanel` is hidden in portrait (`display:none`, same as Big2 hides its log column). Approved: "mobile compact tallies look good!"
- **Center** keeps stock + discard + drawable in **one row**, cards scaled down (existing mobile card tokens).
- **Hand** scrolls horizontally (`TonkHand` copies `PlayerHand`'s mobile scroll behavior — decision 3).
- **Log** moves behind a **floating action button (FAB, `☰`)** opening a teleported drawer — copy `GameBoard.vue`'s `log-toggle` + `log-drawer` pattern (Esc to close, `prefers-reduced-motion` respected) but render `TonkLog` inside.
- Trick number abbreviates to `T<n>` on mobile.

All new colors are added as tokens in `src/frontend/styles/game-variables.css` (`--tonk-cyan`, `--tonk-phase-discard`, `--tonk-phase-draw`, and a `--tonk-near-150` warning tint). Reuse existing felt/rim/text/gold tokens everywhere else.

---

## Interfaces / Types

No shared types change except the additive `GameCard` prop. All Tonk view types already exist in `src/shared/tonk-types.ts` (`TonkPublicState`, `TonkCard`, `TonkJoker`, `isJoker`, `TonkLogEntry`, `TonkTrickResult`, `TonkTurnPhase`, `TonkDrawSource`).

### `GameView.vue` changes (two edits to the existing render tree)

**(a) Board dispatch** inside the `IN_PROGRESS`/`SHOW_FINAL_PLAY` board-container block:

```vue
<TonkBoard
  v-if="gameState.gameType === 'tonk'"
  :game-state="gameState"
  :turn-timer-seconds="turnTimerSeconds"
  :room-code="roomCode"
/>
<GameBoard
  v-else
  :game-state="gameState"
  ... (existing Big2 props unchanged) ...
/>
```

**(b) Ribbon gate.** The existing ribbon block today renders on `v-if="displayPhase === 'SHOW_FINAL_PLAY'"` (`GameView.vue:45-46`) with **no** game-type condition. Add the `gameType === "big2"` guard so it never renders over a Tonk board:

```vue
<!-- BEFORE: v-if="displayPhase === 'SHOW_FINAL_PLAY'" -->
<!-- AFTER: -->
<div
  v-if="displayPhase === 'SHOW_FINAL_PLAY' && gameState.gameType === 'big2'"
  class="game-view__final-play-ribbon"
  data-testid="final-play-overlay"
>
  ... (unchanged ribbon contents) ...
</div>
```

Notes:
- TonkBoard takes **no** selection/action props (read-only) and emits **no** events. `gameState.gameType` is on `PlayerView` (`engine-types.ts`), always present.
- During a Tonk match's transient `SHOW_FINAL_PLAY` step, `gameType === "tonk"` selects `<TonkBoard>` (which renders normally) **and** the gated ribbon `v-if` is false, so **no Big2 ribbon appears**. The `COMPLETED` branch then routes to `GameOverView`.
- The `skipToResults` / "Continue to Results" button lives inside the ribbon block, so gating the block out for Tonk means a Tonk game does not get a manual skip button during `SHOW_FINAL_PLAY`; it advances to `GameOverView` when the watcher's `COMPLETED` branch fires (same generic status flow Big2 uses). This is acceptable for read-only scope; a Tonk-specific results-advance affordance, if wanted, is the GameOver follow-up (§Dependencies).
- The watcher (`GameView.vue:162-172`) is **unchanged**.

### `TonkBoard.vue`

```ts
// props — read-only; no emits
defineProps<{
  gameState: EnrichedPlayerView; // from @shared/socket-events
  turnTimerSeconds: number | null;
  roomCode: string;
}>();

// derived (computed):
const tonkState = computed<TonkPublicState | null>(() =>
  gameState.gameType === "tonk" && gameState.gameSpecificPublicState
    ? (gameState.gameSpecificPublicState as TonkPublicState)
    : null,
);
const myPlayerIndex = computed(/* players.findIndex(p => p.playerId === you.playerId) */);
const isMyTurn = computed(() => gameState.currentPlayerIndex === myPlayerIndex.value);
const currentPlayerName = computed(/* players[currentPlayerIndex].displayName */);
const displayCode = computed(() => gameState.joinCode ?? roomCode); // same as GameBoard
```

### `GameCard.vue` — additive joker support

```ts
// BEFORE: card: Card
// AFTER (additive; Big2 unaffected):
defineProps<{
  card: Card | TonkJoker; // accepts a Tonk joker
  selected?: boolean;
  faceDown?: boolean;
  size?: "small" | "medium" | "large";
  interactive?: boolean;
}>();
// template: v-if isJoker(card) → render joker icon face; else existing rank/suit face.
```

### `TonkPiles.vue`

```ts
defineProps<{
  stockCount: number;
  discardTop: TonkCard | null;
  discardCount: number;
  lastDiscardCount: number;
  lastDiscardPlayerIndex: number | null;
  drawableDiscard: TonkCard | null;
  players: readonly PlayerPublicInfo[]; // to resolve the "just played" / "from" names
}>();
```

### `TonkPhaseBanner.vue`

```ts
defineProps<{
  turnPhase: TonkTurnPhase;
  trickNumber: number;
  currentPlayerName: string;
  isMyTurn: boolean;
}>();
```

### `TonkSeatRail.vue`

```ts
defineProps<{
  players: readonly PlayerPublicInfo[];
  tallies: readonly number[];          // by seat index
  currentPlayerIndex: number;
  myPlayerIndex: number;               // -1 when rendering as spectator (show all seats)
  turnPhase: TonkTurnPhase;
  turnDeadline: number | null;
  totalSeconds: number;
}>();
// renders one seat per player except myPlayerIndex (or all when myPlayerIndex === -1).
// compact (drop fan) when players.length >= 6; flex-wrap when >= 7.
```

### `TonkTallyPanel.vue`

```ts
defineProps<{
  players: readonly PlayerPublicInfo[];
  tallies: readonly number[];
  trickNumber: number;
}>();
// const LOSS_LINE = 150; // display constant (LLD 65 §5.2); progress = min(tally/150, 1)
```

### `TonkHand.vue`

```ts
// read-only local hand; no emits, no selection.
defineProps<{
  cards: readonly TonkCard[]; // NOT Card[] — accepts jokers
}>();
// key: isJoker(card) ? `joker-${card.id}` : `${card.rank}-${card.suit}`
// always passes interactive={false}, no selectedIndices; delegates to joker-aware GameCard.
// copies PlayerHand.vue's overlap/scroll/mobile CSS (read-only variant).
```

### `TonkLog.vue`

```ts
defineProps<{ entries: readonly TonkLogEntry[] }>();
// renders per TonkLogEntry: displayName + type ("discard"/"draw"/"callTonk");
// for discard → show discarded cards (GameCard small or text) + discardCount;
// for draw → show drawSource ("from stock"/"from discard") — NEVER the drawn card (hidden);
// trickResult present → render a trick-end summary line (reason, revealed handValues, tallyDeltas).
// Auto-scroll-to-bottom behavior copied from GameLog.vue.
```

---

## State Model

- **No new client state.** TonkBoard is a pure function of `props.gameState` (an `EnrichedPlayerView` produced by `useGameState`, unchanged). All Tonk-specific data is read from `gameState.gameSpecificPublicState` narrowed to `TonkPublicState`. The only local reactive state is the same as Big2's board: `isMobile` (matchMedia) and `logDrawerOpen` (mobile FAB), both UI-only.
- **Server-authoritative, information-hidden by construction.** TonkBoard reads only fields present in the public view:
  - Own hand: `gameState.you.hand` (the local player only — the server already filters this).
  - Opponents: `players[i].cardCount`, `displayName`, `isConnected` (counts only; never hands).
  - Stock: `stockCount` only (never `stock` contents — the field does not exist in `TonkPublicState`).
  - Public piles/tallies/log: `discardTop`, `discardCount`, `last*`, `drawableDiscard`, `tallies`, `log`.
  Because the public view physically excludes hidden info (architecture-principles #2), the board **cannot** leak it. The board does no rule computation (architecture-principles #1) — `validActions` is consumed only to label the turn/phase indicator, never to gate interactive controls (there are none).
- **Spectator-safe contract.** `TonkPublicState` is identical between `getPlayerView` and `getSpectatorView` (LLD 69). A spectator view has no `you.hand` (it's a `SpectatorView`, not `PlayerView`). TonkBoard's hand zone must render nothing when there is no local hand (e.g. `myPlayerIndex === -1`). Since the live dispatch only passes a `PlayerView` (the local player), spectator handling is a defensive/contract concern verified by unit test, not an end-to-end path (see Scope, Dependencies).
- **Persisted vs in-memory:** nothing persisted here; this is presentation only.

---

## Edge Cases

| # | Case | Handling |
| --- | --- | --- |
| E1 | `gameType === "tonk"` but `gameSpecificPublicState` is null/malformed | `tonkState` computed returns `null`; TonkBoard renders a minimal "loading" placeholder (no crash). Mirrors `GameBoard`'s `big2State` null-guard. |
| E2 | Trick 1, discard pile empty (`discardTop === null`) | Discard slot renders an "empty" placeholder; no "just played" label. |
| E3 | Trick-1 first player, `drawableDiscard === null` | Drawable slot renders a dimmed "no card to draw" placeholder (the absence is explicit, not blank). |
| E4 | Joker is the `discardTop`, the `drawableDiscard`, or in own hand | `GameCard` renders the joker **icon** in all positions (decision 5). |
| E5 | Multi-discard (`lastDiscardCount > 1`) | Discard top shows a `×N` badge (display only); only the single top card is shown (matches the snapshot rule — buried cards aren't drawable, aren't shown individually). |
| E6 | 3 players (min) | Seat rail shows 2 opponent seats with fans + tally chips; tally panel lists 3. |
| E7 | 8 players (max) | Seat rail is compact (no fans) and wraps to 2 rows; remains readable. Tally panel lists 8. |
| E8 | Tonk match completes (`IN_PROGRESS → COMPLETED`); transient `SHOW_FINAL_PLAY` | A Tonk match **does** make the generic `IN_PROGRESS → COMPLETED` status transition (LLD 65 §3.1/§4.1) and **does** set `state.winner` (lowest tally, display-only), so the `displayPhase` watcher (`GameView.vue:162-164`) **does** set `SHOW_FINAL_PLAY` for the brief interval before `COMPLETED`. The fix is **definitive**: (1) the Big2 final-play ribbon block is gated on `displayPhase === "SHOW_FINAL_PLAY" && gameState.gameType === "big2"` (decision 1b), so it never renders for Tonk; (2) during that transient step `TonkBoard` (selected by `gameType === "tonk"`) renders **normally and ribbon-free** — no Big2 "wins!" ribbon over the Tonk board; (3) the watcher's `COMPLETED` branch then routes to the existing `GameOverView`. This avoids the semantic error of showing a single-"winner" ribbon for Tonk's loss-centric model (no one "wins"; the displayed lowest-tally player did not win in any stats sense — LLD 65 §6.3) and avoids the ribbon's Big2-only `lastPlay`/`finalPlay` reads on a Tonk view. |
| E9 | Opponent disconnected | Reuse `OpponentRow`'s "disconnected" affordance in `TonkSeatRail` (read `players[i].isConnected`). |
| E10 | A player's tally ≥ 150 mid-render (before `COMPLETED`) | Tally panel shows the bar full + `near-150`/over-line styling; the board does **not** declare game over (server decides). |
| E11 | Spectator-style render (no local hand, `myPlayerIndex === -1`) | Hand zone renders nothing; seat rail renders all players; piles/tallies/log render from public state. (Contract-level; not a live route — Scope.) |
| E12 | Tie / equal tallies in the tally panel | Stable display order (e.g. by ascending tally then seat index); purely presentational. |
| E13 | `prefers-reduced-motion` | Pulse-dot and drawer transitions disabled (copy Big2's reduced-motion rules). |
| E14 | Long display names at ≥6 players | Names ellipsize (copy `OpponentRow` mobile ellipsis). |

---

## Dependencies

| Dependency | Status | Use |
| --- | --- | --- |
| `src/shared/tonk-types.ts` (`TonkPublicState`, `TonkCard`, `TonkJoker`, `isJoker`, `TonkLogEntry`, `TonkTrickResult`) | Implemented (#57 / LLD 69, PR #80) | The public view shapes TonkBoard renders. |
| `src/shared/engine-types.ts` (`PlayerView`, `SpectatorView`, `PlayerPublicInfo`, `Card`, `GameType`) | Implemented | Generic view fields + game-type dispatch key. |
| `src/shared/socket-events.ts` (`EnrichedPlayerView`) | Implemented | Prop type passed from `GameView`. |
| `src/frontend/component/game/GameView.vue` | Implemented | Add the one game-type dispatch conditional; no plumbing changes. |
| `src/frontend/component/game/GameBoard.vue` | Implemented | Skeleton/grid/mobile-drawer pattern to mirror; **not modified**. |
| `src/frontend/component/game-ui/GameCard.vue` | Implemented | **Modified additively** to accept `Card \| TonkJoker` and render a joker icon. Big2 path unchanged. |
| `src/frontend/component/game-ui/PlayerHand.vue` | Implemented | **NOT reused / not modified** — its `readonly Card[]` prop and `rank-suit` key are Big2-only and break for `TonkJoker` (no `rank`/`suit`). The new `TonkHand.vue` copies its read-only CSS/behavior but types `readonly TonkCard[]` and keys jokers by `id` (decision 3). |
| `src/frontend/component/game-ui/OpponentRow.vue`, `OpponentTimer.vue` | Implemented | Visual language (pulse-dot, active-border, timer) copied into `TonkSeatRail`; not modified. |
| `src/frontend/component/game-ui/GameLog.vue` | Implemented | Pattern/styling reference for `TonkLog`; not reused directly (Big2-typed). |
| `src/frontend/styles/game-variables.css` | Implemented | Add `--tonk-cyan`, `--tonk-phase-discard`, `--tonk-phase-draw`, `--tonk-near-150` tokens. |
| `docs/customer-experience.md` (§7 Spectating, mobile flows) | Reference | Spectator board shows public info only; mobile single-column. |

### Out of scope (separately tracked — do NOT build here)
- **Action controls** (discard/draw/call-TONK) — **#59**.
- **`deckRoundsTarget` lobby control + plumbing** — LLD 65 §8.8 / **#60**.
- **Spectator entry route wiring** for either game (GameView only joins as `role:"player"`; no spectator render path exists today) — **pre-existing gap, flag to CEO/execution-plan**, not this LLD.
- **`GameOverView` Tonk wording/ordering** — **explicit follow-up flagged here; NOT addressed in this LLD.** `GameOverView.vue` is Big2-shaped in two ways that are wrong for Tonk's loss-centric, lower-is-better model (LLD 65 §6.3):
  1. It renders `{{ winner }} wins!` (`GameOverView.vue:4`). For Tonk, the `winner` prop is `state.winner` = the **lowest-tally** player — a **display-only "best result"**, NOT a stats winner (everyone except the TRUE LOSER "won"; LLD 65 §4.1/§6.3). "`<name> wins!`" is therefore misleading for Tonk (it should read more like "lowest score" / "best result", and the loss-centric framing — who the TRUE LOSER was — is not surfaced).
  2. Its score table sorts **descending** (`b.score - a.score`, `GameOverView.vue:168`) and labels the column "Points" with higher = better placement. Tonk tallies are **penalties (lower is better)**, so the placement/ordering and "Points" semantics are inverted for Tonk.
  These render **without crashing** for a Tonk `scores`/`winner` shape (the props are structurally compatible — `PlayerScore[]` + a winner string), so the COMPLETED path is functional; but the wording/ordering is semantically Big2-specific. **Decision:** keep `GameOverView` unchanged in this read-only board LLD (it routes correctly and does not break), and track Tonk-correct GameOver wording/ordering as a **separate follow-up** (suggest folding into #59 results polish or the stats LLD 66, where Tonk's `breakdown.trueLoser`/`finalTally` are already in scope). Flagged for CEO/execution-plan to slot. The dispatch test (§Test Requirements) asserts a completing Tonk game reaches `GameOverView` without a Big2 ribbon; it does **not** assert Tonk-correct GameOver copy (out of scope here).

---

## Test Requirements

Per testing-principles: bias toward automated assertions; reserve manual checks for genuine visual/responsive verification. These are **component/unit tests** (Vue Test Utils + Vitest, mounting components with constructed `PlayerView` fixtures) plus a small manual matrix for layout. No engine, server, or network in these tests.

### Unit — dispatch (`GameView.vue`)
- `gameType === "tonk"` (IN_PROGRESS) renders `TonkBoard`, not `GameBoard`.
- `gameType === "big2"` still renders `GameBoard` (no regression). Both assert the other board is absent.
- **Tonk transient `SHOW_FINAL_PLAY` step (E8 — the key regression guard):** drive a Tonk game through the generic `IN_PROGRESS → COMPLETED` status transition so the watcher sets `displayPhase === "SHOW_FINAL_PLAY"` (set `gameState.gameType === "tonk"`, give it a `state.winner`), then assert: (a) `TonkBoard` is rendered, and (b) the final-play ribbon (`[data-testid="final-play-overlay"]`) is **absent** (negative assertion — the Big2 "wins!" ribbon must not appear over the Tonk board). Mirror with a Big2 control case asserting the ribbon **is** present in `SHOW_FINAL_PLAY`, proving the gate is `gameType`-specific and Big2 is unregressed.
- A `tonk` game reaching `COMPLETED` renders `GameOverView` (and still no Big2 final-play ribbon) — E8 end state. (This LLD does **not** assert Tonk-correct GameOver wording/ordering — that is the flagged follow-up, §Dependencies.)

### Unit — TonkBoard rendering from `TonkPublicState`
- Given a constructed `EnrichedPlayerView` with a `TonkPublicState`, assert the DOM shows: own hand cards (count matches `you.hand`), discard top card, the cyan drawable slot (with the `drawableDiscard` card), the face-down stock with `stockCount` label, opponent counts, the trick number, and the per-player tallies.
- `discardTop === null` → empty placeholder, no "just played" label (E2).
- `drawableDiscard === null` → "no card to draw" placeholder, not blank (E3).
- `lastDiscardCount > 1` → `×N` badge on discard (E5).

### Unit — phase / turn indicator (B1)
- `turnPhase === "discard"` vs `"draw"` → banner chip text and the distinct phase-color class applied; active-seat phase tag matches.
- `isMyTurn` true → "Your turn"; false → "<name>'s turn".
- Active seat shows the pulse-dot; non-active seats do not.

### Unit — seats (3–8, compact/wrap)
- 3 players → 2 opponent seats with card-back fan + tally chip.
- 6 players → compact seats (no fan), count + tally chip present.
- 7 and 8 players → rail wraps (assert the wrap class / 2-row layout) and remains rendered for all seats (usable at 8). (E6, E7)
- Disconnected opponent shows the disconnected affordance (E9).

### Unit — tally panel & 150 line
- Tallies render ranked ascending; each row's progress bar = `min(tally/150, 1)`.
- A tally ≥ near-line threshold gets the `near-150` class; a tally ≥ 150 shows full bar/over-line styling without declaring game over (E10).
- Trick number rendered (E12 stable order asserted).

### Unit — Joker icon
- A hand/discard/drawable containing a `TonkJoker` renders the joker **icon** element and **does not** contain the literal text "Joker" (negative assertion). Big2 cards still render rank+suit (no regression).

### Unit — TonkLog
- A `discard` entry shows name + discarded cards + count; a `draw` entry shows the source label and **never** a drawn-card value (negative assertion: drawn card not in DOM); a `trickResult` entry renders the trick-end summary.

### Security / information-hiding (testing-principles #7)
- **Negative assertions:** mount TonkBoard with a `PlayerView` where opponents have `cardCount` only and `TonkPublicState` has `stockCount` only; serialize the rendered output and assert **no opponent hand card** and **no stock card** appears (they aren't in the props, so they can't render — this guards against any future code reaching for hidden data).
- **Spectator contract (E11):** with `myPlayerIndex === -1` / no `you.hand`, assert the hand zone renders nothing and the rest renders from public state.

### Manual (visual/responsive only — cannot be asserted on computed state)
| Check | Viewport | Expectation |
| --- | --- | --- |
| Center piles legibility | desktop | Stock/discard/drawable distinct; cyan ring reads against felt; A1 layout matches mockup. |
| Phase chip colors | desktop | discard vs draw chips clearly distinguishable; active-seat tag matches. |
| 8-player seating | desktop | 2-row wrap, no overflow, readable. |
| Mobile stack | ≤375px | single column; tallies folded into seat pills; log FAB opens drawer; hand scrolls; one-row piles. |
| Reduced motion | any | pulse-dot + drawer animations disabled. |

(Run via `npm run dev` / `docker compose up` per DEVELOPMENT.md.)
