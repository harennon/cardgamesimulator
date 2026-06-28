import { describe, it, expect } from "vitest";
import { TonkEngine } from "../../../src/backend/engine/tonk/tonk-engine.js";
import { buildTonkState, c, tonk } from "./helpers.js";

const engine = new TonkEngine();

describe("per-trick reset vs per-match carry (§4.4)", () => {
  it("trick ends without match end -> new trick set up, tallies carried, trickNumber+1", () => {
    // p1 calls TONK strictly lowest; no one reaches 150 -> new trick.
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("3", "clubs")], [c("9", "clubs")], [c("K", "spades")]],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 3,
        trickNumber: 1,
        tallies: [10, 20, 30],
      },
    });
    const res = engine.applyAction(state, { type: "callTonk", playerId: "p1" });
    expect(res.success).toBe(true);
    const ns = res.newState!;
    expect(ns.status).toBe("IN_PROGRESS");
    const out = tonk(ns);
    // Carried tallies: p1 +0, p2 +9, p3 +10.
    expect(out.tallies).toEqual([10, 29, 40]);
    expect(out.trickNumber).toBe(2);
    expect(out.trickTurnCount).toBe(0);
    expect(out.turnPhase).toBe("discard");
    expect(out.tonkCallerIndex).toBeNull();
    // Fresh deal: 5 each.
    for (const hand of out.hands) expect(hand.length).toBe(5);
  });

  it("next starter = highest-tally player (ties -> lowest seat)", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("3", "clubs")], [c("9", "clubs")], [c("K", "spades")]],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 3,
        trickNumber: 1,
        tallies: [10, 90, 30],
      },
    });
    // p1 strictly lowest -> p2 +9 (=99), p3 +10 (=40). Highest = p2 (seat 1).
    const res = engine.applyAction(state, { type: "callTonk", playerId: "p1" });
    expect(res.newState!.currentPlayerIndex).toBe(1);
  });

  it("trick-2+ flips one face-up start card as the starter's drawableDiscard", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("3", "clubs")], [c("9", "clubs")], [c("K", "spades")]],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 3,
        trickNumber: 1,
        tallies: [10, 20, 30],
      },
    });
    const res = engine.applyAction(state, { type: "callTonk", playerId: "p1" });
    const out = tonk(res.newState!);
    // A face-up start card exists and equals the starter's drawableDiscard.
    expect(out.discardPile.length).toBe(1);
    expect(out.drawableDiscard).not.toBeNull();
    expect(out.drawableDiscard).toEqual(out.discardPile[0]);
    expect(out.lastDiscardCount).toBe(1);
    expect(out.lastDiscardPlayerIndex).toBeNull();
  });

  it("new trick deck is deterministic for the same match seed", () => {
    const make = () =>
      buildTonkState({
        playerCount: 3,
        currentPlayerIndex: 0,
        randomSeed: "trick-determinism",
        tonk: {
          hands: [[c("3", "clubs")], [c("9", "clubs")], [c("K", "spades")]],
          stock: [c("8", "clubs")],
          turnPhase: "discard",
          trickTurnCount: 3,
          trickNumber: 1,
          tallies: [10, 20, 30],
          trickDeckSize: 39,
        },
      });
    const a = engine.applyAction(make(), { type: "callTonk", playerId: "p1" });
    const b = engine.applyAction(make(), { type: "callTonk", playerId: "p1" });
    expect(tonk(a.newState!).hands).toEqual(tonk(b.newState!).hands);
    expect(tonk(a.newState!).stock).toEqual(tonk(b.newState!).stock);
  });
});
