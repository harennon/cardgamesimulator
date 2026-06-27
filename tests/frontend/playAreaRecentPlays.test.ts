import { describe, it, expect } from "vitest";
import type { Big2HistoryEntry } from "../../src/shared/big2-types.js";
import type { Card } from "../../src/shared/card-types.js";

// Test the recentPlays computed logic from PlayArea.vue in isolation.
// This mirrors what the component does: filter to "play" actions,
// exclude the most recent (which corresponds to lastPlay), take last 2.

function computeRecentPlays(
  playHistory: readonly Big2HistoryEntry[],
): Big2HistoryEntry[] {
  const plays = playHistory.filter((e) => e.action === "play");
  if (plays.length <= 1) return [];
  return plays.slice(-3, -1);
}

const card = (rank: number, suit: number): Card =>
  ({ rank, suit }) as unknown as Card;

function makePlayEntry(
  playerId: string,
  cards: Card[],
  handType = "single",
): Big2HistoryEntry {
  return {
    playerId,
    displayName: playerId,
    action: "play",
    cards,
    handType: handType as Big2HistoryEntry["handType"],
  };
}

function makePassEntry(playerId: string): Big2HistoryEntry {
  return {
    playerId,
    displayName: playerId,
    action: "pass",
  };
}

describe("PlayArea recentPlays computed logic", () => {
  it("returns empty when history has 0 plays", () => {
    const result = computeRecentPlays([]);
    expect(result).toEqual([]);
  });

  it("returns empty when history has only 1 play", () => {
    const history: Big2HistoryEntry[] = [makePlayEntry("p1", [card(3, 0)])];
    const result = computeRecentPlays(history);
    expect(result).toEqual([]);
  });

  it("returns last 2 card-plays before the current (filters out passes)", () => {
    const history: Big2HistoryEntry[] = [
      makePlayEntry("p1", [card(3, 0)]),
      makePassEntry("p2"),
      makePlayEntry("p3", [card(5, 1)]),
      makePassEntry("p4"),
      makePlayEntry("p1", [card(7, 2)]),
    ];
    const result = computeRecentPlays(history);
    // Only "play" actions: p1(3), p3(5), p1(7). Last one is current lastPlay.
    // recentPlays = slice(-3, -1) = [p1(3), p3(5)]
    expect(result).toHaveLength(2);
    expect(result[0].cards![0]).toEqual(card(3, 0));
    expect(result[1].cards![0]).toEqual(card(5, 1));
  });

  it("caps at 2 entries even with long history", () => {
    const history: Big2HistoryEntry[] = [
      makePlayEntry("p1", [card(3, 0)]),
      makePlayEntry("p2", [card(4, 1)]),
      makePlayEntry("p3", [card(5, 2)]),
      makePlayEntry("p4", [card(6, 3)]),
      makePlayEntry("p1", [card(7, 0)]),
    ];
    const result = computeRecentPlays(history);
    // plays = [3,4,5,6,7]. slice(-3,-1) = [5, 6]
    expect(result).toHaveLength(2);
    expect(result[0].cards![0]).toEqual(card(5, 2));
    expect(result[1].cards![0]).toEqual(card(6, 3));
  });

  it("returns 1 entry when history has exactly 2 plays", () => {
    const history: Big2HistoryEntry[] = [
      makePlayEntry("p1", [card(3, 0)]),
      makePlayEntry("p2", [card(5, 1)]),
    ];
    const result = computeRecentPlays(history);
    // plays = [3, 5]. slice(-3, -1) = [3] (only 1 before current)
    expect(result).toHaveLength(1);
    expect(result[0].cards![0]).toEqual(card(3, 0));
  });

  it("returns empty when all entries are passes", () => {
    const history: Big2HistoryEntry[] = [
      makePassEntry("p1"),
      makePassEntry("p2"),
      makePassEntry("p3"),
    ];
    const result = computeRecentPlays(history);
    expect(result).toEqual([]);
  });
});
