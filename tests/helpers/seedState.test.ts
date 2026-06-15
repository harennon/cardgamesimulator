import { describe, it, expect } from "vitest";
import { buildGameState, buildCompletedState } from "./seedState.js";
import type { Card } from "../../src/shared/engine-types.js";
import type { Big2State } from "../../src/backend/engine/big2/big2-types.js";

describe("buildGameState", () => {
  it("produces a valid 4-player IN_PROGRESS state with no overrides", () => {
    const state = buildGameState({ gameId: "test-game-1" });
    expect(state.gameId).toBe("test-game-1");
    expect(state.status).toBe("IN_PROGRESS");
    expect(state.gameType).toBe("big2");
    expect(state.players).toHaveLength(4);
    expect(state.winner).toBeNull();
    expect(state.scores).toBeNull();
    const big2 = state.gameSpecificState as Big2State;
    expect(big2.hands).toHaveLength(4);
    // 4-player game: 13 cards each = 52 total
    const totalCards = big2.hands.reduce((sum, h) => sum + h.length, 0);
    expect(totalCards).toBe(52);
  });

  it("produces a valid 2-player IN_PROGRESS state", () => {
    const players = [
      { playerId: "p1", displayName: "P1" },
      { playerId: "p2", displayName: "P2" },
    ];
    const state = buildGameState({ gameId: "test-game-2", players });
    expect(state.players).toHaveLength(2);
    const big2 = state.gameSpecificState as Big2State;
    expect(big2.hands).toHaveLength(2);
    // 2-player: 13 cards each = 26 total dealt
    const totalCards = big2.hands.reduce((sum, h) => sum + h.length, 0);
    expect(totalCards).toBe(26);
  });

  it("preserves custom hands exactly", () => {
    const customHands: Card[][] = [
      [{ rank: "3", suit: "clubs" }],
      [{ rank: "A", suit: "spades" }],
    ];
    const players = [
      { playerId: "p1", displayName: "P1" },
      { playerId: "p2", displayName: "P2" },
    ];
    const state = buildGameState({
      gameId: "test-game-3",
      players,
      hands: customHands,
    });
    const big2 = state.gameSpecificState as Big2State;
    expect(big2.hands[0]).toEqual([{ rank: "3", suit: "clubs" }]);
    expect(big2.hands[1]).toEqual([{ rank: "A", suit: "spades" }]);
  });

  it("requires winner when status=COMPLETED", () => {
    expect(() =>
      buildGameState({
        gameId: "test-game-4",
        status: "COMPLETED",
        scores: [{ playerId: "p1", score: 5 }],
      }),
    ).toThrow("winner is required");
  });

  it("requires scores when status=COMPLETED", () => {
    expect(() =>
      buildGameState({
        gameId: "test-game-5",
        status: "COMPLETED",
        winner: "p1",
      }),
    ).toThrow("scores is required");
  });

  it("produces deterministic hands with the same seed across calls", () => {
    const state1 = buildGameState({ gameId: "g1" });
    const state2 = buildGameState({ gameId: "g2" });
    const big21 = state1.gameSpecificState as Big2State;
    const big22 = state2.gameSpecificState as Big2State;
    // Both use the same fixed seed so hands must be identical
    expect(big21.hands).toEqual(big22.hands);
  });

  it("respects currentPlayerIndex override", () => {
    const state = buildGameState({ gameId: "g", currentPlayerIndex: 2 });
    expect(state.currentPlayerIndex).toBe(2);
  });

  it("respects turnNumber override", () => {
    const state = buildGameState({ gameId: "g", turnNumber: 42 });
    expect(state.turnNumber).toBe(42);
  });
});

describe("buildCompletedState", () => {
  it("produces a COMPLETED state with the given scores", () => {
    const players = [
      { playerId: "p1", displayName: "Alice" },
      { playerId: "p2", displayName: "Bob" },
    ];
    const scores = [
      { playerId: "p1", score: 5 },
      { playerId: "p2", score: 0 },
    ];
    const state = buildCompletedState({
      gameId: "completed-game",
      players,
      winner: "p1",
      scores,
    });
    expect(state.status).toBe("COMPLETED");
    expect(state.winner).toBe("p1");
    expect(state.scores).toEqual(scores);
    expect(state.currentPlayerIndex).toBe(-1);
    const big2 = state.gameSpecificState as Big2State;
    // All hands should be empty for completed state
    for (const hand of big2.hands) {
      expect(hand).toHaveLength(0);
    }
  });

  it("preserves all player info from input", () => {
    const players = [
      { playerId: "alice-id", displayName: "Alice" },
      { playerId: "bob-id", displayName: "Bob" },
      { playerId: "carol-id", displayName: "Carol" },
    ];
    const scores = [
      { playerId: "alice-id", score: 5 },
      { playerId: "bob-id", score: 3 },
      { playerId: "carol-id", score: 0 },
    ];
    const state = buildCompletedState({
      gameId: "g",
      players,
      winner: "alice-id",
      scores,
    });
    expect(state.players).toEqual(players);
    expect(state.scores).toEqual(scores);
  });
});
