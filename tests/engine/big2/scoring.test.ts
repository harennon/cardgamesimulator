import { describe, it, expect } from "vitest";
import { computeScores } from "../../../src/backend/engine/big2/scoring.js";
import type { PlayerInfo } from "../../../src/shared/engine-types.js";

function player(id: string): PlayerInfo {
  return { playerId: id, displayName: id };
}

const P = ["p1", "p2", "p3", "p4"].map(player);

describe("computeScores — 4 players", () => {
  it("assigns 5/3/1/0 by finishing order", () => {
    // finishedPlayerIndices: [2, 0, 3, 1] means player at index 2 finished 1st, etc.
    const scores = computeScores(P, [2, 0, 3, 1]);
    const byId = Object.fromEntries(scores.map((s) => [s.playerId, s]));
    expect(byId["p3"]?.score).toBe(5); // index 2 → 1st
    expect(byId["p1"]?.score).toBe(3); // index 0 → 2nd
    expect(byId["p4"]?.score).toBe(1); // index 3 → 3rd
    expect(byId["p2"]?.score).toBe(0); // index 1 → 4th
  });

  it("all players accounted for", () => {
    const scores = computeScores(P, [0, 1, 2, 3]);
    expect(scores).toHaveLength(4);
  });

  it("winner (first finisher) is first in scores array", () => {
    const scores = computeScores(P, [3, 0, 1, 2]);
    expect(scores[0]?.playerId).toBe("p4"); // index 3
    expect(scores[0]?.score).toBe(5);
  });

  it("breakdown contains placement (1-based)", () => {
    const scores = computeScores(P, [0, 1, 2, 3]);
    expect(scores[0]?.breakdown?.placement).toBe(1);
    expect(scores[1]?.breakdown?.placement).toBe(2);
    expect(scores[2]?.breakdown?.placement).toBe(3);
    expect(scores[3]?.breakdown?.placement).toBe(4);
  });
});

describe("computeScores — 3 players", () => {
  const P3 = P.slice(0, 3);

  it("assigns 5/3/0 by finishing order", () => {
    const scores = computeScores(P3, [1, 0, 2]);
    const byId = Object.fromEntries(scores.map((s) => [s.playerId, s]));
    expect(byId["p2"]?.score).toBe(5);
    expect(byId["p1"]?.score).toBe(3);
    expect(byId["p3"]?.score).toBe(0);
  });

  it("all players accounted for", () => {
    const scores = computeScores(P3, [0, 1, 2]);
    expect(scores).toHaveLength(3);
  });

  it("breakdown contains placement", () => {
    const scores = computeScores(P3, [0, 1, 2]);
    expect(scores[0]?.breakdown?.placement).toBe(1);
    expect(scores[2]?.breakdown?.placement).toBe(3);
  });
});

describe("computeScores — 2 players", () => {
  const P2 = P.slice(0, 2);

  it("assigns 5/0 by finishing order", () => {
    const scores = computeScores(P2, [1, 0]);
    const byId = Object.fromEntries(scores.map((s) => [s.playerId, s]));
    expect(byId["p2"]?.score).toBe(5);
    expect(byId["p1"]?.score).toBe(0);
  });

  it("all players accounted for", () => {
    const scores = computeScores(P2, [0, 1]);
    expect(scores).toHaveLength(2);
  });
});
