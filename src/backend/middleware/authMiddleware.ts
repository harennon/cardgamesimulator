import jwt from "jsonwebtoken";
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

/**
 * Creates the dual-path auth middleware.
 * Takes GuestSessionStore as a parameter (dependency injection for testability).
 *
 * - Tokens prefixed with "guest:" are verified as guest tokens
 * - All other tokens are verified as Supabase JWTs
 *
 * Both paths set req.userId and req.displayName.
 * Adds req.isGuest (boolean) for route-level permission checks.
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
      decoded = jwt.verify(token, jwtSecret as string, {
        algorithms: ["HS256"],
      }) as unknown as SupabaseJWTPayload;
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
  startCleanupLoop: (): void => undefined,
  stopCleanupLoop: (): void => undefined,
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
