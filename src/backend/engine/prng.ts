import { randomBytes } from "crypto";

/**
 * Pseudorandom number generator interface.
 * All game randomness flows through this — never Math.random() directly.
 */
export interface PRNG {
  /** Returns a float in [0, 1) — same contract as Math.random() */
  next(): number;

  /** Returns an integer in [min, max] inclusive */
  nextInt(min: number, max: number): number;

  /** Fisher-Yates shuffle of an array (returns new array, does not mutate input) */
  shuffle<T>(array: readonly T[]): T[];

  /** The seed this PRNG was initialized with (for persistence/replay) */
  readonly seed: string;
}

/**
 * Hash a seed string to a 32-bit unsigned integer using djb2.
 * Exported for testing.
 */
export function hashSeed(seed: string): number {
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) + hash + seed.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Generate a random seed string using crypto.randomBytes.
 * This is the ONLY place real randomness enters the system.
 * Exported for testing.
 */
export function generateSeed(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Seeded PRNG using mulberry32.
 * Deterministic: same seed always produces same sequence.
 */
export class SeededPRNG implements PRNG {
  readonly seed: string;
  private state: number;

  constructor(seed?: string) {
    this.seed = seed ?? generateSeed();
    this.state = hashSeed(this.seed);
  }

  next(): number {
    // mulberry32
    let z = (this.state += 0x6d2b79f5) >>> 0;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    this.state = z >>> 0;
    return ((z ^ (z >>> 14)) >>> 0) / 0x100000000;
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  shuffle<T>(array: readonly T[]): T[] {
    const result = array.slice();
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const temp = result[i] as T;
      result[i] = result[j] as T;
      result[j] = temp;
    }
    return result;
  }
}

/**
 * Test-only PRNG that returns values from a predefined sequence.
 * When sequence is exhausted, wraps around.
 */
export class FixedPRNG implements PRNG {
  readonly seed: string = "fixed-test";
  private readonly values: number[];
  private index: number = 0;

  constructor(values: number[]) {
    this.values = values;
  }

  next(): number {
    if (this.values.length === 0) {
      return 0;
    }
    const val = this.values[this.index % this.values.length] as number;
    this.index++;
    return val;
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  shuffle<T>(array: readonly T[]): T[] {
    if (this.values.length === 0) {
      return array.slice();
    }
    const result = array.slice();
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const temp = result[i] as T;
      result[i] = result[j] as T;
      result[j] = temp;
    }
    return result;
  }
}
