import { describe, it, expect } from "vitest";
import type { Card, PlayerPublicInfo } from "../../src/shared/engine-types.js";
import type { TonkLogEntry, TonkCard } from "../../src/shared/tonk-types.js";
import {
  LOSS_LINE,
  NEAR_LINE_THRESHOLD,
  cardLabel,
  drawSourceLabel,
  drawableFromName,
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

  it("drawableFromName resolves the player preceding the discarder", () => {
    // index 2 discarded → drawable came from index 1
    expect(drawableFromName(players(4), 2)).toBe("Player1");
    // wraps: index 0 discarded → preceding is the last seat
    expect(drawableFromName(players(4), 0)).toBe("Player3");
  });

  it("drawableFromName returns '' when not derivable (no discarder)", () => {
    expect(drawableFromName(players(4), null)).toBe("");
  });
});

describe("tonkDisplay — seats (3–8, compact/wrap)", () => {
  it("railSeats omits the local player and carries seat index + tally", () => {
    const seats = railSeats(players(3), [10, 20, 30], 0);
    expect(seats.map((s) => s.seatIndex)).toEqual([1, 2]);
    expect(seats.map((s) => s.tally)).toEqual([20, 30]);
  });

  it("railSeats renders ALL players for spectator-style render (myPlayerIndex === -1, E11)", () => {
    const seats = railSeats(players(3), [10, 20, 30], -1);
    expect(seats).toHaveLength(3);
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
    // 8-player rail still renders every opponent seat.
    expect(railSeats(players(8), new Array(8).fill(0), 0)).toHaveLength(7);
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
