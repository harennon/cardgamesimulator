import { describe, it, expect } from "vitest";
import {
  createGuestToken,
  verifyGuestToken,
} from "../../src/backend/guest/guestToken.js";

const SECRET = "test-hmac-secret-for-guest-tokens";
const GUEST_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const GAME_ID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

function futureExpiry(offsetMs = 3_600_000): number {
  return Date.now() + offsetMs;
}

describe("createGuestToken", () => {
  it("produces a token starting with 'guest:'", () => {
    const token = createGuestToken(GUEST_ID, GAME_ID, futureExpiry(), SECRET);
    expect(token.startsWith("guest:")).toBe(true);
  });

  it("produces a base64url-decodable payload after the prefix", () => {
    const token = createGuestToken(GUEST_ID, GAME_ID, futureExpiry(), SECRET);
    const encoded = token.slice(6);
    expect(() => Buffer.from(encoded, "base64url")).not.toThrow();
  });

  it("encodes guestId, gameId, and expiresAt in the payload", () => {
    const expiresAt = futureExpiry();
    const token = createGuestToken(GUEST_ID, GAME_ID, expiresAt, SECRET);
    const encoded = token.slice(6);
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    expect(decoded).toContain(GUEST_ID);
    expect(decoded).toContain(GAME_ID);
    expect(decoded).toContain(String(expiresAt));
  });
});

describe("verifyGuestToken", () => {
  it("returns payload for a valid token", () => {
    const expiresAt = futureExpiry();
    const token = createGuestToken(GUEST_ID, GAME_ID, expiresAt, SECRET);
    const result = verifyGuestToken(token, SECRET);
    expect(result).not.toBeNull();
    expect(result!.guestId).toBe(GUEST_ID);
    expect(result!.gameId).toBe(GAME_ID);
    expect(result!.expiresAt).toBe(expiresAt);
  });

  it("returns null for a tampered payload (HMAC mismatch)", () => {
    const token = createGuestToken(GUEST_ID, GAME_ID, futureExpiry(), SECRET);
    // Decode, alter payload, re-encode without updating HMAC
    const encoded = token.slice(6);
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const tampered = decoded.replace(
      GUEST_ID,
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
    );
    const tamperedToken =
      "guest:" + Buffer.from(tampered).toString("base64url");
    expect(verifyGuestToken(tamperedToken, SECRET)).toBeNull();
  });

  it("returns null for an expired token", () => {
    const pastExpiry = Date.now() - 1000;
    const token = createGuestToken(GUEST_ID, GAME_ID, pastExpiry, SECRET);
    expect(verifyGuestToken(token, SECRET)).toBeNull();
  });

  it("returns null when signed with a different secret", () => {
    const token = createGuestToken(GUEST_ID, GAME_ID, futureExpiry(), SECRET);
    expect(verifyGuestToken(token, "wrong-secret")).toBeNull();
  });

  it("returns null for a string that does not start with 'guest:'", () => {
    expect(verifyGuestToken("Bearer some.jwt.token", SECRET)).toBeNull();
  });

  it("returns null for a completely malformed token", () => {
    expect(verifyGuestToken("guest:notbase64!@#$", SECRET)).toBeNull();
  });

  it("returns null for a token with too few payload parts", () => {
    // Only one part — missing gameId and expiresAt
    const payload = "only-one-part";
    const token = "guest:" + Buffer.from(payload).toString("base64url");
    expect(verifyGuestToken(token, SECRET)).toBeNull();
  });
});
