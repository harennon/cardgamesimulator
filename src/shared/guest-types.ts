/** Request body for POST /guest/session */
export interface CreateGuestSessionRequest {
  displayName: string;
  gameId: string;
  existingGuestId?: string; // Optional: re-create session after server restart
}

/** Response body for POST /guest/session */
export interface CreateGuestSessionResponse {
  guestId: string;
  displayName: string; // May differ from request if deduplication applied
  token: string; // Guest token for auth (prefix: "guest:")
  gameId: string;
}

/**
 * Request body for POST /guest/claim.
 *
 * Authorization model:
 * - The `Authorization: Bearer <supabase-jwt>` header authenticates the newly-registered
 *   user. The authMiddleware sets req.userId to their new Supabase user ID.
 * - The `guestToken` in the body identifies which guest session to claim.
 * - The handler (not middleware) reads the body token and performs the ID swap:
 *   replaces guestId with req.userId in Game.playerIds and Game.playerDisplayNames.
 */
export interface ClaimGuestSessionRequest {
  guestToken: string; // The guest token identifying the guest session to claim
}

/** Response body for POST /guest/claim */
export interface ClaimGuestSessionResponse {
  success: boolean;
  gamesLinked: number; // Number of games retroactively linked to the new account
}
