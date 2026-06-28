import { describe, it, expect } from "vitest";
import {
  cardValue,
  handValue,
} from "../../../src/backend/engine/tonk/constants.js";
import {
  scoreTrick,
  resolveMatchEnd,
  finalScores,
} from "../../../src/backend/engine/tonk/scoring.js";
import { SeededPRNG } from "../../../src/backend/engine/prng.js";
import type { Card, PlayerInfo } from "../../../src/shared/engine-types.js";
import type { TonkCard } from "../../../src/shared/tonk-types.js";

function card(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}
function joker(id: number): TonkCard {
  return { joker: true, id };
}
function player(id: string): PlayerInfo {
  return { playerId: id, displayName: id };
}

describe("cardValue", () => {
  it("Ace = 1", () => {
    expect(cardValue(card("A", "spades"))).toBe(1);
  });
  it("2–10 = face value", () => {
    expect(cardValue(card("2", "clubs"))).toBe(2);
    expect(cardValue(card("7", "hearts"))).toBe(7);
    expect(cardValue(card("10", "diamonds"))).toBe(10);
  });
  it("J/Q/K = 10", () => {
    expect(cardValue(card("J", "clubs"))).toBe(10);
    expect(cardValue(card("Q", "clubs"))).toBe(10);
    expect(cardValue(card("K", "clubs"))).toBe(10);
  });
  it("Joker = 0", () => {
    expect(cardValue(joker(0))).toBe(0);
  });
});

describe("handValue", () => {
  it("sums all cards including jokers contributing 0", () => {
    const hand: TonkCard[] = [
      card("A", "spades"), // 1
      card("K", "hearts"), // 10
      card("5", "clubs"), // 5
      joker(0), // 0
    ];
    expect(handValue(hand)).toBe(16);
  });
  it("empty hand is 0", () => {
    expect(handValue([])).toBe(0);
  });
});

describe("scoreTrick — Case A (TONK, caller strictly lowest)", () => {
  it("others add own hand value; caller adds 0", () => {
    const hands: TonkCard[][] = [
      [card("A", "spades"), card("2", "clubs")], // caller, value 3
      [card("K", "hearts"), card("5", "clubs")], // value 15
      [card("9", "diamonds")], // value 9
    ];
    const deltas = scoreTrick(hands, 0);
    expect(deltas).toEqual([0, 15, 9]);
  });
});

describe("scoreTrick — Case B (TONK, caller tied or beaten)", () => {
  it("caller adds 30, others add 0 when tied", () => {
    const hands: TonkCard[][] = [
      [card("5", "spades")], // caller, value 5
      [card("5", "hearts")], // value 5 (tie)
      [card("9", "diamonds")], // value 9
    ];
    const deltas = scoreTrick(hands, 0);
    expect(deltas).toEqual([30, 0, 0]);
  });
  it("caller adds 30 when beaten", () => {
    const hands: TonkCard[][] = [
      [card("9", "spades")], // caller, value 9
      [card("3", "hearts")], // value 3 (beats caller)
      [card("9", "diamonds")], // value 9
    ];
    const deltas = scoreTrick(hands, 0);
    expect(deltas).toEqual([30, 0, 0]);
  });
});

describe("scoreTrick — Case C (stock-out, no TONK)", () => {
  it("lowest hand adds 30; others 0", () => {
    const hands: TonkCard[][] = [
      [card("K", "spades")], // 10
      [card("3", "hearts")], // 3 (lowest)
      [card("9", "diamonds")], // 9
    ];
    const deltas = scoreTrick(hands, null);
    expect(deltas).toEqual([0, 30, 0]);
  });
  it("ties for lowest each add 30", () => {
    const hands: TonkCard[][] = [
      [card("3", "spades")], // 3 (tie-lowest)
      [card("3", "hearts")], // 3 (tie-lowest)
      [card("9", "diamonds")], // 9
    ];
    const deltas = scoreTrick(hands, null);
    expect(deltas).toEqual([30, 30, 0]);
  });
});

describe("resolveMatchEnd", () => {
  const P3 = ["p1", "p2", "p3"].map(player);

  it("single >=150 → auto TRUE LOSER, no draw", () => {
    const res = resolveMatchEnd([160, 40, 90], new SeededPRNG("s"));
    expect(res.lostPlayerIndices).toEqual([0]);
    expect(res.trueLoserIndex).toBe(0);
  });

  it("multiple >=150 → joker draw picks one TRUE LOSER among lost seats", () => {
    const res = resolveMatchEnd([160, 155, 90], new SeededPRNG("s"));
    expect(res.lostPlayerIndices).toEqual([0, 1]);
    expect([0, 1]).toContain(res.trueLoserIndex);
  });

  it("joker draw is deterministic for the same seed", () => {
    const a = resolveMatchEnd([160, 155, 151], new SeededPRNG("seed-x"));
    const b = resolveMatchEnd([160, 155, 151], new SeededPRNG("seed-x"));
    expect(a.trueLoserIndex).toBe(b.trueLoserIndex);
  });

  it("winner = lowest tally; ties → lowest seat index", () => {
    const res = resolveMatchEnd([40, 40, 160], new SeededPRNG("s"));
    expect(res.winnerIndex).toBe(0);
  });

  it("all players >=150 → still exactly one TRUE LOSER", () => {
    const res = resolveMatchEnd([150, 160, 170], new SeededPRNG("s"));
    expect(res.lostPlayerIndices).toEqual([0, 1, 2]);
    expect([0, 1, 2]).toContain(res.trueLoserIndex);
  });

  it("finalScores: trueLoser=1 on loser, 0 elsewhere; lost flag; finalTally; score", () => {
    const tallies = [160, 40, 90];
    const scores = finalScores(P3, tallies, 0);
    expect(scores[0]!.breakdown!.trueLoser).toBe(1);
    expect(scores[1]!.breakdown!.trueLoser).toBe(0);
    expect(scores[2]!.breakdown!.trueLoser).toBe(0);
    expect(scores[0]!.breakdown!.lost).toBe(1);
    expect(scores[1]!.breakdown!.lost).toBe(0);
    expect(scores[0]!.breakdown!.finalTally).toBe(160);
    expect(scores[0]!.score).toBe(160);
    expect(scores[2]!.score).toBe(90);
  });
});
