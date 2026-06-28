import { describe, it, expect } from "vitest";
import { TonkEngine } from "../../../src/backend/engine/tonk/tonk-engine.js";
import {
  validateDiscard,
  validateDrawSource,
} from "../../../src/backend/engine/tonk/valid-actions.js";
import { card, joker, makeTonkState, tonkOf } from "./helpers.js";
import type { TonkCard } from "../../../src/shared/tonk-types.js";

const engine = new TonkEngine();

describe("getValidActions — by phase and TONK gate (§6.2)", () => {
  it("discard phase, gate closed → [discard]", () => {
    const state = makeTonkState({
      hands: [[card("3", "clubs")], [card("4", "clubs")], [card("5", "clubs")]],
      turnPhase: "discard",
      trickTurnCount: 0,
      currentPlayerIndex: 0,
    });
    const actions = engine.getValidActions(state, "p1");
    expect(actions.map((a) => a.type)).toEqual(["discard"]);
  });

  it("discard phase, gate open → [discard, callTonk]", () => {
    const state = makeTonkState({
      hands: [[card("3", "clubs")], [card("4", "clubs")], [card("5", "clubs")]],
      turnPhase: "discard",
      trickTurnCount: 3,
      currentPlayerIndex: 0,
    });
    const actions = engine.getValidActions(state, "p1");
    expect(actions.map((a) => a.type).sort()).toEqual(["callTonk", "discard"]);
  });

  it("draw phase with snapshot → [draw(stock), draw(discard)]", () => {
    const state = makeTonkState({
      hands: [[card("3", "clubs")], [card("4", "clubs")], [card("5", "clubs")]],
      stock: [card("6", "clubs")],
      discardPile: [card("9", "hearts")],
      drawableDiscard: card("9", "hearts"),
      turnPhase: "draw",
      currentPlayerIndex: 0,
    });
    const actions = engine.getValidActions(state, "p1");
    expect(actions).toHaveLength(2);
    expect(actions.map((a) => a.description).sort()).toEqual([
      "discard",
      "stock",
    ]);
  });

  it("draw phase without snapshot → [draw(stock)] only", () => {
    const state = makeTonkState({
      hands: [[card("3", "clubs")], [card("4", "clubs")], [card("5", "clubs")]],
      stock: [card("6", "clubs")],
      drawableDiscard: null,
      turnPhase: "draw",
      currentPlayerIndex: 0,
    });
    const actions = engine.getValidActions(state, "p1");
    expect(actions).toHaveLength(1);
    expect(actions[0]!.description).toBe("stock");
  });

  it("empty for non-current player", () => {
    const state = makeTonkState({
      hands: [[card("3", "clubs")], [card("4", "clubs")], [card("5", "clubs")]],
      currentPlayerIndex: 0,
    });
    expect(engine.getValidActions(state, "p2")).toEqual([]);
  });

  it("empty when not IN_PROGRESS", () => {
    const state = {
      ...makeTonkState({
        hands: [
          [card("3", "clubs")],
          [card("4", "clubs")],
          [card("5", "clubs")],
        ],
      }),
      status: "COMPLETED" as const,
    };
    expect(engine.getValidActions(state, "p1")).toEqual([]);
  });
});

describe("validateDiscard", () => {
  const hand: TonkCard[] = [
    card("5", "clubs"),
    card("5", "hearts"),
    card("9", "spades"),
    joker(0),
  ];

  it("single card in hand OK", () => {
    expect(validateDiscard([card("9", "spades")], hand).valid).toBe(true);
  });
  it("same-rank multiples OK", () => {
    expect(
      validateDiscard([card("5", "clubs"), card("5", "hearts")], hand).valid,
    ).toBe(true);
  });
  it("mixed-rank rejected", () => {
    const v = validateDiscard([card("5", "clubs"), card("9", "spades")], hand);
    expect(v.valid).toBe(false);
    expect(v.error).toBe("Discard must be a single rank");
  });
  it("joker groups only with jokers (joker + standard rejected)", () => {
    const v = validateDiscard([joker(0), card("5", "clubs")], hand);
    expect(v.valid).toBe(false);
    expect(v.error).toBe("Discard must be a single rank");
  });
  it("not-in-hand rejected", () => {
    const v = validateDiscard([card("K", "diamonds")], hand);
    expect(v.valid).toBe(false);
    expect(v.error).toBe("Cards not in hand");
  });
  it("empty payload rejected", () => {
    const v = validateDiscard([], hand);
    expect(v.valid).toBe(false);
    expect(v.error).toBe("Must discard at least one card");
  });
  it("more copies than in hand rejected", () => {
    const v = validateDiscard(
      [card("5", "clubs"), card("5", "hearts"), card("5", "diamonds")],
      hand,
    );
    expect(v.valid).toBe(false);
    expect(v.error).toBe("Cards not in hand");
  });
});

describe("validateDrawSource", () => {
  it("stock OK", () => {
    const state = tonkOf(
      makeTonkState({ hands: [[card("3", "clubs")], [], []] }),
    );
    expect(validateDrawSource("stock", state).valid).toBe(true);
  });
  it("discard OK when drawableDiscard present", () => {
    const state = tonkOf(
      makeTonkState({
        hands: [[card("3", "clubs")], [], []],
        drawableDiscard: card("9", "hearts"),
      }),
    );
    expect(validateDrawSource("discard", state).valid).toBe(true);
  });
  it("discard rejected when drawableDiscard null", () => {
    const state = tonkOf(
      makeTonkState({
        hands: [[card("3", "clubs")], [], []],
        drawableDiscard: null,
      }),
    );
    const v = validateDrawSource("discard", state);
    expect(v.valid).toBe(false);
    expect(v.error).toBe("No card available to draw from discard");
  });
  it("arbitrary source rejected", () => {
    const state = tonkOf(
      makeTonkState({ hands: [[card("3", "clubs")], [], []] }),
    );
    const v = validateDrawSource("bank" as never, state);
    expect(v.valid).toBe(false);
    expect(v.error).toBe("Invalid draw source");
  });
});
