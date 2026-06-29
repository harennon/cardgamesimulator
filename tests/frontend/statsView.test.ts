import { describe, it, expect } from "vitest";
import type { GameStatsEntry, GameType } from "@shared/model";
import {
  gameTypeLabel,
  formatWinRate,
  statRowsFor,
  sortedEntries,
  GAME_TYPE_UI_BOUNDS,
} from "@/component/statsView";

describe("gameTypeLabel", () => {
  it('maps "big2" -> "Big 2"', () => {
    expect(gameTypeLabel("big2")).toBe("Big 2");
  });

  it('maps "tonk" -> "Tonk"', () => {
    expect(gameTypeLabel("tonk")).toBe("Tonk");
  });

  it("falls back to the raw value for an unknown game type", () => {
    expect(gameTypeLabel("poker" as GameType)).toBe("poker");
  });
});

describe("GAME_TYPE_UI_BOUNDS", () => {
  it("big2 allows 2-4 players and has no deck-rounds control", () => {
    expect(GAME_TYPE_UI_BOUNDS.big2).toEqual({
      minPlayers: 2,
      maxPlayers: 4,
      hasDeckRoundsTarget: false,
    });
  });

  it("tonk allows 3-8 players and has a deck-rounds control", () => {
    expect(GAME_TYPE_UI_BOUNDS.tonk).toEqual({
      minPlayers: 3,
      maxPlayers: 8,
      hasDeckRoundsTarget: true,
    });
  });

  it("hasDeckRoundsTarget is true only for Tonk", () => {
    expect(GAME_TYPE_UI_BOUNDS.tonk.hasDeckRoundsTarget).toBe(true);
    expect(GAME_TYPE_UI_BOUNDS.big2.hasDeckRoundsTarget).toBe(false);
  });
});

describe("formatWinRate", () => {
  it("formats 0 as 0%", () => {
    expect(formatWinRate(0)).toBe("0%");
  });

  it("formats 1 as 100%", () => {
    expect(formatWinRate(1)).toBe("100%");
  });

  it("rounds 0.732 to 73%", () => {
    expect(formatWinRate(0.732)).toBe("73%");
  });

  it("rounds 0.005 to 1% (rounds half up)", () => {
    expect(formatWinRate(0.005)).toBe("1%");
  });

  it("rounds 0.004 down to 0%", () => {
    expect(formatWinRate(0.004)).toBe("0%");
  });
});

describe("statRowsFor", () => {
  const entry: GameStatsEntry = {
    gameType: "big2",
    gamesPlayed: 10,
    gamesWon: 7,
    gamesLost: 3,
    totalScore: 142,
    winRate: 0.7,
    lastPlayedAt: "2026-06-01T00:00:00.000Z",
  };

  it("produces the expected labels and values in render order", () => {
    expect(statRowsFor(entry)).toEqual([
      { label: "Win Rate", value: "70%" },
      { label: "Total Games", value: "10" },
      { label: "Total Score", value: "142" },
      { label: "Won", value: "7" },
      { label: "Lost", value: "3" },
    ]);
  });

  it("passes through the server winRate rather than recomputing from won/played", () => {
    // gamesWon/gamesPlayed = 9/10 = 90%, but the server-sent winRate is 0.5.
    const mismatched: GameStatsEntry = {
      ...entry,
      gamesWon: 9,
      gamesPlayed: 10,
      winRate: 0.5,
    };
    const winRateRow = statRowsFor(mismatched).find(
      (r) => r.label === "Win Rate",
    );
    expect(winRateRow?.value).toBe("50%");
  });
});

describe("sortedEntries", () => {
  it("sorts entries deterministically by gameType", () => {
    const tonk: GameStatsEntry = {
      gameType: "tonk",
      gamesPlayed: 1,
      gamesWon: 0,
      gamesLost: 1,
      totalScore: 0,
      winRate: 0,
      lastPlayedAt: null,
    };
    const big2: GameStatsEntry = {
      gameType: "big2",
      gamesPlayed: 1,
      gamesWon: 1,
      gamesLost: 0,
      totalScore: 5,
      winRate: 1,
      lastPlayedAt: null,
    };
    expect(sortedEntries([tonk, big2]).map((e) => e.gameType)).toEqual([
      "big2",
      "tonk",
    ]);
  });

  it("does not mutate the input array", () => {
    const games: GameStatsEntry[] = [
      {
        gameType: "tonk",
        gamesPlayed: 1,
        gamesWon: 0,
        gamesLost: 1,
        totalScore: 0,
        winRate: 0,
        lastPlayedAt: null,
      },
      {
        gameType: "big2",
        gamesPlayed: 1,
        gamesWon: 1,
        gamesLost: 0,
        totalScore: 5,
        winRate: 1,
        lastPlayedAt: null,
      },
    ];
    sortedEntries(games);
    expect(games[0].gameType).toBe("tonk");
  });
});
