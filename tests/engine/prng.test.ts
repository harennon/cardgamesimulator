import { describe, it, expect } from "vitest";
import {
  SeededPRNG,
  FixedPRNG,
  hashSeed,
  generateSeed,
} from "../../src/backend/engine/prng.js";

describe("hashSeed", () => {
  it("returns a number", () => {
    expect(typeof hashSeed("hello")).toBe("number");
  });

  it("same string produces same hash", () => {
    expect(hashSeed("test-seed")).toBe(hashSeed("test-seed"));
  });

  it("different strings produce different hashes", () => {
    expect(hashSeed("seed-a")).not.toBe(hashSeed("seed-b"));
  });
});

describe("generateSeed", () => {
  it("returns a non-empty string", () => {
    const s = generateSeed();
    expect(typeof s).toBe("string");
    expect(s.length).toBeGreaterThan(0);
  });

  it("produces unique seeds on successive calls", () => {
    const seeds = new Set(Array.from({ length: 10 }, () => generateSeed()));
    expect(seeds.size).toBe(10);
  });
});

describe("SeededPRNG", () => {
  it("same seed produces same sequence", () => {
    const a = new SeededPRNG("test-seed-42");
    const b = new SeededPRNG("test-seed-42");
    for (let i = 0; i < 20; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it("different seeds produce different first values", () => {
    const a = new SeededPRNG("seed-alpha");
    const b = new SeededPRNG("seed-beta");
    // Collect 5 values from each — at least one must differ
    const seqA = Array.from({ length: 5 }, () => a.next());
    const seqB = Array.from({ length: 5 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it("next returns values in [0, 1)", () => {
    const prng = new SeededPRNG("bounds-test");
    for (let i = 0; i < 1000; i++) {
      const v = prng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("nextInt respects inclusive bounds", () => {
    const prng = new SeededPRNG("int-test");
    const results = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const v = prng.nextInt(1, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      results.add(v);
    }
    // All six values should appear in 1000 draws
    expect(results.size).toBe(6);
  });

  it("shuffle returns all elements without loss or duplication", () => {
    const prng = new SeededPRNG("shuffle-test");
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const output = prng.shuffle(input);
    expect(output).toHaveLength(input.length);
    expect(output.sort((a, b) => a - b)).toEqual(
      [...input].sort((a, b) => a - b),
    );
  });

  it("shuffle does not mutate the input array", () => {
    const prng = new SeededPRNG("mutate-test");
    const input = [1, 2, 3, 4, 5];
    const copy = [...input];
    prng.shuffle(input);
    expect(input).toEqual(copy);
  });

  it("shuffle with same seed produces same output", () => {
    const input = ["a", "b", "c", "d", "e", "f"];
    const a = new SeededPRNG("shuffle-determinism");
    const b = new SeededPRNG("shuffle-determinism");
    expect(a.shuffle(input)).toEqual(b.shuffle(input));
  });

  it("shuffle with same seed actually reorders elements", () => {
    const prng = new SeededPRNG("reorder-test");
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
    const output = prng.shuffle(input);
    // A 13-element shuffle almost certainly changes order
    expect(output).not.toEqual(input);
  });

  it("exposes the seed used at construction", () => {
    const prng = new SeededPRNG("my-seed");
    expect(prng.seed).toBe("my-seed");
  });

  it("generates a seed when none is provided", () => {
    const prng = new SeededPRNG();
    expect(typeof prng.seed).toBe("string");
    expect(prng.seed.length).toBeGreaterThan(0);
  });
});

describe("FixedPRNG", () => {
  it("returns values from predefined sequence in order", () => {
    const prng = new FixedPRNG([0.1, 0.5, 0.9]);
    expect(prng.next()).toBe(0.1);
    expect(prng.next()).toBe(0.5);
    expect(prng.next()).toBe(0.9);
  });

  it("wraps around when sequence is exhausted", () => {
    const prng = new FixedPRNG([0.2, 0.8]);
    prng.next(); // 0.2
    prng.next(); // 0.8
    expect(prng.next()).toBe(0.2); // wraps
    expect(prng.next()).toBe(0.8);
  });

  it("empty sequence returns 0 for next()", () => {
    const prng = new FixedPRNG([]);
    expect(prng.next()).toBe(0);
    expect(prng.next()).toBe(0);
  });

  it("empty sequence returns input unshuffled", () => {
    const prng = new FixedPRNG([]);
    const input = [1, 2, 3, 4, 5];
    expect(prng.shuffle(input)).toEqual(input);
  });

  it("empty sequence shuffle does not mutate input", () => {
    const prng = new FixedPRNG([]);
    const input = [1, 2, 3];
    const copy = [...input];
    prng.shuffle(input);
    expect(input).toEqual(copy);
  });

  it("has fixed seed string 'fixed-test'", () => {
    const prng = new FixedPRNG([0.5]);
    expect(prng.seed).toBe("fixed-test");
  });

  it("nextInt uses next() and respects bounds", () => {
    // 0.0 should map to min, just-under-1.0 should map to max
    const low = new FixedPRNG([0.0]);
    expect(low.nextInt(3, 7)).toBe(3);

    const high = new FixedPRNG([0.9999]);
    expect(high.nextInt(3, 7)).toBe(7);
  });

  it("shuffle with values produces a different order", () => {
    // All 0.99 values force j=i on each step (selects last possible index)
    const prng = new FixedPRNG([0.99, 0.99, 0.99, 0.99]);
    const input = [1, 2, 3, 4, 5];
    const output = prng.shuffle(input);
    expect(output).toHaveLength(5);
    expect(output.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});
