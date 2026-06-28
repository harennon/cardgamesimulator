import { describe, it, expect } from "vitest";
import { TonkEngine } from "../../../src/backend/engine/tonk/tonk-engine.js";
import { card, joker, makeTonkState } from "./helpers.js";
import type { TonkDiscardAction } from "../../../src/backend/engine/tonk/tonk-types.js";

const engine = new TonkEngine();

describe("getAutoTimeoutAction — discard phase", () => {
  it("returns single highest-value card (never multiples, never TONK)", () => {
    const state = makeTonkState({
      hands: [
        [card("3", "clubs"), card("K", "hearts"), card("9", "spades")],
        [card("4", "clubs")],
        [card("5", "clubs")],
      ],
      turnPhase: "discard",
      trickTurnCount: 3, // gate open — still must NOT call TONK
      currentPlayerIndex: 0,
    });
    const action = engine.getAutoTimeoutAction(state) as TonkDiscardAction;
    expect(action.type).toBe("discard");
    expect(action.cards).toHaveLength(1);
    expect(action.cards[0]).toEqual(card("K", "hearts"));
  });

  it("deterministic stable tie-break among equal-value cards", () => {
    // Two value-10 cards (K and Q). Stable order: rank K after Q, suit order.
    const state = makeTonkState({
      hands: [
        [card("K", "hearts"), card("K", "clubs"), card("3", "spades")],
        [card("4", "clubs")],
        [card("5", "clubs")],
      ],
      turnPhase: "discard",
      trickTurnCount: 0,
      currentPlayerIndex: 0,
    });
    const a = engine.getAutoTimeoutAction(state) as TonkDiscardAction;
    const b = engine.getAutoTimeoutAction(state) as TonkDiscardAction;
    expect(a.cards[0]).toEqual(b.cards[0]); // reproducible
    // Highest value 10; tie-break picks K♣ (clubs before hearts).
    expect(a.cards[0]).toEqual(card("K", "clubs"));
  });

  it("auto-discard is a valid action that applyAction accepts", () => {
    const state = makeTonkState({
      hands: [
        [card("3", "clubs"), card("K", "hearts"), joker(0)],
        [card("4", "clubs")],
        [card("5", "clubs")],
      ],
      stock: [card("7", "diamonds")],
      turnPhase: "discard",
      trickTurnCount: 0,
      currentPlayerIndex: 0,
    });
    const action = engine.getAutoTimeoutAction(state)!;
    expect(engine.validateAction(state, action)).toBe(true);
  });
});

describe("getAutoTimeoutAction — draw phase", () => {
  it("returns draw from stock", () => {
    const state = makeTonkState({
      hands: [[card("3", "clubs")], [card("4", "clubs")], [card("5", "clubs")]],
      stock: [card("7", "diamonds")],
      drawableDiscard: card("9", "hearts"),
      discardPile: [card("9", "hearts")],
      turnPhase: "draw",
      currentPlayerIndex: 0,
    });
    const action = engine.getAutoTimeoutAction(state)!;
    expect(action.type).toBe("draw");
    expect((action as { source: string }).source).toBe("stock");
  });

  it("draw-phase timeout on empty stock resolves the trick (Case C)", () => {
    const state = makeTonkState({
      hands: [
        [card("K", "clubs")],
        [card("3", "hearts")],
        [card("9", "clubs")],
      ],
      stock: [],
      discardPile: [card("2", "spades")],
      turnPhase: "draw",
      trickTurnCount: 5,
      currentPlayerIndex: 0,
    });
    const action = engine.getAutoTimeoutAction(state)!;
    const res = engine.applyAction(state, action);
    expect(res.success).toBe(true);
    // Trick ended via Case C.
    expect(res.newState!.gameSpecificState).toBeDefined();
  });
});

describe("getAutoTimeoutAction — null cases", () => {
  it("returns null when COMPLETED", () => {
    const state = {
      ...makeTonkState({
        hands: [
          [card("3", "clubs")],
          [card("4", "clubs")],
          [card("5", "clubs")],
        ],
        currentPlayerIndex: -1,
      }),
      status: "COMPLETED" as const,
    };
    expect(engine.getAutoTimeoutAction(state)).toBeNull();
  });

  it("returns null when currentPlayerIndex < 0", () => {
    const state = makeTonkState({
      hands: [[card("3", "clubs")], [card("4", "clubs")], [card("5", "clubs")]],
      currentPlayerIndex: -1,
    });
    expect(engine.getAutoTimeoutAction(state)).toBeNull();
  });
});
