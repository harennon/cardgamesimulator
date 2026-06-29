import { describe, it, expect } from "vitest";
import type { Card } from "../../src/shared/engine-types.js";
import type { TonkCard } from "../../src/shared/tonk-types.js";
import { isJoker } from "../../src/shared/tonk-types.js";

// Transcription of TonkHand.vue's :key expression (LLD 88 decision 3). The hand
// keys standard cards by `rank-suit` and jokers by `joker-<id>` so two jokers in
// a 2-deck pool are distinct (a plain rank/suit key would collide as
// `undefined-undefined`). Tested in isolation per the project pattern.

function card(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}

function handKey(card: TonkCard): string {
  return isJoker(card) ? `joker-${card.id}` : `${card.rank}-${card.suit}`;
}

describe("TonkHand — card keys", () => {
  it("keys a standard card by rank-suit", () => {
    expect(handKey(card("A", "spades"))).toBe("A-spades");
  });

  it("keys a joker by its id, never producing 'undefined-undefined'", () => {
    expect(handKey({ joker: true, id: 0 })).toBe("joker-0");
    expect(handKey({ joker: true, id: 3 })).toBe("joker-3");
  });

  it("two distinct jokers in a 2-deck pool get distinct keys", () => {
    const keys = new Set(
      [
        { joker: true, id: 0 } as TonkCard,
        { joker: true, id: 1 } as TonkCard,
      ].map(handKey),
    );
    expect(keys.size).toBe(2);
  });

  it("a mixed hand (standard + jokers) has all-unique keys", () => {
    const hand: TonkCard[] = [
      card("3", "clubs"),
      { joker: true, id: 0 },
      card("3", "hearts"),
      { joker: true, id: 1 },
    ];
    const keys = hand.map(handKey);
    expect(new Set(keys).size).toBe(hand.length);
  });
});
