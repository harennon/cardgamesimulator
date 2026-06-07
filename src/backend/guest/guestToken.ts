import { createHmac, timingSafeEqual } from "crypto";
import type { PlayerId } from "@shared/engine-types";

/**
 * Create a guest token: "guest:" + base64url(guestId.gameId.expiresAt.hmacSignature)
 * The "guest:" prefix allows the auth middleware to quickly identify guest tokens.
 */
export function createGuestToken(
  guestId: PlayerId,
  gameId: string,
  expiresAt: number,
  secret: string,
): string {
  const payload = `${guestId}.${gameId}.${expiresAt}`;
  const hmac = createHmac("sha256", secret).update(payload).digest("base64url");
  const encoded = Buffer.from(`${payload}.${hmac}`).toString("base64url");
  return `guest:${encoded}`;
}

/**
 * Verify and decode a guest token. Returns null if invalid or expired.
 */
export function verifyGuestToken(
  token: string,
  secret: string,
): { guestId: PlayerId; gameId: string; expiresAt: number } | null {
  if (!token.startsWith("guest:")) {
    return null;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(token.slice(6), "base64url").toString("utf8");
  } catch {
    return null;
  }

  const lastDot = decoded.lastIndexOf(".");
  if (lastDot === -1) {
    return null;
  }

  const payload = decoded.slice(0, lastDot);
  const providedHmac = decoded.slice(lastDot + 1);

  const expectedHmac = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  const a = Buffer.from(expectedHmac);
  const b = Buffer.from(providedHmac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }

  const parts = payload.split(".");
  // guestId is a UUID (contains 4 dashes, so 5 parts), gameId is a UUID (5 parts), expiresAt is the last part
  // Format: guestId(uuid).gameId(uuid).expiresAt
  // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx — no dots, so splitting by "." gives exactly 3 parts
  if (parts.length !== 3) {
    return null;
  }

  const [guestId, gameId, expiresAtStr] = parts as [string, string, string];
  const expiresAt = parseInt(expiresAtStr, 10);

  if (isNaN(expiresAt)) {
    return null;
  }

  if (Date.now() > expiresAt) {
    return null;
  }

  return { guestId, gameId, expiresAt };
}
