import { describe, it, expect } from "vitest";
import {
  buildTonkDeck,
  buildTrueLoserDeck,
} from "../../../src/backend/engine/tonk/deck.js";
import {
  cutAmount,
  buildOrderedPool,
} from "../../../src/backend/engine/tonk/constants.js";
import { SeededPRNG, hashSeed } from "../../../src/backend/engine/prng.js";
import { isJoker } from "../../../src/shared/tonk-types.js";
import type { TonkCard } from "../../../src/shared/tonk-types.js";

function trickPrng(seed: string, trickNumber: number): SeededPRNG {
  return new SeededPRNG(hashSeed(seed + ":trick:" + trickNumber).toString());
}

function cardKey(c: TonkCard): string {
  return isJoker(c) ? `joker:${c.id}` : `${c.rank}:${c.suit}`;
}

function deckSet(deck: {
  hands: readonly (readonly TonkCard[])[];
  stock: readonly TonkCard[];
}): Set<string> {
  const all = [...deck.hands.flat(), ...deck.stock];
  return new Set(all.map(cardKey));
}

describe("cutAmount — §8.1 worked examples", () => {
  it("3 players, 1 deck, default 8 → 15", () => {
    expect(cutAmount(3, 1, 8)).toBe(15);
  });
  it("3 players, 1 deck, target 12 → 3", () => {
    expect(cutAmount(3, 1, 12)).toBe(3);
  });
  it("3 players, 1 deck, target 5 → 24", () => {
    expect(cutAmount(3, 1, 5)).toBe(24);
  });
  it("3 players, 1 deck, target 13 → 0 (no-cut boundary)", () => {
    expect(cutAmount(3, 1, 13)).toBe(0);
  });
  it("6 players, 2 decks, default 8 → 30", () => {
    expect(cutAmount(6, 2, 8)).toBe(30);
  });
  it("8 players, 2 decks, default 8 → 4", () => {
    expect(cutAmount(8, 2, 8)).toBe(4);
  });
});

describe("buildOrderedPool", () => {
  it("1 deck → 54 cards, 2 jokers", () => {
    const pool = buildOrderedPool(1);
    expect(pool.length).toBe(54);
    expect(pool.filter(isJoker).length).toBe(2);
  });
  it("2 decks → 108 cards, 4 jokers, unique joker ids", () => {
    const pool = buildOrderedPool(2);
    expect(pool.length).toBe(108);
    const jokers = pool.filter(isJoker);
    expect(jokers.length).toBe(4);
    expect(new Set(jokers.map((j) => j.id)).size).toBe(4);
  });
});

describe("buildTonkDeck — determinism", () => {
  it("same (seed, trick, target) → identical deck AND identical cut", () => {
    const a = buildTonkDeck(3, 1, 8, trickPrng("seedA", 1));
    const b = buildTonkDeck(3, 1, 8, trickPrng("seedA", 1));
    expect(a.hands.map((h) => h.map(cardKey))).toEqual(
      b.hands.map((h) => h.map(cardKey)),
    );
    expect(a.stock.map(cardKey)).toEqual(b.stock.map(cardKey));
    expect(a.trickDeckSize).toBe(b.trickDeckSize);
  });

  it("deals 5 to each player; remainder is stock; trickDeckSize conserved", () => {
    const d = buildTonkDeck(3, 1, 8, trickPrng("s", 1));
    expect(d.hands.length).toBe(3);
    for (const h of d.hands) expect(h.length).toBe(5);
    // 54 - cut(15) = 39 in play; 15 dealt; 24 stock.
    expect(d.trickDeckSize).toBe(39);
    expect(d.stock.length).toBe(24);
    const total = d.hands.flat().length + d.stock.length;
    expect(total).toBe(39);
  });
});

describe("buildTonkDeck — default target cuts at <=5 players, set differs across tricks", () => {
  it("3 players default 8: card SET differs across distinct trick sub-seeds", () => {
    const t1 = buildTonkDeck(3, 1, 8, trickPrng("seedX", 1));
    const t2 = buildTonkDeck(3, 1, 8, trickPrng("seedX", 2));
    const s1 = deckSet(t1);
    const s2 = deckSet(t2);
    // Both are 39-card cut subsets of a 54-card pool → sets should differ.
    expect(s1.size).toBe(39);
    expect(s2.size).toBe(39);
    const same = [...s1].every((k) => s2.has(k)) && s1.size === s2.size;
    expect(same).toBe(false);
  });
});

describe("buildTonkDeck — high target yields NO cut at <=5 players", () => {
  it("3 players target 13: card SET identical across tricks; only order varies; 2 jokers", () => {
    const t1 = buildTonkDeck(3, 1, 13, trickPrng("seedY", 1));
    const t2 = buildTonkDeck(3, 1, 13, trickPrng("seedY", 2));
    const s1 = deckSet(t1);
    const s2 = deckSet(t2);
    expect(s1.size).toBe(54);
    expect(s2.size).toBe(54);
    // Identical SETS (full pool, no cut).
    expect([...s1].every((k) => s2.has(k))).toBe(true);
    // Joker count = 2 * numDecks = 2.
    const jokerCount = [...t1.hands.flat(), ...t1.stock].filter(isJoker).length;
    expect(jokerCount).toBe(2);
  });
});

describe("buildTonkDeck — 6+ players multi-deck", () => {
  it("6 players, 2 decks default: pool 108, 4 jokers, distinct subset per trick", () => {
    const t1 = buildTonkDeck(6, 2, 8, trickPrng("seedZ", 1));
    const t2 = buildTonkDeck(6, 2, 8, trickPrng("seedZ", 2));
    // 108 - cut(30) = 78 in play.
    expect(t1.trickDeckSize).toBe(78);
    expect(t1.hands.length).toBe(6);
    const s1 = deckSet(t1);
    const s2 = deckSet(t2);
    const identical = s1.size === s2.size && [...s1].every((k) => s2.has(k));
    expect(identical).toBe(false);
  });
});

describe("buildTrueLoserDeck", () => {
  it("is always 54 cards with exactly 2 jokers, regardless of in-play numDecks", () => {
    const deck = buildTrueLoserDeck(new SeededPRNG("tl"));
    expect(deck.length).toBe(54);
    expect(deck.filter(isJoker).length).toBe(2);
  });
  it("is deterministic for the same seed", () => {
    const a = buildTrueLoserDeck(new SeededPRNG("tl-seed"));
    const b = buildTrueLoserDeck(new SeededPRNG("tl-seed"));
    expect(a.map(cardKey)).toEqual(b.map(cardKey));
  });
});
