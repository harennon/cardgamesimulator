# LLD 68: Tonk Game Engine (pure GameEngine implementation, fully unit-tested)

> Parent: #41 · Order 2 of 5 · Depends on: #56 (LLD 65 Tonk rules spec — signed off 2026-06-28, merged in #76).
> Implements the exact variant pinned in `docs/lld/65-tonk-rules-spec.md`. **Where this LLD and LLD 65 ever disagree, LLD 65 is authoritative.** Section refs below are to LLD 65 unless noted.

## Scope

### Covers

- A new pure game engine under `src/backend/engine/tonk/`, mirroring `src/backend/engine/big2/`.
- A `TonkEngine` class implementing **every** `GameEngine` method (`src/backend/engine/game-engine.ts`): `initialize`, `validateAction`, `applyAction`, `getPlayerView`, `getValidActions`, `isGameOver`, `getAutoTimeoutAction`, `getSpectatorView`.
- Registering the engine: `engineFactory.register(new TonkEngine())` in `src/backend/engine/game-engine-factory.ts` (`"tonk"` is already in `GameType`).
- Tonk-specific shared types in `src/shared/tonk-types.ts` (public shapes) and backend types in `src/backend/engine/tonk/tonk-types.ts` (internal `TonkState`, actions), following the `big2-types.ts` split.
- The full Tonk match lifecycle inside one `InternalGameState`: deal → two-phase turns → trick scoring → inter-trick deck rebuild/cut → match-end → TRUE-LOSER resolution.
- Action set **exactly** `{ discard, draw, callTonk }`.
- Engine reads `config.options.deckRoundsTarget` (default 8, clamp to [5,12]) and populates `breakdown.trueLoser` / `breakdown.lost` / `breakdown.finalTally`.

### Does NOT cover

- **No melds/spreads/runs, no hitting/laying-off, no drop/knock, no going-out-by-emptying-hand** (§1 — these mechanics do not exist in this variant).
- The `deckRoundsTarget` cross-stack plumbing (§8.8): `CreateGameRequest`, `createGame.ts` validation, the `Game` entity column/migration, `gameService.startGame` wiring, lobby control. Those are separate sub-issues (#60). **The engine only READS `config.options.deckRoundsTarget`.** If the plumbing has not shipped, `config.options` is `{}` and the engine sees the default 8.
- Any change to `StatsService`, DB schema, the `Game` entity, `createGame.ts`, `gameService.ts`, the WebSocket layer, or any frontend code. The engine merely populates `breakdown.trueLoser` so #60 can later derive loss-centric stats. **If any such change feels necessary, STOP and flag it as a leaking abstraction.**
- The `StatsService` loss-centric derivation change itself (§6.3) — belongs to #60 / LLD 66.

## Approach

Mirror Big2's module layout under a new directory; the engine is a thin dispatcher delegating to pure helper modules:

```
src/backend/engine/tonk/
  tonk-engine.ts       — TonkEngine class (implements GameEngine; dispatch + view filtering + auto-timeout)
  tonk-types.ts        — TonkState, TonkAction union, re-exports of shared public types
  constants.ts         — card values, joker constants, deck-build helpers, stable card ordering
  deck.ts              — buildTonkDeck() + cut, deal, per-trick sub-seeded rebuild, TRUE-LOSER draw deck
  valid-actions.ts     — computeValidActions(state, playerIndex), discard-payload validation, draw-source legality
  scoring.ts           — handValue(), scoreTrick() (Cases A/B/C), resolveMatchEnd() + TRUE-LOSER draw, finalScores()
src/shared/tonk-types.ts — public shapes (TonkCard, TonkPublicState, TonkLogEntry, action payloads)
```

Key technical decisions (all from LLD 65; rationale condensed):

1. **A match is a sequence of tricks in one `InternalGameState`.** `status` stays `IN_PROGRESS` across tricks; flips to `COMPLETED` only at match end (§2.2.1, §4.1). `trickNumber` lives in `TonkState`; `turnNumber` increments per applied action per the interface convention.

2. **Two-phase turn modeled via `turnPhase` (`"discard" | "draw"`), not two turns** (§2.2.3, §6.2). `currentPlayerIndex` is unchanged across both phases; the turn hands off to the next seat **only after the draw phase completes**. `callTonk` is a third action legal **only** in the `"discard"` phase, before discarding, and **only** once `trickTurnCount >= players.length`.

3. **`drawableDiscard` is a turn-start snapshot, NOT the live `discardPile` top** (§3.3, §8.3). Because this variant discards before drawing, at draw time the live top is the player's own just-discarded card. The single drawable card is captured at the **start** of the player's turn (the immediately-preceding active player's top card, or the trick-2+ face-up start card, or `null` for the trick-1 first player) and stored in `TonkState.drawableDiscard`. Drawing from `"discard"` consumes this snapshot, never the live top. A player can therefore never draw back their own just-discarded card.

4. **Jokers use a Tonk-local type — do NOT widen shared `Card`/`Rank`** (§8.6). `TonkCard = Card | TonkJoker` where `TonkJoker = { joker: true; id: number }`. A `cardValue(card)` helper returns 0 for jokers. This keeps Big2's `RANK_ORDER`/`compareCards` untouched.

5. **All inter-trick and end-game randomness uses derived sub-seeds inside `applyAction`** — `applyAction` takes **no** PRNG param and never calls `Math.random()` (§6.3 randomness note, §8.1, §8.5). New per-trick deck+cut uses `new SeededPRNG(hashSeed(randomSeed + ":trick:" + trickNumber).toString())`; the TRUE-LOSER draw uses `hashSeed(randomSeed + ":trueloser:" + trickNumber)`. `hashSeed`/`SeededPRNG`/`FixedPRNG` are exported from `prng.ts` (verified). Same `(state, action)` → same result.

6. **Immutability + version discipline (Big2 pattern).** `applyAction` never mutates the input; it returns a fresh `InternalGameState` with `version + 1` and `turnNumber + 1` on success. On rejection it returns `{ success: false, newState: null, error }` and the caller's state is untouched. `validateAction` delegates to `applyAction(...).success`.

7. **Loss-centric: exactly one loser per game** (§2.2.4, §6.3). The engine sets `breakdown.trueLoser = 1` on exactly the TRUE LOSER, `0` on everyone else; `breakdown.lost = (finalTally >= 150) ? 1 : 0` (informational); `breakdown.finalTally = tally`; `PlayerScore.score = finalTally`. `state.winner` = lowest-tally player (display only; ties → lowest seat index) and **does not drive stats**. `breakdown` is `Record<string, number>`, so all flags are numeric `0|1`, never booleans.

## Interfaces / Types

### `src/shared/tonk-types.ts` (public — also imported by frontend later)

```ts
import type { Card, PlayerId } from "./engine-types.js";

/** A joker — value 0, and the TRUE-LOSER token. Tonk-local; shared Card/Rank untouched. */
export interface TonkJoker {
  readonly joker: true;
  readonly id: number; // 0..(2*numDecks-1), stable identity within a trick's deck
}

/** A Tonk card is a standard Card or a joker. */
export type TonkCard = Card | TonkJoker;

export function isJoker(c: TonkCard): c is TonkJoker {
  return (c as TonkJoker).joker === true;
}

export type TonkTurnPhase = "discard" | "draw";
export type TonkDrawSource = "stock" | "discard";

export interface TonkLogEntry {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly kind: "discard" | "draw" | "callTonk" | "trickResult";
  readonly cards?: readonly TonkCard[];        // discard: cards placed
  readonly drawSource?: TonkDrawSource;        // draw: where from (not WHICH card — hidden)
  readonly trickNumber?: number;
  readonly deltas?: readonly number[];         // trickResult: per-seat tally delta this trick
  readonly revealedHands?: readonly (readonly TonkCard[])[]; // trickResult: all hands at trick end
}

/** gameSpecificPublicState in PlayerView/SpectatorView. No hands, no stock contents. */
export interface TonkPublicState {
  readonly discardTop: TonkCard | null;       // live pile top (visual)
  readonly discardCount: number;
  readonly lastDiscardCount: number;
  readonly lastDiscardPlayerIndex: number | null;
  readonly drawableDiscard: TonkCard | null;  // turn-start snapshot (face-up, public)
  readonly stockCount: number;                 // COUNT ONLY — never the cards
  readonly opponentHandCounts: readonly number[]; // by seat (your own seat included as count too)
  readonly turnPhase: TonkTurnPhase;
  readonly trickNumber: number;
  readonly trickTurnCount: number;
  readonly tonkGateOpen: boolean;
  readonly tallies: readonly number[];
  readonly tonkCallerIndex: number | null;
  readonly trueLoserIndex: number | null;      // null until COMPLETED
  readonly log: readonly TonkLogEntry[];
}

export interface TonkDiscardAction {
  readonly type: "discard";
  readonly playerId: PlayerId;
  readonly cards: readonly TonkCard[]; // 1+ cards, all same rank (jokers group only with jokers)
}
export interface TonkDrawAction {
  readonly type: "draw";
  readonly playerId: PlayerId;
  readonly source: TonkDrawSource;
}
export interface TonkCallTonkAction {
  readonly type: "callTonk";
  readonly playerId: PlayerId;
}
export type TonkActionPayload =
  | TonkDiscardAction
  | TonkDrawAction
  | TonkCallTonkAction;
```

> Note `TonkDiscardAction.cards` / log `cards` / `revealedHands` use `TonkCard`. A `TonkJoker` does not satisfy the shared `Card` shape, so when comparing client-submitted discard cards to in-hand cards, use a `tonkCardEquals(a, b)` helper (suit+rank for standard cards, `joker && id` for jokers) — see `valid-actions.ts`.

### `src/backend/engine/tonk/tonk-types.ts` (internal)

```ts
import type { TonkCard, TonkTurnPhase, TonkLogEntry } from "@shared/tonk-types.js";
import type { GameAction } from "@shared/engine-types.js";

export type {
  TonkCard, TonkJoker, TonkTurnPhase, TonkDrawSource,
  TonkLogEntry, TonkPublicState,
} from "@shared/tonk-types.js";

/** Full server-side Tonk state. Stored in InternalGameState.gameSpecificState. */
export interface TonkState {
  readonly hands: readonly (readonly TonkCard[])[]; // HIDDEN per-player
  readonly stock: readonly TonkCard[];              // HIDDEN (count only public)
  readonly discardPile: readonly TonkCard[];        // PUBLIC (top = most recent)
  readonly drawableDiscard: TonkCard | null;        // PUBLIC turn-start snapshot (§3.3)
  readonly lastDiscardCount: number;
  readonly lastDiscardPlayerIndex: number | null;
  readonly turnPhase: TonkTurnPhase;
  readonly trickNumber: number;        // 1-based
  readonly trickTurnCount: number;     // turns taken this trick (TONK gate = >= players.length)
  readonly trickDeckSize: number;      // cards in play this trick (for card-conservation invariant)
  readonly tallies: readonly number[]; // running match score per seat (lower better)
  readonly deckRoundsTarget: number;   // resolved & clamped at initialize (5..12)
  readonly numDecks: number;           // ceil(players/5) + extraDecks
  readonly tonkCallerIndex: number | null;
  readonly lostPlayerIndices: readonly number[]; // tally >=150 at match end
  readonly trueLoserIndex: number | null;
  readonly log: readonly TonkLogEntry[];
}

// Internal action union — the engine narrows GameAction to this in applyAction.
export type {
  TonkDiscardAction, TonkDrawAction, TonkCallTonkAction, TonkActionPayload,
} from "@shared/tonk-types.js";
export type TonkAction = import("@shared/tonk-types.js").TonkActionPayload & GameAction;
```

### `TonkEngine` method contracts

| Method | Behavior |
| --- | --- |
| `gameType` | `"tonk"` |
| `initialize(gameId, players, config, prng)` | Throw `"Tonk requires 3-8 players"` if `players.length < 3 || > 8`. Resolve `deckRoundsTarget = clamp(Number(config.options.deckRoundsTarget) ?? 8, 5, 12)` (default 8 if absent/NaN). `numDecks = ceil(players.length/5) + (config.options.extraDecks as number ?? 0)`. Build deck (§deck.ts), deal 5 each, rest → stock, trick-1 `discardPile = []`, `drawableDiscard = null`. `currentPlayerIndex = 0`, `turnNumber = 1`, `status = "IN_PROGRESS"`, `version = 1`, `winner = null`, `scores = null`, `randomSeed = prng.seed`. `TonkState`: `turnPhase = "discard"`, `trickNumber = 1`, `trickTurnCount = 0`, `tallies` all 0. Uses the passed `prng` for the trick-1 shuffle/cut (seed it deterministically — see §State Model "Determinism note"). |
| `validateAction(state, action)` | `return this.applyAction(state, action).success` (Big2 pattern). |
| `applyAction(state, action)` | Guard `COMPLETED` → reject `"Game is already over."`; non-`IN_PROGRESS` → `"Game has not started."`; not current player → `"Not your turn."`. Then dispatch on `action.type` × `turnPhase`. Deterministic, immutable, `version + 1`, `turnNumber + 1` on success. |
| `getPlayerView(state, playerId)` | Your hand only (others as counts); `TonkPublicState` (discard top + count, `drawableDiscard`, **stock count only**, tallies, phase, log, gate); `validActions` = `getValidActions(state, playerId)`. |
| `getValidActions(state, playerId)` | `[]` unless `IN_PROGRESS` and your turn (§6.2). Else by phase (below). |
| `isGameOver(state)` | `state.status === "COMPLETED"`. |
| `getAutoTimeoutAction(state)` | `null` if `status !== "IN_PROGRESS"` or `currentPlayerIndex < 0`. Else per phase (§7). |
| `getSpectatorView(state, n)` | Public only: no hands, no stock contents; `TonkPublicState`, counts, tallies, turn info, log, `spectatorCount`. |

### `getValidActions` by phase (§6.2)

- `turnPhase === "discard"` and gate open (`trickTurnCount >= players.length`): `[{ type: "discard" }, { type: "callTonk" }]`.
- `turnPhase === "discard"` and gate closed: `[{ type: "discard" }]`.
- `turnPhase === "draw"`: `[{ type: "draw", description: "stock" }]`, plus `{ type: "draw", description: "discard" }` **only when `drawableDiscard !== null`**.
- Returns action **types**, not every legal discard combination (the cards in a discard payload are validated in `applyAction`, mirroring Big2).

## State Model

**Persisted vs in-memory:** identical to Big2/LLD 04 (§4.3). The full `InternalGameState` (incl. `TonkState`) is the single source of truth, cached in memory for active games, persisted to DB as JSON for durability. `PlayerView`/`SpectatorView` are derived on demand, never stored. `isConnected` is a placeholder (`true`) overwritten by the WebSocket layer.

**Action flow within a turn:**

```
turnPhase = "discard"  (currentPlayerIndex = P)
  ├─ callTonk  (gate open) → reveal, scoreTrick (§5.1), end trick → next trick OR match-end
  └─ discard cards         → remove from hand P, push onto discardPile, set lastDiscard*,
                             turnPhase = "draw"  (still player P, turnNumber+1)
turnPhase = "draw"     (currentPlayerIndex = P)
  └─ draw {source}
       ├─ "stock"   → if stock empty: end trick under Case C (§5.1, §7); else pop stock → hand P
       └─ "discard" → consume drawableDiscard (remove that exact card from discardPile) → hand P
     then: trickTurnCount += 1; turnPhase = "discard";
           currentPlayerIndex = (P+1) % players.length;
           drawableDiscard = snapshot for the new current player (live discardPile top, or null if empty)
```

**Snapshot recomputation (§3.3, §8.3):** at the moment the turn hands off to the next seat, `drawableDiscard` is set to the current live `discardPile` top (the card the player who just finished placed) — i.e. the immediately-preceding player's single top card — or `null` if the pile is empty. For the **trick-2+ starter**, the trick setup flips one face-up card and sets `drawableDiscard` to it. For the **trick-1 first player**, `drawableDiscard = null`. The snapshot is **not** changed by the current player's own discard within their turn.

**Per-trick reset vs per-match carry (§4.4).** On trick end when the match is NOT over:
- **Carry:** `tallies`, `players`, `randomSeed`, `deckRoundsTarget`, `numDecks`; `trickNumber += 1`.
- **Reset:** rebuild + cut a new deck via sub-seed `hashSeed(randomSeed + ":trick:" + newTrickNumber)`; deal 5 each; `stock` = remainder; `discardPile` = `[faceUpStartCard]` (flipped from stock); `drawableDiscard` = that face-up card; `turnPhase = "discard"`; `trickTurnCount = 0`; `tonkCallerIndex = null`; `lastDiscardCount = 0`; `lastDiscardPlayerIndex = null`; `trickDeckSize` = new deck size.
- **Next starter / `currentPlayerIndex`:** the highest-tally player; ties → lowest seat index (§3.1.5, §8.7).

**Match-end resolution (§5.2, §5.3, §8.5).** After scoring a trick, if any `tallies[i] >= 150`:
- `lostPlayerIndices` = all seats with tally ≥ 150.
- If exactly one → that seat is the TRUE LOSER (no draw).
- If more than one → build a **single fresh 52+2-joker deck (54 cards), regardless of in-play `numDecks`**, shuffle via `hashSeed(randomSeed + ":trueloser:" + trickNumber)`; lost players draw one card at a time in ascending seat order, looping, until a joker is drawn; that seat is the TRUE LOSER. Termination guaranteed (2 jokers in 54).
- `status = "COMPLETED"`, `currentPlayerIndex = -1`, `trueLoserIndex` set, `winner` = lowest-tally seat (ties → lowest index), `scores` = `finalScores()` (one `PlayerScore` per player with `score = finalTally`, `breakdown = { lost, trueLoser, finalTally }`).

**Determinism note (initialize vs inter-trick).** `initialize` receives an external `prng` (its `.seed` becomes `randomSeed`). For the trick-1 deck, seed deterministically from `randomSeed` exactly as inter-trick does — `new SeededPRNG(hashSeed(prng.seed + ":trick:1").toString())` — so the same `randomSeed` reproduces the trick-1 deck identically and the per-trick scheme is uniform across all tricks. (Do not consume the external `prng` directly for the deck, so that replay from `randomSeed` alone is exact.)

## Edge Cases

| # | Case | Handling |
| --- | --- | --- |
| 1 | `<3` or `>8` players at `initialize` | Throw `"Tonk requires 3-8 players"` (§9.1). |
| 2 | Discard mixed ranks | Reject `"Discard must be a single rank"`. Jokers group only with jokers (§8.2). |
| 3 | Discard card(s) not in hand | Reject `"Cards not in hand"` (compare via `tonkCardEquals`, accounting for duplicate cards in multi-deck). |
| 4 | Empty discard payload | Reject `"Must discard at least one card"` (§8.7). |
| 5 | `draw` while `turnPhase === "discard"` | Reject `"Cannot draw before discarding"` (wrong phase). |
| 6 | `discard`/`callTonk` while `turnPhase === "draw"` | Reject `"Must draw to finish your turn"`. |
| 7 | `callTonk` before `trickTurnCount >= players.length` | Reject `"TONK can only be called after every player has had a turn"` (§3.4, §8.4). |
| 8 | `callTonk` not at start of turn (after discarding / not discard phase) | Reject (covered by #6 / phase guard). |
| 9 | `draw` from `"discard"` when `drawableDiscard === null` | Reject `"No card available to draw from discard"` (§8.3). Trick-1 first player always hits this. |
| 10 | `draw` with source other than `"stock"`/`"discard"` | Reject `"Invalid draw source"` (§8.3). |
| 11 | Draw from `"stock"` with empty stock | Trick ends under Case C (§5.1, §7) — not a rejection; the draw action resolves the trick. |
| 12 | Stock empty at start of discard phase | Discard still allowed (pile is the sink); trick only ends when a draw can't be satisfied (§7, §8.7). |
| 13 | Drawable snapshot is buried under current player's own discard | Still drawable — draw reads `drawableDiscard` snapshot, not live top; removes that exact card instance from `discardPile`. |
| 14 | Self-draw of just-discarded card | Impossible by construction — snapshot is captured at turn start (the *preceding* player's card), never the current player's discard (§3.3). |
| 15 | Preceding player discarded multiples | `drawableDiscard` is only the single top card; buried cards never drawable (§8.2, §8.3). |
| 16 | Case A (TONK, caller strictly lowest) | Every other player adds own hand value; caller adds 0 (§5.1). |
| 17 | Case B (TONK, caller tied or beaten) | Caller adds 30; others add 0 (§5.1). |
| 18 | Case C (stock-out, no TONK) | Lowest hand adds 30; **ties for lowest each add 30**; others 0 (§5.1, §8.7). |
| 19 | Match-end with exactly one ≥150 | That seat is TRUE LOSER, no draw (§5.3). |
| 20 | Match-end with multiple ≥150 | TRUE-LOSER joker draw from a single fresh 54-card deck (§5.3, §8.5). |
| 21 | All players ≥150 | Still exactly one loser (the joker-drawer); everyone else `gamesWon` via `trueLoser = 0`. `winner` = lowest tally (§8.7). |
| 22 | Tie at match end for lowest tally (display `winner`) | Lowest seat index among tied. Display only; does not drive stats (§8.7). |
| 23 | Action after `COMPLETED` | Reject `"Game is already over."`. |
| 24 | Action when not your turn | Reject `"Not your turn."`. |
| 25 | Rejected action | `newState = null`; caller's state and `version` unchanged (testing-principle #6). |
| 26 | Cut removes all jokers from a trick's deck | Allowed; jokers only matter for hand value (0) and the end-game draw (which uses a fresh full pool) (§8.1). |
| 27 | Reconnection / spectator mid-trick | Standard `getPlayerView`/`getSpectatorView`; revealed hands exist only transiently in the trick-result log entry. |

## Dependencies

| Dependency | Status | Use |
| --- | --- | --- |
| `src/backend/engine/game-engine.ts` (`GameEngine`, `GameEngineConfig`) | Implemented (LLD 02) | Interface implemented. `config.options` is `Record<string, unknown>` (verified). |
| `src/shared/engine-types.ts` | Implemented | `InternalGameState`, `PlayerView`, `SpectatorView`, `Card`, `GameType` (`"tonk"` present), `PlayerScore.breakdown: Record<string, number>`. |
| `src/backend/engine/prng.ts` (`SeededPRNG`, `FixedPRNG`, `hashSeed`, `generateSeed`) | Implemented (verified exports) | Deterministic per-trick deck + cut and TRUE-LOSER draw via derived sub-seeds. |
| `src/backend/engine/game-engine-factory.ts` | Implemented | Register `new TonkEngine()`. |
| Big2 reference (`big2-engine.ts`, `deck.ts`, `constants.ts`, `scoring.ts`, `valid-actions.ts`) | Implemented (LLD 04) | Pattern for immutability, `validateAction` delegation, view filtering, auto-timeout, module split. |

**Out-of-scope downstream (do NOT modify here):** `statsService.ts`, `Game` entity / DB migration, `createGame.ts`, `gameService.ts`, `model.ts`, WebSocket layer, frontend. These are #60 / §8.8. The engine only **reads** `config.options.deckRoundsTarget` and **populates** `breakdown.trueLoser`.

**Integration check (forwarded to #60 / LLD 07, not blocking this engine):** a Tonk turn is two phases, so the turn timer (LLD 07) MUST re-arm per phase within a single turn — on timeout it applies the auto-discard, then must fire **again** for the auto-draw while it is still that player's turn (`turnPhase = "draw"`). `getAutoTimeoutAction` returns the single valid action for the current phase, so the engine side is satisfied; the re-arm is a timer-layer responsibility. Flagged per §7/§9.4/§10. The engine has no timer dependency in code.

## Test Requirements

Per testing-principles: pure-function engine tests, controlled randomness (`FixedPRNG`/seeded), self-contained (no shared `beforeEach` state), invalid-action coverage, info-leakage negatives, invariants after every action, ≥1 full simulation. Mirror Big2's `tests/engine/big2/` layout under `tests/engine/tonk/`. Use direct-state-manipulation helpers (testing-principle #4): `makeTonkState({ hands, stock, discardPile, drawableDiscard, turnPhase, trickTurnCount, tallies, currentPlayerIndex })` and `cardValue`/`handValue` helpers so edge cases are constructed, not replayed.

### Unit — card & hand values (`scoring`/`constants`)
- Ace=1; 2–10=face; J/Q/K=10; Joker=0; `handValue` = sum over hand (incl. jokers contributing 0).

### Unit — deck build & cut determinism (`deck`)
- Same `(seed, trickNumber, deckRoundsTarget)` → identical deck AND identical cut (use seeded PRNG / `FixedPRNG`).
- **Cut formula correctness** matching §8.1 exactly, asserting the worked-example rows:
  - 3 players, 1 deck, default 8 → `cutAmount = 15`.
  - 3 players, target 12 → 3; target 5 → 24; target 13 → 0 (no-cut boundary).
  - 6 players, 2 decks, default 8 → `cutAmount = 30`.
  - 8 players, 2 decks, default 8 → `cutAmount = 4`.
- Default `deckRoundsTarget = 8` DOES cut at ≤5 players (3 players → cut 15) and the **card SET differs across tricks** for distinct sub-seeds.
- High target (≥13 at 3 players) → `cutAmount = 0`; card SET identical across tricks, only draw order varies; joker count = `2 * numDecks` = 2.
- 6+ players → `numDecks = ceil(players/5)` = 2; pool = `54 * numDecks`; `2 * numDecks` jokers; distinct subset per trick; cut may remove jokers.
- Absent `config.options.deckRoundsTarget` → engine uses 8; out-of-range value passed to engine is defensively clamped to [5,12].

### Unit — turn phases & valid actions (`valid-actions`)
- `validActions` correct per phase and per TONK gate (§6.2): discard-gate-closed = `[discard]`; discard-gate-open = `[discard, callTonk]`; draw with snapshot = `[draw(stock), draw(discard)]`; draw without snapshot = `[draw(stock)]`.
- Discard: single card OK; same-rank multiples OK; mixed-rank rejected; not-in-hand rejected; empty rejected.
- Draw: from stock OK; from discard OK only when `drawableDiscard !== null`; arbitrary source rejected; trick-1 first player cannot draw from discard.
- Turn hands off to next seat **only after** the draw phase (assert `currentPlayerIndex` unchanged after discard, advanced after draw).

### Unit — drawable-discard snapshot (`valid-actions`/`tonk-engine`)
- Buried preceding discard still drawable (yields the preceding player's top card, not the live top).
- No self-draw: a player can never draw back their own just-discarded card.
- Snapshot captured at turn start; unchanged by the current player's own discard.
- Multiples: only the single top card of a preceding multi-discard is drawable.
- Trick-2+ start card is the starter's initial `drawableDiscard` and survives the starter's discard.
- After drawing from discard, the exact snapshot card leaves `discardPile`; next player's snapshot recomputed at their turn start.

### Unit — TONK gate & scoring (`scoring`)
- `callTonk` rejected before everyone has had a turn; rejected outside discard phase.
- Case A: caller strictly lowest → others add own hand value, caller 0.
- Case B: caller tied/beaten → caller adds 30, others 0.

### Unit — stock exhaustion (Case C) (`scoring`/`tonk-engine`)
- Draw phase with empty stock ends the trick; lowest hand adds 30; ties for lowest each add 30.

### Unit — match end & TRUE LOSER (`scoring`)
- Tally ≥150 → match-end resolution; otherwise new trick begins with rebuilt deck.
- Single ≥150 → auto TRUE LOSER (no draw).
- Multiple ≥150 → joker draw from a single fresh 54-card deck (deterministic via sub-seed) picks TRUE LOSER; termination guaranteed.
- `winner` = lowest final tally (display; ties → lowest seat index).
- `breakdown` populated: `trueLoser` = 1 on exactly the TRUE LOSER and 0 elsewhere; `lost = (finalTally>=150)?1:0`; `finalTally` set; `score = finalTally`.

### Unit — invalid actions (testing-principle #6)
- Wrong turn, wrong phase, action after `COMPLETED`, source out-of-band, not-in-hand, mixed-rank, empty payload, TONK before gate: all rejected; **state unchanged, version not incremented**.

### Unit — auto-timeout (§7)
- Discard phase → single highest-value card (never multiples, never TONK); deterministic stable tie-break among equal-value cards via an explicit `(suit, rank, joker-id)` ordering defined in `constants.ts`.
- Draw phase → `draw` from `"stock"`; empty stock → resulting trick end via Case C.
- Returns `null` when `status !== "IN_PROGRESS"` or `currentPlayerIndex < 0`.

### Security — information hiding (testing-principle #7)
- `getPlayerView(state, A)` never contains B's hand and never the stock **contents** (count only).
- Opponent info is counts only; `gameSpecificPublicState.stockCount` is a number, with no `stock` array present.
- Discard top, counts, `drawableDiscard`, tallies are public.
- `getSpectatorView` contains no hands and no stock contents.
- At trick end, revealed hands appear only in the `trickResult` log entry, not as ongoing hidden-state leakage in subsequent views.

### Invariants — assert after every action (testing-principle #8)
- **Card conservation:** Σ hands + stock + discardPile = `trickDeckSize` within a trick. `drawableDiscard` is a reference to a card still physically in `discardPile` (until drawn) — count it **once** via `discardPile`, never separately.
- `currentPlayerIndex` is a valid active seat while `IN_PROGRESS`, or `-1` when `COMPLETED`.
- `validActions` non-empty for the current player while `IN_PROGRESS` (no deadlock).
- `status` only advances forward (never `COMPLETED → IN_PROGRESS`).
- `tallies` monotonically non-decreasing across tricks.
- `version` strictly increases by exactly 1 per applied action.

### Integration — full match simulation (testing-principle #9)
- Seeded PRNG; at each step pick from `validActions` (simple strategy — e.g. discard highest, draw stock, never call TONK unless forced, or a strategy guaranteed to reach ≥150). Play tricks until some seat ≥150 and a TRUE LOSER is resolved.
- Assert invariants hold every step, the match terminates (bounded loop), and `winner`/`scores`/`trueLoser` are populated: `winner` = lowest-tally display value; exactly one `scores[].breakdown.trueLoser === 1`; all others `0`; `breakdown.lost`/`finalTally` set.

### Factory registration
- `engineFactory.getEngine("tonk")` returns a `TonkEngine`; `hasEngine("tonk")` is true after the singleton import (extend `tests/engine/game-engine-factory.test.ts` expectations only as needed — do not break existing Big2 tests).
