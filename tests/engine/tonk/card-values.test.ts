import { describe, it, expect } from "vitest";
import {
  cardValue,
  handValue,
} from "../../../src/backend/engine/tonk/constants.js";
import { c, j } from "./helpers.js";

describe("Tonk card values", () => {
  it("Ace = 1", () => {
    expect(cardValue(c("A", "spades"))).toBe(1);
  });

  it("number cards 2-10 = face value", () => {
    expect(cardValue(c("2", "clubs"))).toBe(2);
    expect(cardValue(c("5", "hearts"))).toBe(5);
    expect(cardValue(c("9", "diamonds"))).toBe(9);
    expect(cardValue(c("10", "spades"))).toBe(10);
    expect(cardValue(c("3", "clubs"))).toBe(3);
  });

  it("face cards J/Q/K = 10", () => {
    expect(cardValue(c("J", "clubs"))).toBe(10);
    expect(cardValue(c("Q", "diamonds"))).toBe(10);
    expect(cardValue(c("K", "hearts"))).toBe(10);
  });

  it("Joker = 0", () => {
    expect(cardValue(j(0))).toBe(0);
    expect(cardValue(j(1))).toBe(0);
  });
});

describe("Tonk hand value", () => {
  it("hand value is the sum of all card values", () => {
    const hand = [c("A", "spades"), c("K", "hearts"), c("5", "clubs")];
    expect(handValue(hand)).toBe(1 + 10 + 5);
  });

  it("jokers contribute 0 to hand value", () => {
    const hand = [c("Q", "spades"), j(0), j(1)];
    expect(handValue(hand)).toBe(10);
  });

  it("empty hand has value 0", () => {
    expect(handValue([])).toBe(0);
  });
});
