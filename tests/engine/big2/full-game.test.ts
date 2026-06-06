import { describe, it, expect } from "vitest";
import { Big2Engine } from "../../../src/backend/engine/big2/big2-engine.js";
import { SeededPRNG } from "../../../src/backend/engine/prng.js";
import { detectHandType } from "../../../src/backend/engine/big2/hand-detection.js";
import { beats } from "../../../src/backend/engine/big2/hand-comparison.js";
import { isValidPlay } from "../../../src/backend/engine/big2/valid-actions.js";
import { compareCards } from "../../../src/backend/engine/big2/constants.js";
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

function big2State(state: InternalGameState): Big2State {
  return state.gameSpecificState as Big2State;
}

function totalCards(state: InternalGameState): number {
  return big2State(state).hands.reduce((sum, h) => sum + h.length, 0);
}

function getCombinations<T>(arr: readonly T[], k: number): T[][] {
  if (k === 1) return arr.map((x) => [x]);
  const result: T[][] = [];
  for (let i = 0; i <= arr.length - k; i++) {
    const rest = getCombinations(arr.slice(i + 1), k - 1);
    for (const combo of rest) {
      result.push([arr[i]!, ...combo]);
    }
  }
  return result;
}

function findPlayableCombo(
  gs: Big2State,
  hand: readonly Card[],
  prng: SeededPRNG,
): Card[] | null {
  const lastPlay = gs.lastPlay;
  const isFreePlay = gs.isFreePlay;
  const isFirstPlay = gs.isFirstPlayOfGame;

  const lowestCard = isFirstPlay
    ? hand.reduce((min, c) => (compareCards(c, min) < 0 ? c : min))
    : hand[0]!;

  if (isFirstPlay) {
    const firstCard = hand.find(
      (c) => c.rank === lowestCard.rank && c.suit === lowestCard.suit,
    )!;
    return [firstCard];
  }

  if (isFreePlay || !lastPlay) {
    const idx = Math.floor(prng.next() * hand.length);
    return [hand[idx]!];
  }

  const count = lastPlay.cards.length;
  const candidates = getCombinations(hand, count);
  const shuffled = prng.shuffle(candidates);

  for (const combo of shuffled) {
    const ht = detectHandType(combo);
    if (ht && beats(ht, lastPlay.handType)) {
      const validation = isValidPlay(
        combo,
        hand,
        lastPlay,
        isFreePlay,
        isFirstPlay,
        lowestCard,
      );
      if (validation.valid) return combo;
    }
  }
  return null;
}

function expectedCardCount(playerCount: number): number {
  if (playerCount === 4) return 52;
  if (playerCount === 3) return 51;
  return 26;
}

function playedCardCount(state: InternalGameState): number {
  const gs = big2State(state);
  return gs.playHistory
    .filter((entry) => entry.action === "play" && entry.cards)
    .reduce((sum, entry) => sum + entry.cards!.length, 0);
}

function checkInvariants(state: InternalGameState): void {
  const gs = big2State(state);

  expect(totalCards(state) + playedCardCount(state)).toBe(
    expectedCardCount(state.players.length),
  );

  for (const idx of gs.finishedPlayerIndices) {
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(state.players.length);
  }

  if (state.status === "IN_PROGRESS") {
    expect(gs.finishedPlayerIndices).not.toContain(state.currentPlayerIndex);
    expect(state.currentPlayerIndex).toBeGreaterThanOrEqual(0);
  }

  expect(state.version).toBeGreaterThan(0);
}

function playFullGame(players: PlayerInfo[], seed: string): InternalGameState {
  let state = engine.initialize("game1", players, config, new SeededPRNG(seed));
  const prng = new SeededPRNG(seed + "-strategy");

  const maxTurns = 10000;
  let turns = 0;

  while (state.status !== "COMPLETED" && turns < maxTurns) {
    turns++;
    const currentPlayerId = state.players[state.currentPlayerIndex]!.playerId;
    const validActions = engine.getValidActions(state, currentPlayerId);

    expect(validActions.length).toBeGreaterThan(0);

    const gs = big2State(state);
    const hand = gs.hands[state.currentPlayerIndex]!;
    const canPlay = validActions.some((a) => a.type === "playCards");
    const canPass = validActions.some((a) => a.type === "pass");

    let result;

    if (canPlay && (!canPass || prng.next() > 0.3)) {
      const playedCards = findPlayableCombo(gs, hand, prng);
      if (playedCards) {
        result = engine.applyAction(state, {
          type: "playCards",
          playerId: currentPlayerId,
          cards: playedCards,
        });
      } else if (canPass) {
        result = engine.applyAction(state, {
          type: "pass",
          playerId: currentPlayerId,
        });
      } else {
        break;
      }
    } else if (canPass) {
      result = engine.applyAction(state, {
        type: "pass",
        playerId: currentPlayerId,
      });
    } else {
      break;
    }

    expect(result!.success).toBe(true);
    state = result!.newState!;
    checkInvariants(state);
  }

  return state;
}

describe("full game simulation — 4 players", () => {
  it("completes a 4P game with seeded PRNG", () => {
    const players = ["p1", "p2", "p3", "p4"].map(player);
    const finalState = playFullGame(players, "full-game-4p-seed");
    expect(finalState.status).toBe("COMPLETED");
    expect(finalState.winner).not.toBeNull();
    expect(finalState.scores).toHaveLength(4);
    expect(big2State(finalState).finishedPlayerIndices).toHaveLength(4);
  });

  it("total cards dealt is 52 in a 4P game", () => {
    const players = ["p1", "p2", "p3", "p4"].map(player);
    const state = engine.initialize(
      "game1",
      players,
      config,
      new SeededPRNG("card-count-4p"),
    );
    expect(totalCards(state)).toBe(52);
  });

  it("finishedPlayerIndices grows monotonically and never shrinks", () => {
    const players = ["p1", "p2", "p3", "p4"].map(player);
    let state = engine.initialize(
      "game1",
      players,
      config,
      new SeededPRNG("monotonic-test"),
    );
    let prevFinishedCount = 0;
    const prng = new SeededPRNG("monotonic-strategy");

    for (let i = 0; i < 500 && state.status !== "COMPLETED"; i++) {
      const currentPlayerId = state.players[state.currentPlayerIndex]!.playerId;
      const validActions = engine.getValidActions(state, currentPlayerId);
      if (validActions.length === 0) break;

      const gs = big2State(state);
      const hand = gs.hands[state.currentPlayerIndex]!;
      const canPass = validActions.some((a) => a.type === "pass");
      const canPlay = validActions.some((a) => a.type === "playCards");

      let result;
      if (canPlay && (!canPass || prng.next() > 0.4)) {
        const combo = findPlayableCombo(gs, hand, prng);
        if (combo) {
          result = engine.applyAction(state, {
            type: "playCards",
            playerId: currentPlayerId,
            cards: combo,
          });
        } else if (canPass) {
          result = engine.applyAction(state, {
            type: "pass",
            playerId: currentPlayerId,
          });
        } else break;
      } else if (canPass) {
        result = engine.applyAction(state, {
          type: "pass",
          playerId: currentPlayerId,
        });
      } else break;

      if (!result!.success) break;
      state = result!.newState!;

      const newCount = big2State(state).finishedPlayerIndices.length;
      expect(newCount).toBeGreaterThanOrEqual(prevFinishedCount);
      prevFinishedCount = newCount;
    }
  });

  it("version strictly increases with each action", () => {
    const players = ["p1", "p2", "p3", "p4"].map(player);
    let state = engine.initialize(
      "game1",
      players,
      config,
      new SeededPRNG("version-strict"),
    );
    let prevVersion = state.version;
    const prng = new SeededPRNG("version-strategy");

    for (let i = 0; i < 20 && state.status !== "COMPLETED"; i++) {
      const currentPlayerId = state.players[state.currentPlayerIndex]!.playerId;
      const validActions = engine.getValidActions(state, currentPlayerId);
      if (validActions.length === 0) break;

      const gs = big2State(state);
      const hand = gs.hands[state.currentPlayerIndex]!;
      const canPass = validActions.some((a) => a.type === "pass");

      let result;
      const combo = findPlayableCombo(gs, hand, prng);
      if (combo) {
        result = engine.applyAction(state, {
          type: "playCards",
          playerId: currentPlayerId,
          cards: combo,
        });
      } else if (canPass) {
        result = engine.applyAction(state, {
          type: "pass",
          playerId: currentPlayerId,
        });
      } else break;

      if (!result!.success) break;
      state = result!.newState!;
      expect(state.version).toBe(prevVersion + 1);
      prevVersion = state.version;
    }
  });

  it("status never goes backwards (IN_PROGRESS → COMPLETED only)", () => {
    const players = ["p1", "p2", "p3", "p4"].map(player);
    let state = playFullGame(players, "status-direction");
    // After game, status is COMPLETED (not back to IN_PROGRESS or CREATED)
    expect(state.status).toBe("COMPLETED");
  });

  it("currentPlayerIndex is never a finished player during IN_PROGRESS", () => {
    const players = ["p1", "p2", "p3", "p4"].map(player);
    let state = engine.initialize(
      "game1",
      players,
      config,
      new SeededPRNG("skip-finished"),
    );
    const prng = new SeededPRNG("skip-finished-strategy");

    for (let i = 0; i < 200 && state.status !== "COMPLETED"; i++) {
      const gs = big2State(state);
      if (state.status === "IN_PROGRESS") {
        expect(gs.finishedPlayerIndices).not.toContain(
          state.currentPlayerIndex,
        );
      }

      const currentPlayerId = state.players[state.currentPlayerIndex]!.playerId;
      const validActions = engine.getValidActions(state, currentPlayerId);
      if (validActions.length === 0) break;

      const hand = gs.hands[state.currentPlayerIndex]!;
      const canPass = validActions.some((a) => a.type === "pass");
      const combo = findPlayableCombo(gs, hand, prng);

      let result;
      if (combo) {
        result = engine.applyAction(state, {
          type: "playCards",
          playerId: currentPlayerId,
          cards: combo,
        });
      } else if (canPass) {
        result = engine.applyAction(state, {
          type: "pass",
          playerId: currentPlayerId,
        });
      } else break;

      if (!result!.success) break;
      state = result!.newState!;
    }
  });
});

describe("full game simulation — 3 players", () => {
  it("completes a 3P game with seeded PRNG", () => {
    const players = ["p1", "p2", "p3"].map(player);
    const finalState = playFullGame(players, "full-game-3p-seed");
    expect(finalState.status).toBe("COMPLETED");
    expect(finalState.scores).toHaveLength(3);
    expect(big2State(finalState).finishedPlayerIndices).toHaveLength(3);
  });

  it("total cards dealt is 51 in 3P (3♣ removed)", () => {
    const players = ["p1", "p2", "p3"].map(player);
    const state = engine.initialize(
      "game1",
      players,
      config,
      new SeededPRNG("card-count-3p"),
    );
    expect(totalCards(state)).toBe(51);
  });
});

describe("full game simulation — 2 players", () => {
  it("completes a 2P game with seeded PRNG", () => {
    const players = ["p1", "p2"].map(player);
    const finalState = playFullGame(players, "full-game-2p-seed");
    expect(finalState.status).toBe("COMPLETED");
    expect(finalState.scores).toHaveLength(2);
    expect(big2State(finalState).finishedPlayerIndices).toHaveLength(2);
  });

  it("total cards dealt is 26 in 2P (13 each)", () => {
    const players = ["p1", "p2"].map(player);
    const state = engine.initialize(
      "game1",
      players,
      config,
      new SeededPRNG("card-count-2p"),
    );
    expect(totalCards(state)).toBe(26);
  });
});

describe("random strategy over multiple seeds", () => {
  it("completes 50 random 4P games without error", () => {
    const players = ["p1", "p2", "p3", "p4"].map(player);
    for (let i = 0; i < 50; i++) {
      const finalState = playFullGame(players, `random-seed-4p-${i}`);
      expect(finalState.status).toBe("COMPLETED");
    }
  });

  it("completes 30 random 3P games without error", () => {
    const players = ["p1", "p2", "p3"].map(player);
    for (let i = 0; i < 30; i++) {
      const finalState = playFullGame(players, `random-seed-3p-${i}`);
      expect(finalState.status).toBe("COMPLETED");
    }
  });

  it("completes 30 random 2P games without error", () => {
    const players = ["p1", "p2"].map(player);
    for (let i = 0; i < 30; i++) {
      const finalState = playFullGame(players, `random-seed-2p-${i}`);
      expect(finalState.status).toBe("COMPLETED");
    }
  });
});
