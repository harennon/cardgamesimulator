import { describe, it, expect } from "vitest";
import { AI_NAME_POOL, aiNameForOrdinal } from "../../src/shared/aiNames.js";

describe("AI_NAME_POOL", () => {
  it("contains exactly 7 names", () => {
    expect(AI_NAME_POOL.length).toBe(7);
  });
});

describe("aiNameForOrdinal — within pool (0..6)", () => {
  const expected = [
    "Ace",
    "Bishop",
    "Cortex",
    "Domino",
    "Echo",
    "Fable",
    "Gambit",
  ] as const;

  for (let i = 0; i < expected.length; i++) {
    const ordinal = i;
    const name = expected[i];
    it(`ordinal ${ordinal} → "${name}"`, () => {
      expect(aiNameForOrdinal(ordinal)).toBe(name);
    });
  }
});

describe("aiNameForOrdinal — cycle past the pool", () => {
  it("ordinal 7 → 'Ace 2' (first cycle)", () => {
    expect(aiNameForOrdinal(7)).toBe("Ace 2");
  });

  it("ordinal 13 → 'Gambit 2' (end of first cycle)", () => {
    expect(aiNameForOrdinal(13)).toBe("Gambit 2");
  });

  it("ordinal 14 → 'Ace 3' (second cycle)", () => {
    expect(aiNameForOrdinal(14)).toBe("Ace 3");
  });
});

describe("aiNameForOrdinal — determinism", () => {
  it("calling with the same ordinal twice returns the same name", () => {
    for (let i = 0; i < 14; i++) {
      expect(aiNameForOrdinal(i)).toBe(aiNameForOrdinal(i));
    }
  });

  it("names are unique within a 7-seat table (ordinals 0..6)", () => {
    const names = Array.from({ length: 7 }, (_, i) => aiNameForOrdinal(i));
    expect(new Set(names).size).toBe(7);
  });
});
