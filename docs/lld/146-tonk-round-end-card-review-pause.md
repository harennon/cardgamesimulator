# LLD 146: Add a brief pause when a player tonks to review cards before the next round

## Scope

A **client-side-only** presentation feature for Tonk. When a Tonk round (trick) ends — a player calls TONK or the stock runs out — the engine already scores the round, appends a `TonkTrickResult` (revealed hands + per-seat hand values + tally deltas) to the log, and **synchronously deals the next round in the same state update**. This LLD introduces a transient `SHOW_TRICK_RESULT` display phase in `GameView.vue` that surfaces a **showdown reveal overlay** (Direction A — approved) driven off the newest log entry's `trickResult`, blurring/dimming the already-dealt next-round board behind it, before the player interacts with the next round. Auto-dismisses on a short timer or an explicit Continue tap, **per-client** (never blocks the next round for other players).

### Covers

- A new `DisplayPhase` value `SHOW_TRICK_RESULT` in `GameView.vue`, entered when a **new** Tonk trick-result arrives while the game is still `IN_PROGRESS`, exited on timer or Continue.
- A reveal overlay component (`TonkTrickReveal.vue`, NEW) that renders the showdown table: one row per player (fanned revealed hand, hand value, points-taken delta + running total), flagging the TONK caller and the best/lowest hand. Scales 3–8 players; collapses to name+delta-over-hand on mobile.
- Reuse of the LLD-105 blur+dim board-scrim pattern: the `TonkBoard` behind the overlay is blurred and non-interactive during the reveal.
- Auto-dismiss timer (with a visible countdown hairline + hint) **and** a Continue button that skips the remaining time. Per-client.
- Pure display-derivation helpers for the showdown rows, added to `tonkDisplay.ts` and unit-tested in isolation.

### Explicitly does NOT cover

- **No engine, backend, socket-protocol, data-model, or shared-type change.** `TonkTrickResult` (`revealedHands`, `handValues`, `tallyDeltas`, `reason`, `tonkCallerIndex`, `trickNumber`) is already produced by `endTrick()` and already preserved into the next trick's public state (`setupNextTrick` copies `log: newLog`). This LLD is a pure consumer of the already-filtered `getPlayerView` output. **Do NOT add a server-side round-review turn phase** (Direction 2 in the issue is explicitly rejected).
- **No synchronized multiplayer pause.** The reveal is per-client: each player's timer/Continue is independent. The engine has already advanced to the next round for everyone; the overlay only gates the *local* board's interactivity, and only until this client's timer elapses or the player continues. It can never stall another player's game.
- **The match-end (`COMPLETED`) reveal.** When the trick that ends is also the match-ending trick, Tonk goes straight to `COMPLETED` → `GameOverView` (existing behavior, `GameView.vue:226-242`). This LLD's reveal fires only for **non-terminal** round ends (game stays `IN_PROGRESS`). See Edge Cases E5.
- **Big2.** Big2 has no `TonkPublicState`/`trickResult`; the existing `SHOW_FINAL_PLAY` Big2 reveal (`GameView.vue:27-102`, gated `gameType === 'big2'`) is untouched. This LLD adds a parallel, Tonk-gated branch.
- **The `TonkLog` trick-result line** (`TonkLog.vue`, `trickResultSummary`). Unchanged; the log remains the scrollable history. The new overlay is the review surface visible **without** opening the drawer.

---

## Approach

### A. Client-side, driven off the newest `trickResult` (issue Direction 1, approved)

The engine appends the trick-result log entry then immediately deals the next round in one `applyAction` result. The single `game:state` the client receives therefore already contains: (a) the next round's fresh board (`turnPhase: "discard"`, new `hands`, reset piles, incremented `trickNumber`), and (b) the just-ended round's `TonkTrickResult`, living inside the newest log entry that carries `trickResult`. The client reconstructs the review pause from (b) while deferring interaction with (a).

**Detection** — `GameView` derives `latestTrickResult`: scan `tonkState.log` from the end for the first entry with a `trickResult`; that is the most recently ended round. Track `lastRevealedTrickNumber` (client-local `ref`, init `null`). On each `game:state`, if the game is `IN_PROGRESS` and `latestTrickResult` exists and `latestTrickResult.trickNumber !== lastRevealedTrickNumber`, enter `SHOW_TRICK_RESULT` and set `lastRevealedTrickNumber = latestTrickResult.trickNumber`. This fires exactly once per round end and is idempotent across redundant/interleaved state updates (spectator-count events, timer refreshes) because the trick number only advances on a real round end.

> **Why `trickNumber`, not `version` or log length?** `version` and `turnNumber` increment on every action, so they cannot identify "a round just ended." Log length grows every action too. The trick-result's `trickNumber` is the stable, monotonic identifier of *which round* the reveal is for. Using it makes re-entry impossible for a round already shown (reconnect, late state) — see E4/E6.

### B. `SHOW_TRICK_RESULT` is a transient client display phase, parallel to `SHOW_FINAL_PLAY`

`DisplayPhase` gains `"SHOW_TRICK_RESULT"`. It is **not** a server/engine state; the server only ever reports `IN_PROGRESS`/`COMPLETED`. The board still renders underneath (blurred) because the game IS in progress — the next round is live for everyone else. Exit routes:

- **Timer elapses** (default `REVEAL_DURATION_MS`) → phase returns to `IN_PROGRESS`.
- **Continue tapped** → phase returns to `IN_PROGRESS` immediately (clears the timer).
- **A newer trick-result arrives while revealing** (only possible if this client was slow/backgrounded and another full round elapsed) → re-arm for the newest trick (E7): update `lastRevealedTrickNumber`, restart the timer, keep showing (now the newest) reveal. In practice the local board is blurred/non-interactive so the local player cannot themselves cause a new round; a new round can only arrive from other players acting.
- **`status` becomes `COMPLETED`** → go straight to `COMPLETED` (match over supersedes any pending reveal), see E5.

### C. Reuse the LLD-105 blur scrim; the reveal is a Tonk-gated sibling of the Big2 reveal

`GameView` already blurs the board via `.game-view__board-container--revealing` and hosts a crisp reveal layer above it (LLD 105, `GameView.vue:539-568`). We extend the `--revealing` modifier condition to also cover `SHOW_TRICK_RESULT`, and add a Tonk-gated reveal block (`<TonkTrickReveal>`) alongside the existing Big2-gated `.game-view__reveal`. The blur/scrim CSS is shared; only the crisp content differs (showdown table vs. Big2 winner+final-play).

Because `TonkBoard` uses `position: fixed; inset: 0` (`TonkBoard.vue:253-254`) rather than living inside `.game-view__board-container`, the blur target differs from Big2's `:deep(.game-board)`. The `--revealing` blur rule must target `:deep(.tonk-board)` for the Tonk case (Frontend Design §Board blur layer). The overlay itself is rendered by `GameView` at `z-index` above the Tonk board's wood-rim (`z-index: 100`, `TonkBoard.vue:289-303`), matching how the Big2 reveal sits at `z-index: 101`.

### D. Per-client, auto-dismiss + skip (approved)

A single `setTimeout(REVEAL_DURATION_MS)` per reveal, stored in a `ref`, cleared on Continue / component unmount / re-arm. The overlay shows a countdown hairline (CSS animation) and a "Next round in Ns · everyone continues on their own" hint (timer model) — matching the approved mockup. This is purely local: no socket emit, no server awareness. Other players' clients run their own independent timers off their own `game:state`.

> **Why no synchronization?** The engine has already advanced the round for all seats; a synchronized pause would require Direction 2 (a server round-review phase + timeout handling), explicitly rejected. Per-client is sufficient for the user need ("a beat to review") and cannot deadlock or block anyone. The hint text sets the expectation ("everyone continues on their own").

### E. Pure display helpers (testing-principles #1, LLD 88 display-helper boundary)

All row derivation (who is caller, who has the best hand, sorted order, delta/total formatting) is extracted into pure functions in `tonkDisplay.ts` and unit-tested directly — no rule computation, only presentational transforms of the already-public `TonkTrickResult` + `tallies` + `players`.

---

## Interfaces / Types

**No shared-type / engine changes.** `TonkTrickResult`, `TonkPublicState`, `TonkLogEntry` are consumed as-is.

### `GameView.vue` (local)

`DisplayPhase` extended:

```ts
type DisplayPhase =
  | "CREATED"
  | "IN_PROGRESS"
  | "SHOW_FINAL_PLAY"   // Big2 match-end (unchanged)
  | "SHOW_TRICK_RESULT" // NEW — Tonk per-round reveal pause
  | "COMPLETED";
```

New local state and computeds:

```ts
const REVEAL_DURATION_MS = 6000; // approved default; see Edge Cases E8

const lastRevealedTrickNumber = ref<number | null>(null);
let revealTimer: ReturnType<typeof setTimeout> | null = null;

// Newest ended-round result in the current Tonk log, or null. Pure derivation.
const latestTrickResult = computed<TonkTrickResult | null>(() => { ... });

function enterTrickReveal(): void;   // sets phase, arms revealTimer
function dismissTrickReveal(): void; // clears timer, phase → IN_PROGRESS (Continue / timeout)
```

`toFeedbackPhase` gains a `SHOW_TRICK_RESULT → "in-progress"` case (it is an in-progress round-boundary).

`TonkTrickReveal` is Tonk-gated in the template, e.g.:

```html
<TonkTrickReveal
  v-if="displayPhase === 'SHOW_TRICK_RESULT' && gameState?.gameType === 'tonk' && latestTrickResult"
  :trick-result="latestTrickResult"
  :players="gameState.players"
  :tallies="tonkTallies"
  :my-player-index="myTonkPlayerIndex"
  :duration-ms="REVEAL_DURATION_MS"
  data-testid="tonk-trick-reveal"
  @continue="dismissTrickReveal"
/>
```

The board container gets `--revealing` when `displayPhase === 'SHOW_TRICK_RESULT'` (Tonk) in addition to the existing Big2 `SHOW_FINAL_PLAY` condition.

### `TonkTrickReveal.vue` (NEW)

```ts
const props = defineProps<{
  trickResult: TonkTrickResult;
  players: readonly PlayerPublicInfo[];
  tallies: readonly number[];        // running match tallies AFTER this round (for "total N")
  myPlayerIndex: number;             // -1 for spectator render
  durationMs: number;
}>();
const emit = defineEmits<{ continue: [] }>();
```

- Renders a `verdict` header (reason + who won/called), a `showdown` list (one `TonkTrickReveal` row per player), and a `reveal__cta` (Continue button with countdown hairline + timer hint).
- The countdown is purely visual (CSS animation of `durationMs`); the authoritative timer lives in `GameView` (so unmount/skip logic is centralized). The component emits `continue` on button tap; `GameView` owns the `setTimeout`.
- Uses `GameCard` (or the existing Tonk card rendering) for revealed hands, joker-aware via `isJoker`.

### `tonkDisplay.ts` additions (pure, unit-tested)

```ts
export interface TrickRevealRow {
  readonly seatIndex: number;
  readonly displayName: string;
  readonly hand: readonly TonkCard[];   // revealedHands[seatIndex]
  readonly handValue: number;           // handValues[seatIndex]
  readonly delta: number;               // tallyDeltas[seatIndex]
  readonly total: number;               // tallies[seatIndex] (post-round running total)
  readonly isCaller: boolean;           // seatIndex === trickResult.tonkCallerIndex
  readonly isBest: boolean;             // lowest handValue this round (ties → all flagged best)
  readonly isSelf: boolean;             // seatIndex === myPlayerIndex
}

/** Build showdown rows, sorted best-first (ascending handValue, ties by seat). */
export function trickRevealRows(
  trickResult: TonkTrickResult,
  players: readonly PlayerPublicInfo[],
  tallies: readonly number[],
  myPlayerIndex: number,
): TrickRevealRow[];

/** Reason label: "TONK called" | "Stock ran out". */
export function trickReasonLabel(reason: "tonk" | "stockout"): string;

/**
 * Verdict headline text. TONK: "<caller> called Tonk"; stock-out:
 * "<best-hand player> wins the round". Uses "You" for the local seat.
 */
export function trickVerdictHeadline(
  rows: readonly TrickRevealRow[],
  trickResult: TonkTrickResult,
): string;
```

`isBest` = seat's `handValue` equals `Math.min(...handValues)`. The `latestTrickResult` computed in `GameView` reuses no new type — it walks `tonkState.log` (already `readonly TonkLogEntry[]`).

---

## State Model

All authoritative state is server-derived and already flowing. This LLD adds only **client-local ephemeral** state.

| State | Owner | Lifetime | Source |
| --- | --- | --- | --- |
| `tonkState.log` (contains `trickResult`) | server → `useGameState` | per `game:state` | `getPlayerView` (unchanged) |
| next round's board (`hands`, piles, `turnPhase`, `trickNumber`) | server → `useGameState` | per `game:state` | `getPlayerView` (unchanged) |
| `displayPhase` | `GameView` (client) | transient | derived from `status` + trick detection |
| `lastRevealedTrickNumber` | `GameView` (client) | component lifetime | local; set when a reveal fires |
| `revealTimer` | `GameView` (client) | one reveal | local `setTimeout` |

Nothing new persisted, nothing new in server memory. No socket interaction changes.

### Transition diagram

```
                         (new trickResult.trickNumber arrives,
                          status still IN_PROGRESS)
   IN_PROGRESS ─────────────────────────────────────────────► SHOW_TRICK_RESULT
        ▲                                                            │
        │  Continue tapped  OR  revealTimer elapses                  │
        └────────────────────────────────────────────────────────── ┘
                                                                     │
        (status → COMPLETED, e.g. the ending trick was match-final)  │
   ─────────────────────────────────────────────────────────────────► COMPLETED
```

- Entry is idempotent per round: `lastRevealedTrickNumber` guards against re-entry for a round already shown.
- The board keeps receiving `game:state` while blurred; those are the next round's live updates from other seats. Harmless — the local player is non-interactive until dismiss. On dismiss, the board un-blurs already showing current live state (no stale snapshot; we never froze the board, only the overlay reads the preserved `trickResult`).

---

## Frontend Design

**Frontend decision: Direction A (Showdown table) + auto-dismiss timer + Continue-to-skip + blur+dim board — APPROVED. Direction is locked.**

Reference mockup: `docs/mockups/tonk-round-end-card-review-pause.html` (branch `lld-139-tonk-round-end-card-review-pause`). Directions B (scoreboard) and C (spotlight) in that mockup are NOT chosen; do not implement them.

### Layout (Direction A — desktop, 3–8 players)

```
┌───────────────────────────────────────────────┐
│  opponents / table / hand  (blurred + dimmed)  │ ← TonkBoard layer:
│         (already the NEXT round's deal)         │   filter: blur(7px) brightness(0.55) saturate(0.8)
│ ─────────────────────────────────────────────── │   pointer-events: none
│                                                  │
│              ◆ TONK called                       │ ← reveal layer (crisp, radial scrim):
│           You called Tonk                        │   verdict header
│      Round 4 · lowest hand takes nothing         │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │ You [Tonk]  hv 12   2♥3♣3♦4♠      +0 t42  │   │ ← showdown rows, best-first
│  │ Priya       hv 15   7♦8♠          +15 t33 │   │   caller row gold-outlined
│  │ Mara        hv 19   5♠6♥8♣        +19 t61 │   │   best (lowest) delta green
│  │ Devin       hv 24   K♥★4♠         +24 t118│   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│            [   Continue   ▁▁▁▁ ]                 │ ← countdown hairline rides button bottom
│    Next round in 6s · everyone continues …       │
└───────────────────────────────────────────────┘
```

Each showdown row: `grid-template-columns: 128px 1fr auto` → identity (name + optional Tonk/Low badge + "hand value N"), fanned revealed hand (wraps), delta (`+N` with `total N` beneath). Caller row: gold border + inset ring + warm background (`.showdown__player.is-caller`). Best/lowest delta uses `--win-green` (`.delta--best`); penalty deltas use `--loss-red` (`.delta--penalty`).

### Mobile (≤767px)

Rows collapse to a two-area grid (mockup `.stage--mobile .showdown__player`):

```
grid-template-areas:
  "id    delta"
  "cards cards";
```

Name + delta on top row; fanned hand (smaller `card--sm`, `--card-hand-width: 28px`) below. Verdict headline shrinks to ~1.3rem. Continue button full-width. The reveal must be visible **without** opening the `TonkLog` drawer — it is a full-screen overlay rendered by `GameView`, independent of the mobile log drawer/toggle (`TonkBoard.vue:89-113`).

### Board blur layer (reuse LLD-105 pattern, Tonk target)

```css
.game-view__board-container--revealing :deep(.tonk-board) {
  filter: blur(7px) brightness(0.55) saturate(0.8);
  transform: scale(1.02);
  transition: filter 0.4s ease, transform 0.4s ease;
  pointer-events: none;
}
```

Add the `--revealing` modifier when `displayPhase === 'SHOW_TRICK_RESULT'` (Tonk) as well as the existing Big2 `SHOW_FINAL_PLAY`. Because `TonkBoard` is `position: fixed`, confirm during implementation that the blur applies (the `.game-view__board-container` is `position: relative`; if the fixed `.tonk-board` escapes it, apply the blur/overlay at the same fixed layer — the reveal overlay itself must sit above `.tonk-board`'s `z-index: 100` wood-rim, e.g. `z-index: 101`+). This is a known integration point flagged for the implementer; the mockup validates the visual, `TonkBoard`'s fixed positioning is the one wiring detail to verify.

### Reveal scrim + entrance

Reuse the radial scrim (`rgba(10,6,3,0.55)` → `rgba(8,5,2,0.82)`), `rise` entrance on verdict/showdown/CTA, `flip` entrance on revealed cards (mockup keyframes). Continue button: gold, `min-height: 46px`+ touch target, countdown hairline (`.progress`, `animation: countdown <durationMs> linear forwards`).

### Timer + Continue behavior

- Countdown hairline animates over `durationMs`; a text hint shows "Next round in Ns · everyone continues on their own" (the tick display may be static text or a simple local interval — presentational only).
- Continue button emits `continue`; `GameView` clears the `setTimeout` and returns to `IN_PROGRESS`.
- Timer elapsing calls the same dismiss path.

### Reduced motion

`@media (prefers-reduced-motion: reduce)`: disable `rise`/`flip`/countdown-hairline animations (elements appear in place; the timer still runs, hairline may jump). Blur transition disabled (blur appears immediately). Matches the mockup's reduced-motion block.

---

## Edge Cases

| # | Case | Handling |
| --- | --- | --- |
| E1 | Round ends by TONK | `latestTrickResult.reason === "tonk"`, `tonkCallerIndex` set → caller row flagged `is-caller` + "Tonk" badge; verdict "<caller> called Tonk". Reveal fires. |
| E2 | Round ends by stock-out | `reason === "stockout"`, `tonkCallerIndex === null` → no caller flag; verdict "<lowest-hand player> wins the round" / "No one called Tonk". Reveal fires. |
| E3 | 3-player vs 8-player | Showdown list renders one row per seat; wraps naturally. Rows use fixed identity column + flexible hand that wraps; verified against mockup for density. No layout cap needed for 8 (rows stack; scrim scrolls if ever taller than viewport — set overlay `overflow-y: auto`). |
| E4 | Reconnect / late `game:state` for a round already past | On join/reconnect the newest `game:state` may carry a `trickResult` from a prior round. `lastRevealedTrickNumber` starts `null`, so the FIRST such state WOULD fire a reveal. To avoid a spurious reveal on join, **seed `lastRevealedTrickNumber` from the first state received** (initialize it to `latestTrickResult?.trickNumber ?? null` on the initial bind, before enabling reveal-on-change). Only a *subsequent* new trick number triggers the overlay. (Implementer: gate `enterTrickReveal` behind an `initialized`/"seen first state" flag.) |
| E5 | The ending trick is also the match-ending trick | Engine sets `status: "COMPLETED"` in the same update (`completeMatch`), so `latestTrickResult` exists but `status !== "IN_PROGRESS"`. The reveal detection requires `IN_PROGRESS`, so it does **not** fire; the existing watcher routes Tonk `COMPLETED` straight to `GameOverView` (`GameView.vue:226-242`). No trick-reveal on match end (by design — the match summary is the review surface then). |
| E6 | Same `game:state` re-delivered / duplicate | Detection compares `trickNumber`; unchanged number → no re-entry. Idempotent. |
| E7 | Another full round elapses while this client is still on the reveal (slow/backgrounded) | Newest `latestTrickResult.trickNumber` differs from `lastRevealedTrickNumber` → re-arm: update the tracked number, restart the timer, show the newest reveal. The local player is non-interactive during reveal, so they can't cause this; only other players advancing can. |
| E8 | Timer too short/long | `REVEAL_DURATION_MS = 6000` (matches mockup). Continue always available to skip. Single knob; not user-configurable in this LLD. |
| E9 | Spectator render (`myPlayerIndex === -1`) | Reveal still shows (spectators benefit from the pause too); no `isSelf` row, no "You" substitution. Continue/timer behave identically (local only). |
| E10 | Joker in a revealed hand | `handValues` already counts jokers as 0 (engine `cardValue`); revealed card renders the joker face via `isJoker` (never the text "Joker"). |
| E11 | `prefers-reduced-motion` | Entrance/flip/countdown animations disabled; overlay + blur appear in place; timer still elapses; fully usable. |
| E12 | Player leaves/navigates during reveal | `onUnmounted` clears `revealTimer` (no leak). Existing unbind/disconnect unchanged. |
| E13 | Big2 game | No `TonkPublicState`, `latestTrickResult` is `null`, `SHOW_TRICK_RESULT` never entered; Big2 `SHOW_FINAL_PLAY` path untouched. |
| E14 | Auto-timeout / AI-driven round end | The engine ends the trick the same way regardless of who triggered it (human TONK, timeout draw hitting empty stock, AI move). The reveal fires off the resulting `trickResult` identically. No special-casing. |
| E15 | Reveal dismissed, board still shows a not-your-turn state | Expected: the next round is live; after dismiss the (un-blurred) board shows whoever is now to act. No stale data — the board was always rendering live state, only visually blurred. |

---

## Dependencies

Must exist before implementation (all present in this worktree):

- **LLD 105** (`docs/lld/105-game-over-reveal-mobile-button-blur-board.md`) — the blur+dim scrim pattern and `--revealing` modifier this LLD reuses/extends. Read first.
- **LLD 99** (`docs/lld/99-tonk-player-actions-ui.md`) — the Tonk board/action wiring and `tonkDisplay.ts` helper boundary this LLD follows.
- **Tonk engine** (`src/backend/engine/tonk/tonk-engine.ts`) — `endTrick`/`setupNextTrick` already produce and preserve `TonkTrickResult`. **Consumed unchanged.**
- **`@shared/tonk-types`** — `TonkTrickResult`, `TonkPublicState`, `TonkLogEntry`, `TonkCard`, `isJoker`. Consumed as-is.
- **Approved mockup** — `docs/mockups/tonk-round-end-card-review-pause.html` (branch `lld-139-...`), Direction A + timer + blur.
- **Existing code to modify:**
  - `src/frontend/component/game/GameView.vue` — add `SHOW_TRICK_RESULT` to `DisplayPhase`; add `latestTrickResult`, `lastRevealedTrickNumber`, `enterTrickReveal`/`dismissTrickReveal`, `revealTimer`; detect new trick-results on `game:state`/`gameState` change (seeded per E4); extend `--revealing` condition; render `<TonkTrickReveal>` Tonk-gated; clear timer on unmount; `toFeedbackPhase` case.
  - `src/frontend/component/game/TonkTrickReveal.vue` — NEW component (showdown table + verdict + CTA).
  - `src/frontend/component/game-ui/tonkDisplay.ts` — add `trickRevealRows`, `trickReasonLabel`, `trickVerdictHeadline`, `TrickRevealRow`.
- **Reused unchanged:** `GameCard.vue` (or Tonk card renderer), `EnrichedPlayerView`, `TonkBoard.vue` (only blurred via `:deep`, no prop change required), `TonkLog.vue`.

No backend/socket/data-model/engine change. No dependency on the prod-migration path.

---

## Test Requirements

Per testing-principles: bias to automated; follow the existing Tonk-frontend pattern (extract derivations into `tonkDisplay.ts`, unit-test as pure functions; mount-test component computeds). No backend tests (no backend change). No information-leakage tests needed — this consumes the already-filtered `getPlayerView` and the `trickResult`'s `revealedHands` are intentionally public at round end (already the case in `TonkLog`).

### Unit — showdown-row derivation (`tests/frontend/tonkDisplay.test.ts`, extend)

- `trickRevealRows`: rows sorted ascending by `handValue`, ties by seat index; each row's `delta`/`total`/`handValue`/`hand` map to the correct seat.
- `isCaller` true only for `tonkCallerIndex` (and never on stock-out where it is `null`).
- `isBest` true for the seat(s) with the minimum `handValue`; ties → all min-value seats flagged.
- `isSelf` true only for `myPlayerIndex`; `myPlayerIndex === -1` → no `isSelf` row.
- Joker-containing hand: value contribution 0, hand includes the joker object.
- `trickReasonLabel` maps `tonk`/`stockout` correctly.
- `trickVerdictHeadline`: TONK → caller-based headline (with "You" substitution for self); stock-out → best-hand-player headline.

### Unit — trick-reveal detection (`tests/frontend/tonkTrickReveal.test.ts` or extend `gameOverTransition.test.ts`)

Extract the detection predicate (e.g. a pure `shouldEnterReveal(latestTrickResult, lastRevealedTrickNumber, status)`), and test:

- New `trickNumber` while `IN_PROGRESS` and different from `lastRevealedTrickNumber` → true (enter reveal).
- Same `trickNumber` already revealed → false (idempotent, E6).
- `status === "COMPLETED"` with a trick-result present → false (match-end supersedes, E5).
- No trick-result in log (mid-round or Big2) → false (E13).
- First state after join with a pre-existing trick-result and seeded `lastRevealedTrickNumber` → false (no spurious reveal, E4).
- Newer `trickNumber` arriving while already revealing → true, re-arm (E7).

### Component — `TonkTrickReveal` render (`tests/frontend/tonkTrickReveal.test.ts`)

- Renders one showdown row per player (3-seat and 8-seat cases) with correct name/handValue/delta/total.
- Caller row carries `is-caller` styling + "Tonk" badge on a TONK end; absent on stock-out.
- Best (lowest) delta carries `delta--best`; others `delta--penalty`.
- Continue button present (`data-testid`), clicking emits `continue`.
- Countdown hairline present with the timer model; hidden under reduced motion (or animation disabled).
- Mobile layout: rows collapse (assert the mobile grid class / area) — DOM assertion of the class, geometry left to manual.

### Component / integration — `GameView` phase wiring (`tests/frontend/` mounted slice)

- A `game:state` carrying a new Tonk `trickResult` while `IN_PROGRESS` sets `displayPhase = SHOW_TRICK_RESULT`, applies `--revealing`, renders `<TonkTrickReveal>` (not the Big2 reveal).
- Continue → `displayPhase = IN_PROGRESS`, `--revealing` removed, overlay gone.
- Fake timers: after `REVEAL_DURATION_MS`, `displayPhase` returns to `IN_PROGRESS` without Continue (auto-dismiss).
- A match-ending Tonk state (`status: COMPLETED` + trickResult) routes straight to `COMPLETED`/`GameOverView`, never `SHOW_TRICK_RESULT` (E5).
- Big2 `SHOW_FINAL_PLAY` path unchanged (regression): a Big2 completion still enters `SHOW_FINAL_PLAY`, never `SHOW_TRICK_RESULT`.
- `onUnmounted` clears the reveal timer (no callback after unmount — assert with fake timers).

### Manual (visual/UX only — minimal, per testing-principles §decision-heuristics)

| # | Check | How |
| --- | --- | --- |
| 1 | Reveal visible without opening the log drawer, desktop + mobile | Play a Tonk round to a TONK/stock-out end on a phone-width viewport; confirm the overlay appears full-screen over the blurred board. **AC: visible without drawer.** |
| 2 | Board is blurred/dimmed and non-interactive during the reveal; crisp showdown on top | Reach a round end; confirm blur + that taps on the board do nothing until dismiss. |
| 3 | Auto-dismiss after ~6s advances to the next round; Continue skips early | Reach a round end; wait; then repeat and tap Continue. Confirm the next round's board becomes interactive. |
| 4 | Per-client independence | Two clients in one game reach a round end; each dismisses independently; neither blocks the other's next round. **AC: never blocks others.** |
| 5 | 8-player density + reduced motion | 8-seat game round end; overlay readable/scrolls if needed; reduced-motion OS setting → no animation, still usable. |
