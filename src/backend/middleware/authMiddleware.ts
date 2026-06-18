import jwt from "jsonwebtoken";
import { createPublicKey } from "crypto";
import type { KeyObject } from "crypto";
import { Request, Response, Next } from "@/util/types";
import { AccessDeniedError, UnauthorizedError } from "@/util/errors";
import { verifyGuestToken } from "@/guest/guestToken";
import type { GuestSessionStore } from "@/guest/guestSessionStore";

// Fail fast at module load (server startup) — not on first request.
const jwtSecret = process.env.SUPABASE_JWT_SECRET;
if (!jwtSecret) {
  throw new Error("SUPABASE_JWT_SECRET is required");
}

export interface SupabaseJWTPayload {
  sub: string; // user UUID (from auth.users)
  email: string;
  role: string; // 'authenticated' or 'anon'
  aud: string; // 'authenticated'
  iat: number;
  exp: number;
  user_metadata: {
    display_name?: string;
  };
}

// Cached EC public key fetched from Supabase JWKS endpoint.
// null = not yet fetched or SUPABASE_URL not configured (fall back to HS256).
let cachedJwksKey: KeyObject | null = null;

async function fetchJwksKey(supabaseUrl: string): Promise<void> {
  try {
    const url = `${supabaseUrl}/auth/v1/.well-known/jwks.json`;
    const response = await fetch(url);
    if (!response.ok) {
      return;
    }
    const body = (await response.json()) as { keys?: unknown[] };
    const keys = body.keys;
    if (!Array.isArray(keys) || keys.length === 0) {
      return;
    }
    // Use the first EC key (kty === "EC").
    const ecKey = keys.find(
      (k): k is object =>
        typeof k === "object" &&
        k !== null &&
        (k as Record<string, unknown>)["kty"] === "EC",
    );
    if (!ecKey) {
      return;
    }
    cachedJwksKey = createPublicKey({
      key: ecKey as unknown as import("crypto").JsonWebKey,
      format: "jwk",
    });
  } catch {
    // Non-fatal: fall back to HS256 verification if JWKS fetch fails.
  }
}

// Kick off JWKS fetch at startup if SUPABASE_URL is configured.
const supabaseUrl = process.env.SUPABASE_URL;
if (supabaseUrl) {
  void fetchJwksKey(supabaseUrl);
}

/**
 * Returns the cached JWKS public key, or null if not yet fetched.
 * Shared by authMiddleware (HTTP) and socketAuth (WebSocket) to avoid
 * duplicating the JWKS fetch logic.
 */
export function getCachedJwksKey(): KeyObject | null {
  return cachedJwksKey;
}

/**
 * Creates the dual-path auth middleware.
 * Takes GuestSessionStore as a parameter (dependency injection for testability).
 *
 * - Tokens prefixed with "guest:" are verified as guest tokens
 * - All other tokens are verified as Supabase JWTs
 *
 * Both paths set req.userId and req.displayName.
 * Adds req.isGuest (boolean) for route-level permission checks.
 *
 * Supabase JWT verification: tries ES256 with the cached JWKS public key first,
 * then falls back to HS256 with the shared secret (for local/dev deployments).
 */
export function createAuthMiddleware(
  guestSessionStore: GuestSessionStore,
): (req: Request, _res: Response, next: Next) => void {
  return function authMiddleware(
    req: Request,
    _res: Response,
    next: Next,
  ): void {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : undefined;

    if (!token) {
      throw new UnauthorizedError();
    }

    if (token.startsWith("guest:")) {
      const payload = verifyGuestToken(token, jwtSecret as string);
      if (!payload) {
        throw new UnauthorizedError();
      }

      const session = guestSessionStore.get(payload.guestId);
      if (!session) {
        throw new UnauthorizedError();
      }

      req.userId = session.guestId;
      req.displayName = session.displayName;
      req.isGuest = true;
      next();
      return;
    }

    let decoded: SupabaseJWTPayload;
    try {
      if (cachedJwksKey !== null) {
        // Prefer ES256 verification with the JWKS public key.
        decoded = jwt.verify(token, cachedJwksKey, {
          algorithms: ["ES256"],
        }) as unknown as SupabaseJWTPayload;
      } else {
        // Fall back to HS256 with shared secret (local dev / no SUPABASE_URL).
        decoded = jwt.verify(token, jwtSecret as string, {
          algorithms: ["HS256"],
        }) as unknown as SupabaseJWTPayload;
      }
    } catch {
      throw new UnauthorizedError();
    }

    if (decoded.role !== "authenticated") {
      throw new UnauthorizedError();
    }

    req.userId = decoded.sub;
    req.displayName = decoded.user_metadata?.display_name ?? decoded.email;
    req.isGuest = false;
    next();
  };
}

// Null-object store that always returns null — used so the legacy authMiddleware
// export rejects guest tokens (HMAC valid but no session found → 401).
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
 * Guest tokens are rejected (no session store). Supabase JWTs work as before.
 * Existing routes wired directly to this export continue to work unchanged.
 * New routes should use createAuthMiddleware(guestSessionStore) from server.ts.
 */
export const authMiddleware = createAuthMiddleware(nullStore);

/**
 * Middleware that only allows registered users (rejects guests).
 * Used on routes like POST /createGame. Throws AccessDeniedError if req.isGuest is true.
 */
export function registeredOnlyMiddleware(
  req: Request,
  _res: Response,
  next: Next,
): void {
  if (req.isGuest === true) {
    throw new AccessDeniedError();
  }
  next();
}
