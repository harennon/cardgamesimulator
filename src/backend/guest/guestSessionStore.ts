import { randomUUID } from "crypto";
import type { GuestSession } from "./types";
import type { PlayerId } from "@shared/engine-types";

/**
 * In-memory store for active guest sessions.
 * Sessions are scoped to a single game and auto-expire.
 */
export class GuestSessionStore {
  private readonly sessions: Map<PlayerId, GuestSession> = new Map();

  /**
   * Create and store a new guest session. Returns the session.
   * Pass existingGuestId to re-create a session for a known guest (e.g., after server restart).
   */
  create(
    displayName: string,
    gameId: string,
    ttlMs: number,
    existingGuestId?: PlayerId,
  ): GuestSession {
    const guestId = existingGuestId ?? randomUUID();
    const now = Date.now();
    const session: GuestSession = {
      guestId,
      displayName,
      gameId,
      createdAt: now,
      expiresAt: now + ttlMs,
    };
    this.sessions.set(guestId, session);
    return session;
  }

  /** Get a session by guestId. Returns null if not found or expired. */
  get(guestId: PlayerId): GuestSession | null {
    const session = this.sessions.get(guestId);
    if (!session) {
      return null;
    }
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(guestId);
      return null;
    }
    return session;
  }

  /** Delete a session (e.g., after conversion or game cleanup). */
  delete(guestId: PlayerId): void {
    this.sessions.delete(guestId);
  }

  /** Get all active guest sessions for a specific game. Deletes expired sessions encountered during scan. */
  getByGame(gameId: string): GuestSession[] {
    const now = Date.now();
    const result: GuestSession[] = [];
    for (const [guestId, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(guestId);
        continue;
      }
      if (session.gameId === gameId) {
        result.push(session);
      }
    }
    return result;
  }
}
