import type { PlayerId } from "@shared/engine-types";

/** Server-side guest session record */
export interface GuestSession {
  readonly guestId: PlayerId; // Plain UUID (compatible with Game.playerIds uuid[] column)
  readonly displayName: string;
  readonly gameId: string; // The game this session is scoped to
  readonly createdAt: number; // Unix timestamp (ms)
  readonly expiresAt: number; // Unix timestamp (ms)
}
