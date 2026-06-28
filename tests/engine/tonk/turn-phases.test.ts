import { describe, it, expect } from "vitest";
import { TonkEngine } from "../../../src/backend/engine/tonk/tonk-engine.js";
import type { TonkState } from "../../../src/backend/engine/tonk/tonk-types.js";
import { buildTonkState, c, j, tonk } from "./helpers.js";

const engine = new TonkEngine();

describe("validActions by phase and TONK gate", () => {
  it("discard phase, gate closed -> only discard", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("5", "clubs")], [c("6", "clubs")], [c("7", "clubs")]],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 0,
      },
    });
    const actions = engine.getValidActions(state, "p1");
    expect(actions.map((a) => a.type)).toEqual(["discard"]);
  });

  it("discard phase, gate open -> discard + callTonk", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("5", "clubs")], [c("6", "clubs")], [c("7", "clubs")]],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 3,
      },
    });
    const actions = engine.getValidActions(state, "p1");
    expect(actions.map((a) => a.type).sort()).toEqual(["callTonk", "discard"]);
  });

  it("draw phase -> only draw", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("5", "clubs")], [c("6", "clubs")], [c("7", "clubs")]],
        stock: [c("8", "clubs")],
        turnPhase: "draw",
        trickTurnCount: 3,
      },
    });
    const actions = engine.getValidActions(state, "p1");
    expect(actions.map((a) => a.type)).toEqual(["draw"]);
  });

  it("empty for non-current player", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("5", "clubs")], [c("6", "clubs")], [c("7", "clubs")]],
        stock: [c("8", "clubs")],
      },
    });
    expect(engine.getValidActions(state, "p2")).toEqual([]);
  });
});

describe("discard action", () => {
  it("single card OK -> moves to pile, phase -> draw, same player, turnNumber+1", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      turnNumber: 5,
      tonk: {
        hands: [
          [c("5", "clubs"), c("9", "hearts")],
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
      },
    });
    const res = engine.applyAction(state, {
      type: "discard",
      playerId: "p1",
      cards: [c("5", "clubs")],
    });
    expect(res.success).toBe(true);
    const ts = tonk(res.newState!);
    expect(ts.turnPhase).toBe("draw");
    expect(res.newState!.currentPlayerIndex).toBe(0);
    expect(res.newState!.turnNumber).toBe(6);
    expect(res.newState!.version).toBe(state.version + 1);
    expect(ts.hands[0]).toEqual([c("9", "hearts")]);
    expect(ts.discardPile[ts.discardPile.length - 1]).toEqual(c("5", "clubs"));
    expect(ts.lastDiscardCount).toBe(1);
    expect(ts.lastDiscardPlayerIndex).toBe(0);
  });

  it("multiples of same rank OK", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [c("Q", "clubs"), c("Q", "hearts"), c("Q", "spades")],
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
      },
    });
    const res = engine.applyAction(state, {
      type: "discard",
      playerId: "p1",
      cards: [c("Q", "clubs"), c("Q", "hearts"), c("Q", "spades")],
    });
    expect(res.success).toBe(true);
    const ts = tonk(res.newState!);
    expect(ts.hands[0]).toEqual([]);
    expect(ts.lastDiscardCount).toBe(3);
  });

  it("jokers group only with jokers", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[j(0), j(1)], [c("6", "clubs")], [c("7", "clubs")]],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
      },
    });
    const res = engine.applyAction(state, {
      type: "discard",
      playerId: "p1",
      cards: [j(0), j(1)],
    });
    expect(res.success).toBe(true);
  });

  it("mixed ranks rejected", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [c("5", "clubs"), c("6", "hearts")],
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
      },
    });
    const res = engine.applyAction(state, {
      type: "discard",
      playerId: "p1",
      cards: [c("5", "clubs"), c("6", "hearts")],
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("Discard must be a single rank.");
  });

  it("not-in-hand rejected", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("5", "clubs")], [c("6", "clubs")], [c("7", "clubs")]],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
      },
    });
    const res = engine.applyAction(state, {
      type: "discard",
      playerId: "p1",
      cards: [c("K", "spades")],
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("Cards not in hand.");
  });

  it("empty payload rejected", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("5", "clubs")], [c("6", "clubs")], [c("7", "clubs")]],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
      },
    });
    const res = engine.applyAction(state, {
      type: "discard",
      playerId: "p1",
      cards: [],
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("Must discard at least one card.");
  });
});

describe("draw action and turn hand-off", () => {
  function afterDiscard(): TonkState {
    return {
      hands: [[c("9", "hearts")], [c("6", "clubs")], [c("7", "clubs")]],
      stock: [c("8", "clubs"), c("K", "diamonds")],
      discardPile: [c("5", "clubs")],
      drawableDiscard: null,
      lastDiscardCount: 1,
      lastDiscardPlayerIndex: 0,
      turnPhase: "draw",
      trickNumber: 1,
      trickTurnCount: 0,
      tallies: [0, 0, 0],
      tonkCallerIndex: null,
      lostPlayerIndices: [],
      trueLoserIndex: null,
      trickDeckSize: 6,
      log: [],
    };
  }

  it("draw from stock OK; hands off to next seat; trickTurnCount+1; phase -> discard", () => {
    const ts = afterDiscard();
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      turnNumber: 2,
      tonk: ts,
    });
    const res = engine.applyAction(state, {
      type: "draw",
      playerId: "p1",
      source: "stock",
    });
    expect(res.success).toBe(true);
    const out = tonk(res.newState!);
    expect(res.newState!.currentPlayerIndex).toBe(1);
    expect(out.turnPhase).toBe("discard");
    expect(out.trickTurnCount).toBe(1);
    expect(res.newState!.turnNumber).toBe(3);
    // p1 drew the stock top.
    expect(out.hands[0]!.length).toBe(2);
    expect(out.stock.length).toBe(1);
    // drawable snapshot for p2 = p1's single top discard.
    expect(out.drawableDiscard).toEqual(c("5", "clubs"));
  });

  it("full turn (discard + draw) advances turnNumber by 2", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      turnNumber: 1,
      tonk: {
        hands: [
          [c("5", "clubs"), c("9", "hearts")],
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs"), c("K", "diamonds")],
        turnPhase: "discard",
      },
    });
    const r1 = engine.applyAction(state, {
      type: "discard",
      playerId: "p1",
      cards: [c("5", "clubs")],
    });
    const r2 = engine.applyAction(r1.newState!, {
      type: "draw",
      playerId: "p1",
      source: "stock",
    });
    expect(r2.newState!.turnNumber).toBe(3);
  });
});
