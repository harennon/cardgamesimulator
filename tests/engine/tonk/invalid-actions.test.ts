import { describe, it, expect } from "vitest";
import { TonkEngine } from "../../../src/backend/engine/tonk/tonk-engine.js";
import { buildTonkState, c } from "./helpers.js";
import type { InternalGameState } from "../../../src/shared/engine-types.js";

const engine = new TonkEngine();

function baseDiscardState(): InternalGameState {
  return buildTonkState({
    playerCount: 3,
    currentPlayerIndex: 0,
    version: 7,
    tonk: {
      hands: [[c("5", "clubs")], [c("6", "clubs")], [c("7", "clubs")]],
      stock: [c("8", "clubs")],
      turnPhase: "discard",
      trickTurnCount: 0,
    },
  });
}

function expectUnchanged(
  before: InternalGameState,
  result: { success: boolean; newState: InternalGameState | null },
) {
  expect(result.success).toBe(false);
  expect(result.newState).toBeNull();
  // state object is immutable; version on `before` is unchanged.
  expect(before.version).toBe(7);
}

describe("invalid actions — rejected, state unchanged, version not incremented", () => {
  it("action by non-current player -> Not your turn", () => {
    const state = baseDiscardState();
    const res = engine.applyAction(state, {
      type: "discard",
      playerId: "p2",
      cards: [c("6", "clubs")],
    });
    expect(res.error).toBe("Not your turn.");
    expectUnchanged(state, res);
  });

  it("draw while in discard phase -> Cannot draw before discarding", () => {
    const state = baseDiscardState();
    const res = engine.applyAction(state, {
      type: "draw",
      playerId: "p1",
      source: "stock",
    });
    expect(res.error).toBe("Cannot draw before discarding.");
    expectUnchanged(state, res);
  });

  it("discard while in draw phase -> Must draw, not discard", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      version: 7,
      tonk: {
        hands: [[c("5", "clubs")], [c("6", "clubs")], [c("7", "clubs")]],
        stock: [c("8", "clubs")],
        turnPhase: "draw",
      },
    });
    const res = engine.applyAction(state, {
      type: "discard",
      playerId: "p1",
      cards: [c("5", "clubs")],
    });
    expect(res.error).toBe("Must draw, not discard, this phase.");
    expectUnchanged(state, res);
  });

  it("draw from discard when snapshot null -> No card available", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      version: 7,
      tonk: {
        hands: [[c("5", "clubs")], [c("6", "clubs")], [c("7", "clubs")]],
        stock: [c("8", "clubs")],
        discardPile: [c("9", "clubs")],
        drawableDiscard: null,
        lastDiscardCount: 1,
        turnPhase: "draw",
      },
    });
    const res = engine.applyAction(state, {
      type: "draw",
      playerId: "p1",
      source: "discard",
    });
    expect(res.error).toBe("No card available to draw from the discard.");
    expectUnchanged(state, res);
  });

  it("draw with arbitrary source -> Invalid draw source", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      version: 7,
      tonk: {
        hands: [[c("5", "clubs")], [c("6", "clubs")], [c("7", "clubs")]],
        stock: [c("8", "clubs")],
        turnPhase: "draw",
      },
    });
    const res = engine.applyAction(state, {
      type: "draw",
      playerId: "p1",
      source: "magic" as unknown as "stock",
    });
    expect(res.error).toBe("Invalid draw source.");
    expectUnchanged(state, res);
  });

  it("action after COMPLETED -> Game is already over", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: -1,
      status: "COMPLETED",
      version: 7,
      tonk: {
        hands: [[], [], []],
        stock: [],
      },
    });
    const res = engine.applyAction(state, {
      type: "discard",
      playerId: "p1",
      cards: [c("5", "clubs")],
    });
    expect(res.error).toBe("Game is already over.");
    expect(res.newState).toBeNull();
  });

  it("unknown action type -> Unknown action type", () => {
    const state = baseDiscardState();
    const res = engine.applyAction(state, {
      type: "teleport",
      playerId: "p1",
    } as unknown as { type: string; playerId: string });
    expect(res.error).toBe("Unknown action type.");
    expectUnchanged(state, res);
  });

  it("validateAction mirrors applyAction success", () => {
    const state = baseDiscardState();
    expect(
      engine.validateAction(state, {
        type: "discard",
        playerId: "p1",
        cards: [c("5", "clubs")],
      }),
    ).toBe(true);
    expect(
      engine.validateAction(state, {
        type: "draw",
        playerId: "p1",
        source: "stock",
      }),
    ).toBe(false);
  });
});
