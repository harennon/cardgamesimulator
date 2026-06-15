import type { TimerProvider, TimerHandle } from "@/timer/timerProvider";
import type { PlayerId } from "@shared/engine-types";

export const DISCONNECT_GRACE_PERIOD_MS = 30_000; // 30 seconds

export type DisconnectCallback = (
  gameId: string,
  playerId: PlayerId,
) => void | Promise<void>;

export class DisconnectTimerService {
  // gameId:playerId -> TimerHandle (for cancellation on reconnect)
  private readonly activeTimers: Map<string, TimerHandle> = new Map();
  // gameId -> Set<PlayerId> (players who have been marked abandoned)
  private readonly abandonedPlayers: Map<string, Set<PlayerId>> = new Map();

  constructor(
    private readonly timerProvider: TimerProvider,
    private readonly onGracePeriodExpired: DisconnectCallback,
  ) {}

  private key(gameId: string, playerId: PlayerId): string {
    return `${gameId}:${playerId}`;
  }

  /**
   * Start the grace period for a disconnected player.
   * Called when a player's last socket disconnects during an IN_PROGRESS game.
   * No-op if the player already has a running grace period timer.
   */
  startGracePeriod(gameId: string, playerId: PlayerId): void {
    const k = this.key(gameId, playerId);
    if (this.activeTimers.has(k)) return; // Already running

    const handle = this.timerProvider.schedule(
      DISCONNECT_GRACE_PERIOD_MS,
      () => {
        this.activeTimers.delete(k);
        // Mark player as abandoned
        if (!this.abandonedPlayers.has(gameId)) {
          this.abandonedPlayers.set(gameId, new Set());
        }
        this.abandonedPlayers.get(gameId)!.add(playerId);
        void this.onGracePeriodExpired(gameId, playerId);
      },
    );

    this.activeTimers.set(k, handle);
  }

  /**
   * Cancel the grace period for a player (they reconnected).
   * Also clears abandoned status if previously set.
   */
  cancelGracePeriod(gameId: string, playerId: PlayerId): void {
    const k = this.key(gameId, playerId);
    const handle = this.activeTimers.get(k);
    if (handle) {
      this.timerProvider.cancel(handle);
      this.activeTimers.delete(k);
    }
    // Clear abandoned status on reconnect
    this.abandonedPlayers.get(gameId)?.delete(playerId);
  }

  /**
   * Check if a player has been marked as abandoned (grace period expired).
   */
  isAbandoned(gameId: string, playerId: PlayerId): boolean {
    return this.abandonedPlayers.get(gameId)?.has(playerId) ?? false;
  }

  /**
   * Clean up all timers and state for a game (game completed or evicted).
   */
  unregisterGame(gameId: string): void {
    // Cancel all grace period timers for this game
    for (const [k, handle] of this.activeTimers.entries()) {
      if (k.startsWith(`${gameId}:`)) {
        this.timerProvider.cancel(handle);
        this.activeTimers.delete(k);
      }
    }
    this.abandonedPlayers.delete(gameId);
  }
}
