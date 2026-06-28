import { describe, it, expect } from "vitest";
import { SeededPRNG, hashSeed } from "../../../src/backend/engine/prng.js";
import {
  deckCount,
  cutAmount,
  buildPool,
  buildTrickDeck,
  resolveDeckRoundsTarget,
  recoverDeckRoundsTarget,
} from "../../../src/backend/engine/tonk/deck.js";
import type { TonkCard } from "../../../src/backend/engine/tonk/tonk-types.js";
import { isJoker } from "../../../src/shared/tonk-types.js";

function trickPrng(seed: string, trick: number): SeededPRNG {
  return new SeededPRNG(String(hashSeed(seed + ":trick:" + trick)));
}

function cardKey(card: TonkCard): string {
  return isJoker(card) ? `J${card.id}` : `${card.rank}${card.suit}`;
}

function deckSet(deck: {
  hands: readonly (readonly TonkCard[])[];
  stock: readonly TonkCard[];
}): Set<string> {
  const all = [...deck.hands.flat(), ...deck.stock];
  return new Set(all.map(cardKey));
}

function countJokers(deck: {
  hands: readonly (readonly TonkCard[])[];
  stock: readonly TonkCard[];
}): number {
  return [...deck.hands.flat(), ...deck.stock].filter((card) => isJoker(card))
    .length;
}

describe("deckCount", () => {
  it("3-5 players -> 1 deck", () => {
    expect(deckCount(3)).toBe(1);
    expect(deckCount(4)).toBe(1);
    expect(deckCount(5)).toBe(1);
  });

  it("6-8 players -> 2 decks (6 triggers multi-deck)", () => {
    expect(deckCount(6)).toBe(2);
    expect(deckCount(7)).toBe(2);
    expect(deckCount(8)).toBe(2);
  });

  it("extraDecks adds to the count", () => {
    expect(deckCount(3, 1)).toBe(2);
  });
});

describe("cutAmount — §8.1 worked examples", () => {
  it("3 players, default target 8 -> cut 15", () => {
    expect(cutAmount(3, 1, 8)).toBe(15);
  });

  it("3 players, high target 12 -> cut 3", () => {
    expect(cutAmount(3, 1, 12)).toBe(3);
  });

  it("3 players, low target 5 -> cut 24", () => {
    expect(cutAmount(3, 1, 5)).toBe(24);
  });

  it("6 players, default target 8 -> cut 30", () => {
    expect(cutAmount(6, 2, 8)).toBe(30);
  });

  it("8 players (max), default target 8 -> cut 4", () => {
    expect(cutAmount(8, 2, 8)).toBe(4);
  });

  it("matches generic formula for arbitrary rows", () => {
    const clamp = (x: number, lo: number, hi: number) =>
      Math.min(hi, Math.max(lo, x));
    for (const players of [3, 4, 5, 6, 7, 8]) {
      const numDecks = deckCount(players);
      for (let target = 5; target <= 12; target++) {
        const handCardsDealt = 5 * players;
        const poolSize = 54 * numDecks;
        const targetCards = handCardsDealt + target * players;
        const expected = Math.max(
          0,
          poolSize - clamp(targetCards, handCardsDealt + players, poolSize),
        );
        expect(cutAmount(players, numDecks, target)).toBe(expected);
      }
    }
  });
});

describe("resolveDeckRoundsTarget — defaulting & clamping", () => {
  it("absent -> default 8", () => {
    expect(resolveDeckRoundsTarget(undefined)).toBe(8);
  });

  it("out-of-range low -> clamped to 5", () => {
    expect(resolveDeckRoundsTarget(2)).toBe(5);
  });

  it("out-of-range high -> clamped to 12", () => {
    expect(resolveDeckRoundsTarget(99)).toBe(12);
  });

  it("non-integer -> rounded then clamped", () => {
    expect(resolveDeckRoundsTarget(7.4)).toBe(7);
  });

  it("non-number -> default 8", () => {
    expect(resolveDeckRoundsTarget("nope")).toBe(8);
    expect(resolveDeckRoundsTarget(null)).toBe(8);
  });
});

describe("buildPool", () => {
  it("one deck = 52 + 2 jokers = 54", () => {
    const pool = buildPool(1);
    expect(pool.length).toBe(54);
    expect(pool.filter((card) => isJoker(card)).length).toBe(2);
  });

  it("two decks = 108 with 4 jokers, distinct joker ids", () => {
    const pool = buildPool(2);
    expect(pool.length).toBe(108);
    const jokers = pool.filter((card) => isJoker(card));
    expect(jokers.length).toBe(4);
    const ids = new Set(jokers.map((card) => (card as { id: number }).id));
    expect(ids.size).toBe(4);
  });
});

describe("buildTrickDeck — determinism", () => {
  it("same (seed, trick, target) -> identical deck and cut", () => {
    const a = buildTrickDeck(3, 1, 8, trickPrng("seed-A", 1));
    const b = buildTrickDeck(3, 1, 8, trickPrng("seed-A", 1));
    expect(a.deckSize).toBe(b.deckSize);
    expect([...a.hands.flat(), ...a.stock].map(cardKey)).toEqual(
      [...b.hands.flat(), ...b.stock].map(cardKey),
    );
  });

  it("each player dealt 5; stock = deckSize - 5*players", () => {
    const deck = buildTrickDeck(4, 1, 8, trickPrng("seed-B", 1));
    for (const hand of deck.hands) expect(hand.length).toBe(5);
    expect(deck.stock.length).toBe(deck.deckSize - 5 * 4);
  });
});

describe("default target DOES cut at <=5 players (card set changes between tricks)", () => {
  it("3 players default: deckSize = 54 - 15 = 39, distinct subsets across tricks", () => {
    const t1 = buildTrickDeck(3, 1, 8, trickPrng("low-count", 1));
    const t2 = buildTrickDeck(3, 1, 8, trickPrng("low-count", 2));
    expect(t1.deckSize).toBe(39);
    expect(t2.deckSize).toBe(39);
    const s1 = deckSet(t1);
    const s2 = deckSet(t2);
    // Distinct subsets — at least one card differs between tricks.
    const same = [...s1].every((k) => s2.has(k));
    expect(same).toBe(false);
  });

  it("lower target 5 cuts more (deckSize = 54 - 24 = 30)", () => {
    const deck = buildTrickDeck(3, 1, 5, trickPrng("low-target", 1));
    expect(deck.deckSize).toBe(30);
  });
});

describe("high target >=13 yields NO cut at 3 players", () => {
  it("target clamps but a no-cut boundary is verified via cutAmount", () => {
    // The engine clamps to [5,12]; the no-cut boundary (target>=13) is a
    // property of the formula itself.
    expect(cutAmount(3, 1, 13)).toBe(0);
  });

  it("no-cut: identical card SET across tricks, only order varies; 2 jokers in pool", () => {
    const t1 = buildTrickDeck(3, 1, 13, trickPrng("nocut", 1));
    const t2 = buildTrickDeck(3, 1, 13, trickPrng("nocut", 2));
    expect(t1.deckSize).toBe(54);
    const s1 = deckSet(t1);
    const s2 = deckSet(t2);
    expect(s1.size).toBe(s2.size);
    for (const k of s1) expect(s2.has(k)).toBe(true);
    expect(countJokers(t1)).toBe(2);
  });
});

describe("6+ players multi-deck cut", () => {
  it("6 players: pool 108, 4 jokers, cut honors formula, distinct subset per trick", () => {
    const t1 = buildTrickDeck(6, 2, 8, trickPrng("multi", 1));
    const t2 = buildTrickDeck(6, 2, 8, trickPrng("multi", 2));
    expect(t1.deckSize).toBe(108 - 30);
    const s1 = deckSet(t1);
    const s2 = deckSet(t2);
    const identical = s1.size === s2.size && [...s1].every((k) => s2.has(k));
    expect(identical).toBe(false);
  });

  it("multi-deck reproducible across runs", () => {
    const a = buildTrickDeck(6, 2, 8, trickPrng("repro", 3));
    const b = buildTrickDeck(6, 2, 8, trickPrng("repro", 3));
    expect([...a.hands.flat(), ...a.stock].map(cardKey)).toEqual(
      [...b.hands.flat(), ...b.stock].map(cardKey),
    );
  });
});

describe("recoverDeckRoundsTarget", () => {
  it("recovers a target whose cut reproduces the deck size", () => {
    for (const players of [3, 4, 5, 6, 7, 8]) {
      const numDecks = deckCount(players);
      for (const target of [5, 8, 12]) {
        const poolSize = 54 * numDecks;
        const deckSize = poolSize - cutAmount(players, numDecks, target);
        const recovered = recoverDeckRoundsTarget(players, numDecks, deckSize);
        // The recovered target must reproduce the SAME cut (deck size).
        expect(poolSize - cutAmount(players, numDecks, recovered)).toBe(
          deckSize,
        );
      }
    }
  });
});
