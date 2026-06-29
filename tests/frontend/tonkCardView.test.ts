import { describe, it, expect } from "vitest";
import type { Card } from "../../src/shared/engine-types.js";
import { isJoker } from "../../src/shared/tonk-types.js";
import type { TonkCard } from "../../src/shared/tonk-types.js";

// LLD 89 test 2/5: TonkCardView selects exactly one render branch. The project
// tests component logic in isolation (node env). `branchFor` is an exact
// transcription of the template's mutually-exclusive v-if/v-else-if/v-else order:
//   faceDown → "back"; else isJoker → "joker"; else → "standard" (delegates to GameCard).

type Branch = "back" | "joker" | "standard";

function branchFor(card: TonkCard | undefined, faceDown: boolean): Branch {
  if (faceDown) return "back";
  if (card != null && isJoker(card)) return "joker";
  return "standard";
}

function card(rank: Card["rank"], suit: Card["suit"]): TonkCard {
  return { rank, suit };
}

describe("TonkCardView — render branch selection (LLD 89 tests 2, 5)", () => {
  it("face-down renders a card back (no card needed)", () => {
    expect(branchFor(undefined, true)).toBe("back");
    expect(branchFor(card("3", "clubs"), true)).toBe("back");
  });

  it("a Joker renders the joker icon branch, never a standard card", () => {
    expect(branchFor({ joker: true, id: 0 }, false)).toBe("joker");
  });

  it("a standard card delegates to GameCard", () => {
    expect(branchFor(card("A", "spades"), false)).toBe("standard");
    expect(branchFor(card("10", "hearts"), false)).toBe("standard");
  });

  it("mixed hands resolve each card independently", () => {
    const hand: TonkCard[] = [
      card("3", "clubs"),
      { joker: true, id: 1 },
      card("K", "diamonds"),
    ];
    expect(hand.map((c) => branchFor(c, false))).toEqual([
      "standard",
      "joker",
      "standard",
    ]);
  });
});
