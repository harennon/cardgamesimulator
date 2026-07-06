import { describe, it, expect } from "vitest";
import type { Card, PlayerPublicInfo } from "../../src/shared/engine-types.js";
import type {
  TonkLogEntry,
  TonkCard,
  TonkTrickResult,
} from "../../src/shared/tonk-types.js";
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
  shouldEnterTrickReveal,
  trickLabel,
  trickReasonLabel,
  trickResultSummary,
  trickRevealRows,
  trickVerdictHeadline,
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

// ---------------------------------------------------------------------------
// LLD 146: showdown-row derivation helpers
// ---------------------------------------------------------------------------

function makeTrickResult(
  overrides: Partial<TonkTrickResult> = {},
): TonkTrickResult {
  return {
    trickNumber: 1,
    reason: "tonk",
    tonkCallerIndex: 0,
    revealedHands: [
      [
        { rank: "3", suit: "clubs" },
        { rank: "4", suit: "hearts" },
      ],
      [
        { rank: "K", suit: "spades" },
        { rank: "Q", suit: "diamonds" },
      ],
      [
        { rank: "7", suit: "clubs" },
        { rank: "8", suit: "hearts" },
        { rank: "9", suit: "spades" },
      ],
    ],
    handValues: [7, 23, 24],
    tallyDeltas: [0, 23, 24],
    ...overrides,
  };
}

function makePlayers3(): PlayerPublicInfo[] {
  return [
    { playerId: "p0", displayName: "Alice", cardCount: 2, isConnected: true },
    { playerId: "p1", displayName: "Bob", cardCount: 2, isConnected: true },
    { playerId: "p2", displayName: "Cara", cardCount: 3, isConnected: true },
  ];
}

describe("tonkDisplay — trickRevealRows (LLD 146)", () => {
  it("sorts rows ascending by handValue (best-first)", () => {
    const rows = trickRevealRows(
      makeTrickResult(),
      makePlayers3(),
      [42, 65, 81],
      0,
    );
    expect(rows.map((r) => r.handValue)).toEqual([7, 23, 24]);
  });

  it("ties in handValue are broken by ascending seat index", () => {
    const result = makeTrickResult({
      handValues: [10, 10, 5],
      tallyDeltas: [10, 10, 0],
    });
    const rows = trickRevealRows(result, makePlayers3(), [10, 10, 5], -1);
    // seat 2 has lowest (5), then seat 0, seat 1
    expect(rows.map((r) => r.seatIndex)).toEqual([2, 0, 1]);
  });

  it("each row maps delta, total, handValue, and hand to the correct seat", () => {
    const rows = trickRevealRows(
      makeTrickResult(),
      makePlayers3(),
      [42, 65, 81],
      -1,
    );
    const seat0 = rows.find((r) => r.seatIndex === 0)!;
    expect(seat0.handValue).toBe(7);
    expect(seat0.delta).toBe(0);
    expect(seat0.total).toBe(42);
    expect(seat0.hand).toHaveLength(2);
  });

  it("isCaller is true only for the tonkCallerIndex seat", () => {
    const rows = trickRevealRows(
      makeTrickResult(),
      makePlayers3(),
      [42, 65, 81],
      -1,
    );
    expect(rows.find((r) => r.seatIndex === 0)!.isCaller).toBe(true);
    expect(rows.find((r) => r.seatIndex === 1)!.isCaller).toBe(false);
    expect(rows.find((r) => r.seatIndex === 2)!.isCaller).toBe(false);
  });

  it("isCaller is false for all seats on stock-out (tonkCallerIndex null)", () => {
    const result = makeTrickResult({
      reason: "stockout",
      tonkCallerIndex: null,
    });
    const rows = trickRevealRows(result, makePlayers3(), [0, 0, 0], -1);
    expect(rows.every((r) => !r.isCaller)).toBe(true);
  });

  it("isBest is true for the seat(s) with the minimum handValue", () => {
    const rows = trickRevealRows(
      makeTrickResult(),
      makePlayers3(),
      [42, 65, 81],
      -1,
    );
    expect(rows.find((r) => r.seatIndex === 0)!.isBest).toBe(true);
    expect(rows.find((r) => r.seatIndex === 1)!.isBest).toBe(false);
    expect(rows.find((r) => r.seatIndex === 2)!.isBest).toBe(false);
  });

  it("isBest is true for ALL seats with the minimum handValue (tie)", () => {
    const result = makeTrickResult({ handValues: [10, 10, 20] });
    const rows = trickRevealRows(result, makePlayers3(), [0, 0, 0], -1);
    expect(rows.find((r) => r.seatIndex === 0)!.isBest).toBe(true);
    expect(rows.find((r) => r.seatIndex === 1)!.isBest).toBe(true);
    expect(rows.find((r) => r.seatIndex === 2)!.isBest).toBe(false);
  });

  it("isSelf is true only for myPlayerIndex", () => {
    const rows = trickRevealRows(
      makeTrickResult(),
      makePlayers3(),
      [42, 65, 81],
      1,
    );
    expect(rows.find((r) => r.seatIndex === 0)!.isSelf).toBe(false);
    expect(rows.find((r) => r.seatIndex === 1)!.isSelf).toBe(true);
    expect(rows.find((r) => r.seatIndex === 2)!.isSelf).toBe(false);
  });

  it("myPlayerIndex -1 → no isSelf row (spectator render, E9)", () => {
    const rows = trickRevealRows(
      makeTrickResult(),
      makePlayers3(),
      [0, 0, 0],
      -1,
    );
    expect(rows.every((r) => !r.isSelf)).toBe(true);
  });

  it("joker in a revealed hand: value contribution 0, joker object present", () => {
    const jokerCard: TonkCard = { joker: true, id: 0 };
    const result = makeTrickResult({
      revealedHands: [
        [jokerCard],
        [{ rank: "K", suit: "spades" }],
        [{ rank: "7", suit: "clubs" }],
      ],
      handValues: [0, 10, 7],
      tallyDeltas: [0, 10, 7],
    });
    const rows = trickRevealRows(result, makePlayers3(), [0, 10, 7], -1);
    const jokerRow = rows.find((r) => r.seatIndex === 0)!;
    expect(jokerRow.handValue).toBe(0);
    expect(jokerRow.hand[0]).toEqual(jokerCard);
  });

  it("returns one row per player (3-player and 8-player)", () => {
    const p8 = Array.from({ length: 8 }, (_, i) => ({
      playerId: `p${i}`,
      displayName: `P${i}`,
      cardCount: 5,
      isConnected: true,
    }));
    const result8: TonkTrickResult = {
      trickNumber: 2,
      reason: "stockout",
      tonkCallerIndex: null,
      revealedHands: Array.from({ length: 8 }, () => []),
      handValues: [5, 8, 12, 15, 6, 9, 11, 14],
      tallyDeltas: [5, 8, 12, 15, 6, 9, 11, 14],
    };
    const rows3 = trickRevealRows(
      makeTrickResult(),
      makePlayers3(),
      [0, 0, 0],
      -1,
    );
    const rows8 = trickRevealRows(result8, p8, new Array(8).fill(0), -1);
    expect(rows3).toHaveLength(3);
    expect(rows8).toHaveLength(8);
  });
});

describe("tonkDisplay — trickReasonLabel (LLD 146)", () => {
  it("tonk reason → 'TONK called'", () => {
    expect(trickReasonLabel("tonk")).toBe("TONK called");
  });

  it("stockout reason → 'Stock ran out'", () => {
    expect(trickReasonLabel("stockout")).toBe("Stock ran out");
  });
});

describe("tonkDisplay — trickVerdictHeadline (LLD 146)", () => {
  it("TONK: '<caller> called Tonk' using displayName for non-self", () => {
    const result = makeTrickResult({ tonkCallerIndex: 1 });
    const rows = trickRevealRows(result, makePlayers3(), [0, 0, 0], 0);
    expect(trickVerdictHeadline(rows, result)).toBe("Bob called Tonk");
  });

  it("TONK: 'You called Tonk' when the caller is the local player", () => {
    const result = makeTrickResult({ tonkCallerIndex: 0 });
    const rows = trickRevealRows(result, makePlayers3(), [0, 0, 0], 0);
    expect(trickVerdictHeadline(rows, result)).toBe("You called Tonk");
  });

  it("stock-out: '<best-hand player> wins the round'", () => {
    const result = makeTrickResult({
      reason: "stockout",
      tonkCallerIndex: null,
    });
    const rows = trickRevealRows(result, makePlayers3(), [0, 0, 0], -1);
    // seat 0 has lowest handValue (7)
    expect(trickVerdictHeadline(rows, result)).toBe("Alice wins the round");
  });

  it("stock-out: 'You wins the round' when best hand is the local player", () => {
    const result = makeTrickResult({
      reason: "stockout",
      tonkCallerIndex: null,
    });
    const rows = trickRevealRows(result, makePlayers3(), [0, 0, 0], 0);
    expect(trickVerdictHeadline(rows, result)).toBe("You wins the round");
  });
});

describe("tonkDisplay — shouldEnterTrickReveal (LLD 146)", () => {
  it("new trickNumber while IN_PROGRESS and different from lastRevealed → true", () => {
    expect(shouldEnterTrickReveal(2, 1, "IN_PROGRESS")).toBe(true);
  });

  it("same trickNumber already revealed → false (idempotent, E6)", () => {
    expect(shouldEnterTrickReveal(2, 2, "IN_PROGRESS")).toBe(false);
  });

  it("status COMPLETED with a trick-result present → false (E5)", () => {
    expect(shouldEnterTrickReveal(2, 1, "COMPLETED")).toBe(false);
  });

  it("no trick-result in log (null) → false (E13)", () => {
    expect(shouldEnterTrickReveal(null, null, "IN_PROGRESS")).toBe(false);
  });

  it("first state after join with seeded lastRevealedTrickNumber → false (no spurious reveal, E4)", () => {
    // lastRevealedTrickNumber is seeded to the existing trickNumber on join
    expect(shouldEnterTrickReveal(1, 1, "IN_PROGRESS")).toBe(false);
  });

  it("newer trickNumber arriving while already revealing → true, re-arm (E7)", () => {
    expect(shouldEnterTrickReveal(3, 2, "IN_PROGRESS")).toBe(true);
  });

  it("lastRevealedTrickNumber null and trickNumber present → true (first real round end)", () => {
    expect(shouldEnterTrickReveal(1, null, "IN_PROGRESS")).toBe(true);
  });
});
