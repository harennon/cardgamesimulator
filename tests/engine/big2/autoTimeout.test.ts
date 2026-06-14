import { describe, it, expect } from "vitest";
import { Big2Engine } from "../../../src/backend/engine/big2/big2-engine.js";
import { SeededPRNG } from "../../../src/backend/engine/prng.js";
import type {
  InternalGameState,
  PlayerInfo,
  Card,
} from "../../../src/shared/engine-types.js";
import type { Big2State } from "../../../src/backend/engine/big2/big2-types.js";

const engine = new Big2Engine();
const config = { maxPlayers: 4, minPlayers: 2, options: {} };

function player(id: string): PlayerInfo {
  return { playerId: id, displayName: id };
}

function card(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}

function initGame(
  players: PlayerInfo[],
  seed = "auto-timeout-seed",
): InternalGameState {
  return engine.initialize("game-1", players, config, new SeededPRNG(seed));
}

function big2State(state: InternalGameState): Big2State {
  return state.gameSpecificState as Big2State;
}

function currentPlayerId(state: InternalGameState): string {
  return state.players[state.currentPlayerIndex]!.playerId;
}

/** Build a state where passing is legal (not first play, not free play). */
function stateAfterOnePlay(): InternalGameState {
  const state = initGame(["p1", "p2", "p3", "p4"].map(player));
  const gs = big2State(state);
  const startingIndex = state.currentPlayerIndex;
  const lowestCard = gs.hands[startingIndex]!.reduce((a, b) =>
    compareSingle(a, b) < 0 ? a : b,
  );
  const result = engine.applyAction(state, {
    type: "playCards",
    playerId: currentPlayerId(state),
    cards: [lowestCard],
  });
  return result.newState!;
}

function compareSingle(a: Card, b: Card): number {
  const rankOrder = [
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
  const suitOrder = ["clubs", "diamonds", "hearts", "spades"];
  const rankDiff = rankOrder.indexOf(a.rank) - rankOrder.indexOf(b.rank);
  if (rankDiff !== 0) return rankDiff;
  return suitOrder.indexOf(a.suit) - suitOrder.indexOf(b.suit);
}

describe("getAutoTimeoutAction", () => {
  describe("pass scenario", () => {
    it("returns pass action when lastPlay exists and not free play", () => {
      const state = stateAfterOnePlay();
      // After the first play, the next player can pass
      const gs = big2State(state);
      expect(gs.isFirstPlayOfGame).toBe(false);
      expect(gs.isFreePlay).toBe(false);

      const action = engine.getAutoTimeoutAction(state);

      expect(action).not.toBeNull();
      expect(action!.type).toBe("pass");
      expect(action!.playerId).toBe(currentPlayerId(state));
    });

    it("the pass action is accepted by validateAction", () => {
      const state = stateAfterOnePlay();
      const action = engine.getAutoTimeoutAction(state);

      expect(action).not.toBeNull();
      expect(engine.validateAction(state, action!)).toBe(true);
    });
  });

  describe("play lowest card scenario", () => {
    it("returns playCards with lowest card on first play of game", () => {
      const state = initGame(["p1", "p2", "p3", "p4"].map(player));
      const gs = big2State(state);
      expect(gs.isFirstPlayOfGame).toBe(true);

      const action = engine.getAutoTimeoutAction(state);

      expect(action).not.toBeNull();
      expect(action!.type).toBe("playCards");
      // The returned action must include cards (cast for inspection)
      const playAction = action as {
        type: string;
        playerId: string;
        cards: Card[];
      };
      expect(playAction.cards).toHaveLength(1);
    });

    it("the first-play auto action is accepted by validateAction", () => {
      const state = initGame(["p1", "p2", "p3", "p4"].map(player));
      const action = engine.getAutoTimeoutAction(state);

      expect(action).not.toBeNull();
      expect(engine.validateAction(state, action!)).toBe(true);
    });

    it("returns playCards with lowest card on free play", () => {
      // Create a free play state: all players have passed back to the trick winner
      let state = initGame(["p1", "p2", "p3", "p4"].map(player));
      const starterId = currentPlayerId(state);
      const gs = big2State(state);
      const lowestCard = gs.hands[state.currentPlayerIndex]!.reduce((a, b) =>
        compareSingle(a, b) < 0 ? a : b,
      );

      // Player 1 plays the lowest card
      const playResult = engine.applyAction(state, {
        type: "playCards",
        playerId: starterId,
        cards: [lowestCard],
      });
      state = playResult.newState!;

      // The remaining 3 active players all pass to give free play back to starter
      for (let i = 0; i < 3; i++) {
        const passResult = engine.applyAction(state, {
          type: "pass",
          playerId: currentPlayerId(state),
        });
        state = passResult.newState!;
      }

      const gsAfter = big2State(state);
      expect(gsAfter.isFreePlay).toBe(true);
      expect(gsAfter.isFirstPlayOfGame).toBe(false);

      const action = engine.getAutoTimeoutAction(state);

      expect(action).not.toBeNull();
      expect(action!.type).toBe("playCards");
    });

    it("the free play auto action is accepted by validateAction", () => {
      let state = initGame(["p1", "p2", "p3", "p4"].map(player));
      const gs = big2State(state);
      const lowestCard = gs.hands[state.currentPlayerIndex]!.reduce((a, b) =>
        compareSingle(a, b) < 0 ? a : b,
      );

      state = engine.applyAction(state, {
        type: "playCards",
        playerId: currentPlayerId(state),
        cards: [lowestCard],
      }).newState!;

      for (let i = 0; i < 3; i++) {
        state = engine.applyAction(state, {
          type: "pass",
          playerId: currentPlayerId(state),
        }).newState!;
      }

      const action = engine.getAutoTimeoutAction(state);
      expect(action).not.toBeNull();
      expect(engine.validateAction(state, action!)).toBe(true);
    });
  });

  describe("null return cases", () => {
    it("returns null when game is COMPLETED", () => {
      const state: InternalGameState = {
        ...initGame(["p1", "p2"].map(player)),
        status: "COMPLETED",
        currentPlayerIndex: -1,
      };

      expect(engine.getAutoTimeoutAction(state)).toBeNull();
    });

    it("returns null when game is CREATED (not started)", () => {
      const state: InternalGameState = {
        ...initGame(["p1", "p2"].map(player)),
        status: "CREATED",
      };

      expect(engine.getAutoTimeoutAction(state)).toBeNull();
    });

    it("returns null when currentPlayerIndex is -1", () => {
      const state: InternalGameState = {
        ...initGame(["p1", "p2"].map(player)),
        status: "IN_PROGRESS",
        currentPlayerIndex: -1,
      };

      expect(engine.getAutoTimeoutAction(state)).toBeNull();
    });
  });

  describe("action validity invariant", () => {
    it("auto action can be applied without error for a 2-player game first play", () => {
      const state = initGame(["p1", "p2"].map(player));
      const action = engine.getAutoTimeoutAction(state);

      expect(action).not.toBeNull();
      const result = engine.applyAction(state, action!);
      expect(result.success).toBe(true);
    });

    it("auto action can be applied without error for a 3-player game first play", () => {
      const state = engine.initialize(
        "game-1",
        ["p1", "p2", "p3"].map(player),
        config,
        new SeededPRNG("3p-seed"),
      );
      const action = engine.getAutoTimeoutAction(state);

      expect(action).not.toBeNull();
      const result = engine.applyAction(state, action!);
      expect(result.success).toBe(true);
    });
  });
});
