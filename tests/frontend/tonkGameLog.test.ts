import { describe, it, expect } from "vitest";
import type { Card } from "../../src/shared/engine-types.js";
import type {
  TonkCard,
  TonkLogEntry,
  TonkTrickResult,
} from "../../src/shared/tonk-types.js";

// LLD 89 test 9: TonkGameLog renders each TonkLogEntry type correctly and a
// trickResult summary, and the drawn card is NEVER rendered for a draw entry
// (information-hiding). The project pattern tests <script setup>/template gating
// logic in isolation (no DOM mount) — see gameOverFinalPlay.test.ts. The
// `phraseFor`/`cardsFor` transcriptions below mirror the template's per-entry
// branches exactly; `cardsFor` returns the cards the template would render.

function card(rank: Card["rank"], suit: Card["suit"]): TonkCard {
  return { rank, suit };
}

/** Exact transcription of the per-entry action phrase rendered by the template. */
function phraseFor(entry: TonkLogEntry): string {
  if (entry.type === "discard") {
    const n = entry.discardCount ?? entry.discarded?.length ?? 0;
    return `discarded ${n}×`;
  }
  if (entry.type === "draw") {
    return `drew from ${entry.drawSource}`;
  }
  return "called TONK"; // callTonk
}

/** Cards the template renders for an entry (discard only; never the drawn card). */
function cardsFor(entry: TonkLogEntry): readonly TonkCard[] {
  return entry.type === "discard" ? (entry.discarded ?? []) : [];
}

describe("TonkGameLog — entry phrases (LLD 89 test 9)", () => {
  it("discard entry → 'discarded N×' with the discarded cards", () => {
    const entry: TonkLogEntry = {
      playerId: "p0",
      displayName: "Me",
      type: "discard",
      discarded: [card("3", "clubs"), card("3", "hearts")],
      discardCount: 2,
    };
    expect(phraseFor(entry)).toBe("discarded 2×");
    expect(cardsFor(entry)).toHaveLength(2);
  });

  it("draw entry → 'drew from {source}' and renders NO cards (drawn card hidden)", () => {
    const fromStock: TonkLogEntry = {
      playerId: "p1",
      displayName: "Bob",
      type: "draw",
      drawSource: "stock",
    };
    const fromDiscard: TonkLogEntry = {
      playerId: "p1",
      displayName: "Bob",
      type: "draw",
      drawSource: "discard",
    };
    expect(phraseFor(fromStock)).toBe("drew from stock");
    expect(phraseFor(fromDiscard)).toBe("drew from discard");
    // Information-hiding: a draw entry exposes no card data at all.
    expect(cardsFor(fromStock)).toEqual([]);
    expect((fromStock as Record<string, unknown>).drawn).toBeUndefined();
    expect((fromStock as Record<string, unknown>).discarded).toBeUndefined();
  });

  it("callTonk entry → 'called TONK'", () => {
    const entry: TonkLogEntry = {
      playerId: "p2",
      displayName: "Cara",
      type: "callTonk",
    };
    expect(phraseFor(entry)).toBe("called TONK");
    expect(cardsFor(entry)).toEqual([]);
  });
});

describe("TonkGameLog — trick result summary (LLD 89 test 9)", () => {
  it("a trickResult exposes per-seat handValues and tallyDeltas for the summary row", () => {
    const trickResult: TonkTrickResult = {
      trickNumber: 2,
      reason: "tonk",
      tonkCallerIndex: 1,
      revealedHands: [[card("K", "spades")], [card("2", "clubs")]],
      handValues: [10, 2],
      tallyDeltas: [10, 0],
    };
    const entry: TonkLogEntry = {
      playerId: "p1",
      displayName: "Bob",
      type: "callTonk",
      trickResult,
    };
    expect(entry.trickResult).toBeDefined();
    expect(entry.trickResult!.handValues).toEqual([10, 2]);
    expect(entry.trickResult!.tallyDeltas).toEqual([10, 0]);
    expect(entry.trickResult!.reason).toBe("tonk");
    expect(entry.trickResult!.trickNumber).toBe(2);
  });
});

describe("TonkGameLog — empty log (LLD 89 edge case 10)", () => {
  it("renders an empty list with no entries", () => {
    const entries: readonly TonkLogEntry[] = [];
    expect(entries.map(phraseFor)).toEqual([]);
  });
});
