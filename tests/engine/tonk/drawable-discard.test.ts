import { describe, it, expect } from "vitest";
import { TonkEngine } from "../../../src/backend/engine/tonk/tonk-engine.js";
import { buildTonkState, c, tonk } from "./helpers.js";

const engine = new TonkEngine();

describe("drawable-discard snapshot (discard-before-draw)", () => {
  it("trick-1 first player cannot draw from discard (snapshot null)", () => {
    // p1 has discarded; drawableDiscard is null (trick-1 first player).
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("9", "hearts")], [c("6", "clubs")], [c("7", "clubs")]],
        stock: [c("8", "clubs")],
        discardPile: [c("5", "clubs")],
        drawableDiscard: null,
        lastDiscardCount: 1,
        lastDiscardPlayerIndex: 0,
        turnPhase: "draw",
      },
    });
    const res = engine.applyAction(state, {
      type: "draw",
      playerId: "p1",
      source: "discard",
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("No card available to draw from the discard.");
  });

  it("buried preceding discard still drawable (yields snapshot, not live top)", () => {
    // p2 (index 1) starts a turn: snapshot = p0's card (5C), live top = 5C.
    // p2 discards 9H (burying 5C), then draws from discard and gets 5C.
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 1,
      tonk: {
        hands: [[c("2", "clubs")], [c("9", "hearts")], [c("4", "clubs")]],
        stock: [c("8", "clubs")],
        discardPile: [c("5", "clubs")],
        drawableDiscard: c("5", "clubs"),
        lastDiscardCount: 1,
        lastDiscardPlayerIndex: 0,
        turnPhase: "discard",
        trickTurnCount: 1,
      },
    });
    const r1 = engine.applyAction(state, {
      type: "discard",
      playerId: "p2",
      cards: [c("9", "hearts")],
    });
    expect(r1.success).toBe(true);
    const res = engine.applyAction(r1.newState!, {
      type: "draw",
      playerId: "p2",
      source: "discard",
    });
    expect(res.success).toBe(true);
    const out = tonk(res.newState!);
    // p2 (index 1) got the snapshot card.
    expect(out.hands[1]).toContainEqual(c("5", "clubs"));
    // 9H (p2's own discard) remains on the pile; 5C removed.
    expect(out.discardPile).toEqual([c("9", "hearts")]);
  });

  it("snapshot is captured at turn start, unchanged by current player's discard", () => {
    // p2 (index 1) starts a turn with snapshot = p0's top card 5C.
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 1,
      tonk: {
        hands: [[], [c("3", "clubs"), c("K", "spades")], [c("4", "clubs")]],
        stock: [c("8", "clubs")],
        discardPile: [c("5", "clubs")],
        drawableDiscard: c("5", "clubs"),
        lastDiscardCount: 1,
        lastDiscardPlayerIndex: 0,
        turnPhase: "discard",
        trickTurnCount: 1,
      },
    });
    // p2 discards their own card; snapshot must still be 5C.
    const r1 = engine.applyAction(state, {
      type: "discard",
      playerId: "p2",
      cards: [c("K", "spades")],
    });
    expect(r1.success).toBe(true);
    expect(tonk(r1.newState!).drawableDiscard).toEqual(c("5", "clubs"));
    // p2 draws their own snapshot — gets 5C (the preceding player's card),
    // NOT their own just-discarded K.
    const r2 = engine.applyAction(r1.newState!, {
      type: "draw",
      playerId: "p2",
      source: "discard",
    });
    expect(r2.success).toBe(true);
    expect(tonk(r2.newState!).hands[1]).toContainEqual(c("5", "clubs"));
    // K (p2's own) remains on the pile.
    expect(tonk(r2.newState!).discardPile).toContainEqual(c("K", "spades"));
    expect(tonk(r2.newState!).discardPile).not.toContainEqual(c("5", "clubs"));
  });

  it("preceding multiples -> only single top is the snapshot", () => {
    // p0 discarded Q,Q,Q (multiples). Snapshot for p1 is the single top Q.
    // p1 discards their own card, then draws the single top Q from discard.
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 1,
      tonk: {
        hands: [[], [c("3", "clubs")], [c("4", "clubs")]],
        stock: [c("8", "clubs")],
        discardPile: [c("Q", "clubs"), c("Q", "hearts"), c("Q", "spades")],
        drawableDiscard: c("Q", "spades"),
        lastDiscardCount: 3,
        lastDiscardPlayerIndex: 0,
        turnPhase: "discard",
        trickTurnCount: 1,
      },
    });
    const r1 = engine.applyAction(state, {
      type: "discard",
      playerId: "p2",
      cards: [c("3", "clubs")],
    });
    expect(r1.success).toBe(true);
    const res = engine.applyAction(r1.newState!, {
      type: "draw",
      playerId: "p2",
      source: "discard",
    });
    expect(res.success).toBe(true);
    const out = tonk(res.newState!);
    // Only the single top Q (spades) drawn; the other two Qs remain buried,
    // and p2's own discard (3C) is now the live top.
    expect(out.hands[1]).toContainEqual(c("Q", "spades"));
    expect(out.discardPile).toEqual([
      c("Q", "clubs"),
      c("Q", "hearts"),
      c("3", "clubs"),
    ]);
  });

  it("after drawing from discard, snapshot consumed; next snapshot recomputed", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 1,
      tonk: {
        hands: [[], [c("3", "clubs")], [c("4", "clubs")]],
        stock: [c("8", "clubs")],
        discardPile: [c("5", "clubs"), c("9", "hearts")],
        drawableDiscard: c("5", "clubs"),
        lastDiscardCount: 1,
        lastDiscardPlayerIndex: 1,
        turnPhase: "draw",
      },
    });
    const res = engine.applyAction(state, {
      type: "draw",
      playerId: "p2",
      source: "discard",
    });
    expect(res.success).toBe(true);
    const out = tonk(res.newState!);
    // Next player's snapshot = the live top (9H, p2's own discard) — the single
    // top card of the immediately-preceding player.
    expect(out.drawableDiscard).toEqual(c("9", "hearts"));
    // The drawn snapshot card is no longer in the pile.
    expect(out.discardPile).not.toContainEqual(c("5", "clubs"));
  });
});

describe("trick-2+ start card as initial drawable", () => {
  it("start-card snapshot is drawable by the starter after they bury it", () => {
    // Simulate the trick-2 starter (index 0) with the face-up start card as
    // drawableDiscard. The starter discards (burying the start card), then can
    // draw the start card from discard.
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [c("3", "clubs"), c("K", "spades")],
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        discardPile: [c("J", "hearts")], // face-up start card
        drawableDiscard: c("J", "hearts"),
        lastDiscardCount: 1,
        lastDiscardPlayerIndex: null,
        turnPhase: "discard",
        trickNumber: 2,
      },
    });
    const r1 = engine.applyAction(state, {
      type: "discard",
      playerId: "p1",
      cards: [c("K", "spades")],
    });
    expect(r1.success).toBe(true);
    expect(tonk(r1.newState!).drawableDiscard).toEqual(c("J", "hearts"));
    const r2 = engine.applyAction(r1.newState!, {
      type: "draw",
      playerId: "p1",
      source: "discard",
    });
    expect(r2.success).toBe(true);
    expect(tonk(r2.newState!).hands[0]).toContainEqual(c("J", "hearts"));
    // Starter's own discard (K) remains, start card consumed.
    expect(tonk(r2.newState!).discardPile).toContainEqual(c("K", "spades"));
    expect(tonk(r2.newState!).discardPile).not.toContainEqual(c("J", "hearts"));
  });
});
