import { describe, it, expect } from "vitest";
import type { Card, PlayerPublicInfo } from "../../src/shared/engine-types.js";
import type { TonkLogEntry, TonkCard } from "../../src/shared/tonk-types.js";
import {
  LOSS_LINE,
  NEAR_LINE_THRESHOLD,
  cardLabel,
  dimmedSelectionIndices,
  drawSourceLabel,
  drawableFromName,
  isBadSelect,
  isCompactRail,
  isNearLine,
  isWrappingRail,
  justPlayedName,
  logActionText,
  lossLineProgress,
  phaseClass,
  phaseLabel,
  phaseTag,
  railSeats,
  rankedTallies,
  selectionRankKey,
  trickLabel,
  trickResultSummary,
  turnLabel,
} from "../../src/frontend/component/game-ui/tonkDisplay.js";

// These tests exercise the Tonk board derivation logic in isolation (node
// environment, no DOM mount), mirroring the project pattern (gameOverFinalPlay /
// trickPile / gameBoardMobile). The helpers in tonkDisplay.ts are the same
// source the components consume, so asserting them asserts what the templates
// render via v-if/v-for/text bindings.

function card(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}

function players(n: number): PlayerPublicInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    playerId: `p${i}`,
    displayName: `Player${i}`,
    cardCount: 5,
    isConnected: true,
  }));
}

describe("tonkDisplay — phase / turn labels (B1)", () => {
  it("discard phase → 'discard phase' chip + discard color class + 'disc.' tag", () => {
    expect(phaseLabel("discard")).toBe("discard phase");
    expect(phaseClass("discard")).toBe("tonk-phase--discard");
    expect(phaseTag("discard")).toBe("disc.");
  });

  it("draw phase → 'draw phase' chip + draw color class + 'draw' tag", () => {
    expect(phaseLabel("draw")).toBe("draw phase");
    expect(phaseClass("draw")).toBe("tonk-phase--draw");
    expect(phaseTag("draw")).toBe("draw");
  });

  it("the two phase color classes are distinct", () => {
    expect(phaseClass("discard")).not.toBe(phaseClass("draw"));
  });

  it("isMyTurn true → 'Your turn'; false → \"<name>'s turn\"", () => {
    expect(turnLabel("Devon", true)).toBe("Your turn");
    expect(turnLabel("Devon", false)).toBe("Devon's turn");
  });

  it("trick label: full on desktop, abbreviated on mobile", () => {
    expect(trickLabel(3)).toBe("TRICK 3");
    expect(trickLabel(3, true)).toBe("T3");
  });
});

describe("tonkDisplay — piles name derivation (A1)", () => {
  it("justPlayedName resolves the lastDiscardPlayerIndex name", () => {
    expect(justPlayedName(players(3), 1)).toBe("Player1");
  });

  it("justPlayedName returns '' when no one has discarded (E2 — trick 1 empty)", () => {
    expect(justPlayedName(players(3), null)).toBe("");
  });

  it("justPlayedName returns '' for an out-of-range index", () => {
    expect(justPlayedName(players(3), 9)).toBe("");
  });

  it("drawableFromName (draw phase) resolves the player preceding the discarder", () => {
    // Draw phase: current player has already discarded, so lastDiscardPlayerIndex
    // is the current player; the drawable came from the seat before them.
    // index 2 discarded → drawable came from index 1
    expect(drawableFromName(players(4), 2, "draw")).toBe("Player1");
    // wraps: index 0 discarded → preceding is the last seat
    expect(drawableFromName(players(4), 0, "draw")).toBe("Player3");
  });

  it("drawableFromName (discard phase) attributes the drawable to the player who just handed off", () => {
    // Discard phase: at turn start the current player has NOT discarded yet, so
    // lastDiscardPlayerIndex still points at the player who placed the drawable
    // card. The provenance is that seat itself — NOT one seat further back.
    expect(drawableFromName(players(4), 2, "discard")).toBe("Player2");
    expect(drawableFromName(players(4), 0, "discard")).toBe("Player0");
  });

  it("drawableFromName returns '' when not derivable (no discarder)", () => {
    expect(drawableFromName(players(4), null, "discard")).toBe("");
    expect(drawableFromName(players(4), null, "draw")).toBe("");
  });
});

describe("tonkDisplay — seats (3–8, compact/wrap)", () => {
  it("railSeats includes the local player, marks it isSelf, and sorts it first", () => {
    const seats = railSeats(players(3), [10, 20, 30], 0);
    expect(seats.map((s) => s.seatIndex)).toEqual([0, 1, 2]);
    expect(seats.map((s) => s.tally)).toEqual([10, 20, 30]);
    expect(seats[0]!.isSelf).toBe(true);
    expect(seats[1]!.isSelf).toBe(false);
    expect(seats[2]!.isSelf).toBe(false);
  });

  it("railSeats carries the own tally value for the self row", () => {
    const seats = railSeats(players(3), [10, 20, 30], 0);
    const selfSeat = seats.find((s) => s.isSelf);
    expect(selfSeat?.tally).toBe(10);
  });

  it("non-self rows retain ascending seatIndex order", () => {
    const seats = railSeats(players(4), [10, 20, 30, 40], 1);
    // self is seat 1 (first), then seats 0, 2, 3 in ascending order
    expect(seats[0]!.seatIndex).toBe(1);
    expect(seats[0]!.isSelf).toBe(true);
    expect(seats.slice(1).map((s) => s.seatIndex)).toEqual([0, 2, 3]);
  });

  it("railSeats renders ALL players for spectator-style render (myPlayerIndex === -1, E11)", () => {
    const seats = railSeats(players(3), [10, 20, 30], -1);
    expect(seats).toHaveLength(3);
    expect(seats.every((s) => !s.isSelf)).toBe(true);
  });

  it("3 players → not compact (fan shown), not wrapping (E6)", () => {
    expect(isCompactRail(3)).toBe(false);
    expect(isWrappingRail(3)).toBe(false);
  });

  it("6 players → compact (fan dropped), not yet wrapping", () => {
    expect(isCompactRail(6)).toBe(true);
    expect(isWrappingRail(6)).toBe(false);
  });

  it("7 and 8 players → compact and wrapping (E7, usable at max 8)", () => {
    expect(isCompactRail(7)).toBe(true);
    expect(isWrappingRail(7)).toBe(true);
    expect(isCompactRail(8)).toBe(true);
    expect(isWrappingRail(8)).toBe(true);
    // 8-player rail now renders all 8 seats (self included).
    expect(railSeats(players(8), new Array(8).fill(0), 0)).toHaveLength(8);
  });

  it("tallies shorter than players → self row tally falls back to 0 (defensive E6)", () => {
    const seats = railSeats(players(3), [], 0);
    expect(seats.find((s) => s.isSelf)?.tally).toBe(0);
  });

  it("seat carries the disconnected flag for the disconnected affordance (E9)", () => {
    const p = players(3);
    const disconnected = [...p];
    disconnected[1] = { ...p[1]!, isConnected: false };
    const seats = railSeats(disconnected, [0, 0, 0], 0);
    expect(seats.find((s) => s.seatIndex === 1)!.isConnected).toBe(false);
  });
});

describe("tonkDisplay — tally panel & 150 line", () => {
  it("rankedTallies sorts ascending (lower is better)", () => {
    const ranked = rankedTallies([30, 10, 20]);
    expect(ranked.map((r) => r.seatIndex)).toEqual([1, 2, 0]);
    expect(ranked.map((r) => r.tally)).toEqual([10, 20, 30]);
  });

  it("rankedTallies breaks ties by seat index (E12 stable order)", () => {
    const ranked = rankedTallies([15, 15, 5]);
    expect(ranked.map((r) => r.seatIndex)).toEqual([2, 0, 1]);
  });

  it("progress = min(tally/150, 1)", () => {
    expect(lossLineProgress(0)).toBe(0);
    expect(lossLineProgress(75)).toBeCloseTo(0.5);
    expect(lossLineProgress(LOSS_LINE)).toBe(1);
    // A tally over the line caps the bar at full (E10).
    expect(lossLineProgress(200)).toBe(1);
  });

  it("near-150 flag triggers at the display threshold and at/over the line", () => {
    expect(isNearLine(NEAR_LINE_THRESHOLD - 1)).toBe(false);
    expect(isNearLine(NEAR_LINE_THRESHOLD)).toBe(true);
    expect(isNearLine(LOSS_LINE)).toBe(true);
    expect(isNearLine(160)).toBe(true);
  });
});

describe("tonkDisplay — joker label (icon, never the word)", () => {
  it("a standard card labels rank+suit", () => {
    expect(cardLabel(card("A", "spades"))).toBe("A♠");
  });

  it("a joker labels the star glyph, never the literal text 'Joker'", () => {
    const label = cardLabel({ joker: true, id: 1 });
    expect(label).toBe("★");
    expect(label.toLowerCase()).not.toContain("joker");
  });
});

describe("tonkDisplay — log rendering", () => {
  it("a discard entry shows count + the discarded cards", () => {
    const entry: TonkLogEntry = {
      playerId: "p1",
      displayName: "Alice",
      type: "discard",
      discarded: [card("7", "hearts")],
      discardCount: 1,
    };
    const text = logActionText(entry);
    expect(text).toContain("discarded 1");
    expect(text).toContain("7♥");
  });

  it("a multi-discard entry shows the full count", () => {
    const cards: TonkCard[] = [card("7", "hearts"), card("7", "spades")];
    const entry: TonkLogEntry = {
      playerId: "p1",
      displayName: "Alice",
      type: "discard",
      discarded: cards,
      discardCount: 2,
    };
    expect(logActionText(entry)).toContain("discarded 2");
  });

  it("drawSourceLabel maps the public source", () => {
    expect(drawSourceLabel("stock")).toBe("from stock");
    expect(drawSourceLabel("discard")).toBe("from discard");
  });

  it("a draw entry shows ONLY the source — never a drawn card value (info-hiding)", () => {
    const entry: TonkLogEntry = {
      playerId: "p1",
      displayName: "Bob",
      type: "draw",
      drawSource: "stock",
    };
    const text = logActionText(entry);
    expect(text).toBe("drew from stock");
    // The drawn card is hidden and absent from the entry; the label exposes
    // nothing beyond the source.
    expect(text).not.toMatch(/[♣♦♥♠★]/);
  });

  it("a callTonk entry renders the TONK call", () => {
    const entry: TonkLogEntry = {
      playerId: "p1",
      displayName: "Cara",
      type: "callTonk",
    };
    expect(logActionText(entry)).toBe("called TONK");
  });

  it("a trickResult entry renders a trick-end summary with reason + per-seat values/deltas", () => {
    const entry: TonkLogEntry = {
      playerId: "p1",
      displayName: "Alice",
      type: "callTonk",
      trickResult: {
        trickNumber: 2,
        reason: "tonk",
        tonkCallerIndex: 0,
        revealedHands: [[card("3", "clubs")], [card("K", "hearts")]],
        handValues: [3, 10],
        tallyDeltas: [0, 10],
      },
    };
    const summary = trickResultSummary(entry, players(2));
    expect(summary).toContain("Trick 2 ended");
    expect(summary).toContain("TONK called");
    expect(summary).toContain("Player0: 3 (+0)");
    expect(summary).toContain("Player1: 10 (+10)");
  });

  it("trickResultSummary is null when there is no trick result", () => {
    const entry: TonkLogEntry = {
      playerId: "p1",
      displayName: "Alice",
      type: "discard",
      discardCount: 1,
    };
    expect(trickResultSummary(entry, players(2))).toBeNull();
  });
});

describe("tonkDisplay — same-rank discard selection hints (LLD 99)", () => {
  function c(rank: Card["rank"], suit: Card["suit"]): Card {
    return { rank, suit };
  }

  // Q♣ Q♦ K♠ J + a joker, by index.
  const hand: TonkCard[] = [
    c("Q", "clubs"),
    c("Q", "diamonds"),
    c("K", "spades"),
    c("J", "hearts"),
    { joker: true, id: 0 },
  ];

  describe("selectionRankKey", () => {
    it("groups standard cards by rank", () => {
      expect(selectionRankKey(c("Q", "clubs"))).toBe("Q");
      expect(selectionRankKey(c("Q", "diamonds"))).toBe("Q");
    });

    it("groups all jokers under the 'joker' key (jokers group only with jokers)", () => {
      expect(selectionRankKey({ joker: true, id: 0 })).toBe("joker");
      expect(selectionRankKey({ joker: true, id: 7 })).toBe("joker");
    });
  });

  describe("dimmedSelectionIndices", () => {
    it("empty selection → nothing dimmed", () => {
      expect(dimmedSelectionIndices(hand, new Set()).size).toBe(0);
    });

    it("a same-rank group dims every other-rank index (E4)", () => {
      // Select both Queens (indices 0,1). Dimmed = K, J, joker (2,3,4).
      const dimmed = dimmedSelectionIndices(hand, new Set([0, 1]));
      expect([...dimmed].sort()).toEqual([2, 3, 4]);
    });

    it("selecting a single card dims all non-matching ranks", () => {
      const dimmed = dimmedSelectionIndices(hand, new Set([0]));
      expect([...dimmed].sort()).toEqual([2, 3, 4]);
    });

    it("selecting a joker dims all non-joker cards", () => {
      const dimmed = dimmedSelectionIndices(hand, new Set([4]));
      expect([...dimmed].sort()).toEqual([0, 1, 2, 3]);
    });

    it("a mixed-rank selection dims nothing (bad-select carries the feedback, E3)", () => {
      const dimmed = dimmedSelectionIndices(hand, new Set([0, 2]));
      expect(dimmed.size).toBe(0);
    });
  });

  describe("isBadSelect", () => {
    it("empty selection is not a bad select", () => {
      expect(isBadSelect(hand, new Set())).toBe(false);
    });

    it("a single-rank selection is not a bad select (E4)", () => {
      expect(isBadSelect(hand, new Set([0, 1]))).toBe(false);
    });

    it("a multi-rank selection is a bad select (E3)", () => {
      expect(isBadSelect(hand, new Set([0, 2]))).toBe(true);
    });

    it("joker + a ranked card is a bad select (E16)", () => {
      expect(isBadSelect(hand, new Set([0, 4]))).toBe(true);
    });

    it("two jokers are a single group, not a bad select", () => {
      const jokerHand: TonkCard[] = [
        { joker: true, id: 0 },
        { joker: true, id: 1 },
        c("Q", "clubs"),
      ];
      expect(isBadSelect(jokerHand, new Set([0, 1]))).toBe(false);
    });
  });
});
