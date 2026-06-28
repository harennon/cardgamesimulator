import { describe, it, expect } from "vitest";
import { TonkEngine } from "../../../src/backend/engine/tonk/tonk-engine.js";
import { SeededPRNG, hashSeed } from "../../../src/backend/engine/prng.js";
import {
  scoreTrick,
  resolveMatchEnd,
} from "../../../src/backend/engine/tonk/scoring.js";
import { buildTonkState, c, tonk } from "./helpers.js";
import type { PlayerScore } from "../../../src/shared/engine-types.js";

const engine = new TonkEngine();

describe("scoreTrick — pure cases", () => {
  it("Case A: caller strictly lowest", () => {
    const hands = [
      [c("3", "clubs")], // 3
      [c("9", "clubs")], // 9
      [c("K", "spades")], // 10
    ];
    expect(scoreTrick(hands, 0)).toEqual([0, 9, 10]);
  });

  it("Case B: caller tied", () => {
    const hands = [[c("9", "clubs")], [c("9", "hearts")], [c("K", "spades")]];
    expect(scoreTrick(hands, 0)).toEqual([30, 0, 0]);
  });

  it("Case C: stock-out, single lowest +30", () => {
    const hands = [[c("3", "clubs")], [c("9", "hearts")], [c("K", "spades")]];
    expect(scoreTrick(hands, null)).toEqual([30, 0, 0]);
  });

  it("Case C: stock-out, tie for lowest -> each tied-lowest +30", () => {
    const hands = [
      [c("3", "clubs")], // 3
      [c("3", "hearts")], // 3 (tie)
      [c("K", "spades")], // 10
    ];
    expect(scoreTrick(hands, null)).toEqual([30, 30, 0]);
  });
});

describe("stock-out (Case C) via draw on empty stock", () => {
  it("draw from empty stock ends trick, scores Case C", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("3", "clubs")], [c("9", "hearts")], [c("K", "spades")]],
        stock: [],
        discardPile: [c("4", "clubs")],
        drawableDiscard: null,
        lastDiscardCount: 1,
        lastDiscardPlayerIndex: 1,
        turnPhase: "draw",
        trickTurnCount: 3,
        tallies: [0, 0, 0],
      },
    });
    const res = engine.applyAction(state, {
      type: "draw",
      playerId: "p1",
      source: "stock",
    });
    expect(res.success).toBe(true);
    const out = tonk(res.newState!);
    expect(out.tallies).toEqual([30, 0, 0]);
    const last = out.log[out.log.length - 1]!;
    expect(last.trickResult!.reason).toBe("stockout");
  });
});

describe("resolveMatchEnd — pure", () => {
  function prng() {
    return new SeededPRNG(String(hashSeed("seed:trueloser:1")));
  }

  it("no tally >= 150 -> null (match continues)", () => {
    expect(resolveMatchEnd([10, 149, 0], prng())).toBeNull();
  });

  it("single >= 150 -> auto TRUE LOSER, no draw", () => {
    const r = resolveMatchEnd([155, 10, 20], prng())!;
    expect(r.lostPlayerIndices).toEqual([0]);
    expect(r.trueLoserIndex).toBe(0);
  });

  it("multiple >= 150 -> joker draw picks a TRUE LOSER among them", () => {
    const r = resolveMatchEnd([160, 10, 200], prng())!;
    expect(r.lostPlayerIndices).toEqual([0, 2]);
    expect([0, 2]).toContain(r.trueLoserIndex);
  });

  it("multiple-lost draw is deterministic for a given seed", () => {
    const a = resolveMatchEnd([160, 10, 200], prng())!;
    const b = resolveMatchEnd([160, 10, 200], prng())!;
    expect(a.trueLoserIndex).toBe(b.trueLoserIndex);
  });

  it("every player >= 150 -> still exactly one TRUE LOSER", () => {
    const r = resolveMatchEnd([150, 160, 170], prng())!;
    expect(r.lostPlayerIndices).toEqual([0, 1, 2]);
    expect([0, 1, 2]).toContain(r.trueLoserIndex);
  });
});

describe("match end through the engine", () => {
  it("tally >= 150 -> COMPLETED, currentPlayerIndex -1, winner lowest tally", () => {
    // p1 calls TONK strictly lowest -> p3 adds 30 -> p3 reaches 150.
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("3", "clubs")], [c("9", "clubs")], [c("K", "spades")]],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 3,
        tallies: [10, 40, 140],
      },
    });
    const res = engine.applyAction(state, { type: "callTonk", playerId: "p1" });
    expect(res.success).toBe(true);
    const ns = res.newState!;
    expect(ns.status).toBe("COMPLETED");
    expect(ns.currentPlayerIndex).toBe(-1);
    // tallies: p1 +0 (=10), p2 +9 (=49), p3 +10 (=150).
    expect(tonk(ns).tallies).toEqual([10, 49, 150]);
    // winner = lowest tally = p1.
    expect(ns.winner).toBe("p1");
  });

  it("winner tie -> lowest seat index (display only)", () => {
    // Force two players tied for lowest at match end.
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("3", "clubs")], [c("3", "hearts")], [c("K", "spades")]],
        stock: [],
        discardPile: [c("4", "clubs")],
        turnPhase: "draw",
        trickTurnCount: 3,
        tallies: [10, 10, 150],
      },
    });
    // Case C: lowest hands (p1=3, p2=3) each +30. p3 unaffected, already 150.
    const res = engine.applyAction(state, {
      type: "draw",
      playerId: "p1",
      source: "stock",
    });
    const ns = res.newState!;
    expect(ns.status).toBe("COMPLETED");
    // tallies p1=40, p2=40, p3=150. winner = lowest tally, tie -> seat 0.
    expect(ns.winner).toBe("p1");
  });
});

describe("stats breakdown population (engine output for §6.3)", () => {
  function scoresOf(state: { scores: readonly PlayerScore[] | null }) {
    return state.scores!;
  }

  it("single lost: TRUE LOSER has trueLoser=1, others 0; lost flag correct", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("3", "clubs")], [c("9", "clubs")], [c("K", "spades")]],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 3,
        tallies: [10, 40, 140],
      },
    });
    const res = engine.applyAction(state, { type: "callTonk", playerId: "p1" });
    const scores = scoresOf(res.newState!);
    // p3 reached 150 -> trueLoser.
    expect(scores[2]!.breakdown!["trueLoser"]).toBe(1);
    expect(scores[0]!.breakdown!["trueLoser"]).toBe(0);
    expect(scores[1]!.breakdown!["trueLoser"]).toBe(0);
    // lost flag = (finalTally >= 150) ? 1 : 0.
    expect(scores[2]!.breakdown!["lost"]).toBe(1);
    expect(scores[0]!.breakdown!["lost"]).toBe(0);
    // score === finalTally === breakdown.finalTally.
    expect(scores[2]!.score).toBe(150);
    expect(scores[2]!.breakdown!["finalTally"]).toBe(150);
  });

  it("exactly one trueLoser=1 even when every player >= 150", () => {
    // Construct a Case-C trick where all three reach >=150 simultaneously.
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("3", "clubs")], [c("3", "hearts")], [c("3", "spades")]],
        stock: [],
        discardPile: [c("4", "clubs")],
        turnPhase: "draw",
        trickTurnCount: 3,
        tallies: [149, 149, 149],
      },
      randomSeed: "all-lost-seed",
    });
    // All hands tie for lowest (3 each) -> each +30 -> all reach 179.
    const res = engine.applyAction(state, {
      type: "draw",
      playerId: "p1",
      source: "stock",
    });
    const ns = res.newState!;
    expect(ns.status).toBe("COMPLETED");
    const scores = scoresOf(ns);
    const trueLosers = scores.filter((s) => s.breakdown!["trueLoser"] === 1);
    expect(trueLosers.length).toBe(1);
    // Everyone crossed 150 -> all lost flags = 1.
    expect(scores.every((s) => s.breakdown!["lost"] === 1)).toBe(true);
  });
});
