import type { InternalGameState } from "@shared/engine-types";

export interface GameCacheEntry {
  state: InternalGameState;
  lastAccessedAt: number;
  isDirty: boolean;
}

export interface GameCacheConfig {
  maxEntries: number;
  evictionCheckIntervalMs: number;
  inactivityThresholdMs: number;
}

const DEFAULT_CONFIG: GameCacheConfig = {
  maxEntries: 1000,
  evictionCheckIntervalMs: 60_000,
  inactivityThresholdMs: 3_600_000,
};

export class GameCache {
  private readonly cache: Map<string, GameCacheEntry> = new Map();
  private readonly config: GameCacheConfig;
  private evictionTimer: NodeJS.Timeout | null = null;

  constructor(config?: Partial<GameCacheConfig>) {
    this.config = {
      maxEntries: config?.maxEntries ?? DEFAULT_CONFIG.maxEntries,
      evictionCheckIntervalMs: config?.evictionCheckIntervalMs ?? DEFAULT_CONFIG.evictionCheckIntervalMs,
      inactivityThresholdMs: config?.inactivityThresholdMs ?? DEFAULT_CONFIG.inactivityThresholdMs,
    };
  }

  /** Get game state from cache. Returns null if not cached (caller must load from DB). */
  get(gameId: string): InternalGameState | null {
    const entry = this.cache.get(gameId);
    if (!entry) {
      return null;
    }
    entry.lastAccessedAt = Date.now();
    return entry.state;
  }

  /** Put game state into cache. Marks as clean (just loaded or just persisted). */
  set(gameId: string, state: InternalGameState): void {
    this.evictLeastRecentlyAccessedIfFull();
    this.cache.set(gameId, {
      state,
      lastAccessedAt: Date.now(),
      isDirty: false,
    });
  }

  /** Update game state in cache after an action. Marks as dirty. */
  update(gameId: string, state: InternalGameState): void {
    const existing = this.cache.get(gameId);
    if (existing) {
      existing.state = state;
      existing.lastAccessedAt = Date.now();
      existing.isDirty = true;
    } else {
      this.evictLeastRecentlyAccessedIfFull();
      this.cache.set(gameId, {
        state,
        lastAccessedAt: Date.now(),
        isDirty: true,
      });
    }
  }

  /** Mark a game as persisted (clean). Called after successful DB write. */
  markClean(gameId: string): void {
    const entry = this.cache.get(gameId);
    if (entry) {
      entry.isDirty = false;
    }
  }

  /** Remove a game from cache. Called on game completion + successful persist. */
  evict(gameId: string): void {
    this.cache.delete(gameId);
  }

  /** Check if a game is in cache. */
  has(gameId: string): boolean {
    return this.cache.has(gameId);
  }

  /** Get all dirty entries (for batch persistence). Does not update lastAccessedAt. */
  getDirtyEntries(): Array<{ gameId: string; state: InternalGameState }> {
    const dirty: Array<{ gameId: string; state: InternalGameState }> = [];
    for (const [gameId, entry] of this.cache.entries()) {
      if (entry.isDirty) {
        dirty.push({ gameId, state: entry.state });
      }
    }
    return dirty;
  }

  /** Start the periodic eviction timer. Called once at server startup. */
  startEvictionLoop(): void {
    if (this.evictionTimer !== null) {
      return;
    }
    this.evictionTimer = setInterval(() => {
      this.evictInactive();
    }, this.config.evictionCheckIntervalMs);
  }

  /** Stop the eviction timer. Called on server shutdown. */
  stopEvictionLoop(): void {
    if (this.evictionTimer !== null) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
  }

  private evictInactive(): void {
    const threshold = Date.now() - this.config.inactivityThresholdMs;
    for (const [gameId, entry] of this.cache.entries()) {
      if (entry.lastAccessedAt < threshold) {
        this.cache.delete(gameId);
      }
    }
  }

  private evictLeastRecentlyAccessedIfFull(): void {
    if (this.cache.size < this.config.maxEntries) {
      return;
    }
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [gameId, entry] of this.cache.entries()) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestId = gameId;
      }
    }
    if (oldestId !== null) {
      this.cache.delete(oldestId);
    }
  }
}
