import { describe, it, expect } from "vitest";
import { generateJoinCode } from "../../src/backend/service/joinCodeService.js";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

describe("generateJoinCode", () => {
  it("returns a 4-character string", () => {
    const code = generateJoinCode();
    expect(code).toHaveLength(4);
  });

  it("only contains characters from the reduced alphabet", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateJoinCode();
      for (const char of code) {
        expect(ALPHABET).toContain(char);
      }
    }
  });

  it("returns uppercase characters", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateJoinCode();
      expect(code).toBe(code.toUpperCase());
    }
  });

  it("generates different codes across calls (not deterministic)", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) {
      codes.add(generateJoinCode());
    }
    // With 810k possible codes, 50 calls should produce at least 40 unique
    expect(codes.size).toBeGreaterThan(40);
  });
});
