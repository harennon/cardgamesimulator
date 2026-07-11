import jwt from "jsonwebtoken";
import { nanoid } from "nanoid";
import type { TypedSocket } from "./socketServer.js";
import type { SupabaseJWTPayload } from "@/middleware/authMiddleware";
import { getCachedJwksKey } from "@/middleware/authMiddleware";
import { verifyGuestToken } from "@/guest/guestToken";
import type { GuestSessionStore } from "@/guest/guestSessionStore";

// Fail fast at module load — not on first connection.
const jwtSecret = process.env.SUPABASE_JWT_SECRET;
if (!jwtSecret) {
  throw new Error("SUPABASE_JWT_SECRET is required");
}

/**
 * Creates the dual-path socket auth middleware.
 * Takes GuestSessionStore as a parameter (dependency injection for testability).
 *
 * - Tokens prefixed with "guest:" are verified as guest tokens
 * - All other tokens are verified as Supabase JWTs
 *
 * Both paths set socket.data.userId and socket.data.displayName.
 * Adds socket.data.isGuest (boolean).
 */
export function createSocketAuthMiddleware(
  guestSessionStore: GuestSessionStore,
): (socket: TypedSocket, next: (err?: Error) => void) => void {
  return function socketAuthMiddleware(
    socket: TypedSocket,
    next: (err?: Error) => void,
  ): void {
    const token = socket.handshake.auth?.token;

    if (!token || typeof token !== "string") {
      next(new Error("UNAUTHORIZED: No token provided"));
      return;
    }

    // Read client-supplied correlation id from handshake auth (transport-agnostic).
    // E7: client may omit it (old client, direct curl) — we accept undefined, never mint a substitute.
    const rawCorrelationId = socket.handshake.auth?.correlationId;
    const correlationId =
      typeof rawCorrelationId === "string" && rawCorrelationId
        ? rawCorrelationId
        : undefined;

    if (token.startsWith("guest:")) {
      const payload = verifyGuestToken(token, jwtSecret as string);
      if (!payload) {
        next(new Error("UNAUTHORIZED: Invalid guest token"));
        return;
      }

      const session = guestSessionStore.get(payload.guestId);
      if (!session) {
        next(new Error("UNAUTHORIZED: Guest session not found"));
        return;
      }

      socket.data.userId = session.guestId;
      socket.data.displayName = session.displayName;
      socket.data.isGuest = true;
      socket.data.correlationId = correlationId;
      socket.data.requestId = nanoid();
      next();
      return;
    }

    try {
      let decoded: SupabaseJWTPayload;
      const jwksKey = getCachedJwksKey();
      if (jwksKey !== null) {
        // Prefer ES256 verification with the JWKS public key.
        decoded = jwt.verify(token, jwksKey, {
          algorithms: ["ES256"],
        }) as unknown as SupabaseJWTPayload;
      } else {
        // Fall back to HS256 with shared secret (local dev / no SUPABASE_URL).
        decoded = jwt.verify(token, jwtSecret as string, {
          algorithms: ["HS256"],
        }) as unknown as SupabaseJWTPayload;
      }

      if (decoded.role !== "authenticated") {
        next(new Error("UNAUTHORIZED: Invalid role"));
        return;
      }

      socket.data.userId = decoded.sub;
      socket.data.displayName =
        decoded.user_metadata?.display_name ?? decoded.email;
      socket.data.isGuest = false;
      socket.data.correlationId = correlationId;
      socket.data.requestId = nanoid();
      next();
    } catch {
      next(new Error("UNAUTHORIZED: Invalid token"));
    }
  };
}

// Null-object store — used so the legacy export rejects guest tokens.
const nullStore = {
  create: (): never => {
    throw new Error("nullStore.create should never be called");
  },
  get: (): null => null,
  delete: (): void => undefined,
  getByGame: (): never[] => [],
} as unknown as GuestSessionStore;

/**
 * Backwards-compatible single-instance middleware.
 * Guest tokens are rejected (no session store). Existing wiring in server.ts
 * will be replaced by createSocketAuthMiddleware(guestSessionStore).
 */
export const socketAuthMiddleware = createSocketAuthMiddleware(nullStore);
