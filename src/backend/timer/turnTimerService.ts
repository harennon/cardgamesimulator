import type { TimerProvider, TimerHandle } from "./timerProvider.js";

export interface TurnTimerConfig {
  /** Seconds per turn. null = no timer. */
  turnTimerSeconds: number | null;
}

export type TimeoutCallback = (gameId: string) => void | Promise<void>;

export class TurnTimerService {
  private readonly activeTimers: Map<string, TimerHandle> = new Map();
  private readonly deadlines: Map<string, number> = new Map();
  private readonly configs: Map<string, TurnTimerConfig> = new Map();

  constructor(
    private readonly timerProvider: TimerProvider,
    private readonly onTimeout: TimeoutCallback,
  ) {}

  /**
   * Register a game's timer configuration. Called once when game starts.
   * Does NOT start the timer — call startTurn() after registration.
   */
  registerGame(gameId: string, config: TurnTimerConfig): void {
    this.configs.set(gameId, config);
  }

  /**
   * Start (or restart) the turn timer for a game.
   * Cancels any existing timer for this game, then schedules a new one.
   * @param isFirstTurn - if true, uses 2x the configured duration
   */
  startTurn(gameId: string, isFirstTurn: boolean): void {
    const config = this.configs.get(gameId);
    if (!config || config.turnTimerSeconds === null) return;

    this.cancelTimer(gameId);

    const multiplier = isFirstTurn ? 2 : 1;
    const durationMs = config.turnTimerSeconds * multiplier * 1000;
    const deadline = Date.now() + durationMs;

    this.deadlines.set(gameId, deadline);

    const handle = this.timerProvider.schedule(durationMs, () => {
      this.activeTimers.delete(gameId);
      this.deadlines.delete(gameId);
      this.onTimeout(gameId);
    });

    this.activeTimers.set(gameId, handle);
  }

  /**
   * Cancel the active timer for a game. Called on game completion.
   */
  cancelTimer(gameId: string): void {
    const handle = this.activeTimers.get(gameId);
    if (handle) {
      this.timerProvider.cancel(handle);
      this.activeTimers.delete(gameId);
    }
    this.deadlines.delete(gameId);
  }

  /**
   * Unregister a game entirely. Called on game completion or cache eviction.
   */
  unregisterGame(gameId: string): void {
    this.cancelTimer(gameId);
    this.configs.delete(gameId);
  }

  /**
   * Get the current deadline for a game (epoch ms).
   * Returns null if no timer is active or game has no timer configured.
   */
  getDeadline(gameId: string): number | null {
    return this.deadlines.get(gameId) ?? null;
  }

  /**
   * Check if a game has a timer configured.
   */
  hasTimer(gameId: string): boolean {
    const config = this.configs.get(gameId);
    return config != null && config.turnTimerSeconds !== null;
  }
}
