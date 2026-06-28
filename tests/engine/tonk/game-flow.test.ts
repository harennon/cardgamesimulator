import { describe, it, expect } from "vitest";
import { TonkEngine } from "../../../src/backend/engine/tonk/tonk-engine.js";
import { card, makeTonkState, tonkOf, totalCards } from "./helpers.js";
import type { InternalGameState } from "../../../src/shared/engine-types.js";
import type { TonkCard } from "../../../src/shared/tonk-types.js";

const engine = new TonkEngine();

function assertInvariants(
  state: InternalGameState,
  expectedTotal: number,
): void {
  const t = tonkOf(state);
  // Card conservation within a trick (drawableDiscard counted once via discardPile).
  if (state.status === "IN_PROGRESS") {
    expect(totalCards(state)).toBe(expectedTotal);
    expect(state.currentPlayerIndex).toBeGreaterThanOrEqual(0);
    expect(state.currentPlayerIndex).toBeLessThan(state.players.length);
    // No deadlock: current player has at least one valid action.
    const pid = state.players[state.currentPlayerIndex]!.playerId;
    expect(engine.getValidActions(state, pid).length).toBeGreaterThan(0);
  } else {
    expect(state.currentPlayerIndex).toBe(-1);
  }
  // drawableDiscard, if set, must physically be in the discardPile.
  if (t.drawableDiscard !== null) {
    const inPile = t.discardPile.some((c) =>
      isSame(c, t.drawableDiscard as TonkCard),
    );
    expect(inPile).toBe(true);
  }
}

function isSame(a: TonkCard, b: TonkCard): boolean {
  if ("joker" in a || "joker" in b) {
    return "joker" in a && "joker" in b && a.id === b.id;
  }
  return a.suit === b.suit && a.rank === b.rank;
}

describe("two-phase turn — discard then draw", () => {
  it("discard moves to draw phase, same player, version+1, turnNumber+1", () => {
    const state = makeTonkState({
      hands: [
        [card("5", "clubs"), card("9", "hearts")],
        [card("4", "clubs"), card("6", "hearts")],
        [card("3", "clubs"), card("7", "hearts")],
      ],
      stock: [card("K", "spades")],
      turnPhase: "discard",
      currentPlayerIndex: 0,
    });
    const total = totalCards(state);

    const res = engine.applyAction(state, {
      type: "discard",
      playerId: "p1",
      cards: [card("9", "hearts")],
    });
    expect(res.success).toBe(true);
    const ns = res.newState!;
    expect(tonkOf(ns).turnPhase).toBe("draw");
    expect(ns.currentPlayerIndex).toBe(0); // same player
    expect(ns.version).toBe(state.version + 1);
    expect(ns.turnNumber).toBe(state.turnNumber + 1);
    expect(
      tonkOf(ns).discardPile.map((c) => (c as { rank?: string }).rank),
    ).toContain("9");
    assertInvariants(ns, total);
  });

  it("draw from stock hands off to next seat, trickTurnCount+1", () => {
    const state = makeTonkState({
      hands: [[card("5", "clubs")], [card("4", "clubs")], [card("3", "clubs")]],
      stock: [card("K", "spades")],
      discardPile: [card("9", "hearts")],
      drawableDiscard: card("9", "hearts"),
      turnPhase: "draw",
      trickTurnCount: 1,
      currentPlayerIndex: 0,
    });
    const total = totalCards(state);

    const res = engine.applyAction(state, {
      type: "draw",
      playerId: "p1",
      source: "stock",
    });
    expect(res.success).toBe(true);
    const ns = res.newState!;
    expect(ns.currentPlayerIndex).toBe(1);
    expect(tonkOf(ns).turnPhase).toBe("discard");
    expect(tonkOf(ns).trickTurnCount).toBe(2);
    expect(tonkOf(ns).hands[0]!.length).toBe(2); // drew one
    expect(tonkOf(ns).stock.length).toBe(0);
    assertInvariants(ns, total);
  });

  it("cannot draw before discarding", () => {
    const state = makeTonkState({
      hands: [[card("5", "clubs")], [card("4", "clubs")], [card("3", "clubs")]],
      stock: [card("K", "spades")],
      turnPhase: "discard",
      currentPlayerIndex: 0,
    });
    const res = engine.applyAction(state, {
      type: "draw",
      playerId: "p1",
      source: "stock",
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("Cannot draw before discarding");
    expect(res.newState).toBeNull();
  });

  it("cannot discard while in draw phase", () => {
    const state = makeTonkState({
      hands: [[card("5", "clubs")], [card("4", "clubs")], [card("3", "clubs")]],
      stock: [card("K", "spades")],
      turnPhase: "draw",
      currentPlayerIndex: 0,
    });
    const res = engine.applyAction(state, {
      type: "discard",
      playerId: "p1",
      cards: [card("5", "clubs")],
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("Must draw to finish your turn");
  });
});

describe("drawable-discard snapshot (§3.3)", () => {
  it("snapshot captured at turn start, unchanged by current player's own discard", () => {
    // p2's turn, snapshot is p1's prior top (9♥). p2 discards K♠.
    const state = makeTonkState({
      hands: [
        [card("2", "clubs")],
        [card("K", "spades"), card("5", "hearts")],
        [card("3", "clubs")],
      ],
      stock: [card("7", "diamonds")],
      discardPile: [card("9", "hearts")],
      drawableDiscard: card("9", "hearts"),
      turnPhase: "discard",
      trickTurnCount: 1,
      currentPlayerIndex: 1,
    });
    const res = engine.applyAction(state, {
      type: "discard",
      playerId: "p2",
      cards: [card("K", "spades")],
    });
    const ns = res.newState!;
    // Snapshot still 9♥ even though live top is now K♠.
    expect(tonkOf(ns).drawableDiscard).toEqual(card("9", "hearts"));
    expect(tonkOf(ns).discardPile[tonkOf(ns).discardPile.length - 1]).toEqual(
      card("K", "spades"),
    );
  });

  it("buried snapshot still drawable — yields preceding top, not live top", () => {
    const state = makeTonkState({
      hands: [
        [card("2", "clubs")],
        [card("5", "hearts")],
        [card("3", "clubs")],
      ],
      stock: [card("7", "diamonds")],
      // p2 already discarded K♠ on top of p1's 9♥; snapshot is 9♥.
      discardPile: [card("9", "hearts"), card("K", "spades")],
      drawableDiscard: card("9", "hearts"),
      turnPhase: "draw",
      trickTurnCount: 2,
      currentPlayerIndex: 1,
    });
    const total = totalCards(state);
    const res = engine.applyAction(state, {
      type: "draw",
      playerId: "p2",
      source: "discard",
    });
    expect(res.success).toBe(true);
    const ns = res.newState!;
    // p2's hand gained 9♥ (the snapshot), not K♠ (the live top).
    expect(tonkOf(ns).hands[1]).toContainEqual(card("9", "hearts"));
    // 9♥ left the pile; K♠ remains.
    expect(tonkOf(ns).discardPile).toEqual([card("K", "spades")]);
    assertInvariants(ns, total);
  });

  it("no self-draw: current player never draws back own just-discarded card", () => {
    // p2 discards K♠ then can only draw the snapshot (9♥) or stock — never K♠.
    let state = makeTonkState({
      hands: [
        [card("2", "clubs")],
        [card("K", "spades"), card("5", "hearts")],
        [card("3", "clubs")],
      ],
      stock: [card("7", "diamonds")],
      discardPile: [card("9", "hearts")],
      drawableDiscard: card("9", "hearts"),
      turnPhase: "discard",
      trickTurnCount: 1,
      currentPlayerIndex: 1,
    });
    state = engine.applyAction(state, {
      type: "discard",
      playerId: "p2",
      cards: [card("K", "spades")],
    }).newState!;
    const res = engine.applyAction(state, {
      type: "draw",
      playerId: "p2",
      source: "discard",
    });
    const ns = res.newState!;
    expect(tonkOf(ns).hands[1]).toContainEqual(card("9", "hearts"));
    expect(tonkOf(ns).hands[1]).not.toContainEqual(card("K", "spades"));
  });

  it("only single top of a preceding multi-discard is drawable", () => {
    // p1 discarded two 5s (5♣ buried, 5♥ on top). Snapshot for p2 is 5♥.
    const state = makeTonkState({
      hands: [
        [card("2", "clubs")],
        [card("9", "hearts")],
        [card("3", "clubs")],
      ],
      stock: [card("7", "diamonds")],
      discardPile: [card("5", "clubs"), card("5", "hearts")],
      drawableDiscard: card("5", "hearts"),
      turnPhase: "draw",
      trickTurnCount: 1,
      currentPlayerIndex: 1,
    });
    const res = engine.applyAction(state, {
      type: "draw",
      playerId: "p2",
      source: "discard",
    });
    const ns = res.newState!;
    expect(tonkOf(ns).hands[1]).toContainEqual(card("5", "hearts"));
    // 5♣ remains buried in the pile, never drawn.
    expect(tonkOf(ns).discardPile).toContainEqual(card("5", "clubs"));
    expect(tonkOf(ns).discardPile).not.toContainEqual(card("5", "hearts"));
  });

  it("after drawing snapshot, next player's snapshot = the live top", () => {
    const state = makeTonkState({
      hands: [
        [card("2", "clubs")],
        [card("5", "hearts")],
        [card("3", "clubs")],
      ],
      stock: [card("7", "diamonds")],
      discardPile: [card("9", "hearts"), card("K", "spades")],
      drawableDiscard: card("9", "hearts"),
      turnPhase: "draw",
      trickTurnCount: 2,
      currentPlayerIndex: 1,
    });
    const ns = engine.applyAction(state, {
      type: "draw",
      playerId: "p2",
      source: "discard",
    }).newState!;
    // Next player p3's snapshot is the live top after the draw (K♠).
    expect(ns.currentPlayerIndex).toBe(2);
    expect(tonkOf(ns).drawableDiscard).toEqual(card("K", "spades"));
  });
});

describe("trick-1 first player", () => {
  it("cannot draw from discard (drawableDiscard null)", () => {
    let state = makeTonkState({
      hands: [
        [card("5", "clubs"), card("9", "hearts")],
        [card("4", "clubs")],
        [card("3", "clubs")],
      ],
      stock: [card("K", "spades")],
      discardPile: [],
      drawableDiscard: null,
      turnPhase: "discard",
      trickTurnCount: 0,
      currentPlayerIndex: 0,
    });
    state = engine.applyAction(state, {
      type: "discard",
      playerId: "p1",
      cards: [card("9", "hearts")],
    }).newState!;
    const res = engine.applyAction(state, {
      type: "draw",
      playerId: "p1",
      source: "discard",
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("No card available to draw from discard");
  });
});

describe("TONK gate (§3.4, §8.4)", () => {
  const baseHands = [
    [card("5", "clubs")],
    [card("4", "clubs")],
    [card("3", "clubs")],
  ];

  it("rejected before everyone has had a turn", () => {
    const state = makeTonkState({
      hands: baseHands,
      turnPhase: "discard",
      trickTurnCount: 2,
      currentPlayerIndex: 2,
    });
    const res = engine.applyAction(state, { type: "callTonk", playerId: "p3" });
    expect(res.success).toBe(false);
    expect(res.error).toBe(
      "TONK can only be called after every player has had a turn",
    );
  });

  it("rejected outside discard phase", () => {
    const state = makeTonkState({
      hands: baseHands,
      stock: [card("K", "spades")],
      turnPhase: "draw",
      trickTurnCount: 3,
      currentPlayerIndex: 0,
    });
    const res = engine.applyAction(state, { type: "callTonk", playerId: "p1" });
    expect(res.success).toBe(false);
    expect(res.error).toBe("Must draw to finish your turn");
  });

  it("accepted once gate open and scores trick (Case A)", () => {
    const state = makeTonkState({
      hands: [
        [card("A", "clubs")], // caller strictly lowest (1)
        [card("K", "clubs")], // 10
        [card("9", "clubs")], // 9
      ],
      turnPhase: "discard",
      trickTurnCount: 3,
      currentPlayerIndex: 0,
      tallies: [0, 0, 0],
    });
    const res = engine.applyAction(state, { type: "callTonk", playerId: "p1" });
    expect(res.success).toBe(true);
    const ns = res.newState!;
    // New trick began (tallies updated; trick 2).
    expect(tonkOf(ns).tallies).toEqual([0, 10, 9]);
    expect(tonkOf(ns).trickNumber).toBe(2);
  });
});

describe("stock exhaustion (Case C)", () => {
  it("draw from empty stock ends the trick; lowest hand adds 30", () => {
    const state = makeTonkState({
      hands: [
        [card("K", "clubs")], // 10
        [card("3", "hearts")], // 3 (lowest)
        [card("9", "clubs")], // 9
      ],
      stock: [],
      discardPile: [card("2", "spades")],
      drawableDiscard: null, // forces stock-only; here we test stock draw on empty
      turnPhase: "draw",
      trickTurnCount: 5,
      currentPlayerIndex: 0,
      tallies: [0, 0, 0],
    });
    const res = engine.applyAction(state, {
      type: "draw",
      playerId: "p1",
      source: "stock",
    });
    expect(res.success).toBe(true);
    const ns = res.newState!;
    // Case C: lowest (p2) +30.
    expect(tonkOf(ns).tallies).toEqual([0, 30, 0]);
    expect(tonkOf(ns).trickNumber).toBe(2);
  });
});
