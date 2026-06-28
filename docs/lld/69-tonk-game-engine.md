# LLD 69: Tonk Game Engine

**Status:** Draft for review. Parent: #41. Order 2 of 5. Depends on: #56 / **LLD 65 (`docs/lld/65-tonk-rules-spec.md`, signed off & merged 2026-06-28, #76)** — the authoritative rules spec. This LLD turns that spec into a concrete, implementable engine design.

This is **backend-only**: the architectural proof that the `GameEngine` abstraction supports a second game with no rearchitecting. Where this doc and LLD 65 ever disagree, **LLD 65 is authoritative** — flag the discrepancy rather than silently diverging.

---

## Scope

### Covers

- A new pure engine under `src/backend/engine/tonk/`, mirroring `src/backend/engine/big2/`, implementing **every** `GameEngine` method (`game-engine.ts`).
- Registration via `engineFactory.register(new TonkEngine())` in `src/backend/engine/game-engine-factory.ts` (`"tonk"` is already in `GameType`).
- Tonk-specific shared types in `src/shared/tonk-types.ts` (public shapes) and backend-local types in `tonk/tonk-types.ts` (state + actions), following the `big2-types.ts` split.
- A **Tonk-local Joker representation** (LLD 65 §8.6) that does NOT widen the shared `Card`/`Rank` types.
- Two-phase turn (`discard` then `draw`) modeled as ONE player's turn via `turnPhase`.
- Action set is **exactly** `{ discard, draw, callTonk }`.
- Deterministic deck build + per-trick blind cut driven by `deckRoundsTarget` (LLD 65 §8.1), read from `config.options` (default 8).
- Scoring (Cases A/B/C), match-end at tally ≥150, and TRUE-LOSER joker draw — all randomness via derived sub-seeds inside `applyAction`.
- `breakdown.{lost,trueLoser,finalTally}` population for the loss-centric stats derivation (LLD 65 §6.3).

### Explicitly does NOT cover

- **No melds / spreads / runs, no hitting / laying-off, no drop / knock, no going-out-by-emptying-hand** (LLD 65 §1). The action set has none of these.
- **No `Math.random()`**, no PRNG parameter threaded into `applyAction`.
- **No changes to** the WebSocket layer, DB schema/migrations, `StatsService`, or the generic frontend framework. The `deckRoundsTarget` API/DB/frontend plumbing (LLD 65 §8.8) and the `StatsService` `breakdown.trueLoser` read (§6.3) are **separately-tracked sub-issues (#60)**, NOT this engine. This engine only *reads* `config.options.deckRoundsTarget` and *populates* `breakdown.trueLoser`. If any other such change seems necessary, **STOP and flag a leaking abstraction.**
- The turn-timer integration code itself (LLD 07). This engine only supplies `getAutoTimeoutAction`; the per-phase re-arm is a tracked integration check owned by LLD 07 (LLD 65 §10).

---

## Approach

Key technical decisions (all derived from LLD 65; rationale condensed):

1. **Mirror the Big2 module layout.** Engine class delegates to small pure helper modules. Proposed files under `src/backend/engine/tonk/`:
   - `tonk-engine.ts` — the `TonkEngine implements GameEngine` class; thin orchestration + view filtering.
   - `tonk-types.ts` — backend `TonkState`, action union, re-exports of public types.
   - `deck.ts` — `buildDeck`, `cardValue`, joker construction, the §8.1 cut formula.
   - `scoring.ts` — `scoreTrick` (Cases A/B/C), `resolveMatchEnd` (≥150 detection, TRUE-LOSER draw).
   - `turn.ts` — turn/phase advance, `drawableDiscard` snapshot computation, TONK-gate predicate, next-starter selection.
   - `valid-actions.ts` — `computeValidActions(state, playerIndex)` and the `applyAction` payload validators (discard same-rank/in-hand, draw source).
   - `constants.ts` — `cardValue` table, joker count, the deterministic stable card-ordering used by auto-timeout tie-break.
   - `src/shared/tonk-types.ts` — public view shapes (`TonkPublicState`, `TonkLogEntry`, the public card representation).

2. **Validate by delegation.** `validateAction(state, action)` returns `applyAction(state, action).success` (Big2 pattern, `big2-engine.ts:74`). `applyAction` never mutates input — it builds a new `TonkState` and returns `{...state, version: state.version+1, ...}`.

3. **Two-phase turn inside `gameSpecificState`.** `currentPlayerIndex` stays the SAME player across `discard` then `draw`; the turn hands off to the next seat ONLY after the `draw` phase completes. No interface change (LLD 65 §6.2 ⚠ note). `turnNumber` still increments on every applied action (so a full turn advances it by 2).

4. **`drawableDiscard` is a turn-start snapshot, not the live pile top** (LLD 65 §3.3, §8.3). It is computed at each turn hand-off and stored in state; the draw phase reads it, never `discardPile[top]`. This is the single most subtle invariant in the engine.

5. **Determinism via derived sub-seeds** (LLD 65 §6.3 ⚠, §8.1, §8.5). `applyAction` takes no PRNG. When it needs randomness (new per-trick deck+cut, TRUE-LOSER draw) it constructs `new SeededPRNG(String(hashSeed(state.randomSeed + ":trick:" + n)))` etc. Same `(state, action)` → same result. `hashSeed`, `SeededPRNG` are imported from `prng.ts` (verified exports).

6. **Joker is Tonk-local** (LLD 65 §8.6). A `TonkCard` discriminated union is stored in `TonkState`; `cardValue()` returns 0 for jokers. The shared `Card`/`Rank` are untouched, so Big2's `RANK_ORDER`/`compareCards` are unaffected.

7. **`getPlayerView`/`getSpectatorView` physically exclude** opponent hands and stock contents — counts only (LLD 65 §6.1; architecture-principles #2). `getValidActions` is the single source of truth, returns `[]` when not the player's turn or not `IN_PROGRESS`, and returns action TYPES per phase.

### Alternatives considered

- **Widen shared `Rank` with a `"joker"` literal** — rejected per LLD 65 §8.6 (ripples into Big2 `RANK_ORDER`/comparisons). Tonk-local union chosen.
- **Two separate turns for discard and draw** — rejected per LLD 65 §2.2(3) / §6.2 (the interface assumes one action per turn; we model two phases inside state, no interface change, turn hands off only after draw).
- **Reading the live `discardPile` top for draw-from-discard** — rejected; would either be impossible (current player's own discard is on top) or allow self-draw (LLD 65 §3.3). Snapshot is the only correct model.

---

## Interfaces / Types

### Public (shared) — `src/shared/tonk-types.ts`

```ts
import type { Card, PlayerId } from "./engine-types.js";

/** Tonk-local card: a standard Card OR a Joker. Does NOT touch shared Card/Rank. */
export type TonkCard = Card | TonkJoker;
export interface TonkJoker {
  readonly joker: true;
  /** Stable id so two jokers in a 2-deck pool are distinct (e.g. 0..2*numDecks-1). */
  readonly id: number;
}
export function isJoker(c: TonkCard): c is TonkJoker {
  return (c as TonkJoker).joker === true;
}

export type TonkActionType = "discard" | "draw" | "callTonk";
export type TonkDrawSource = "stock" | "discard";
export type TonkTurnPhase = "discard" | "draw";

/** Public per-action log entry (no hidden info). */
export interface TonkLogEntry {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly type: TonkActionType;
  readonly discarded?: readonly TonkCard[]; // face-up, public
  readonly discardCount?: number;
  readonly drawSource?: TonkDrawSource; // public which source; drawn card NOT logged (hidden)
  readonly trickResult?: TonkTrickResult; // appended at trick end (all hands revealed)
}

/** Appended to the log when a trick ends (TONK or stock-out); hands are revealed here. */
export interface TonkTrickResult {
  readonly trickNumber: number;
  readonly reason: "tonk" | "stockout";
  readonly tonkCallerIndex: number | null;
  readonly revealedHands: readonly (readonly TonkCard[])[]; // by seat index
  readonly handValues: readonly number[]; // by seat index
  readonly tallyDeltas: readonly number[]; // points added this trick, by seat index
}

/** What getPlayerView/getSpectatorView expose for Tonk. Hidden info absent by construction. */
export interface TonkPublicState {
  readonly turnPhase: TonkTurnPhase;
  readonly trickNumber: number;
  readonly trickTurnCount: number;
  readonly tonkGateOpen: boolean; // trickTurnCount >= players.length
  readonly stockCount: number; // count ONLY — never the cards
  readonly discardTop: TonkCard | null; // live pile top (the current player's own once discarded)
  readonly discardCount: number;
  readonly lastDiscardCount: number;
  readonly lastDiscardPlayerIndex: number | null;
  readonly drawableDiscard: TonkCard | null; // turn-start snapshot (face-up, public)
  readonly tallies: readonly number[]; // running match score by seat (lower better)
  readonly log: readonly TonkLogEntry[];
}
```

### Backend-local — `src/backend/engine/tonk/tonk-types.ts`

```ts
import type { GameAction } from "@shared/engine-types";
import type { TonkCard, TonkDrawSource, TonkTurnPhase } from "@shared/tonk-types.js";
export type * from "@shared/tonk-types.js"; // re-export public shapes (Big2 pattern)

/** Full server-only Tonk state in InternalGameState.gameSpecificState. */
export interface TonkState {
  readonly hands: readonly (readonly TonkCard[])[]; // HIDDEN per-player
  readonly stock: readonly TonkCard[];              // HIDDEN (count only public)
  readonly discardPile: readonly TonkCard[];        // PUBLIC, top = most recent
  readonly drawableDiscard: TonkCard | null;        // PUBLIC turn-start snapshot (§3.3)
  readonly lastDiscardCount: number;
  readonly lastDiscardPlayerIndex: number | null;
  readonly turnPhase: TonkTurnPhase;
  readonly trickNumber: number;     // 1-based
  readonly trickTurnCount: number;  // turns taken this trick; TONK gate = >= players.length
  readonly tallies: readonly number[];
  readonly tonkCallerIndex: number | null;
  readonly lostPlayerIndices: readonly number[]; // tally >= 150 at match end
  readonly trueLoserIndex: number | null;
  readonly trickDeckSize: number; // size of THIS trick's dealt+stock deck (for card-conservation invariant)
  readonly log: readonly TonkLogEntry[];
}

export interface TonkDiscardAction extends GameAction {
  readonly type: "discard";
  readonly cards: readonly TonkCard[]; // >=1, all same rank (jokers group only with jokers)
}
export interface TonkDrawAction extends GameAction {
  readonly type: "draw";
  readonly source: TonkDrawSource; // "stock" | "discard"
}
export interface TonkCallTonkAction extends GameAction {
  readonly type: "callTonk";
}
export type TonkAction = TonkDiscardAction | TonkDrawAction | TonkCallTonkAction;
```

### `TonkEngine` (implements `GameEngine`) — method signatures

Standard `GameEngine` signatures (`game-engine.ts:20-125`). Behavior summary (full rules in LLD 65 §6.1):

| Method | Behavior |
| --- | --- |
| `gameType` | `"tonk"` |
| `initialize(gameId, players, config, prng)` | Throw `"Tonk requires 3-8 players"` if `players.length < 3 \|\| > 8`. Read `deckRoundsTarget` from `config.options` (clamp to [5,12], default 8). Build deck + cut deterministically with `prng` (§8.1). Deal 5 each; rest → `stock`; trick-1 `discardPile=[]`, `drawableDiscard=null`. `currentPlayerIndex=0`, `status="IN_PROGRESS"`, `version=1`, `turnNumber=1`, `turnPhase="discard"`, `tallies=[0…]`, `trickNumber=1`, `trickTurnCount=0`, `trickDeckSize = stock.length + 5*players.length`, `randomSeed=prng.seed`. |
| `validateAction(state, action)` | `return this.applyAction(state, action).success` |
| `applyAction(state, action)` | Guard status/turn, then dispatch on `action.type` × `turnPhase`. Pure, immutable, `version+1`. Inter-trick/end-game randomness via derived sub-seeds. |
| `getPlayerView(state, playerId)` | Your hand only; opponents as `cardCount`; `TonkPublicState` (stock count only, no stock cards, no opponent hands); `validActions` only on your turn. |
| `getValidActions(state, playerId)` | `[]` unless `IN_PROGRESS` and your turn; else action types per `turnPhase` (§6.2 below). |
| `isGameOver(state)` | `state.status === "COMPLETED"` |
| `getAutoTimeoutAction(state)` | See §7 below; `null` when not `IN_PROGRESS` or `currentPlayerIndex < 0`. |
| `getSpectatorView(state, n)` | Public only: no hands, no stock cards; same `TonkPublicState`. |

### `getValidActions` by phase (LLD 65 §6.2)

- `turnPhase==="discard"` and `trickTurnCount >= players.length` → `[{type:"discard"}, {type:"callTonk"}]`
- `turnPhase==="discard"` and gate closed → `[{type:"discard"}]`
- `turnPhase==="draw"` → `[{type:"draw"}]` (payload carries `source`; `"discard"` source only legal when `drawableDiscard !== null`, validated in `applyAction`)

Returns action **types**, not enumerated discard combinations (Big2 convention); the specific cards in a `discard` payload are validated in `applyAction`.

---

## State Model

### `InternalGameState` usage (LLD 65 §4.1)

- `status`: `IN_PROGRESS` from init until match end (some tally ≥150 and TRUE LOSER resolved) → `COMPLETED`. `currentPlayerIndex = -1` when `COMPLETED`.
- `turnNumber`: +1 per applied action (a full turn = discard + draw = +2).
- `winner`: set at `COMPLETED` to lowest final tally (ties → lowest seat index). **Display/best-result only — does NOT drive stats** (§6.3).
- `scores`: at `COMPLETED`, one `PlayerScore` per player: `score = finalTally`; `breakdown = { lost: 0|1, trueLoser: 0|1, finalTally }` (numeric flags — `breakdown` is `Record<string, number>`, `engine-types.ts:80`). `trueLoser=1` on exactly the TRUE LOSER; `lost = (finalTally>=150)?1:0` (informational).
- `randomSeed`: the seed; all deck builds, per-trick cuts, and the TRUE-LOSER draw derive sub-seeds from it.
- `gameSpecificState`: `TonkState` (narrowed from `unknown`).

### Persisted vs in-memory

Same as Big2/LLD 04: full `InternalGameState` (incl. `TonkState`) is the single source of truth, cached in memory for active games, persisted as JSON. `PlayerView`/`SpectatorView` are derived on demand, never stored (architecture-principles #2, #5). `isConnected` is a placeholder set `true` by the engine, overwritten by the WebSocket layer.

### Turn / phase flow (single trick)

```
[discard phase, player P]
  P plays discard action (1+ same-rank cards) -> cards leave hand, pushed onto discardPile;
      lastDiscardCount/lastDiscardPlayerIndex updated; turnPhase -> "draw"; SAME player; turnNumber+1.
  (OR P plays callTonk if gate open -> score trick, see below.)
[draw phase, player P]
  P plays draw action:
    source "stock": pop stock top into hand. If stock empty -> trick ends, Case C (§7).
    source "discard": legal only if drawableDiscard !== null; that exact card is removed from
        discardPile and added to hand; drawableDiscard consumed.
  Turn hands off: currentPlayerIndex -> next seat (ascending, wrap); trickTurnCount+1;
      turnPhase -> "discard"; recompute drawableDiscard for the new current player (§ snapshot rule);
      turnNumber+1.
```

### `drawableDiscard` snapshot rule (LLD 65 §3.3, §8.3 — the critical invariant)

`drawableDiscard` is recomputed at each **turn hand-off** (and at trick setup), as the single top-most card placed by the **immediately-preceding active player** as the pile stood *before* the now-current player discards. Concretely:

- Trick-1 first player: `null` (pile started empty).
- Trick-2+ starter: the face-up start card flipped at setup.
- All other turns: the single top card of the immediately-preceding player's discard (only the top 1 even if they discarded multiples; buried cards never drawable).
- The current player's own just-discarded card (now the live `discardPile` top) is **never** the snapshot → a player can never draw back their own discard.

Implementation note: compute the snapshot at hand-off from the discard the *previous* player placed (i.e. `discardPile` top + `lastDiscardCount`), captured **before** the new current player discards. Storing it explicitly in state avoids any reliance on the live pile top during the draw phase.

### Per-trick reset vs per-match carry (LLD 65 §4.4)

On trick end (TONK or stock-out) when the match is NOT over:
- **Carry:** `tallies`, `players`, `randomSeed`, `trickNumber` (+1), `log` (append `trickResult`).
- **Reset:** rebuild + cut a fresh deck via sub-seed `hashSeed(randomSeed + ":trick:" + newTrickNumber)`; deal 5 each; `stock` = remainder; trick-2+ flips one face-up start card → that becomes the new starter's `drawableDiscard`; `discardPile` set accordingly; `lastDiscard*` reset; `turnPhase="discard"`; `trickTurnCount=0`; `tonkCallerIndex=null`; `trickDeckSize` recomputed.
- **Next starter / dealer:** highest-tally player; ties → lowest seat index (§3.1.5, §8.7).

### Match end + TRUE LOSER (LLD 65 §5.2, §5.3, §8.5)

After scoring a trick, if any `tallies[i] >= 150`:
1. `lostPlayerIndices` = all seats with tally ≥150.
2. If exactly one → that seat is `trueLoserIndex`.
3. If more than one → shuffle a **single fresh 54-card deck (52 + 2 jokers), regardless of in-play `numDecks`**, via sub-seed `hashSeed(randomSeed + ":trueloser:" + trickNumber)`; lost players draw in ascending seat order, looping, until a joker is drawn; that seat is `trueLoserIndex`. Termination guaranteed (2 jokers in 54).
4. `status="COMPLETED"`, `currentPlayerIndex=-1`, `winner` = lowest-tally seat (display), `scores` populated with `breakdown.{lost,trueLoser,finalTally}`.

---

## Edge Cases

Enumerated; each maps to a `validateAction`/`applyAction` rejection (state unchanged, version NOT incremented) or a resolution path. Mirrors LLD 65 §8.

| # | Case | Handling |
| --- | --- | --- |
| 1 | `players.length < 3` or `> 8` at init | `initialize` throws `"Tonk requires 3-8 players"` (§9.1). |
| 2 | Action when `status === "COMPLETED"` | Reject `"Game is already over."` |
| 3 | Action when `status !== "IN_PROGRESS"` | Reject `"Game has not started."` |
| 4 | Action by non-current player | Reject `"Not your turn."` |
| 5 | `draw` while `turnPhase==="discard"` | Reject `"Cannot draw before discarding."` |
| 6 | `discard` while `turnPhase==="draw"` | Reject `"Must draw, not discard, this phase."` |
| 7 | `callTonk` while `turnPhase==="draw"` (after discarding) | Reject `"TONK can only be called at the start of your turn."` |
| 8 | `callTonk` with `trickTurnCount < players.length` | Reject `"TONK can only be called after every player has had a turn."` |
| 9 | Empty discard payload | Reject `"Must discard at least one card."` |
| 10 | Discard with mixed ranks | Reject `"Discard must be a single rank."` (jokers group only with jokers) |
| 11 | Discard card(s) not in hand | Reject `"Cards not in hand."` |
| 12 | `draw` source `"discard"` when `drawableDiscard === null` (incl. trick-1 first player) | Reject `"No card available to draw from the discard."` |
| 13 | `draw` source neither `"stock"` nor `"discard"` | Reject `"Invalid draw source."` |
| 14 | `draw` source `"stock"` when stock empty | NOT a rejection — trick ends immediately, Case C scoring (§7). |
| 15 | Stock empty at start of a turn's discard phase | Discard still allowed (pile is the sink); trick only ends when a draw can't be satisfied (#14). |
| 16 | Buried preceding discard | Still drawable: draw-from-discard yields the turn-start snapshot, not the live top. |
| 17 | Self-draw of own just-discarded card | Impossible by construction — snapshot is the preceding player's card, not the current player's. |
| 18 | Preceding player discarded multiples | Snapshot = single top card only; buried cards never drawable. |
| 19 | TONK Case A (caller strictly lowest) | Every other player adds own hand value; caller adds 0. |
| 20 | TONK Case B (caller tied or beaten) | Caller adds 30; all others add 0. |
| 21 | Stock-out Case C, single lowest | Lowest hand adds 30; others 0. |
| 22 | Stock-out Case C, tie for lowest | Each tied-lowest player adds 30 (§9.7). |
| 23 | Multiple players ≥150 at match end | TRUE-LOSER joker draw from single fresh 54-card deck (§8.5). |
| 24 | Single player ≥150 | Auto TRUE LOSER, no draw. |
| 25 | Every player ≥150 | Still exactly one TRUE LOSER (joker draw); everyone else `gamesWon:1`; `winner`=lowest tally (display). |
| 26 | Tie at match end for lowest tally (`winner`) | Lowest seat index — **display tiebreak only**, does not affect win/loss. |
| 27 | `deckRoundsTarget` absent in `config.options` | Default 8. |
| 28 | `deckRoundsTarget` out of [5,12] / non-integer reaching the engine | Engine clamps/defaults defensively to [5,12]→8; authoritative validation is `createGame.ts` (#60, NOT this engine). |
| 29 | A trick's cut deck contains 0 jokers | Harmless — jokers only matter for hand value (0) and the end-of-game draw (which uses a fresh full pool). |
| 30 | Reconnection / spectator mid-trick | Standard `getPlayerView`/`getSpectatorView`; revealed hands exist only in the log's `trickResult` at trick end. |

---

## Dependencies

| Dependency | Status | Use |
| --- | --- | --- |
| `src/backend/engine/game-engine.ts` (`GameEngine`, `GameEngineConfig`) | Implemented | Interface to implement; `config.options` is `Record<string, unknown>` (verified). |
| `src/shared/engine-types.ts` (`InternalGameState`, `PlayerView`, `SpectatorView`, `Card`, `GameType`, `PlayerScore`) | Implemented | `"tonk"` already in `GameType`; `PlayerScore.breakdown` is `Record<string, number>`. Joker gap resolved Tonk-locally (§8.6). |
| `src/backend/engine/prng.ts` (`PRNG`, `SeededPRNG`, `hashSeed`; `FixedPRNG` for tests) | Implemented (verified) | Deterministic deck cut + TRUE-LOSER draw via derived sub-seeds. |
| `src/backend/engine/game-engine-factory.ts` | Implemented | Add `engineFactory.register(new TonkEngine())` (single line, after Big2 registration). |
| Big2 reference (`big2-engine.ts`, `big2-types.ts`, `deck.ts`, `scoring.ts`, `constants.ts`) | Implemented | Pattern for immutability, `validateAction` delegation, view filtering, helper-module split, shared/backend type split. |
| `src/shared/tonk-types.ts` | **New (this LLD)** | Public types + Tonk-local `TonkCard`/`TonkJoker`. |

### Out of scope here (separately tracked — do NOT implement in this engine)

- **`deckRoundsTarget` creator-config plumbing** (LLD 65 §8.8: `CreateGameRequest`/`SerializableGame`, `createGame.ts` validation, `Game` entity column + migration, `gameService.startGame` wiring, lobby control) — **#60**. The engine must be correct/deterministic for any in-range value whether or not this ships (it simply sees default 8 if unwired).
- **`StatsService` `breakdown.trueLoser` read** (LLD 65 §6.3) — stats sub-issue / **#60**. The engine only *populates* `breakdown.trueLoser`; it does not touch `statsService.ts`.
- **Turn-timer per-phase re-arm** (LLD 65 §7, §10) — LLD 07 integration check. The engine only supplies `getAutoTimeoutAction`.

If implementing any of the above feels necessary to make the engine work, it is a **leaking abstraction — STOP and escalate.**

---

## Test Requirements

Per testing-principles: pure-function tests, controlled randomness (`FixedPRNG`/seeded `SeededPRNG`), self-contained (no shared `beforeEach` state), direct state construction via helpers, invalid-action coverage, info-leakage, invariants, one full-game simulation. Mirror the Big2 test layout under `tests/engine/tonk/`. Use a `seedState`-style helper (`tests/helpers/`) to construct `TonkState` directly rather than replaying turns.

### Unit — card values & hand value
- Ace=1; 2–10 = face value; J/Q/K=10; Joker=0; hand value = sum (`cardValue` + sum helper).

### Unit — deck build & cut (determinism + `deckRoundsTarget`)
- Same `(seed, trickNumber, deckRoundsTarget)` → identical deck AND identical cut.
- Cut-formula correctness: assert `cutAmount === max(0, poolSize - clamp(handCardsDealt + deckRoundsTarget*players, [handCardsDealt+players, poolSize]))` for the §8.1 worked-example rows (incl. 3-player default = 15, 6-player default = 30, 8-player default = 4).
- Default `deckRoundsTarget=8` DOES cut at ≤5 players (3 players → cut 15); assert the card SET changes between tricks (distinct subsets for distinct sub-seeds).
- High `deckRoundsTarget` (≥13 at 3 players) → `cutAmount=0`; card SET identical across tricks, only draw order varies by seed; joker count = `2*numDecks` = 2.
- 6+ players → `numDecks = ceil(players/5)` (6→2); pool = `54*numDecks` with `2*numDecks` jokers; cut honors formula; distinct subset per trick; reproducible; cut may remove jokers.
- Absent `config.options.deckRoundsTarget` → defaults to 8. Out-of-range reaching the engine → clamped/defaulted (defensive).

### Unit — initialize / deal (3–8 players)
- For 3,4,5,6,7,8 players: 5 cards dealt each; `stock.length = trickDeckSize - 5*players`; `currentPlayerIndex=0`; `turnPhase="discard"`; `tallies` all 0; `trickNumber=1`; `trickTurnCount=0`; `version=1`; `status="IN_PROGRESS"`.
- `<3` or `>8` players → `initialize` throws `"Tonk requires 3-8 players"`.

### Unit — turn phases (discard → draw)
- `validActions` correct per phase and per TONK gate (§6.2), incl. `callTonk` offered only when gate open + discard phase.
- Discard: single OK; multiples same-rank OK; mixed-rank rejected; not-in-hand rejected; empty rejected.
- Draw: from stock OK; from discard only when `drawableDiscard !== null`; arbitrary/out-of-band source rejected; trick-1 first player cannot draw from discard.
- Turn hands off only AFTER the draw phase, to the next seat; `turnNumber` +1 per action (full turn → +2).

### Unit — drawable-discard snapshot (discard-before-draw)
- Buried preceding discard still drawable (yields snapshot, not live top).
- No self-draw of own just-discarded card.
- Snapshot captured at turn start, unchanged by current player's discard.
- Preceding multiples → only single top is the snapshot.
- Trick-2+ start card is the starter's initial `drawableDiscard`, drawable after the starter buries it.
- After drawing from `"discard"`, snapshot consumed (card moves to hand), next snapshot recomputed at next turn start.

### Unit — TONK
- Rejected before everyone has had a turn (`trickTurnCount < players.length`); rejected outside discard phase / after discarding.
- Case A: caller strictly lowest → others add own hand value, caller 0.
- Case B: caller tied/beaten → caller +30, others 0.

### Unit — stock exhaustion (Case C)
- Draw phase with empty stock ends the trick; lowest hand +30; ties for lowest each +30.

### Unit — match end & TRUE LOSER
- Tally ≥150 → match-end resolution; otherwise new trick begins (carry/reset per §4.4).
- Single lost player → auto TRUE LOSER (no draw).
- Multiple lost → joker-draw from single fresh 54-card deck (regardless of in-play `numDecks`), deterministic via seed; termination guaranteed; correct seat selected.
- `winner` = lowest final tally (display; ties → lowest seat).
- Per-trick reset: new deck rebuilt/cut, next starter = highest tally (ties → lowest seat), phase/counters reset.

### Unit — stats breakdown population (engine output for §6.3)
- TRUE LOSER: `breakdown.trueLoser === 1`, all others `0`.
- `breakdown.lost === (finalTally>=150)?1:0`; `breakdown.finalTally === score === finalTally`.
- Every-player-≥150 game still has exactly one `trueLoser===1`.
- (Note: the *derivation* `gamesWon`/`gamesLost` lives in `StatsService`/#60, not this engine; tests here assert only the engine-produced `breakdown`.)

### Unit — invalid actions (testing-principles #6)
- Wrong turn, wrong phase, action after `COMPLETED`, action not in `validActions`, bad payloads (mixed-rank/not-in-hand/empty/bad source): all rejected, **state unchanged, version not incremented**.

### Unit — auto-timeout (§7 below)
- Discard phase → single highest-value card; never multiples; never `callTonk`; deterministic tie-break (assert reproducibility from `(state)` alone).
- Draw phase → `source:"stock"`; empty stock at draw → returns the stock-draw action (which ends the trick when applied).
- Returns `null` when `status !== "IN_PROGRESS"` or `currentPlayerIndex < 0`.

### Security — information hiding (testing-principles #7)
- `getPlayerView(state, A)` never contains B's hand nor any stock card; opponents appear as `cardCount` only; stock as `stockCount` only.
- Negative assertions: serialize the view to JSON and assert no opponent hand card and no stock card appears.
- `discardTop`, `drawableDiscard`, counts, `tallies`, `log` are public.
- `getSpectatorView` contains no hands and no stock cards.
- At trick end, revealed hands appear only in the log `trickResult`, not as ongoing hidden-state leakage.

### Invariants — assert after every action (testing-principles #8)
- **Card conservation:** Σ hands + stock + discardPile = `trickDeckSize` within a trick (no cards created/destroyed). `drawableDiscard` is a reference to a card still physically in `discardPile` until drawn — NOT counted separately.
- `currentPlayerIndex` is a valid active seat while `IN_PROGRESS`, or `-1` when `COMPLETED`.
- `getValidActions` non-empty for the current player while `IN_PROGRESS` (no deadlock).
- `status` advances forward only (never `COMPLETED → IN_PROGRESS`).
- `tallies` monotonically non-decreasing across tricks.
- `version` strictly +1 per applied action.

### Integration — full match simulation (testing-principles #9)
- Seeded PRNG; at each step pick from `validActions` with a simple strategy (e.g. discard highest, draw stock, never auto-TONK except a deterministic occasional call when gate open); play tricks until some tally ≥150 and a TRUE LOSER resolves.
- Assert invariants hold every step; match terminates (no infinite loop); `winner`/`scores`/`trueLoser` populated; `breakdown.{lost,trueLoser,finalTally}` set; exactly one `trueLoser===1`.

### Test file layout (proposed, mirroring `tests/engine/big2/`)
```
tests/engine/tonk/
  card-values.test.ts
  deck-cut.test.ts
  initialize.test.ts
  turn-phases.test.ts
  drawable-discard.test.ts
  tonk-call.test.ts
  scoring.test.ts            (Cases A/B/C, match-end, true-loser)
  invalid-actions.test.ts
  auto-timeout.test.ts
  information-hiding.test.ts
  full-game.test.ts          (simulation + invariants)
```

---

## Auto-timeout (`getAutoTimeoutAction`) — LLD 65 §7

| Phase when timer fires | Auto-action |
| --- | --- |
| `discard` | `discard` the **single highest-value card** in hand (one card only; never multiples; never `callTonk`). Ties broken by a **deterministic stable card order** defined in `constants.ts` (a fixed `(value, rank, suit, jokerId)` ordering) so the action is fully reproducible from `(state)`. |
| `draw` | `draw` with `source:"stock"`. If stock is empty, the returned stock-draw, when applied, ends the trick (Case C). |

`getAutoTimeoutAction` returns `null` when `status !== "IN_PROGRESS"` or `currentPlayerIndex < 0`. Because a Tonk turn has two phases, a fully-timed-out turn fires the timeout twice (auto-discard, then auto-draw) — the timer (LLD 07) must re-arm per phase; this is a **tracked integration check** (LLD 65 §10), not engine code.
