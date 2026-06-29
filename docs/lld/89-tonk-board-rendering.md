# LLD 89: Tonk Board Rendering (read-only board: hand, discard pile, stock, tallies)

> Parent: #41. Order 3 of 5. Depends on #57 (Tonk engine — merged as LLD 69 / PR #80).
> Frontend direction signed off in issue comment (2026-06-29): **A1 + B1 + compact seats at 6**, joker rendered as an **icon**, mobile compact tallies approved. Mockup gate is **CLEARED** — build to that direction.

## Scope

**In scope** — a new **read-only** Tonk game board (`TonkBoard.vue`), dispatched by game type, that renders entirely from the server-provided Tonk `PlayerView`/`SpectatorView` (`gameSpecificPublicState: TonkPublicState`):

- Player's own hand (face up), including Jokers (rendered as an icon).
- Discard pile **top** card (`discardTop`) AND the **`drawableDiscard`** indicator — the turn-start snapshot, visually distinct from the live pile top (LLD 65 §3.3/§4.2).
- Stock as a **face-down** pile showing its **count** only (`stockCount`).
- Opponent hand **counts** (no card contents).
- **Turn + phase** indicator: whose turn it is and whether they are in the `discard` or `draw` phase (`turnPhase`).
- Per-player **running tallies** (lower is better) and the **trick number** (`tallies`, `trickNumber`).
- Game log (`TonkLogEntry[]`).
- 3–8 player seating; usable (compact) at 6–8.
- Mobile-responsive layout.
- Dispatch in `GameView.vue`: render `TonkBoard` when `gameState.gameType === "tonk"`, `GameBoard` otherwise.

**Explicitly NOT in scope:**

- **No action controls** of any kind — no discard/draw/callTonk buttons, no card selection, no action panel, no emits to the parent. Those are #59. The hand is non-interactive here.
- **No melds / spreads / hits / drops** — these mechanics DO NOT EXIST in this variant (LLD 65 §1, §2.2.5). Do not render them. Disregard any older issue text mentioning them.
- **No spectator transport/join wiring.** `GameView.vue` joins only as `role: "player"` and only handles `game:state` today; adding a `game:spectatorState` subscription is a separate concern. `TonkBoard` is built so a spectator-shaped view renders public-only (see State Model), but wiring the spectator socket path is out of scope here.
- **No new Tonk branches in the WebSocket/state-composable plumbing.** Board selection happens **only** at the `GameView.vue` component-dispatch layer. `useGameState`, `useSocket`, `socket-events.ts`, and the engine view-builders are untouched.
- **No engine/shared-type changes.** Rendering consumes the existing `TonkPublicState` (`src/shared/tonk-types.ts`) as-is.

## Approach

**Key decisions and rationale:**

1. **Dispatch at the component layer only.** `GameView.vue` already passes `gameState: EnrichedPlayerView` into `GameBoard`. We add a single `v-if`/`v-else` branch on `gameState.gameType` to choose `TonkBoard` vs `GameBoard`. The plumbing above `GameView` (socket, `useGameState`) is game-agnostic and stays so (architecture-principles #9). `GameView`'s Big2-specific selection state (`selectedIndices`, `toggleCard`, `onPlay`, `onPass`) is **not** wired to `TonkBoard` — the read-only board takes no selection/action props or emits.

2. **Render strictly from the server view; zero client-side rules.** `TonkBoard` reads `gameState.gameSpecificPublicState as TonkPublicState` and `gameState.you.hand`. It computes **no** legality, **no** drawable-source logic, **no** scoring — it only displays fields the engine already computed (architecture-principles #1). Whether a card is "the drawable discard" is taken verbatim from `drawableDiscard`, never recomputed.

3. **Reuse shared primitives where they fit; add Tonk layout only where Big2's doesn't map.**
   - `OpponentRow.vue` — reused as-is for opponent counts (already an uncapped `v-for`, LLD 65 §2.3). Compact-seat CSS for 6–8 is added in `TonkBoard`'s scope (see Frontend Design), not by editing `OpponentRow`.
   - `GameLog.vue` — **cannot be reused directly.** It is typed to `Big2HistoryEntry` (`action: "play" | "pass"`, `handType`, Big2 cards). Tonk's `TonkLogEntry` has a different shape (`type: "discard" | "draw" | "callTonk"`, `discarded`, `drawSource`, `trickResult`). A small **`TonkGameLog.vue`** is added rather than overloading `GameLog`. (Alternative: gener'ize `GameLog` with a discriminated union — rejected as out-of-scope churn to a Big2-stable component; keep changes surgical per CLAUDE.md §3.)
   - `GameCard.vue` — reused for **standard** cards. It is typed to `Card` (suit+rank) and has **no Joker branch**, so a Joker must not be passed to it. A thin **`TonkCardView.vue`** wrapper renders a Joker as an icon and delegates standard cards to `GameCard`. (Alternative: extend `GameCard` to accept `TonkCard` — rejected; it would push Tonk concepts into a shared Big2 primitive. The wrapper keeps the joker concern Tonk-local.)
   - `PlayerHand.vue` — **not reused** (it is interactive: `selectedIndices`, `interactive`, `toggle-card`, typed to `Card[]`). `TonkBoard` renders its own non-interactive hand strip of `TonkCardView` (a fanned, read-only row reusing `PlayerHand`'s overlap/scroll CSS pattern). This avoids threading unused selection props through a read-only board.

4. **`drawableDiscard` is rendered as a separate, labeled slot** next to the discard pile — not stacked on it — because it is conceptually distinct from the live pile top (LLD 65 §3.3): it is what a drawing player *could* take, captured at turn start. Rendering it as its own face-up "drawable" slot makes the distinction visually unambiguous (acceptance criterion). When `drawableDiscard === null` (trick-1 first player, or pre-discard), the slot shows an empty/"no draw" placeholder.

5. **Joker as icon (approved).** `TonkCardView` detects a joker via the shared `isJoker(card)` guard (`src/shared/tonk-types.ts`) and renders a joker glyph/icon on a card face, never text "Joker". Value badge optional; not required for read-only display.

## Interfaces / Types

No new shared types. Components consume existing types from `@shared/tonk-types` and `@shared/socket-events`.

**`TonkBoard.vue`** (new, `src/frontend/component/game/`):

```ts
const props = defineProps<{
  gameState: EnrichedPlayerView; // gameType === "tonk"; same prop GameBoard receives
  roomCode: string;
}>();
// NO emits. Read-only.

// Derived (computed), all from server data — no rule computation:
const tonkState = computed<TonkPublicState | null>(() =>
  props.gameState.gameType === "tonk" && props.gameState.gameSpecificPublicState
    ? (props.gameState.gameSpecificPublicState as TonkPublicState)
    : null,
);
const myHand        = computed<readonly TonkCard[]>(() => (props.gameState.you?.hand ?? []) as readonly TonkCard[]);
const myPlayerIndex = computed(() => /* findIndex you.playerId in players, may be -1 for spectator */);
const isMyTurn      = computed(() => myPlayerIndex.value === props.gameState.currentPlayerIndex);
const currentName   = computed(() => props.gameState.players[props.gameState.currentPlayerIndex]?.displayName ?? "");
// phase label: tonkState.turnPhase ("discard" | "draw")
// tallies: tonkState.tallies (by seat index, align to players[] by index)
// trick: tonkState.trickNumber
```

**`TonkCardView.vue`** (new, `src/frontend/component/game-ui/`):

```ts
const props = withDefaults(
  defineProps<{
    card: TonkCard;                 // standard Card OR TonkJoker
    size?: "small" | "medium" | "large";
    faceDown?: boolean;
  }>(),
  { size: "medium", faceDown: false },
);
// if faceDown → card-back; else if isJoker(card) → joker-icon face; else → <GameCard :card size>
// Non-interactive: never emits, never accepts selected/interactive.
```

**`TonkGameLog.vue`** (new, `src/frontend/component/game-ui/`):

```ts
const props = defineProps<{ entries: readonly TonkLogEntry[] }>();
// Renders, per entry: displayName + action phrase:
//   type "discard" → "discarded {n}×" (discardCount) with discarded cards rendered via TonkCardView small
//   type "draw"    → "drew from {drawSource}"  (drawn card is hidden — never shown)
//   type "callTonk"→ "called TONK"
//   entry.trickResult present → a trick-summary row: trick #, reason (tonk/stockout),
//     per-seat handValues + tallyDeltas. (Hands revealed at trick end are public here.)
// Mirrors GameLog.vue auto-scroll-to-bottom behavior.
```

**`GameView.vue`** dispatch (only change to existing file):

```vue
<TonkBoard
  v-if="gameState.gameType === 'tonk'"
  :game-state="gameState"
  :room-code="roomCode"
/>
<GameBoard
  v-else
  :game-state="gameState"
  ...existing Big2 props/emits unchanged...
/>
```

The `SHOW_FINAL_PLAY` ribbon and `GameOverView` branches are Big2-shaped (`Big2Play`, `playHistory`); they are left unchanged and continue to apply only to Big2 in practice. Tonk end-of-game UI is a later sub-issue — this LLD does not touch the final-play/game-over branches.

## State Model

- **Nothing persisted; nothing fetched.** `TonkBoard` is purely presentational. All data arrives via the `gameState` prop, which `GameView` already keeps reactive from the `useGameState` composable (`game:state` events). No new socket subscriptions, no REST calls, no local game state.
- **Source of truth:** `TonkPublicState` (built server-side by `TonkEngine.buildPublicState`, verified in `tonk-engine.ts`). Fields consumed: `turnPhase`, `trickNumber`, `stockCount`, `discardTop`, `discardCount`, `drawableDiscard`, `lastDiscardCount`, `lastDiscardPlayerIndex` (for "N of top are current player's", optional), `tallies`, `log`. Plus top-level `players[].cardCount`, `currentPlayerIndex`, `you.hand`.
- **Seat alignment:** `tonkState.tallies`, `revealedHands`, `handValues`, `tallyDeltas` are all **indexed by seat**, parallel to `gameState.players[]`. The board must align them by array index (player `i`'s tally is `tallies[i]`), exactly as `OpponentRow` aligns by `originalIndex`.
- **Information hiding is server-enforced (architecture-principles #2):** stock contents and opponent hands are simply **absent** from the payload (`stockCount` is a number; opponents carry `cardCount` only). The board renders counts/backs because that is all it has — it does not "hide" anything client-side. A spectator view (no `you.hand`, or empty) therefore renders public-only by construction.
- **Spectator behavior:** when `you` is absent/empty or `myPlayerIndex === -1`, `TonkBoard` renders no own-hand strip and shows public info only. (The component is spectator-safe; wiring the spectator *join* path is out of scope — see Scope.)

## Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | `gameSpecificPublicState` is `null`/undefined mid-transition | `tonkState` computed returns `null`; board renders a neutral "loading" placeholder for the table region rather than throwing. |
| 2 | `drawableDiscard === null` (trick-1 first player, or no preceding discard) | Render the drawable slot as an empty/"no draw" placeholder, visually distinct from a present card. Never fabricate a card. |
| 3 | `discardTop === null` (trick-1 empty pile) | Render the discard pile as an empty slot with `discardCount = 0`. |
| 4 | `drawableDiscard` equals the same card object as `discardTop` (trick-2+ starter, before discarding) | Render both slots; the labels ("Top of pile" vs "Drawable") disambiguate. Do not dedupe — they are conceptually separate snapshots. |
| 5 | Hand contains Joker(s) | `TonkCardView` renders joker as icon via `isJoker()`. Standard cards delegate to `GameCard`. Mixed hands render correctly. |
| 6 | `stockCount === 0` (stock exhausted) | Render the stock as an empty face-down slot showing `0`. No card backs drawn. |
| 7 | 8 players (max) | Seats remain readable via compact-seat CSS (Frontend Design). Opponent row wraps/shrinks; no overflow off-screen. |
| 8 | Spectator / `you` absent | No own-hand strip; public-only render (State Model). |
| 9 | `tallies.length` mismatch vs `players.length` (defensive) | Index by seat; render `tallies[i] ?? 0`. Never assume length equality beyond what the engine guarantees. |
| 10 | `log` empty (game just started) | `TonkGameLog` renders an empty list (no header churn), mirroring `GameLog`. |
| 11 | Mobile viewport | Log moves to the same drawer/toggle pattern `GameBoard` uses (or an equivalent collapsed panel); tallies render in the **compact** mobile form (approved). Hand strip is horizontally scrollable like `PlayerHand`. |
| 12 | Status `COMPLETED` reached while this board is mounted | This board is only mounted for `IN_PROGRESS`/`SHOW_FINAL_PLAY` (driven by `GameView`'s `displayPhase`). Trick-end reveals appear in the log via `trickResult`. End-of-match UI is a separate sub-issue. |

## Frontend Design

Implements the approved direction: **A1 + B1, compact seats at 6, joker-as-icon, mobile compact tallies.**

**A1 — board layout (center-stack table).** Desktop uses a CSS grid mirroring `GameBoard`'s structure (`opponents / table / hand / log` areas) so the Tonk board feels consistent with Big2:

- **Opponents row** (top): `OpponentRow.vue` reused, plus a `RoomCodeChip`. The opponent's `cardCount` is the Tonk hand count.
- **Table (center, A1):** a horizontal cluster of three labeled slots — **Stock** (face-down pile + count badge), **Discard** (top card via `TonkCardView`, with a small "×N current" hint from `lastDiscardCount` when the current player placed the live top), and **Drawable** (the `drawableDiscard` card or empty placeholder). The Drawable slot is visually emphasized (e.g. gold dashed outline / "Drawable" caption) so it reads as distinct from the pile top. A centered **turn + phase banner** ("{name}'s turn — discard phase" / "draw phase") sits above the slots, reusing the felt/gold styling tokens.
- **Tallies (B1 — persistent side/strip panel):** a compact per-player tally panel (name + running tally, lower-is-better) plus the current **trick number**. Rendered as a small standings strip (B1) rather than a modal — always visible. Highlight the current player's row.
- **Hand strip (bottom):** read-only fanned row of `TonkCardView` (large), reusing `PlayerHand`'s overlap (`--card-overlap`) and horizontal-scroll CSS; **non-interactive** (no lift/select states).
- **Log (right column):** `TonkGameLog`, styled with the same `--panel-bg` / `--gold-accent` tokens as `GameLog`.

**Joker as icon.** `TonkCardView` renders a Joker as a card-face with a joker glyph/icon (e.g. a jester/🃏-style mark) centered, using existing card dimensions (`--card-hand-width/height`) and the standard card border — never the literal word "Joker".

**Compact seats at 6 (seating polish).** When `players.length >= 6`, the opponents area applies a compact modifier (smaller seat padding, smaller name font, hidden mini card-back fans — keep the count badge) so 6–8 seats fit without horizontal overflow or off-screen clipping. This is `TonkBoard`-scoped CSS (a wrapper class toggled on player count); `OpponentRow.vue` itself is not modified. At 8 the row must remain fully visible and readable (acceptance criterion).

**Mobile (compact tallies approved).** On `max-width: 767px`:

- Reuse `GameBoard`'s single-column grid + log-drawer/toggle pattern (or an equivalent collapsed log) so the table and hand get full width.
- Tallies render in the **compact** form (approved): a condensed inline standings strip (name abbreviations + tally numbers) rather than the full side panel.
- Stock/Discard/Drawable slots shrink to mobile card sizes (`--card-play-width/height` mobile overrides already exist).
- Hand strip uses the existing mobile `PlayerHand` scroll treatment.

Use existing CSS variables from `src/frontend/styles/game-variables.css` (felt, gold-accent, panel-bg, card sizing, mobile heights) throughout; do not introduce a parallel palette.

## Dependencies

| Dependency | Status | Use |
|---|---|---|
| #57 Tonk engine (LLD 69) | **Merged (PR #80)** | Produces `gameSpecificPublicState: TonkPublicState` and `you.hand: TonkCard[]`. This board renders that contract verbatim. |
| `src/shared/tonk-types.ts` | Exists | `TonkPublicState`, `TonkCard`, `TonkJoker`, `isJoker`, `TonkLogEntry`, `TonkTrickResult`. |
| `EnrichedPlayerView` (`@shared/socket-events`) | Exists | The prop type passed from `GameView`. |
| `GameView.vue` | Exists | Receives the dispatch change (only edit to existing code). |
| `GameCard.vue`, `OpponentRow.vue`, `RoomCodeChip.vue` | Exist, reused unchanged | Standard cards, opponent counts, room code. |
| `game-variables.css` | Exists | Styling tokens. |

No backend, schema, socket-event, or shared-type changes. Spectator socket wiring (`game:spectatorState`) is a **separate** sub-issue and is not a prerequisite for this read-only board (the component is spectator-shaped-safe).

## Test Requirements

Per testing-principles: bias toward automated assertions; reserve manual checks for genuine visual/responsiveness items. Engine rules are already covered by #57 — **do not** re-test Tonk logic here. These tests assert **rendering of server-provided view data** and the **dispatch**.

**Unit (component, e.g. Vitest + Vue Test Utils):**

1. `GameView` dispatch: with `gameState.gameType === "tonk"` renders `TonkBoard` and not `GameBoard`; with `"big2"` renders `GameBoard` and not `TonkBoard`. (Big2 path is unaffected.)
2. `TonkBoard` renders own hand from `you.hand` — N cards for N-card hand; renders a Joker via `TonkCardView` (joker icon present, word "Joker" absent).
3. Discard pile renders `discardTop` (or empty slot when `null`); `discardCount` shown.
4. **Drawable indicator:** when `drawableDiscard` is a card, a distinct drawable slot renders it; when `null`, the drawable slot renders the empty/"no draw" placeholder (not a card). Asserts the drawable slot is a distinct element from the pile-top slot.
5. Stock renders face-down with `stockCount`; `stockCount === 0` renders an empty stock showing 0 (no card backs).
6. Opponent counts: each non-self player shows its `cardCount`; no opponent hand contents in the DOM.
7. **Turn + phase indicator:** shows the current player's name and the correct phase label for `turnPhase === "discard"` and `"draw"`.
8. **Tallies + trick:** each player's tally renders by seat index aligned to `players[]`; `trickNumber` shown; current player's tally row highlighted.
9. `TonkGameLog` renders each `TonkLogEntry` type correctly (discard count, draw source, callTonk) and a `trickResult` summary row; the **drawn card is never rendered** for a `draw` entry (information-hiding assertion).
10. Seat count: renders without error for 3 and 8 players; at `>= 6` the compact-seat wrapper class is applied.

**Security / information-leakage (testing-principles #7):**

11. Given a `TonkPublicState`-shaped view (no opponent hands, `stockCount` only), assert the rendered DOM contains **no** card faces other than the viewer's own hand + the public discard/drawable cards + log-revealed trick-end hands. No opponent in-progress hand contents, no stock contents, appear anywhere. (Rendering can only show what the payload contains — this verifies the board never reaches for hidden data.)
12. Spectator-shaped view (`you` absent / `myPlayerIndex === -1`): no own-hand strip renders; public info (discard, drawable, stock count, counts, tallies, log) still renders.

**Manual (visual/responsive only — cannot be asserted in DOM):**

13. Desktop: 3–8 player seating is readable; at 8 the opponent row is fully on-screen (no clipping). Drawable slot reads as visually distinct from the pile top.
14. Mobile (≤767px): table, hand, compact tallies, and log-drawer are usable; hand scrolls horizontally; nothing overflows the viewport.
