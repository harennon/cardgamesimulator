import { describe, it, expect } from "vitest";
import { TonkEngine } from "../../../src/backend/engine/tonk/tonk-engine.js";
import { buildTonkState, c, j } from "./helpers.js";
import type {
  TonkDiscardAction,
  TonkDrawAction,
} from "../../../src/backend/engine/tonk/tonk-types.js";

const engine = new TonkEngine();

describe("getAutoTimeoutAction — discard phase", () => {
  it("discards the single highest-value card (one card, never multiples)", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [c("3", "clubs"), c("K", "hearts"), c("5", "spades")],
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
      },
    });
    const action = engine.getAutoTimeoutAction(state) as TonkDiscardAction;
    expect(action.type).toBe("discard");
    expect(action.cards.length).toBe(1);
    expect(action.cards[0]).toEqual(c("K", "hearts"));
  });

  it("never returns callTonk even when gate is open", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [c("3", "clubs"), c("K", "hearts")],
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 5,
      },
    });
    const action = engine.getAutoTimeoutAction(state)!;
    expect(action.type).toBe("discard");
  });

  it("deterministic tie-break: same value -> reproducible choice from state alone", () => {
    const make = () =>
      buildTonkState({
        playerCount: 3,
        currentPlayerIndex: 0,
        tonk: {
          hands: [
            [c("K", "hearts"), c("Q", "spades"), c("J", "clubs")], // all value 10
            [c("6", "clubs")],
            [c("7", "clubs")],
          ],
          stock: [c("8", "clubs")],
          turnPhase: "discard",
        },
      });
    const a = engine.getAutoTimeoutAction(make()) as TonkDiscardAction;
    const b = engine.getAutoTimeoutAction(make()) as TonkDiscardAction;
    expect(a.cards[0]).toEqual(b.cards[0]);
    // Tie-break picks the lowest in the stable order among value-10 cards: J clubs.
    expect(a.cards[0]).toEqual(c("J", "clubs"));
  });

  it("ignores jokers (value 0) as the highest when other cards exist", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[j(0), c("4", "clubs")], [c("6", "clubs")], [c("7", "clubs")]],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
      },
    });
    const action = engine.getAutoTimeoutAction(state) as TonkDiscardAction;
    expect(action.cards[0]).toEqual(c("4", "clubs"));
  });
});

describe("getAutoTimeoutAction — draw phase", () => {
  it("returns draw from stock", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("5", "clubs")], [c("6", "clubs")], [c("7", "clubs")]],
        stock: [c("8", "clubs")],
        turnPhase: "draw",
      },
    });
    const action = engine.getAutoTimeoutAction(state) as TonkDrawAction;
    expect(action.type).toBe("draw");
    expect(action.source).toBe("stock");
  });

  it("empty stock at draw -> returns stock-draw which ends the trick when applied", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("3", "clubs")], [c("9", "hearts")], [c("K", "spades")]],
        stock: [],
        discardPile: [c("4", "clubs")],
        turnPhase: "draw",
        trickTurnCount: 3,
      },
    });
    const action = engine.getAutoTimeoutAction(state) as TonkDrawAction;
    expect(action.source).toBe("stock");
    const res = engine.applyAction(state, action);
    expect(res.success).toBe(true);
    expect(res.newState!.status).toBe("IN_PROGRESS"); // new trick (no >=150)
  });
});

describe("getAutoTimeoutAction — null cases", () => {
  it("null when not IN_PROGRESS", () => {
    const state = buildTonkState({
      playerCount: 3,
      status: "COMPLETED",
      currentPlayerIndex: -1,
      tonk: { hands: [[], [], []], stock: [] },
    });
    expect(engine.getAutoTimeoutAction(state)).toBeNull();
  });

  it("null when currentPlayerIndex < 0", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: -1,
      tonk: {
        hands: [[c("5", "clubs")], [c("6", "clubs")], [c("7", "clubs")]],
        stock: [c("8", "clubs")],
      },
    });
    expect(engine.getAutoTimeoutAction(state)).toBeNull();
  });
});
