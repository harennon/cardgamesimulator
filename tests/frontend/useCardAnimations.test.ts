import { describe, it, expect } from "vitest";
import {
  isFreshDeal,
  playKey,
  discardKey,
} from "../../src/frontend/composables/useCardAnimations.js";

// ---------------------------------------------------------------------------
// LLD 152 — useCardAnimations pure helper unit tests.
// Tests the decision logic (when to arm animations) without DOM mounting.
// ---------------------------------------------------------------------------

describe("isFreshDeal", () => {
  it("returns true on empty → full transition (round start)", () => {
    expect(isFreshDeal(0, 13)).toBe(true);
  });

  it("returns true on empty → small hand (short deal)", () => {
    expect(isFreshDeal(0, 5)).toBe(true);
  });

  it("returns false when hand shrinks (local player plays a card)", () => {
    // E1: play/discard reduces hand size — must NOT re-arm deal-in
    expect(isFreshDeal(13, 12)).toBe(false);
  });

  it("returns false when hand grows by one (Tonk draw)", () => {
    // E2: a single draw is not a fresh deal
    expect(isFreshDeal(10, 11)).toBe(false);
  });

  it("returns false when hand length is unchanged (unrelated re-render)", () => {
    expect(isFreshDeal(13, 13)).toBe(false);
  });

  it("returns false when nextLen is 0 (no cards to animate)", () => {
    expect(isFreshDeal(0, 0)).toBe(false);
  });

  it("returns false for a full→full swap at same size", () => {
    expect(isFreshDeal(7, 7)).toBe(false);
  });

  it("does not gate on motion preference (motion-agnostic)", () => {
    // The helper has no branch on prefers-reduced-motion — CSS handles it.
    // Simply verifying the return type is boolean for both transitions.
    const result = isFreshDeal(0, 13);
    expect(typeof result).toBe("boolean");
  });
});

describe("playKey", () => {
  it("returns empty string for null lastPlay (free trick / no play)", () => {
    expect(playKey(null)).toBe("");
  });

  it("returns a stable string for the same play across two calls (idempotent)", () => {
    // E6: same play arriving again (e.g. window resize) must not re-animate
    const play = {
      playerId: "player-1",
      cards: [
        { rank: "A", suit: "spades" },
        { rank: "A", suit: "hearts" },
      ],
    };
    expect(playKey(play)).toBe(playKey(play));
  });

  it("returns a different string when a different player plays", () => {
    const play1 = {
      playerId: "player-1",
      cards: [{ rank: "3", suit: "clubs" }],
    };
    const play2 = {
      playerId: "player-2",
      cards: [{ rank: "3", suit: "clubs" }],
    };
    expect(playKey(play1)).not.toBe(playKey(play2));
  });

  it("returns a different string when the same player plays different cards", () => {
    const play1 = {
      playerId: "player-1",
      cards: [{ rank: "3", suit: "clubs" }],
    };
    const play2 = {
      playerId: "player-1",
      cards: [{ rank: "4", suit: "clubs" }],
    };
    expect(playKey(play1)).not.toBe(playKey(play2));
  });

  it("includes all card ranks and suits in the key", () => {
    const play = {
      playerId: "p1",
      cards: [
        { rank: "K", suit: "diamonds" },
        { rank: "K", suit: "clubs" },
      ],
    };
    const key = playKey(play);
    expect(key).toContain("p1");
    expect(key).toContain("Kdiamonds");
    expect(key).toContain("Kclubs");
  });

  it("returns a different string for a new play (new cards, same player)", () => {
    const firstPlay = {
      playerId: "p1",
      cards: [{ rank: "2", suit: "spades" }],
    };
    const secondPlay = {
      playerId: "p1",
      cards: [{ rank: "3", suit: "spades" }],
    };
    expect(playKey(firstPlay)).not.toBe(playKey(secondPlay));
  });
});

describe("discardKey", () => {
  it("returns empty string for null discard top", () => {
    expect(discardKey(null, 0)).toBe("");
  });

  it("changes when discardCount increments even if top card rank/suit repeats", () => {
    // Same card, different discard count → different key (new discard landed)
    const card = { rank: "5", suit: "hearts" };
    const key1 = discardKey(card, 3);
    const key2 = discardKey(card, 4);
    expect(key1).not.toBe(key2);
  });

  it("returns the same string for the same discard top and count (idempotent)", () => {
    const card = { rank: "J", suit: "clubs" };
    expect(discardKey(card, 7)).toBe(discardKey(card, 7));
  });

  it("includes discardCount in the key", () => {
    const card = { rank: "A", suit: "spades" };
    const key = discardKey(card, 5);
    expect(key.startsWith("5:")).toBe(true);
  });

  it("uses card id when present (joker cards)", () => {
    const joker = { id: "joker-1" };
    const key = discardKey(joker, 2);
    expect(key).toContain("joker-1");
  });

  it("falls back to rank+suit when id is absent", () => {
    const card = { rank: "Q", suit: "diamonds" };
    const key = discardKey(card, 1);
    expect(key).toContain("Qdiamonds");
  });

  it("does not gate on motion preference (motion-agnostic)", () => {
    const card = { rank: "2", suit: "clubs" };
    const result = discardKey(card, 1);
    expect(typeof result).toBe("string");
  });
});
