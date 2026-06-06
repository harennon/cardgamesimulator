import { describe, it, expect } from "vitest";
import { detectHandType } from "../../../src/backend/engine/big2/hand-detection.js";
import type { Card } from "../../../src/shared/engine-types.js";

function card(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}

describe("detectHandType — single", () => {
  it("detects a single card", () => {
    const result = detectHandType([card("A", "spades")]);
    expect(result).toEqual({ kind: "single", card: card("A", "spades") });
  });

  it("detects the 3 of clubs as a single", () => {
    const result = detectHandType([card("3", "clubs")]);
    expect(result?.kind).toBe("single");
  });
});

describe("detectHandType — pair", () => {
  it("detects a pair of same rank, picks higher suit as highCard", () => {
    const result = detectHandType([card("5", "clubs"), card("5", "spades")]);
    expect(result?.kind).toBe("pair");
    if (result?.kind === "pair") {
      expect(result.rank).toBe("5");
      expect(result.highCard).toEqual(card("5", "spades"));
    }
  });

  it("rejects two cards of different rank", () => {
    const result = detectHandType([card("5", "clubs"), card("6", "clubs")]);
    expect(result).toBeNull();
  });
});

describe("detectHandType — invalid counts", () => {
  it("rejects 3 cards", () => {
    expect(
      detectHandType([
        card("3", "clubs"),
        card("3", "diamonds"),
        card("3", "hearts"),
      ]),
    ).toBeNull();
  });

  it("rejects 4 cards", () => {
    expect(
      detectHandType([
        card("3", "clubs"),
        card("3", "diamonds"),
        card("3", "hearts"),
        card("3", "spades"),
      ]),
    ).toBeNull();
  });

  it("rejects 0 cards", () => {
    expect(detectHandType([])).toBeNull();
  });

  it("rejects 6 cards", () => {
    expect(
      detectHandType([
        card("3", "clubs"),
        card("4", "clubs"),
        card("5", "clubs"),
        card("6", "clubs"),
        card("7", "clubs"),
        card("8", "clubs"),
      ]),
    ).toBeNull();
  });
});

describe("detectHandType — straight", () => {
  it("detects 3-4-5-6-7 as a straight", () => {
    const result = detectHandType([
      card("3", "clubs"),
      card("4", "diamonds"),
      card("5", "hearts"),
      card("6", "spades"),
      card("7", "clubs"),
    ]);
    expect(result?.kind).toBe("straight");
    if (result?.kind === "straight") {
      expect(result.highCard).toEqual(card("7", "clubs"));
    }
  });

  it("detects 10-J-Q-K-A as a straight (A-high)", () => {
    const result = detectHandType([
      card("10", "clubs"),
      card("J", "diamonds"),
      card("Q", "hearts"),
      card("K", "spades"),
      card("A", "clubs"),
    ]);
    expect(result?.kind).toBe("straight");
    if (result?.kind === "straight") {
      expect(result.highCard).toEqual(card("A", "clubs"));
    }
  });

  it("rejects a straight containing rank 2", () => {
    const result = detectHandType([
      card("A", "clubs"),
      card("2", "clubs"),
      card("3", "clubs"),
      card("4", "clubs"),
      card("5", "diamonds"),
    ]);
    expect(result).toBeNull();
  });

  it("rejects wrapping Q-K-A-3-4", () => {
    const result = detectHandType([
      card("Q", "clubs"),
      card("K", "clubs"),
      card("A", "clubs"),
      card("3", "diamonds"),
      card("4", "diamonds"),
    ]);
    expect(result).toBeNull();
  });

  it("rejects non-consecutive 3-4-5-6-8", () => {
    const result = detectHandType([
      card("3", "clubs"),
      card("4", "clubs"),
      card("5", "clubs"),
      card("6", "clubs"),
      card("8", "clubs"),
    ]);
    // All same suit but non-consecutive — also not a straight flush
    expect(result).toBeNull();
  });
});

describe("detectHandType — full house", () => {
  it("detects a full house (triple + pair)", () => {
    const result = detectHandType([
      card("K", "clubs"),
      card("K", "diamonds"),
      card("K", "hearts"),
      card("4", "clubs"),
      card("4", "spades"),
    ]);
    expect(result?.kind).toBe("fullHouse");
    if (result?.kind === "fullHouse") {
      expect(result.tripleRank).toBe("K");
      expect(result.highCard).toEqual(card("K", "hearts"));
    }
  });

  it("detects full house where pair comes before triple in hand order", () => {
    const result = detectHandType([
      card("4", "clubs"),
      card("4", "spades"),
      card("K", "clubs"),
      card("K", "diamonds"),
      card("K", "hearts"),
    ]);
    expect(result?.kind).toBe("fullHouse");
    if (result?.kind === "fullHouse") {
      expect(result.tripleRank).toBe("K");
    }
  });
});

describe("detectHandType — four of a kind", () => {
  it("detects four of a kind with a kicker", () => {
    const result = detectHandType([
      card("A", "clubs"),
      card("A", "diamonds"),
      card("A", "hearts"),
      card("A", "spades"),
      card("3", "clubs"),
    ]);
    expect(result?.kind).toBe("fourOfAKind");
    if (result?.kind === "fourOfAKind") {
      expect(result.quadRank).toBe("A");
      expect(result.highCard).toEqual(card("A", "spades"));
    }
  });
});

describe("detectHandType — straight flush", () => {
  it("detects a straight flush (5 consecutive same suit)", () => {
    const result = detectHandType([
      card("3", "hearts"),
      card("4", "hearts"),
      card("5", "hearts"),
      card("6", "hearts"),
      card("7", "hearts"),
    ]);
    expect(result?.kind).toBe("straightFlush");
    if (result?.kind === "straightFlush") {
      expect(result.highCard).toEqual(card("7", "hearts"));
    }
  });

  it("detects 10-J-Q-K-A of same suit as straight flush", () => {
    const result = detectHandType([
      card("10", "spades"),
      card("J", "spades"),
      card("Q", "spades"),
      card("K", "spades"),
      card("A", "spades"),
    ]);
    expect(result?.kind).toBe("straightFlush");
  });
});

describe("detectHandType — invalid 5-card hands", () => {
  it("returns null for 5 cards that form no valid combination", () => {
    const result = detectHandType([
      card("3", "clubs"),
      card("3", "diamonds"),
      card("5", "hearts"),
      card("8", "spades"),
      card("J", "clubs"),
    ]);
    expect(result).toBeNull();
  });
});
