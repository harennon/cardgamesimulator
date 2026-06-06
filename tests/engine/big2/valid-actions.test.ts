import { describe, it, expect } from "vitest";
import {
  computeValidActions,
  isValidPlay,
  canBeatLastPlay,
} from "../../../src/backend/engine/big2/valid-actions.js";
import type {
  Big2State,
  Big2Play,
} from "../../../src/backend/engine/big2/big2-types.js";
import type { Card } from "../../../src/shared/engine-types.js";

function card(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}

const THREE_OF_CLUBS = card("3", "clubs");
const THREE_OF_DIAMONDS = card("3", "diamonds");

function makeState(overrides: Partial<Big2State>): Big2State {
  return {
    hands: [[]],
    lastPlay: null,
    lastPlayPlayerIndex: null,
    consecutivePasses: 0,
    isFreePlay: false,
    isFirstPlayOfGame: false,
    playHistory: [],
    finishedPlayerIndices: [],
    ...overrides,
  };
}

describe("computeValidActions", () => {
  it("first play of game: only playCards offered, no pass", () => {
    const state = makeState({ isFirstPlayOfGame: true, isFreePlay: true });
    const hand = [THREE_OF_CLUBS, card("4", "clubs"), card("5", "clubs")];
    const actions = computeValidActions(state, hand);
    expect(actions.map((a) => a.type)).toContain("playCards");
    expect(actions.map((a) => a.type)).not.toContain("pass");
  });

  it("free play (trick win): only playCards offered, no pass", () => {
    const state = makeState({ isFreePlay: true, isFirstPlayOfGame: false });
    const hand = [card("A", "spades"), card("K", "spades")];
    const actions = computeValidActions(state, hand);
    expect(actions.map((a) => a.type)).toContain("playCards");
    expect(actions.map((a) => a.type)).not.toContain("pass");
  });

  it("normal turn with a beatable play: both playCards and pass offered", () => {
    // Current play is 3♣ single; hand has 4♦ which beats it
    const lastPlay: Big2Play = {
      cards: [THREE_OF_CLUBS],
      handType: { kind: "single", card: THREE_OF_CLUBS },
      playerId: "p2",
    };
    const state = makeState({ isFreePlay: false, lastPlay });
    const hand = [card("4", "diamonds"), card("5", "spades")];
    const actions = computeValidActions(state, hand);
    expect(actions.map((a) => a.type)).toContain("playCards");
    expect(actions.map((a) => a.type)).toContain("pass");
  });

  it("normal turn with no beatable play: only pass offered", () => {
    // Current play is 2♠ (highest single); hand has only 3♣
    const lastPlay: Big2Play = {
      cards: [card("2", "spades")],
      handType: { kind: "single", card: card("2", "spades") },
      playerId: "p2",
    };
    const state = makeState({ isFreePlay: false, lastPlay });
    const hand = [THREE_OF_CLUBS];
    const actions = computeValidActions(state, hand);
    expect(actions.map((a) => a.type)).not.toContain("playCards");
    expect(actions.map((a) => a.type)).toContain("pass");
  });
});

describe("isValidPlay", () => {
  it("rejects cards not in hand", () => {
    const hand = [card("4", "clubs"), card("5", "clubs")];
    const result = isValidPlay(
      [card("A", "spades")],
      hand,
      null,
      true,
      false,
      THREE_OF_CLUBS,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not in hand/i);
  });

  it("rejects duplicate cards in the play", () => {
    const hand = [card("4", "clubs"), card("5", "clubs")];
    const result = isValidPlay(
      [card("4", "clubs"), card("4", "clubs")],
      hand,
      null,
      true,
      false,
      THREE_OF_CLUBS,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/duplicate/i);
  });

  it("rejects invalid card combination (3 cards)", () => {
    const hand = [card("3", "clubs"), card("4", "clubs"), card("5", "clubs")];
    const result = isValidPlay(hand, hand, null, true, false, THREE_OF_CLUBS);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/invalid card combination/i);
  });

  it("rejects play with wrong card count vs lastPlay", () => {
    const lastPlay: Big2Play = {
      cards: [THREE_OF_CLUBS],
      handType: { kind: "single", card: THREE_OF_CLUBS },
      playerId: "p2",
    };
    const hand = [card("4", "clubs"), card("4", "diamonds")];
    const result = isValidPlay(
      hand,
      hand,
      lastPlay,
      false,
      false,
      THREE_OF_CLUBS,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/same number of cards/i);
  });

  it("rejects play that does not beat lastPlay", () => {
    const lastPlay: Big2Play = {
      cards: [card("A", "spades")],
      handType: { kind: "single", card: card("A", "spades") },
      playerId: "p2",
    };
    const hand = [card("3", "clubs")];
    const result = isValidPlay(
      hand,
      hand,
      lastPlay,
      false,
      false,
      THREE_OF_CLUBS,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/does not beat/i);
  });

  it("rejects first play that does not include the lowest card", () => {
    const hand = [card("4", "clubs"), THREE_OF_DIAMONDS];
    const result = isValidPlay(
      [card("4", "clubs")],
      hand,
      null,
      true,
      true,
      THREE_OF_DIAMONDS,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/first play must include/i);
  });

  it("accepts a valid first play that includes the lowest card", () => {
    const hand = [THREE_OF_CLUBS, card("4", "clubs")];
    const result = isValidPlay(
      [THREE_OF_CLUBS],
      hand,
      null,
      true,
      true,
      THREE_OF_CLUBS,
    );
    expect(result.valid).toBe(true);
    expect(result.handType?.kind).toBe("single");
  });

  it("accepts a valid play that beats the last play", () => {
    const lastPlay: Big2Play = {
      cards: [THREE_OF_CLUBS],
      handType: { kind: "single", card: THREE_OF_CLUBS },
      playerId: "p2",
    };
    const hand = [card("4", "clubs")];
    const result = isValidPlay(
      hand,
      hand,
      lastPlay,
      false,
      false,
      THREE_OF_CLUBS,
    );
    expect(result.valid).toBe(true);
    expect(result.handType?.kind).toBe("single");
  });
});

describe("canBeatLastPlay", () => {
  it("returns true when hand has a card that beats the single", () => {
    const lastPlay: Big2Play = {
      cards: [THREE_OF_CLUBS],
      handType: { kind: "single", card: THREE_OF_CLUBS },
      playerId: "p2",
    };
    const hand = [card("4", "diamonds"), card("7", "spades")];
    expect(canBeatLastPlay(hand, lastPlay)).toBe(true);
  });

  it("returns false when no card in hand beats the single", () => {
    const lastPlay: Big2Play = {
      cards: [card("2", "spades")],
      handType: { kind: "single", card: card("2", "spades") },
      playerId: "p2",
    };
    const hand = [THREE_OF_CLUBS, card("A", "hearts")];
    expect(canBeatLastPlay(hand, lastPlay)).toBe(false);
  });

  it("returns true when hand has a pair that beats the current pair", () => {
    const lastPlay: Big2Play = {
      cards: [card("3", "clubs"), card("3", "diamonds")],
      handType: {
        kind: "pair",
        rank: "3",
        highCard: card("3", "diamonds"),
      },
      playerId: "p2",
    };
    const hand = [
      card("4", "clubs"),
      card("4", "diamonds"),
      card("5", "hearts"),
    ];
    expect(canBeatLastPlay(hand, lastPlay)).toBe(true);
  });

  it("returns false when hand has no pair that beats the current pair", () => {
    const lastPlay: Big2Play = {
      cards: [card("2", "clubs"), card("2", "diamonds")],
      handType: {
        kind: "pair",
        rank: "2",
        highCard: card("2", "diamonds"),
      },
      playerId: "p2",
    };
    // Hand has pairs but only 3s and 4s — cannot beat pair of 2s
    const hand = [
      card("3", "clubs"),
      card("3", "diamonds"),
      card("4", "clubs"),
      card("4", "diamonds"),
    ];
    expect(canBeatLastPlay(hand, lastPlay)).toBe(false);
  });

  it("returns true when hand has a 5-card combo that beats the current straight", () => {
    const lastPlay: Big2Play = {
      cards: [
        card("3", "clubs"),
        card("4", "clubs"),
        card("5", "clubs"),
        card("6", "clubs"),
        card("7", "clubs"),
      ],
      handType: { kind: "straight", highCard: card("7", "clubs") },
      playerId: "p2",
    };
    // Hand has 4-5-6-7-8 which beats 3-4-5-6-7
    const hand = [
      card("4", "diamonds"),
      card("5", "diamonds"),
      card("6", "diamonds"),
      card("7", "diamonds"),
      card("8", "diamonds"),
    ];
    expect(canBeatLastPlay(hand, lastPlay)).toBe(true);
  });

  it("returns false when no 5-card combo can beat the current straight", () => {
    const lastPlay: Big2Play = {
      cards: [
        card("9", "spades"),
        card("10", "spades"),
        card("J", "spades"),
        card("Q", "spades"),
        card("K", "spades"),
      ],
      handType: { kind: "straight", highCard: card("K", "spades") },
      playerId: "p2",
    };
    // Hand has 5 cards but they form no valid combination (no straight, no bomb)
    const hand = [
      card("3", "clubs"),
      card("5", "diamonds"),
      card("7", "hearts"),
      card("9", "spades"),
      card("J", "clubs"),
    ];
    expect(canBeatLastPlay(hand, lastPlay)).toBe(false);
  });
});
