import { describe, it, expect } from "vitest";
import { beats } from "../../../src/backend/engine/big2/hand-comparison.js";
import type { HandType } from "../../../src/backend/engine/big2/hand-types.js";
import type { Card } from "../../../src/shared/engine-types.js";

function card(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}

function single(c: Card): HandType {
  return { kind: "single", card: c };
}

function pair(rank: string, highCard: Card): HandType {
  return { kind: "pair", rank, highCard };
}

function straight(highCard: Card): HandType {
  return { kind: "straight", highCard };
}

function fullHouse(tripleRank: string, highCard: Card): HandType {
  return { kind: "fullHouse", tripleRank, highCard };
}

function fourOfAKind(quadRank: string, highCard: Card): HandType {
  return { kind: "fourOfAKind", quadRank, highCard };
}

function straightFlush(highCard: Card): HandType {
  return { kind: "straightFlush", highCard };
}

describe("beats — singles", () => {
  it("higher rank single beats lower rank single", () => {
    expect(
      beats(single(card("4", "spades")), single(card("3", "spades"))),
    ).toBe(true);
  });

  it("lower rank single does not beat higher rank single", () => {
    expect(
      beats(single(card("3", "spades")), single(card("4", "spades"))),
    ).toBe(false);
  });

  it("higher suit beats same rank single", () => {
    expect(
      beats(single(card("3", "spades")), single(card("3", "hearts"))),
    ).toBe(true);
  });

  it("lower suit does not beat same rank single", () => {
    expect(beats(single(card("3", "clubs")), single(card("3", "hearts")))).toBe(
      false,
    );
  });

  it("same card does not beat itself", () => {
    expect(
      beats(single(card("A", "spades")), single(card("A", "spades"))),
    ).toBe(false);
  });
});

describe("beats — pairs", () => {
  it("higher rank pair beats lower rank pair", () => {
    expect(
      beats(pair("5", card("5", "spades")), pair("4", card("4", "spades"))),
    ).toBe(true);
  });

  it("lower rank pair does not beat higher rank pair", () => {
    expect(
      beats(pair("4", card("4", "spades")), pair("5", card("5", "spades"))),
    ).toBe(false);
  });

  it("same rank pair with higher suit beats lower suit", () => {
    // Pair(5S,5H) high=5S beats Pair(5D,5C) high=5D
    expect(
      beats(pair("5", card("5", "spades")), pair("5", card("5", "diamonds"))),
    ).toBe(true);
  });

  it("same rank pair with lower suit does not beat higher suit", () => {
    expect(
      beats(pair("5", card("5", "clubs")), pair("5", card("5", "hearts"))),
    ).toBe(false);
  });

  it("identical pair does not beat itself", () => {
    expect(
      beats(pair("5", card("5", "spades")), pair("5", card("5", "spades"))),
    ).toBe(false);
  });
});

describe("beats — straights", () => {
  it("higher high-card straight beats lower", () => {
    // 4-5-6-7-8 beats 3-4-5-6-7
    expect(
      beats(straight(card("8", "clubs")), straight(card("7", "clubs"))),
    ).toBe(true);
  });

  it("lower high-card straight does not beat higher", () => {
    expect(
      beats(straight(card("7", "clubs")), straight(card("8", "clubs"))),
    ).toBe(false);
  });

  it("same rank high card: higher suit straight beats lower", () => {
    expect(
      beats(straight(card("8", "spades")), straight(card("8", "clubs"))),
    ).toBe(true);
  });

  it("identical straight does not beat itself", () => {
    expect(
      beats(straight(card("8", "spades")), straight(card("8", "spades"))),
    ).toBe(false);
  });
});

describe("beats — full houses", () => {
  it("higher triple rank full house beats lower", () => {
    // FH(KKK,44) beats FH(QQQ,AA)
    expect(
      beats(
        fullHouse("K", card("K", "spades")),
        fullHouse("Q", card("Q", "spades")),
      ),
    ).toBe(true);
  });

  it("lower triple rank full house does not beat higher", () => {
    expect(
      beats(
        fullHouse("Q", card("Q", "spades")),
        fullHouse("K", card("K", "spades")),
      ),
    ).toBe(false);
  });
});

describe("beats — four of a kind", () => {
  it("higher quad rank beats lower quad rank", () => {
    expect(
      beats(
        fourOfAKind("K", card("K", "spades")),
        fourOfAKind("Q", card("Q", "spades")),
      ),
    ).toBe(true);
  });

  it("lower quad rank does not beat higher quad rank", () => {
    expect(
      beats(
        fourOfAKind("Q", card("Q", "spades")),
        fourOfAKind("K", card("K", "spades")),
      ),
    ).toBe(false);
  });
});

describe("beats — straight flushes", () => {
  it("higher high-card straight flush beats lower", () => {
    expect(
      beats(
        straightFlush(card("8", "hearts")),
        straightFlush(card("7", "hearts")),
      ),
    ).toBe(true);
  });

  it("lower high-card straight flush does not beat higher", () => {
    expect(
      beats(
        straightFlush(card("7", "hearts")),
        straightFlush(card("8", "hearts")),
      ),
    ).toBe(false);
  });
});

describe("beats — 5-card category hierarchy", () => {
  it("full house beats any straight", () => {
    expect(
      beats(fullHouse("3", card("3", "spades")), straight(card("A", "spades"))),
    ).toBe(true);
  });

  it("straight does not beat any full house", () => {
    expect(
      beats(straight(card("A", "spades")), fullHouse("3", card("3", "spades"))),
    ).toBe(false);
  });

  it("four of a kind beats any full house", () => {
    expect(
      beats(
        fourOfAKind("3", card("3", "spades")),
        fullHouse("2", card("2", "spades")),
      ),
    ).toBe(true);
  });

  it("full house does not beat any four of a kind", () => {
    expect(
      beats(
        fullHouse("2", card("2", "spades")),
        fourOfAKind("3", card("3", "spades")),
      ),
    ).toBe(false);
  });

  it("straight flush beats any four of a kind", () => {
    expect(
      beats(
        straightFlush(card("3", "clubs")),
        fourOfAKind("2", card("2", "spades")),
      ),
    ).toBe(true);
  });

  it("four of a kind does not beat any straight flush", () => {
    expect(
      beats(
        fourOfAKind("2", card("2", "spades")),
        straightFlush(card("3", "clubs")),
      ),
    ).toBe(false);
  });

  it("straight flush beats any straight", () => {
    expect(
      beats(straightFlush(card("3", "clubs")), straight(card("A", "spades"))),
    ).toBe(true);
  });
});

describe("beats — cross size-class returns false", () => {
  it("single vs pair returns false", () => {
    expect(
      beats(single(card("2", "spades")), pair("3", card("3", "spades"))),
    ).toBe(false);
  });

  it("pair vs single returns false", () => {
    expect(
      beats(pair("3", card("3", "spades")), single(card("2", "spades"))),
    ).toBe(false);
  });

  it("single vs straight returns false", () => {
    expect(
      beats(single(card("2", "spades")), straight(card("7", "clubs"))),
    ).toBe(false);
  });
});
