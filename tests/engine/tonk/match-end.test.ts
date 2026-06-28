import { describe, it, expect } from "vitest";
import { TonkEngine } from "../../../src/backend/engine/tonk/tonk-engine.js";
import { card, makeTonkState, tonkOf } from "./helpers.js";
import type { PlayerScore } from "../../../src/shared/engine-types.js";

const engine = new TonkEngine();

describe("match end via TONK (single loser)", () => {
  it("Case A pushing one player past 150 → COMPLETED, that player is TRUE LOSER", () => {
    // Gate open, caller (p1) strictly lowest. p2 has high hand and is at 145.
    const state = makeTonkState({
      hands: [
        [card("A", "clubs")], // caller, 1
        [card("K", "clubs"), card("K", "hearts")], // 20 → 145+20 = 165
        [card("3", "clubs")], // 3
      ],
      turnPhase: "discard",
      trickTurnCount: 3,
      currentPlayerIndex: 0,
      tallies: [0, 145, 10],
    });
    const res = engine.applyAction(state, { type: "callTonk", playerId: "p1" });
    expect(res.success).toBe(true);
    const ns = res.newState!;
    expect(ns.status).toBe("COMPLETED");
    expect(ns.currentPlayerIndex).toBe(-1);
    expect(tonkOf(ns).trueLoserIndex).toBe(1);

    const scores = ns.scores as readonly PlayerScore[];
    const byId = Object.fromEntries(scores.map((s) => [s.playerId, s]));
    expect(byId["p2"]!.breakdown!.trueLoser).toBe(1);
    expect(byId["p1"]!.breakdown!.trueLoser).toBe(0);
    expect(byId["p3"]!.breakdown!.trueLoser).toBe(0);
    expect(byId["p2"]!.breakdown!.lost).toBe(1);
    expect(byId["p2"]!.score).toBe(165);
    // winner = lowest tally (p1 at 1).
    expect(ns.winner).toBe("p1");
  });
});

describe("match end with multiple >=150 (joker draw)", () => {
  it("picks exactly one TRUE LOSER among lost seats; others trueLoser=0", () => {
    // p1 and p2 both cross 150 this trick via Case C (both lowest-tied).
    // Actually use Case A to push two: caller lowest, two opponents already high.
    const state = makeTonkState({
      hands: [
        [card("A", "clubs")], // caller, 1
        [card("K", "clubs"), card("Q", "hearts")], // 20 → 140+20 = 160
        [card("K", "spades"), card("J", "clubs")], // 20 → 155+20 = 175
      ],
      turnPhase: "discard",
      trickTurnCount: 3,
      currentPlayerIndex: 0,
      tallies: [0, 140, 155],
      randomSeed: "joker-seed",
    });
    const res = engine.applyAction(state, { type: "callTonk", playerId: "p1" });
    const ns = res.newState!;
    expect(ns.status).toBe("COMPLETED");
    expect(tonkOf(ns).lostPlayerIndices).toEqual([1, 2]);
    const trueLoser = tonkOf(ns).trueLoserIndex!;
    expect([1, 2]).toContain(trueLoser);

    const scores = ns.scores as readonly PlayerScore[];
    const loserCount = scores.filter(
      (s) => s.breakdown!.trueLoser === 1,
    ).length;
    expect(loserCount).toBe(1);
    // Deterministic for the same seed.
    const res2 = engine.applyAction(state, {
      type: "callTonk",
      playerId: "p1",
    });
    expect(tonkOf(res2.newState!).trueLoserIndex).toBe(trueLoser);
  });
});

describe("inter-trick transition (trick 2+ setup)", () => {
  it("when match not over, new trick has face-up start card as drawableDiscard and highest-tally starter", () => {
    const state = makeTonkState({
      hands: [
        [card("A", "clubs")], // caller 1 (strictly lowest)
        [card("9", "clubs")], // 9
        [card("5", "clubs")], // 5
      ],
      turnPhase: "discard",
      trickTurnCount: 3,
      currentPlayerIndex: 0,
      tallies: [0, 20, 40], // p3 highest → starts next trick
      numDecks: 1,
      deckRoundsTarget: 8,
    });
    const res = engine.applyAction(state, { type: "callTonk", playerId: "p1" });
    const ns = res.newState!;
    expect(ns.status).toBe("IN_PROGRESS");
    const t = tonkOf(ns);
    expect(t.trickNumber).toBe(2);
    expect(t.turnPhase).toBe("discard");
    expect(t.trickTurnCount).toBe(0);
    // Face-up start card flipped into discard, and it is the drawable snapshot.
    expect(t.discardPile.length).toBe(1);
    expect(t.drawableDiscard).toEqual(t.discardPile[0]);
    // Next starter = highest tally (p3, index 2).
    expect(ns.currentPlayerIndex).toBe(2);
    // Tallies carried + updated (Case A: others add own hand value).
    expect(t.tallies).toEqual([0, 29, 45]);
  });
});
