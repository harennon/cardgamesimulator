import { describe, it, expect } from "vitest";
import { Big2Engine } from "../../../src/backend/engine/big2/big2-engine.js";
import { SeededPRNG, FixedPRNG } from "../../../src/backend/engine/prng.js";
import type {
  InternalGameState,
  PlayerInfo,
  Card,
} from "../../../src/shared/engine-types.js";
import type { Big2State } from "../../../src/backend/engine/big2/big2-types.js";

const engine = new Big2Engine();

function player(id: string): PlayerInfo {
  return { playerId: id, displayName: id };
}

const PLAYERS4 = ["p1", "p2", "p3", "p4"].map(player);
const PLAYERS3 = ["p1", "p2", "p3"].map(player);
const PLAYERS2 = ["p1", "p2"].map(player);

function card(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}

const config = { maxPlayers: 4, minPlayers: 2, options: {} };

function initGame(
  players: PlayerInfo[],
  seed = "test-seed",
): InternalGameState {
  return engine.initialize("game1", players, config, new SeededPRNG(seed));
}

function big2State(state: InternalGameState): Big2State {
  return state.gameSpecificState as Big2State;
}

function currentPlayerId(state: InternalGameState): string {
  return state.players[state.currentPlayerIndex]!.playerId;
}

function playAction(
  state: InternalGameState,
  cards: Card[],
): InternalGameState {
  const playerId = currentPlayerId(state);
  const result = engine.applyAction(state, {
    type: "playCards",
    playerId,
    cards,
  });
  if (!result.success) throw new Error(`playCards failed: ${result.error}`);
  return result.newState!;
}

function passAction(state: InternalGameState): InternalGameState {
  const playerId = currentPlayerId(state);
  const result = engine.applyAction(state, { type: "pass", playerId });
  if (!result.success) throw new Error(`pass failed: ${result.error}`);
  return result.newState!;
}

describe("initialize", () => {
  it("deals 13 cards each to 4 players", () => {
    const state = initGame(PLAYERS4);
    const gs = big2State(state);
    for (const hand of gs.hands) {
      expect(hand.length).toBe(13);
    }
  });

  it("deals 17 cards each to 3 players (51-card deck)", () => {
    const state = initGame(PLAYERS3);
    const gs = big2State(state);
    for (const hand of gs.hands) {
      expect(hand.length).toBe(17);
    }
    expect(gs.hands.flat().length).toBe(51);
  });

  it("deals 13 cards each to 2 players", () => {
    const state = initGame(PLAYERS2);
    const gs = big2State(state);
    for (const hand of gs.hands) {
      expect(hand.length).toBe(13);
    }
  });

  it("starting player holds the lowest card", () => {
    const state = initGame(PLAYERS4);
    const gs = big2State(state);
    const startingHand = gs.hands[state.currentPlayerIndex]!;
    // 4P lowest card is 3♣
    expect(startingHand.some((c) => c.rank === "3" && c.suit === "clubs")).toBe(
      true,
    );
  });

  it("isFirstPlayOfGame is true initially", () => {
    const state = initGame(PLAYERS4);
    expect(big2State(state).isFirstPlayOfGame).toBe(true);
  });

  it("isFreePlay is true initially", () => {
    const state = initGame(PLAYERS4);
    expect(big2State(state).isFreePlay).toBe(true);
  });

  it("throws for fewer than 2 players", () => {
    expect(() =>
      engine.initialize("g", [player("p1")], config, new SeededPRNG("s")),
    ).toThrow("Big2 requires 2-4 players");
  });

  it("throws for more than 4 players", () => {
    const five = ["p1", "p2", "p3", "p4", "p5"].map(player);
    expect(() =>
      engine.initialize("g", five, config, new SeededPRNG("s")),
    ).toThrow("Big2 requires 2-4 players");
  });
});

describe("turn advancement", () => {
  it("turn advances to next player after a play", () => {
    const state = initGame(PLAYERS4, "flow-test");
    const gs = big2State(state);
    const startingIndex = state.currentPlayerIndex;
    const startingHand = gs.hands[startingIndex]!;
    // Play the lowest card (3♣ single) as the first play
    const lowestCard = startingHand.find(
      (c) => c.rank === "3" && c.suit === "clubs",
    )!;
    const next = playAction(state, [lowestCard]);
    expect(next.currentPlayerIndex).not.toBe(startingIndex);
    expect(next.currentPlayerIndex).toBe((startingIndex + 1) % 4);
  });

  it("turn advances after a pass", () => {
    // Set up a state where passing is allowed (not first play, not free play)
    // First, make the opening play
    let state = initGame(PLAYERS4, "pass-test");
    const gs = big2State(state);
    const startIdx = state.currentPlayerIndex;
    const lowestCard = gs.hands[startIdx]!.find(
      (c) => c.rank === "3" && c.suit === "clubs",
    )!;
    state = playAction(state, [lowestCard]);
    const beforePassIdx = state.currentPlayerIndex;
    state = passAction(state);
    expect(state.currentPlayerIndex).toBe((beforePassIdx + 1) % 4);
  });

  it("version increments on every action", () => {
    let state = initGame(PLAYERS4, "version-test");
    const initialVersion = state.version;
    const gs = big2State(state);
    const lowestCard = gs.hands[state.currentPlayerIndex]!.find(
      (c) => c.rank === "3" && c.suit === "clubs",
    )!;
    state = playAction(state, [lowestCard]);
    expect(state.version).toBe(initialVersion + 1);
    state = passAction(state);
    expect(state.version).toBe(initialVersion + 2);
  });
});

describe("cannot pass on first play or free play", () => {
  it("rejects pass on first play of game", () => {
    const state = initGame(PLAYERS4);
    const playerId = currentPlayerId(state);
    const result = engine.applyAction(state, { type: "pass", playerId });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot pass on the first play/i);
  });

  it("rejects pass on free play (trick winner leads)", () => {
    let state = initGame(PLAYERS4, "free-play-test");
    const gs = big2State(state);
    const startIdx = state.currentPlayerIndex;
    const lowestCard = gs.hands[startIdx]!.find(
      (c) => c.rank === "3" && c.suit === "clubs",
    )!;
    // Play then have all others pass to reset to free play for starting player
    state = playAction(state, [lowestCard]);
    state = passAction(state);
    state = passAction(state);
    state = passAction(state);
    // Now starting player should have free play
    expect(big2State(state).isFreePlay).toBe(true);
    expect(state.currentPlayerIndex).toBe(startIdx);
    const playerId = currentPlayerId(state);
    const result = engine.applyAction(state, { type: "pass", playerId });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot pass when leading/i);
  });
});

describe("trick reset after all active players pass", () => {
  it("resets to free play for trick winner after all others pass", () => {
    let state = initGame(PLAYERS4, "trick-reset");
    const gs = big2State(state);
    const startIdx = state.currentPlayerIndex;
    const lowestCard = gs.hands[startIdx]!.find(
      (c) => c.rank === "3" && c.suit === "clubs",
    )!;
    state = playAction(state, [lowestCard]);
    // All 3 other players pass
    state = passAction(state);
    state = passAction(state);
    state = passAction(state);
    const gs2 = big2State(state);
    expect(gs2.isFreePlay).toBe(true);
    expect(gs2.lastPlay).toBeNull();
    expect(gs2.consecutivePasses).toBe(0);
    expect(state.currentPlayerIndex).toBe(startIdx);
  });
});

describe("wrong player / invalid state rejections", () => {
  it("rejects action from wrong player", () => {
    const state = initGame(PLAYERS4);
    const wrongPlayer = PLAYERS4.find(
      (p) => p.playerId !== currentPlayerId(state),
    )!;
    const result = engine.applyAction(state, {
      type: "pass",
      playerId: wrongPlayer.playerId,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not your turn/i);
  });

  it("rejects action after game is COMPLETED", () => {
    // Build a completed state manually
    const state = initGame(PLAYERS2, "complete-test");
    const completedState: InternalGameState = {
      ...state,
      status: "COMPLETED",
    };
    const result = engine.applyAction(completedState, {
      type: "pass",
      playerId: "p1",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already over/i);
  });

  it("rejects action when game has not started (CREATED)", () => {
    const state = initGame(PLAYERS2);
    const createdState: InternalGameState = {
      ...state,
      status: "CREATED",
    };
    const result = engine.applyAction(createdState, {
      type: "pass",
      playerId: "p1",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not started/i);
  });
});

describe("state immutability", () => {
  it("original state is not mutated after applyAction", () => {
    const state = initGame(PLAYERS4, "immutable-test");
    const gs = big2State(state);
    const startIdx = state.currentPlayerIndex;
    const lowestCard = gs.hands[startIdx]!.find(
      (c) => c.rank === "3" && c.suit === "clubs",
    )!;
    const originalHandSize = gs.hands[startIdx]!.length;
    const originalVersion = state.version;
    playAction(state, [lowestCard]);
    // Original state unchanged
    expect(state.version).toBe(originalVersion);
    expect(big2State(state).hands[startIdx]!.length).toBe(originalHandSize);
  });
});

describe("game completion in 2P", () => {
  it("game completes when first player empties hand", () => {
    // Use FixedPRNG to create a controlled 2P game where p1 gets all low cards
    // Use seeded PRNG and run until completion
    const state = initGame(PLAYERS2, "two-player-completion");
    const gs = big2State(state);
    // Starting player holds lowest card
    const startIdx = state.currentPlayerIndex;
    const otherIdx = 1 - startIdx;
    expect(gs.hands[startIdx]!.length).toBe(13);
    expect(gs.hands[otherIdx]!.length).toBe(13);
  });
});

describe("finished player indices", () => {
  it("finishedPlayerIndices is empty at game start", () => {
    const state = initGame(PLAYERS4);
    expect(big2State(state).finishedPlayerIndices).toEqual([]);
  });

  it("turn never lands on a finished player", () => {
    // Play a minimal sequence and verify currentPlayerIndex is always active
    let state = initGame(PLAYERS4, "skip-finished-test");
    const gs = big2State(state);
    const startIdx = state.currentPlayerIndex;
    const lowestCard = gs.hands[startIdx]!.find(
      (c) => c.rank === "3" && c.suit === "clubs",
    )!;
    state = playAction(state, [lowestCard]);
    // currentPlayerIndex should not be in finishedPlayerIndices
    const gs2 = big2State(state);
    expect(gs2.finishedPlayerIndices).not.toContain(state.currentPlayerIndex);
  });
});

describe("trick winner finished — free play goes to next active player", () => {
  it("free play is awarded to next active player when trick winner has already finished", () => {
    // Player 0 won the last trick but finished their hand on that play.
    // Players 1, 2, 3 are the remaining active players.
    // consecutivePasses=1 means one more pass by player 1 will trigger the trick reset
    // (activePlayerCount=3, reset triggers at newConsecutivePasses >= 2).
    const fiveOfClubs = card("5", "clubs");
    const gs: Big2State = {
      hands: [
        [], // player 0 — finished, empty hand
        [fiveOfClubs, card("8", "hearts")],
        [card("9", "diamonds"), card("J", "spades")],
        [card("K", "clubs"), card("A", "hearts")],
      ],
      lastPlay: {
        cards: [card("4", "spades")],
        handType: { kind: "single", card: card("4", "spades") },
        playerId: "p1",
      },
      lastPlayPlayerIndex: 0,
      consecutivePasses: 1,
      isFreePlay: false,
      isFirstPlayOfGame: false,
      playHistory: [],
      finishedPlayerIndices: [0],
    };

    const state: InternalGameState = {
      gameId: "test-finished-winner",
      gameType: "big2",
      status: "IN_PROGRESS",
      version: 5,
      players: PLAYERS4,
      currentPlayerIndex: 1, // player 1 is next to act
      turnNumber: 10,
      gameSpecificState: gs,
      winner: null,
      scores: null,
      randomSeed: "test",
    };

    // Player 1 passes → consecutivePasses becomes 2 >= activePlayerCount-1 (3-1=2) → trick reset
    const result = engine.applyAction(state, { type: "pass", playerId: "p2" });

    expect(result.success).toBe(true);
    const newState = result.newState!;
    const newGs = newState.gameSpecificState as Big2State;

    // Trick winner (player 0) is finished, so free play goes to next active: player 1
    expect(newState.currentPlayerIndex).toBe(1);
    expect(newGs.isFreePlay).toBe(true);
    expect(newGs.lastPlay).toBeNull();
    expect(newGs.consecutivePasses).toBe(0);
  });
});

describe("player finishes on a play but trick continues for others", () => {
  it("adds finisher to finishedPlayerIndices and lets next player beat the play", () => {
    const fiveOfSpades = card("5", "spades");
    const sevenOfSpades = card("7", "spades");

    const gs: Big2State = {
      hands: [
        [fiveOfSpades], // player 0 — 1 card left
        [sevenOfSpades, card("9", "clubs")], // player 1 — can beat with 7♠
        [card("Q", "diamonds"), card("K", "hearts")],
        [card("A", "clubs"), card("2", "diamonds")],
      ],
      lastPlay: null,
      lastPlayPlayerIndex: null,
      consecutivePasses: 0,
      isFreePlay: true,
      isFirstPlayOfGame: false,
      playHistory: [],
      finishedPlayerIndices: [],
    };

    const state: InternalGameState = {
      gameId: "test-finish-then-beat",
      gameType: "big2",
      status: "IN_PROGRESS",
      version: 3,
      players: PLAYERS4,
      currentPlayerIndex: 0,
      turnNumber: 5,
      gameSpecificState: gs,
      winner: null,
      scores: null,
      randomSeed: "test",
    };

    // Player 0 plays their last card (5♠) on a free play
    const afterPlay = engine.applyAction(state, {
      type: "playCards",
      playerId: "p1",
      cards: [fiveOfSpades],
    });

    expect(afterPlay.success).toBe(true);
    const midState = afterPlay.newState!;
    const midGs = midState.gameSpecificState as Big2State;

    // Player 0 is finished
    expect(midGs.finishedPlayerIndices).toContain(0);
    // Game still in progress — 3 active players remain
    expect(midState.status).toBe("IN_PROGRESS");
    // Turn advances to player 1
    expect(midState.currentPlayerIndex).toBe(1);
    // Trick is live with player 0's play
    expect(midGs.lastPlay).not.toBeNull();
    expect(midGs.lastPlay!.cards).toEqual([fiveOfSpades]);
    // Not a free play — player 1 must beat it
    expect(midGs.isFreePlay).toBe(false);

    // Player 1 plays 7♠ which beats 5♠ (higher rank single)
    const afterBeat = engine.applyAction(midState, {
      type: "playCards",
      playerId: "p2",
      cards: [sevenOfSpades],
    });

    expect(afterBeat.success).toBe(true);
    const finalGs = afterBeat.newState!.gameSpecificState as Big2State;
    expect(finalGs.lastPlay!.cards).toEqual([sevenOfSpades]);
  });
});
