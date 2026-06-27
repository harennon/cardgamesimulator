import { describe, it, expect } from "vitest";
import type { Big2HistoryEntry } from "@shared/big2-types";
import {
  deriveBig2Stats,
  countTricksWon,
  getBestHand,
  getBadgeForPosition,
  getBadgeClass,
} from "@/component/game/gameOverStats";

describe("deriveBig2Stats", () => {
  const playerA = "player-a";
  const playerB = "player-b";
  const playerC = "player-c";
  const playerD = "player-d";

  function entry(
    playerId: string,
    action: "play" | "pass",
    handType?: Big2HistoryEntry["handType"],
  ): Big2HistoryEntry {
    return { playerId, displayName: playerId, action, handType };
  }

  describe("counts plays correctly", () => {
    it("counts only play actions for the target player", () => {
      const history: Big2HistoryEntry[] = [
        entry(playerA, "play", "single"),
        entry(playerB, "pass"),
        entry(playerC, "pass"),
        entry(playerD, "pass"),
        entry(playerA, "play", "pair"),
        entry(playerB, "play", "pair"),
      ];

      const stats = deriveBig2Stats(history, playerA);
      const playsMade = stats.find((s) => s.label === "Plays Made");
      expect(playsMade?.value).toBe(2);
    });
  });

  describe("counts passes correctly", () => {
    it("counts only pass actions for the target player", () => {
      const history: Big2HistoryEntry[] = [
        entry(playerB, "play", "single"),
        entry(playerA, "pass"),
        entry(playerC, "pass"),
        entry(playerD, "pass"),
        entry(playerB, "play", "pair"),
        entry(playerA, "pass"),
      ];

      const stats = deriveBig2Stats(history, playerA);
      const passes = stats.find((s) => s.label === "Passes");
      expect(passes?.value).toBe(2);
    });
  });

  describe("counts tricks won correctly", () => {
    it("detects trick-winning sequences (play followed by N-1 passes)", () => {
      // 4-player game: A plays, B passes, C passes, D passes = A wins trick
      const history: Big2HistoryEntry[] = [
        entry(playerA, "play", "single"),
        entry(playerB, "pass"),
        entry(playerC, "pass"),
        entry(playerD, "pass"),
        // Next trick: B plays, others pass except A who plays higher
        entry(playerA, "play", "pair"),
        entry(playerB, "play", "pair"),
        entry(playerC, "pass"),
        entry(playerD, "pass"),
        entry(playerA, "pass"),
      ];

      const stats = deriveBig2Stats(history, playerA);
      const tricksWon = stats.find((s) => s.label === "Tricks Won");
      // First trick: A plays, then 3 passes = win
      // Second A play at index 4 is followed by B play (not 3 passes) = no win
      expect(tricksWon?.value).toBe(1);
    });

    it("counts multiple tricks won by the same player", () => {
      const history: Big2HistoryEntry[] = [
        entry(playerA, "play", "single"),
        entry(playerB, "pass"),
        entry(playerC, "pass"),
        entry(playerD, "pass"),
        entry(playerA, "play", "pair"),
        entry(playerB, "pass"),
        entry(playerC, "pass"),
        entry(playerD, "pass"),
      ];

      const tricks = countTricksWon(history, playerA);
      expect(tricks).toBe(2);
    });
  });

  describe("identifies best hand type", () => {
    it("ranks handTypes and picks the highest", () => {
      const plays = [
        { handType: "single" as const },
        { handType: "pair" as const },
        { handType: "straight" as const },
        { handType: "fullHouse" as const },
      ];

      const best = getBestHand(plays);
      expect(best).toBe("Full House");
    });

    it("identifies straightFlush as highest", () => {
      const plays = [
        { handType: "fourOfAKind" as const },
        { handType: "straightFlush" as const },
        { handType: "pair" as const },
      ];

      const best = getBestHand(plays);
      expect(best).toBe("Straight Flush");
    });
  });

  describe('returns "--" for best hand when no plays made', () => {
    it("returns placeholder for empty plays array", () => {
      const best = getBestHand([]);
      expect(best).toBe("--");
    });

    it("returns placeholder when plays have no handType", () => {
      const best = getBestHand([{}, {}]);
      expect(best).toBe("--");
    });
  });

  describe("returns all zeros for empty playHistory", () => {
    it("produces zeroed stats with empty input", () => {
      const stats = deriveBig2Stats([], playerA);
      expect(stats).toEqual([
        { label: "Plays Made", value: 0 },
        { label: "Passes", value: 0 },
        { label: "Tricks Won", value: 0 },
        { label: "Best Hand", value: "--" },
      ]);
    });
  });

  describe("ignores other players' entries", () => {
    it("only counts entries matching currentPlayerId", () => {
      const history: Big2HistoryEntry[] = [
        entry(playerB, "play", "single"),
        entry(playerB, "play", "pair"),
        entry(playerB, "play", "straight"),
        entry(playerC, "pass"),
        entry(playerD, "pass"),
        entry(playerA, "play", "single"),
      ];

      const stats = deriveBig2Stats(history, playerA);
      const playsMade = stats.find((s) => s.label === "Plays Made");
      const passes = stats.find((s) => s.label === "Passes");
      expect(playsMade?.value).toBe(1);
      expect(passes?.value).toBe(0);
    });
  });
});

describe("placement badge logic", () => {
  describe("4-player game assigns gold/silver/bronze/grey", () => {
    it("maps positions 0-3 to correct badge types", () => {
      expect(getBadgeForPosition(0, 4)).toBe("gold");
      expect(getBadgeForPosition(1, 4)).toBe("silver");
      expect(getBadgeForPosition(2, 4)).toBe("bronze");
      expect(getBadgeForPosition(3, 4)).toBe("grey");
    });
  });

  describe("2-player game assigns gold/silver only", () => {
    it("returns null for positions beyond totalPlayers", () => {
      expect(getBadgeForPosition(0, 2)).toBe("gold");
      expect(getBadgeForPosition(1, 2)).toBe("silver");
      expect(getBadgeForPosition(2, 2)).toBeNull();
    });
  });

  describe("badge maps to correct CSS class", () => {
    it("each badge type produces the expected class string", () => {
      expect(getBadgeClass("gold")).toBe("game-over__badge--gold");
      expect(getBadgeClass("silver")).toBe("game-over__badge--silver");
      expect(getBadgeClass("bronze")).toBe("game-over__badge--bronze");
      expect(getBadgeClass("grey")).toBe("game-over__badge--grey");
    });
  });
});
