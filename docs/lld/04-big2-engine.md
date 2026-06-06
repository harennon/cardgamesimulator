# LLD 4: Big2 Rules and Engine

Complete Big2 implementation against the `GameEngine` interface defined in LLD 2. After this LLD, the Big2 game can be played through the WebSocket layer (LLD 3) — deal, play, pass, score.

---

## 1. Scope

### In scope

- Big2 card ranking (rank order, suit order)
- Valid hand types: single, pair, straight (5 cards), full house, four-of-a-kind + kicker, straight flush
- Hand comparison rules (determining which hand beats which)
- Turn flow: first player plays 3 of clubs, trick reset on all-pass, play continues until last place
- 4-player support (13 cards each, full 52-card deck)
- 2-player and 3-player support with deck reduction
- Scoring (placement-based: 5/3/1/0 points)
- `Big2Engine` class implementing `GameEngine` from `src/backend/engine/game-engine.ts`
- `Big2State` type for `InternalGameState.gameSpecificState`
- Big2-specific action types (`playCards`, `pass`)
- Hand validation logic (is this a valid combination?)
- Hand comparison logic (does this beat the current play?)
- `getPlayerView()` implementation (hide other hands)
- `getSpectatorView()` implementation
- `getValidActions()` implementation
- Game initialization (shuffle, deal, determine starting player)

### Out of scope

- WebSocket transport (LLD 3)
- Turn timer and auto-pass (LLD 7)
- Frontend card rendering and selection (LLD 6)
- Guest access (LLD 5)
- Spectator join flow (LLD 8)
- Persistence and caching (LLD 2 — already implemented)

---

## 2. Approach

### Key decisions

1. **No triples, no flushes.** Per the execution plan, the valid 5-card hands are: straight, full house, four-of-a-kind (+ kicker), and straight flush. Flushes alone and triples alone are not valid plays.

2. **Suit ranking: diamonds < clubs < hearts < spades.** This matches the execution plan's `clubs < diamonds < hearts < spades` ... wait, the execution plan states `suits: ♣ < ♦ < ♥ < ♠`. Let me follow the execution plan exactly: **clubs < diamonds < hearts < spades**.

3. **Rank ordering: 3 lowest, 2 highest.** The full rank order is: 3, 4, 5, 6, 7, 8, 9, 10, J, Q, K, A, 2. This matches `engine-types.ts` `Rank` type ordering.

4. **Straights: A can be high (10-J-Q-K-A) but NOT low (A-2-3-4-5). 2 never participates in a straight.** Per the execution plan: "A can be low (A-2-3-4-5) or high (10-J-Q-K-A), no wrapping, 2 never in a straight." However, this contradicts itself — A-2-3-4-5 includes 2. The intent is clear: A can be the lowest card in a straight (A-2-3-4-5 is NOT valid since 2 cannot be in a straight). Therefore: A is high only (10-J-Q-K-A is the highest straight). The lowest straight is 3-4-5-6-7. A can be used in 10-J-Q-K-A. No wrapping (Q-K-A-3-4 is invalid).

5. **First play must include the lowest card.** In 4P: the player holding the 3 of clubs goes first, and their first play must include the 3 of clubs. In 3P: the 3 of clubs is removed, so the player holding the 3 of diamonds goes first. In 2P: first play must include whichever is the lowest card among dealt cards.

6. **Immutable state transitions.** `applyAction` returns a fresh state object. Spread operators for shallow copies, explicit array construction for hands.

7. **Hand type hierarchy for 5-card hands.** A higher hand type always beats a lower hand type regardless of card values: straight < full house < four-of-a-kind < straight flush.

8. **Player count support:**
   - 4 players: full 52-card deck, 13 cards each
   - 3 players: remove one card (3 of clubs — lowest card), 17 cards each
   - 2 players: deal 13 cards each from a shuffled deck, remaining 26 cards unused (not revealed)

9. **Game flow — play continues until last place.** The game does NOT end when the first player empties their hand. Instead, that player is placed 1st and play continues among remaining players until only one player remains (last place). This applies to 3P and 4P games. For 2P, the game ends when the first player goes out (the other is automatically last).

10. **Scoring — placement-based.** Players earn points based on finishing order:
    - 4P: 1st = 5 points, 2nd = 3 points, 3rd = 1 point, 4th = 0 points
    - 3P: 1st = 5 points, 2nd = 3 points, 3rd = 0 points
    - 2P: 1st = 5 points, 2nd = 0 points

---

## 3. Interfaces / Types

### 3.1 Constants

```typescript
// src/backend/engine/big2/constants.ts

import type { Suit, Rank, Card } from "@shared/engine-types";

// Suit ranking: clubs (lowest) < diamonds < hearts < spades (highest)
export const SUIT_ORDER: readonly Suit[] = [
  "clubs",
  "diamonds",
  "hearts",
  "spades",
];

// Rank ranking: 3 (lowest) through 2 (highest)
export const RANK_ORDER: readonly Rank[] = [
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
  "A",
  "2",
];

// Rank values for comparison (index in RANK_ORDER)
export function rankValue(rank: Rank): number {
  return RANK_ORDER.indexOf(rank);
}

// Suit values for comparison (index in SUIT_ORDER)
export function suitValue(suit: Suit): number {
  return SUIT_ORDER.indexOf(suit);
}

// Compare two cards. Returns negative if a < b, 0 if equal, positive if a > b.
// Primary: rank. Secondary: suit.
export function compareCards(a: Card, b: Card): number {
  const rankDiff = rankValue(a.rank) - rankValue(b.rank);
  if (rankDiff !== 0) return rankDiff;
  return suitValue(a.suit) - suitValue(b.suit);
}

// The lowest card in a standard 4-player game
export const THREE_OF_CLUBS: Card = { rank: "3", suit: "clubs" };

// Full 52-card deck (generated at module load, immutable)
export const FULL_DECK: readonly Card[] = SUIT_ORDER.flatMap((suit) =>
  RANK_ORDER.map((rank) => ({ suit, rank })),
);

// Placement points by player count and finishing position (0-indexed)
export const PLACEMENT_POINTS: Record<number, readonly number[]> = {
  2: [5, 0],
  3: [5, 3, 0],
  4: [5, 3, 1, 0],
};
```

### 3.2 Hand Types

```typescript
// src/backend/engine/big2/hand-types.ts

import type { Card } from "@shared/engine-types";

/** Discriminated union of valid Big2 hand types */
export type HandType =
  | { kind: "single"; card: Card }
  | { kind: "pair"; rank: string; highCard: Card }
  | { kind: "straight"; highCard: Card }
  | { kind: "fullHouse"; tripleRank: string; highCard: Card }
  | { kind: "fourOfAKind"; quadRank: string; highCard: Card }
  | { kind: "straightFlush"; highCard: Card };

/**
 * Five-card hand type hierarchy. Higher index beats lower index regardless of card values.
 * Hands of the same category are compared by their specific comparison rule.
 */
export const FIVE_CARD_HIERARCHY: readonly string[] = [
  "straight",
  "fullHouse",
  "fourOfAKind",
  "straightFlush",
];

/**
 * Number of cards required for each hand kind.
 */
export const HAND_SIZE: Record<HandType["kind"], number> = {
  single: 1,
  pair: 2,
  straight: 5,
  fullHouse: 5,
  fourOfAKind: 5,
  straightFlush: 5,
};
```

### 3.3 Big2 Game State

```typescript
// src/backend/engine/big2/big2-types.ts

import type { Card, PlayerId, GameAction } from "@shared/engine-types";
import type { HandType } from "./hand-types";

/** The game-specific state stored in InternalGameState.gameSpecificState */
export interface Big2State {
  /** Each player's hand (indexed same as InternalGameState.players) */
  readonly hands: readonly (readonly Card[])[];

  /** The last play on the table (null at start of a new trick) */
  readonly lastPlay: Big2Play | null;

  /** Index of the player who made the last play (for trick resolution) */
  readonly lastPlayPlayerIndex: number | null;

  /** Number of consecutive passes since the last play */
  readonly consecutivePasses: number;

  /** Whether the current player is leading a new trick (free play — any valid combo) */
  readonly isFreePlay: boolean;

  /** Whether this is the very first play of the game (must include lowest card) */
  readonly isFirstPlayOfGame: boolean;

  /** History of plays for the game log (public information) */
  readonly playHistory: readonly Big2HistoryEntry[];

  /**
   * Players who have finished (emptied their hand), in order of finishing.
   * Each entry is the player index. The first entry is 1st place, second is 2nd, etc.
   * Players still active have hands with length > 0 and are NOT in this array.
   */
  readonly finishedPlayerIndices: readonly number[];
}

/** A play that was made (cards + their detected hand type) */
export interface Big2Play {
  readonly cards: readonly Card[];
  readonly handType: HandType;
  readonly playerId: PlayerId;
}

/** Entry in the game history log (sent to all players and spectators) */
export interface Big2HistoryEntry {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly action: "play" | "pass";
  readonly cards?: readonly Card[]; // Only present for "play" actions
  readonly handType?: HandType["kind"]; // Only present for "play" actions
}

/** Big2-specific actions */
export interface Big2PlayCardsAction extends GameAction {
  readonly type: "playCards";
  readonly cards: readonly Card[];
}

export interface Big2PassAction extends GameAction {
  readonly type: "pass";
}

export type Big2Action = Big2PlayCardsAction | Big2PassAction;
```

### 3.4 Public State (for PlayerView and SpectatorView)

```typescript
// src/backend/engine/big2/big2-types.ts (continued)

/** Public game state visible to all players and spectators */
export interface Big2PublicState {
  readonly lastPlay: Big2Play | null;
  readonly consecutivePasses: number;
  readonly isFreePlay: boolean;
  readonly isFirstPlayOfGame: boolean;
  readonly playHistory: readonly Big2HistoryEntry[];
  readonly finishedPlayerIndices: readonly number[];
}
```

---

## 4. State Model

### 4.1 State Flow

```
Host clicks "Start Game"
  → GameService calls Big2Engine.initialize(gameId, players, config, prng)
  → PRNG shuffles deck
  → Deal 13 cards each (4P) / 17 each (3P) / 13 each (2P)
  → Find player with lowest card (3 of clubs in 4P)
  → Return InternalGameState with:
      status: "IN_PROGRESS"
      currentPlayerIndex: index of player with lowest card
      gameSpecificState: Big2State { isFreePlay: true, isFirstPlayOfGame: true, finishedPlayerIndices: [] }

Player plays cards
  → applyAction validates:
      - It is this player's turn
      - Cards are in their hand
      - Cards form a valid HandType
      - If isFirstPlayOfGame: cards include the lowest card
      - If !isFreePlay: hand type matches lastPlay type AND beats lastPlay
  → Removes cards from player's hand
  → Sets lastPlay, resets consecutivePasses to 0
  → If player's hand is empty:
      → Add player to finishedPlayerIndices
      → Count remaining active players (hand.length > 0)
      → If remaining active players <= 1:
          → status: "COMPLETED"
          → Last remaining player is automatically last place (added to finishedPlayerIndices)
          → Compute placement-based scores
          → winner = first entry in finishedPlayerIndices (1st place player)
      → Else:
          → Advance currentPlayerIndex to next ACTIVE player (skip finished players)
          → Game remains IN_PROGRESS
  → Else → advance currentPlayerIndex to next ACTIVE player (skip finished players)

Player passes
  → applyAction validates:
      - It is this player's turn
      - NOT isFirstPlayOfGame (cannot pass on first play)
      - NOT isFreePlay (cannot pass when you lead — you must play something)
  → Increments consecutivePasses
  → Advances currentPlayerIndex to next ACTIVE player (skip finished players)
  → If consecutivePasses === activePlayers - 1 (all other ACTIVE players passed):
      → If lastPlayPlayerIndex player is still active:
          → Set isFreePlay: true, lastPlay: null, consecutivePasses: 0
          → currentPlayerIndex = lastPlayPlayerIndex (trick winner leads)
      → Else (lastPlayPlayerIndex player has since finished):
          → Set isFreePlay: true, lastPlay: null, consecutivePasses: 0
          → currentPlayerIndex = next active player after lastPlayPlayerIndex
```

### 4.2 What is persisted vs in-memory

| Data                                             | Location                                                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full `InternalGameState` (including `Big2State`) | Persisted to DB as JSON (via GameCache → GameService → GameRepository) | Restored on server restart                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `PlayerView` derivations                         | Computed on-demand, never stored                                       | Pure function of `InternalGameState` + `playerId`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Connection status (`isConnected`)                | In-memory only (ConnectionManager, LLD 3)                              | Engine sets `true` as placeholder. The WebSocket broadcast layer (LLD 3) overwrites with real values from ConnectionManager before any view reaches a client. The engine must produce a value because `PlayerPublicInfo.isConnected` is required by the type, but the engine is pure and has no connection awareness — the field exists here solely so that `PlayerView` is the single source of truth for the frontend, avoiding client-side state reconciliation. |

### 4.3 Turn Order

Players take turns in order of `InternalGameState.players` array (index 0, 1, 2, 3, 0, 1, ...). The `currentPlayerIndex` wraps modulo player count, **skipping players whose index is in `finishedPlayerIndices`**. A player who has finished (empty hand) is never assigned as `currentPlayerIndex`.

### 4.4 Game Completion Logic

The game completes when the second-to-last player empties their hand (in 3P/4P) or when the first player empties their hand (in 2P). At that point:

1. All finished players are already recorded in `finishedPlayerIndices` in order.
2. The one remaining active player is automatically appended as last place.
3. `InternalGameState.status` is set to `"COMPLETED"`.
4. `InternalGameState.winner` is set to the `playerId` of `finishedPlayerIndices[0]` (1st place).
5. `InternalGameState.scores` is populated with placement points for all players.

---

## 5. Core Logic Specifications

### 5.1 Hand Detection

Given an array of cards, determine what `HandType` they form (or `null` if invalid):

```typescript
// src/backend/engine/big2/hand-detection.ts

export function detectHandType(cards: readonly Card[]): HandType | null;
```

**Detection rules:**

| Card count | Valid types                                     | Detection criteria                   |
| ---------- | ----------------------------------------------- | ------------------------------------ |
| 1          | single                                          | Always valid                         |
| 2          | pair                                            | Both cards same rank                 |
| 3          | (invalid)                                       | No triples allowed in Big2           |
| 4          | (invalid)                                       | Four cards alone is not a valid play |
| 5          | straight, fullHouse, fourOfAKind, straightFlush | See below                            |
| Other      | (invalid)                                       | No valid hand type                   |

**5-card detection (in evaluation order — first match wins):**

1. **Straight flush:** 5 cards of consecutive rank AND same suit. A-high allowed (10-J-Q-K-A). No wrapping. 2 never in a straight.
2. **Four of a kind:** 4 cards of the same rank + 1 kicker. The `highCard` is the highest of the four (by suit).
3. **Full house:** 3 cards of one rank + 2 of another rank. The `tripleRank` determines comparison. The `highCard` is the highest card in the triple (by suit).
4. **Straight:** 5 cards of consecutive rank, NOT all same suit. A-high allowed. No wrapping. 2 never in a straight.

**Straight validity:** Sort cards by rank value. Check that each consecutive pair differs by exactly 1 in rank value. Additionally, rank "2" (value index 12) cannot appear in any straight. The valid straight range is ranks 3 through A (indices 0 through 11).

### 5.2 Hand Comparison

```typescript
// src/backend/engine/big2/hand-comparison.ts

/**
 * Returns true if `challenger` beats `current`.
 * Both must be the same "size class" (same number of cards).
 * For 5-card hands, a higher category always beats a lower category.
 */
export function beats(challenger: HandType, current: HandType): boolean;
```

**Comparison rules:**

| Scenario                              | Rule                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Single vs single                      | Compare by rank first, then suit                                                                        |
| Pair vs pair                          | Compare by rank first, then by highest suit in the pair                                                 |
| 5-card vs 5-card (different category) | Higher category wins (straight < fullHouse < fourOfAKind < straightFlush)                               |
| Straight vs straight                  | Compare by high card (rank, then suit)                                                                  |
| Full house vs full house              | Compare by triple rank (suits don't matter since there are only 4 of each rank — triple rank is unique) |
| Four-of-a-kind vs four-of-a-kind      | Compare by quad rank                                                                                    |
| Straight flush vs straight flush      | Compare by high card (rank, then suit)                                                                  |

**Critical constraint:** You can only play the same number of cards as the current play. A pair cannot beat a single. A straight cannot beat a pair. This is enforced in `applyAction`, not in `beats`.

### 5.3 Valid Actions Computation

```typescript
// src/backend/engine/big2/valid-actions.ts

/**
 * Determine what actions the current player can take.
 * Returns action types (not every possible combination).
 */
export function computeValidActions(
  state: Big2State,
  hand: readonly Card[],
  isFirstPlayOfGame: boolean,
): ValidAction[];

/**
 * Check if a specific play is valid given the current game state.
 * Used by applyAction for validation.
 */
export function isValidPlay(
  cards: readonly Card[],
  hand: readonly Card[],
  lastPlay: Big2Play | null,
  isFreePlay: boolean,
  isFirstPlayOfGame: boolean,
  lowestCard: Card,
): { valid: boolean; handType: HandType | null; error?: string };
```

**`computeValidActions` logic:**

- If `isFirstPlayOfGame`: return `[{ type: "playCards", description: "Play cards (must include lowest card)" }]` — pass is NOT allowed.
- If `isFreePlay`: return `[{ type: "playCards", description: "Play any valid combination" }]` — pass is NOT allowed (you won the trick, you must lead).
- Otherwise: check if the player has ANY combination that can beat `lastPlay`. If yes: return `[{ type: "playCards", ... }, { type: "pass", description: "Pass" }]`. If no: return `[{ type: "pass", description: "Pass" }]`.

**Why return types not combinations:** Per LLD 2 Section 3 contract, `getValidActions` returns action types, not every possible card combination. The combinatorial explosion (hundreds of possible plays from a 13-card hand) would be impractical to enumerate in the validActions array. The client uses `validActions` to know what buttons to show (Play and/or Pass). Specific card selection validation happens in `applyAction`.

### 5.4 Determining if Player Can Beat Current Play

To determine whether to offer "playCards" as a valid action type, the engine must check if ANY valid combination exists in the player's hand that beats the current play. This is a helper function:

```typescript
/**
 * Returns true if the hand contains at least one combination that beats lastPlay.
 * Used internally to determine if "playCards" should appear in validActions.
 * Does NOT enumerate all possibilities — short-circuits on first found.
 */
export function canBeatLastPlay(
  hand: readonly Card[],
  lastPlay: Big2Play,
): boolean;
```

**Implementation approach for `canBeatLastPlay`:**

- For singles: find any card in hand that beats `lastPlay.handType.card`.
- For pairs: find any pair in hand whose high card beats `lastPlay.handType.highCard`.
- For 5-card hands: check all 5-card combinations (C(13,5) = 1287 max, acceptable for real-time). For each valid combination that matches or exceeds the lastPlay's category, check if it beats. Short-circuit on first match.

### 5.5 Deck Setup by Player Count

```typescript
/**
 * Build and shuffle the deck for the given player count.
 * Returns { deck, lowestCard }.
 */
export function buildDeck(
  playerCount: number,
  prng: PRNG,
): { deck: readonly Card[]; lowestCard: Card };
```

| Players | Deck size         | Cards dealt per player | Removal                                     |
| ------- | ----------------- | ---------------------- | ------------------------------------------- |
| 4       | 52                | 13                     | None                                        |
| 3       | 51                | 17                     | Remove 3 of clubs (lowest card by suit)     |
| 2       | 52 (deal 13 each) | 13                     | Remaining 26 cards set aside (not revealed) |

**Lowest card determination:**

- 4P: 3 of clubs (lowest rank + lowest suit in the full deck).
- 3P: After removing 3 of clubs from the deck, the lowest card is 3 of diamonds.
- 2P: Since only 26 of 52 cards are dealt, the starting player is whoever holds the lowest card among dealt cards. The engine must find it after dealing.

### 5.6 Scoring

```typescript
/**
 * Compute placement-based scores when the game completes.
 * Called within applyAction when the second-to-last player finishes (or first in 2P).
 *
 * @param players - all players in the game
 * @param finishedPlayerIndices - player indices in order of finishing (1st, 2nd, ..., last)
 */
export function computeScores(
  players: readonly PlayerInfo[],
  finishedPlayerIndices: readonly number[],
): readonly PlayerScore[];
```

**Scoring rules (placement-based):**

| Player count | 1st place | 2nd place | 3rd place | 4th place |
| ------------ | --------- | --------- | --------- | --------- |
| 4            | 5         | 3         | 1         | 0         |
| 3            | 5         | 3         | 0         | —         |
| 2            | 5         | 0         | —         | —         |

- Each player's score is determined solely by their finishing position.
- `finishedPlayerIndices[0]` is 1st place (5 points), `finishedPlayerIndices[1]` is 2nd place, etc.
- The last remaining player (automatically appended when game completes) gets 0 points.

`PlayerScore.breakdown` keys (exact names for frontend compatibility):

- **All players:** `{ placement: number }` — the player's finishing position (1, 2, 3, or 4)

---

## 6. Big2Engine Implementation

### 6.1 Class Structure

```typescript
// src/backend/engine/big2/big2-engine.ts

import type { GameEngine, GameEngineConfig } from "../game-engine";
import type { PRNG } from "../prng";
import type {
  GameAction,
  ActionResult,
  InternalGameState,
  PlayerView,
  SpectatorView,
  PlayerId,
  PlayerInfo,
  ValidAction,
} from "@shared/engine-types";
import type { Big2State, Big2Action, Big2PublicState } from "./big2-types";

export class Big2Engine implements GameEngine {
  readonly gameType = "big2" as const;

  initialize(
    gameId: string,
    players: readonly PlayerInfo[],
    config: GameEngineConfig,
    prng: PRNG,
  ): InternalGameState {
    // 1. Validate player count (2-4)
    // 2. Build deck for player count, shuffle with prng
    // 3. Deal cards to each player
    // 4. Sort each player's hand (for UX — deterministic sort by rank then suit)
    // 5. Find starting player (who holds the lowest card)
    // 6. Return InternalGameState with Big2State (finishedPlayerIndices: [])
  }

  validateAction(state: InternalGameState, action: GameAction): boolean {
    // Call applyAction and check result.success — avoids duplicating validation logic
    return this.applyAction(state, action).success;
  }

  applyAction(state: InternalGameState, action: GameAction): ActionResult {
    // 1. Verify game is IN_PROGRESS
    // 2. Verify it is this player's turn
    // 3. Cast action to Big2Action
    // 4. Dispatch to handlePlayCards or handlePass
    // 5. Check finish condition (hand empty → add to finishedPlayerIndices)
    // 6. Check game completion (active players <= 1)
    // 7. Return ActionResult with new state
  }

  getPlayerView(state: InternalGameState, playerId: PlayerId): PlayerView {
    // 1. Find player index
    // 2. Build PlayerPublicInfo for all players (card counts, no cards)
    // 3. Build PlayerPrivateInfo for requesting player (their hand)
    // 4. Build Big2PublicState (lastPlay, history, finishedPlayerIndices, etc.)
    // 5. Compute validActions for this player (empty if finished)
    // 6. Return PlayerView
  }

  getValidActions(
    state: InternalGameState,
    playerId: PlayerId,
  ): readonly ValidAction[] {
    // 1. If not IN_PROGRESS or not this player's turn, return []
    // 2. If player is in finishedPlayerIndices, return []
    // 3. Delegate to computeValidActions
  }

  isGameOver(state: InternalGameState): boolean {
    return state.status === "COMPLETED";
  }

  getSpectatorView(
    state: InternalGameState,
    spectatorCount: number,
  ): SpectatorView {
    // Same as PlayerView minus `you` and `validActions`
    // Shows card counts, lastPlay, history, turn info, finishedPlayerIndices
  }
}
```

### 6.2 applyAction Detail

```typescript
private handlePlayCards(
  state: InternalGameState,
  big2State: Big2State,
  action: Big2PlayCardsAction,
  playerIndex: number,
): ActionResult {
  const hand = big2State.hands[playerIndex];
  const lowestCard = this.getLowestCard(big2State, state.players.length);

  // Validate the play
  const validation = isValidPlay(
    action.cards,
    hand,
    big2State.lastPlay,
    big2State.isFreePlay,
    big2State.isFirstPlayOfGame,
    lowestCard,
  );

  if (!validation.valid) {
    return { success: false, newState: null, error: validation.error };
  }

  // Remove played cards from hand
  const newHand = hand.filter(c => !action.cards.some(ac => ac.rank === c.rank && ac.suit === c.suit));

  // Build new hands array
  const newHands = big2State.hands.map((h, i) => i === playerIndex ? newHand : h);

  // Build the play record
  const play: Big2Play = {
    cards: action.cards,
    handType: validation.handType!,
    playerId: state.players[playerIndex].playerId,
  };

  const newPlayHistory = [...big2State.playHistory, { /* play entry */ }];

  // Check if player just finished (emptied their hand)
  if (newHand.length === 0) {
    const newFinished = [...big2State.finishedPlayerIndices, playerIndex];

    // Count remaining active players
    const activePlayers = state.players.filter(
      (_, i) => !newFinished.includes(i)
    );

    // Check game completion: only 1 (or 0) players remain
    if (activePlayers.length <= 1) {
      // Append the last remaining player as last place
      const lastPlayerIndex = state.players.findIndex(
        (_, i) => !newFinished.includes(i)
      );
      const finalFinished = lastPlayerIndex >= 0
        ? [...newFinished, lastPlayerIndex]
        : newFinished;

      const scores = computeScores(state.players, finalFinished);
      const newBig2State: Big2State = {
        ...big2State,
        hands: newHands,
        lastPlay: play,
        lastPlayPlayerIndex: playerIndex,
        consecutivePasses: 0,
        isFreePlay: false,
        isFirstPlayOfGame: false,
        playHistory: newPlayHistory,
        finishedPlayerIndices: finalFinished,
      };
      return {
        success: true,
        newState: {
          ...state,
          version: state.version + 1,
          turnNumber: state.turnNumber + 1,
          status: "COMPLETED",
          currentPlayerIndex: -1,
          winner: state.players[finalFinished[0]].playerId,
          scores,
          gameSpecificState: newBig2State,
        },
      };
    }

    // Game continues — player finished but others remain
    const nextPlayerIndex = this.getNextActivePlayerIndex(
      playerIndex, state.players.length, newFinished
    );

    const newBig2State: Big2State = {
      hands: newHands,
      lastPlay: play,
      lastPlayPlayerIndex: playerIndex,
      consecutivePasses: 0,
      isFreePlay: false,
      isFirstPlayOfGame: false,
      playHistory: newPlayHistory,
      finishedPlayerIndices: newFinished,
    };

    return {
      success: true,
      newState: {
        ...state,
        version: state.version + 1,
        turnNumber: state.turnNumber + 1,
        currentPlayerIndex: nextPlayerIndex,
        gameSpecificState: newBig2State,
      },
    };
  }

  // Player did not finish — normal advance
  const nextPlayerIndex = this.getNextActivePlayerIndex(
    playerIndex, state.players.length, big2State.finishedPlayerIndices
  );

  const newBig2State: Big2State = {
    hands: newHands,
    lastPlay: play,
    lastPlayPlayerIndex: playerIndex,
    consecutivePasses: 0,
    isFreePlay: false,
    isFirstPlayOfGame: false,
    playHistory: newPlayHistory,
    finishedPlayerIndices: big2State.finishedPlayerIndices,
  };

  return {
    success: true,
    newState: {
      ...state,
      version: state.version + 1,
      turnNumber: state.turnNumber + 1,
      currentPlayerIndex: nextPlayerIndex,
      gameSpecificState: newBig2State,
    },
  };
}

private handlePass(
  state: InternalGameState,
  big2State: Big2State,
  playerIndex: number,
): ActionResult {
  // Cannot pass on first play of game
  if (big2State.isFirstPlayOfGame) {
    return { success: false, newState: null, error: "Cannot pass on the first play" };
  }

  // Cannot pass on free play (you won the trick — you must lead)
  if (big2State.isFreePlay) {
    return { success: false, newState: null, error: "Cannot pass when leading a trick" };
  }

  const newConsecutivePasses = big2State.consecutivePasses + 1;
  const activePlayerCount = state.players.length - big2State.finishedPlayerIndices.length;

  // Check if everyone else (who is still active) has passed (trick complete)
  if (newConsecutivePasses >= activePlayerCount - 1) {
    // Trick winner leads next — but they may have finished since their play
    const trickWinnerIndex = big2State.lastPlayPlayerIndex!;
    const trickWinnerIsActive = !big2State.finishedPlayerIndices.includes(trickWinnerIndex);

    let nextLeader: number;
    if (trickWinnerIsActive) {
      nextLeader = trickWinnerIndex;
    } else {
      // Trick winner has since gone out — next active player after them leads
      nextLeader = this.getNextActivePlayerIndex(
        trickWinnerIndex, state.players.length, big2State.finishedPlayerIndices
      );
    }

    const newBig2State: Big2State = {
      ...big2State,
      consecutivePasses: 0,
      isFreePlay: true,
      lastPlay: null,
      lastPlayPlayerIndex: null,
      playHistory: [...big2State.playHistory, { /* pass entry */ }],
    };
    return {
      success: true,
      newState: {
        ...state,
        version: state.version + 1,
        turnNumber: state.turnNumber + 1,
        currentPlayerIndex: nextLeader,
        gameSpecificState: newBig2State,
      },
    };
  }

  // Normal pass — advance turn to next active player
  const nextPlayerIndex = this.getNextActivePlayerIndex(
    playerIndex, state.players.length, big2State.finishedPlayerIndices
  );
  const newBig2State: Big2State = {
    ...big2State,
    consecutivePasses: newConsecutivePasses,
    playHistory: [...big2State.playHistory, { /* pass entry */ }],
  };

  return {
    success: true,
    newState: {
      ...state,
      version: state.version + 1,
      turnNumber: state.turnNumber + 1,
      currentPlayerIndex: nextPlayerIndex,
      gameSpecificState: newBig2State,
    },
  };
}
```

### 6.3 Turn Advancement

```typescript
/**
 * Get the next active player index, skipping finished players.
 * Wraps around the player array modulo playerCount.
 */
private getNextActivePlayerIndex(
  currentIndex: number,
  playerCount: number,
  finishedPlayerIndices: readonly number[],
): number {
  let next = (currentIndex + 1) % playerCount;
  // Safety: loop at most playerCount times to avoid infinite loop
  for (let i = 0; i < playerCount; i++) {
    if (!finishedPlayerIndices.includes(next)) {
      return next;
    }
    next = (next + 1) % playerCount;
  }
  // Should never reach here if game completion is checked before calling this
  return -1;
}
```

Players who have finished (their index is in `finishedPlayerIndices`) are always skipped during turn advancement. When a finished player's turn would come up, the engine moves to the next active player automatically.

---

## 7. Edge Cases

| Edge case                                                     | Handling                                                                                                                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Player plays cards not in their hand                          | `isValidPlay` checks every card exists in the hand. Returns error "Cards not in hand."                                                                                                                |
| Player plays duplicate cards (same card twice in one play)    | Validation checks that all played cards are distinct (no two have same rank+suit).                                                                                                                    |
| Player plays cards that don't form a valid hand type          | `detectHandType` returns null. Action rejected with "Invalid card combination."                                                                                                                       |
| Player plays valid hand type but wrong size vs current play   | Must match card count of `lastPlay`. E.g., cannot play a pair to beat a single. Error: "Must play same number of cards as current play."                                                              |
| Player plays valid hand type but doesn't beat current play    | `beats()` returns false. Error: "Play does not beat the current hand."                                                                                                                                |
| First play of game doesn't include lowest card                | Explicit check in `isValidPlay` when `isFirstPlayOfGame` is true. Error: "First play must include the [card]."                                                                                        |
| Player tries to pass on first play                            | Rejected. Error: "Cannot pass on the first play."                                                                                                                                                     |
| Player tries to pass when leading (free play)                 | Rejected. Error: "Cannot pass when leading a trick."                                                                                                                                                  |
| Player submits action but it's not their turn                 | `applyAction` checks `currentPlayerIndex` vs player index. Error: "Not your turn."                                                                                                                    |
| Action submitted after game is COMPLETED                      | Rejected immediately. Error: "Game is already over."                                                                                                                                                  |
| Action submitted while game is CREATED                        | Rejected. Error: "Game has not started."                                                                                                                                                              |
| Player has no valid plays but it's their turn (non-free-play) | `getValidActions` returns only `[{ type: "pass" }]`. The "playCards" option is not offered. If somehow submitted anyway, `applyAction` rejects because no valid combo exists that beats current play. |
| All active players pass back to the trick leader              | Trick resets — leader gets free play. `consecutivePasses` is reset. `lastPlay` is cleared.                                                                                                            |
| Trick leader has since finished (went out)                    | When all active players pass and the trick leader's index is in `finishedPlayerIndices`, the next active player after the trick leader gets the free play instead.                                    |
| Finished player's turn is reached                             | Never happens — `getNextActivePlayerIndex` always skips finished players. `currentPlayerIndex` is never set to a finished player.                                                                     |
| Player finishes but game not over (3P/4P)                     | Player added to `finishedPlayerIndices`. Turn advances to next active player. Game continues among remaining players.                                                                                 |
| Second-to-last player finishes (game completion)              | The last remaining player is automatically placed last. Game status → COMPLETED. Scores computed based on placement order.                                                                            |
| 2-player game: first player goes out                          | Game immediately completes. The other player is automatically last place. Scores: 5 and 0.                                                                                                            |
| 3-player game with removed card                               | Deck built without 3 of clubs. Lowest card becomes 3 of diamonds. First player is whoever holds 3 of diamonds.                                                                                        |
| 2-player game                                                 | Only 26 cards dealt (13 each). Remaining 26 are set aside unseen. Lowest card among dealt cards determines starting player.                                                                           |
| A is used in a straight                                       | Only valid as high: 10-J-Q-K-A. A-2-3-4-5 is NOT valid (2 cannot be in a straight).                                                                                                                   |
| Player tries to play 2 in a straight                          | `detectHandType` for straight rejects any hand containing rank "2". Returns null.                                                                                                                     |
| Cards comparison for identical rank                           | Suit breaks the tie (clubs < diamonds < hearts < spades).                                                                                                                                             |
| Game initialized with fewer than 2 or more than 4 players     | `initialize` throws Error("Big2 requires 2-4 players").                                                                                                                                               |
| Finished player tries to submit an action                     | Rejected. They are not `currentPlayerIndex` so "Not your turn" error fires. Additionally, `getValidActions` returns `[]` for finished players.                                                        |

---

## 8. File Layout

```
src/backend/engine/big2/
  big2-engine.ts          -- Big2Engine class (implements GameEngine)
  big2-types.ts           -- Big2State, Big2Play, Big2Action, Big2PublicState, Big2HistoryEntry
  constants.ts            -- SUIT_ORDER, RANK_ORDER, rankValue, suitValue, compareCards, FULL_DECK, PLACEMENT_POINTS
  hand-detection.ts       -- detectHandType(cards) → HandType | null
  hand-comparison.ts      -- beats(challenger, current) → boolean
  hand-types.ts           -- HandType discriminated union, FIVE_CARD_HIERARCHY, HAND_SIZE
  valid-actions.ts        -- computeValidActions, isValidPlay, canBeatLastPlay
  scoring.ts              -- computeScores (placement-based)
  deck.ts                 -- buildDeck(playerCount, prng)

tests/engine/big2/
  hand-detection.test.ts  -- All hand type detection cases
  hand-comparison.test.ts -- Comparison logic for each hand type
  valid-actions.test.ts   -- Action availability and validation
  game-flow.test.ts       -- Turn order, trick reset, passing, multi-finish mechanics
  scoring.test.ts         -- Placement-based scoring
  full-game.test.ts       -- Complete game simulation with invariant checks
  information-hiding.test.ts -- PlayerView never leaks hidden data
```

---

## 9. Dependencies

| Dependency                                  | Status              | Notes                                                                              |
| ------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| `src/backend/engine/game-engine.ts`         | Implemented (LLD 2) | The `GameEngine` interface this implements                                         |
| `src/backend/engine/prng.ts`                | Implemented (LLD 2) | `PRNG`, `SeededPRNG`, `FixedPRNG`                                                  |
| `src/shared/engine-types.ts`                | Implemented (LLD 2) | All shared types (`Card`, `Suit`, `Rank`, `InternalGameState`, `PlayerView`, etc.) |
| `src/backend/engine/game-engine-factory.ts` | Implemented (LLD 2) | `Big2Engine` must be registered here at startup                                    |

No new npm packages required. All implementations use the existing type system and PRNG infrastructure.

---

## 10. Test Requirements

### 10.1 Unit Tests: Hand Detection (`tests/engine/big2/hand-detection.test.ts`)

| Test                                        | What it verifies                                           |
| ------------------------------------------- | ---------------------------------------------------------- |
| Single card detected                        | Any 1 card → `{ kind: "single", card }`                    |
| Pair detected                               | Two cards same rank → pair with correct highCard (by suit) |
| Non-pair rejected (2 cards, different rank) | Returns null                                               |
| 3 cards rejected                            | Always returns null                                        |
| 4 cards rejected                            | Always returns null                                        |
| 6+ cards rejected                           | Always returns null                                        |
| Straight detected (3-4-5-6-7)               | Valid straight, highCard is 7 of highest suit              |
| Straight detected (10-J-Q-K-A)              | A-high straight valid                                      |
| Straight rejected (contains 2)              | Any 5-sequence containing rank 2 → null                    |
| Straight rejected (wrapping Q-K-A-3-4)      | Non-consecutive → null                                     |
| Straight rejected (non-consecutive)         | e.g., 3-4-5-6-8 → null                                     |
| Full house detected                         | 3+2 of different ranks → fullHouse with correct tripleRank |
| Four of a kind detected                     | 4+1 → fourOfAKind with correct quadRank                    |
| Straight flush detected                     | 5 consecutive same suit → straightFlush                    |
| Straight flush (10-J-Q-K-A same suit)       | Valid                                                      |
| 5 cards that are none of the above          | e.g., 3C 3D 5H 8S JC → null                                |

### 10.2 Unit Tests: Hand Comparison (`tests/engine/big2/hand-comparison.test.ts`)

| Test                                             | What it verifies                                  |
| ------------------------------------------------ | ------------------------------------------------- |
| Higher rank single beats lower                   | 4S beats 3S                                       |
| Higher suit single beats same rank               | 3S beats 3H                                       |
| Higher rank pair beats lower                     | Pair of 5s beats pair of 4s                       |
| Same rank pair, higher suit wins                 | Pair(5S,5H) beats Pair(5D,5C) — compare high suit |
| Straight beats straight (higher high card)       | 4-5-6-7-8 beats 3-4-5-6-7                         |
| Full house beats full house (higher triple rank) | FH(KKK,44) beats FH(QQQ,AA)                       |
| Four-of-a-kind beats four-of-a-kind              | Quad K beats quad Q                               |
| Straight flush beats straight flush              | Higher high card wins                             |
| Full house beats any straight                    | Category hierarchy                                |
| Four-of-a-kind beats any full house              | Category hierarchy                                |
| Straight flush beats any four-of-a-kind          | Category hierarchy                                |
| Same hand does not beat itself                   | beats(X, X) returns false                         |

### 10.3 Unit Tests: Valid Actions (`tests/engine/big2/valid-actions.test.ts`)

| Test                                                  | What it verifies                         |
| ----------------------------------------------------- | ---------------------------------------- |
| First play of game: only "playCards" offered          | Pass not available                       |
| Free play (after trick win): only "playCards" offered | Pass not available                       |
| Normal turn with valid plays: both offered            | "playCards" and "pass" available         |
| Normal turn with NO valid plays: only "pass" offered  | Cannot play anything that beats current  |
| isValidPlay: cards not in hand rejected               | Error message                            |
| isValidPlay: invalid combination rejected             | Error message                            |
| isValidPlay: wrong card count vs lastPlay rejected    | Error message                            |
| isValidPlay: doesn't beat lastPlay rejected           | Error message                            |
| isValidPlay: first play without lowest card rejected  | Error message                            |
| isValidPlay: valid play accepted                      | Returns valid=true with correct handType |
| canBeatLastPlay: returns true when beatable           | Player has at least one combo            |
| canBeatLastPlay: returns false when unbeatable        | No combo in hand can beat current        |

### 10.4 Unit Tests: Game Flow (`tests/engine/big2/game-flow.test.ts`)

| Test                                                      | What it verifies                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------- |
| Initialize deals correct card count (4P)                  | Each player has 13 cards                                                   |
| Initialize deals correct card count (3P)                  | Each player has 17 cards, deck has 51                                      |
| Initialize deals correct card count (2P)                  | Each player has 13 cards                                                   |
| Starting player holds lowest card                         | currentPlayerIndex points to correct player                                |
| Turn advances after valid play                            | currentPlayerIndex moves to next active player                             |
| Turn advances after pass                                  | currentPlayerIndex moves to next active player                             |
| Trick resets after all active players pass                | isFreePlay=true, lastPlay=null, currentPlayer=trick winner                 |
| Cannot pass on first play                                 | applyAction returns failure                                                |
| Cannot pass on free play                                  | applyAction returns failure                                                |
| Player finishes — added to finishedPlayerIndices          | finishedPlayerIndices grows by 1, player's hand is empty                   |
| Player finishes — turn skips to next active player        | currentPlayerIndex skips the finished player                               |
| Game continues after 1st place finishes (4P)              | status remains IN_PROGRESS, 3 active players remain                        |
| Game completes when second-to-last finishes (4P)          | status=COMPLETED, last player auto-placed, winner set to 1st finisher      |
| Game completes immediately in 2P                          | First player to empty hand wins, other is last place                       |
| Trick winner finished — next active player gets free play | When all pass and trick leader has gone out, free play goes to next active |
| Finished player turn is skipped                           | Turn never lands on a player in finishedPlayerIndices                      |
| Version increments on every action                        | newState.version = state.version + 1                                       |
| State is immutable                                        | Original state unchanged after applyAction                                 |
| Wrong player's turn rejected                              | Error: "Not your turn"                                                     |
| Action after game over rejected                           | Error: "Game is already over"                                              |
| Finished player submitting action rejected                | Error: "Not your turn"                                                     |

### 10.5 Unit Tests: Scoring (`tests/engine/big2/scoring.test.ts`)

| Test                         | What it verifies                                                           |
| ---------------------------- | -------------------------------------------------------------------------- |
| 4P scoring: 5/3/1/0          | First finisher gets 5, second gets 3, third gets 1, last gets 0            |
| 3P scoring: 5/3/0            | First finisher gets 5, second gets 3, last gets 0                          |
| 2P scoring: 5/0              | First finisher gets 5, other gets 0                                        |
| Breakdown contains placement | Each player's breakdown has `{ placement: N }` where N is 1-based position |
| Winner is first finisher     | scores[0] corresponds to the player who finished first                     |
| All players accounted for    | scores array has one entry per player                                      |

### 10.6 Integration Tests: Full Game Simulation (`tests/engine/big2/full-game.test.ts`)

| Test                                                     | What it verifies                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| Complete 4P game using seeded PRNG                       | Game terminates, all players placed, scores computed                    |
| Complete 3P game                                         | Same as above with 3 players                                            |
| Complete 2P game                                         | Same as above with 2 players                                            |
| Invariant: total cards constant                          | Sum of all hand sizes + played cards = expected total (every turn)      |
| Invariant: no deadlock                                   | validActions is never empty for current player (game always progresses) |
| Invariant: status never goes backwards                   | Only forward: IN_PROGRESS → COMPLETED                                   |
| Invariant: version strictly increases                    | Each action increments by exactly 1                                     |
| Invariant: finishedPlayerIndices only grows              | Never shrinks, entries never removed                                    |
| Invariant: currentPlayerIndex is never a finished player | During IN_PROGRESS, current player is always active                     |
| Random strategy game (pick random valid action)          | Completes without error over 100 random seeds                           |
| Multiple players finish in sequence                      | finishedPlayerIndices reflects correct ordering                         |

### 10.7 Security Tests: Information Hiding (`tests/engine/big2/information-hiding.test.ts`)

| Test                                              | What it verifies                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| PlayerView for A does not contain B's hand        | No cards from player B appear in A's view                         |
| PlayerView shows only your own hand               | `you.hand` matches your actual hand                               |
| PlayerView shows opponent card counts (not cards) | `players[].cardCount` is a number, no Card objects                |
| SpectatorView contains no hands                   | No Card arrays anywhere in spectator view                         |
| gameSpecificPublicState contains no hands         | Only public info (lastPlay, history, finishedPlayerIndices, etc.) |
| After a play, played cards visible to all         | lastPlay.cards appears in all views                               |
| Played cards no longer in player's hand           | PlayerView.you.hand shrinks after play                            |
| Finished player's hand is empty in their view     | After finishing, `you.hand` is `[]`                               |

---

## 11. Acceptance Criteria

Implementation is complete when:

1. `npm run build` succeeds with zero TypeScript errors.
2. `Big2Engine` implements all `GameEngine` interface methods.
3. A 4-player game can be played from start to finish using `initialize` → repeated `applyAction` → `COMPLETED`, with all players placed in order.
4. `getPlayerView` for any player never contains another player's cards (proven by tests).
5. Hand detection correctly identifies all valid hand types and rejects invalid ones.
6. Hand comparison correctly determines the winner for all same-category and cross-category matchups.
7. Scoring produces correct placement-based points (5/3/1/0 for 4P, 5/3/0 for 3P, 5/0 for 2P).
8. All edge cases in Section 7 are covered by tests.
9. Full game simulation (random strategy, 100+ seeds) completes without error or invariant violation.
10. No `Math.random()` anywhere in the engine code.
11. No I/O (network, filesystem, database) in any file under `src/backend/engine/big2/`.
12. All tests pass via `npm test`.
13. Game continues after first player finishes until only one active player remains.
14. Finished players are never assigned as `currentPlayerIndex`.
15. `finishedPlayerIndices` correctly tracks finishing order across entire game.
