import { describe, it, expect } from "vitest";
import { TonkEngine } from "../../../src/backend/engine/tonk/tonk-engine.js";
import { card, makeTonkState } from "./helpers.js";

const engine = new TonkEngine();

const hands = [
  [card("5", "clubs"), card("9", "hearts")],
  [card("4", "clubs")],
  [card("3", "clubs")],
];

describe("invalid actions — rejected, state unchanged, version not incremented", () => {
  it("action when not your turn", () => {
    const state = makeTonkState({
      hands,
      stock: [card("K", "spades")],
      turnPhase: "discard",
      currentPlayerIndex: 0,
    });
    const res = engine.applyAction(state, {
      type: "discard",
      playerId: "p2",
      cards: [card("4", "clubs")],
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("Not your turn.");
    expect(res.newState).toBeNull();
  });

  it("action after COMPLETED", () => {
    const state = {
      ...makeTonkState({ hands, currentPlayerIndex: -1 }),
      status: "COMPLETED" as const,
    };
    const res = engine.applyAction(state, {
      type: "discard",
      playerId: "p1",
      cards: [card("5", "clubs")],
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("Game is already over.");
  });

  it("not-in-hand discard", () => {
    const state = makeTonkState({
      hands,
      stock: [card("K", "spades")],
      turnPhase: "discard",
      currentPlayerIndex: 0,
    });
    const res = engine.applyAction(state, {
      type: "discard",
      playerId: "p1",
      cards: [card("Q", "diamonds")],
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("Cards not in hand");
  });

  it("mixed-rank discard", () => {
    const state = makeTonkState({
      hands,
      stock: [card("K", "spades")],
      turnPhase: "discard",
      currentPlayerIndex: 0,
    });
    const res = engine.applyAction(state, {
      type: "discard",
      playerId: "p1",
      cards: [card("5", "clubs"), card("9", "hearts")],
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("Discard must be a single rank");
  });

  it("empty discard payload", () => {
    const state = makeTonkState({
      hands,
      stock: [card("K", "spades")],
      turnPhase: "discard",
      currentPlayerIndex: 0,
    });
    const res = engine.applyAction(state, {
      type: "discard",
      playerId: "p1",
      cards: [],
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("Must discard at least one card");
  });

  it("draw with out-of-band source", () => {
    const state = makeTonkState({
      hands,
      stock: [card("K", "spades")],
      turnPhase: "draw",
      currentPlayerIndex: 0,
    });
    const res = engine.applyAction(state, {
      type: "draw",
      playerId: "p1",
      source: "bank" as never,
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("Invalid draw source");
  });

  it("draw from discard when no snapshot", () => {
    const state = makeTonkState({
      hands,
      stock: [card("K", "spades")],
      drawableDiscard: null,
      turnPhase: "draw",
      currentPlayerIndex: 0,
    });
    const res = engine.applyAction(state, {
      type: "draw",
      playerId: "p1",
      source: "discard",
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("No card available to draw from discard");
  });

  it("TONK before gate", () => {
    const state = makeTonkState({
      hands,
      turnPhase: "discard",
      trickTurnCount: 0,
      currentPlayerIndex: 0,
    });
    const res = engine.applyAction(state, { type: "callTonk", playerId: "p1" });
    expect(res.success).toBe(false);
  });

  it("rejected actions leave original state and version untouched", () => {
    const state = makeTonkState({
      hands,
      stock: [card("K", "spades")],
      turnPhase: "discard",
      currentPlayerIndex: 0,
      version: 7,
    });
    const before = JSON.stringify(state);
    const res = engine.applyAction(state, {
      type: "discard",
      playerId: "p1",
      cards: [card("Q", "diamonds")],
    });
    expect(res.success).toBe(false);
    expect(JSON.stringify(state)).toBe(before); // not mutated
    expect(state.version).toBe(7); // unchanged
  });

  it("validateAction mirrors applyAction success", () => {
    const state = makeTonkState({
      hands,
      stock: [card("K", "spades")],
      turnPhase: "discard",
      currentPlayerIndex: 0,
    });
    expect(
      engine.validateAction(state, {
        type: "discard",
        playerId: "p1",
        cards: [card("5", "clubs")],
      }),
    ).toBe(true);
    expect(
      engine.validateAction(state, {
        type: "discard",
        playerId: "p1",
        cards: [card("Q", "diamonds")],
      }),
    ).toBe(false);
  });
});
