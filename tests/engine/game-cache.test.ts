import { describe, it, expect, beforeEach, vi } from "vitest";
import { GameCache } from "../../src/backend/engine/game-cache.js";
import type { InternalGameState } from "../../src/shared/engine-types.js";

function makeState(gameId: string, version: number = 1): InternalGameState {
  return {
    gameId,
    gameType: "big2",
    status: "IN_PROGRESS",
    version,
    players: [],
    currentPlayerIndex: 0,
    turnNumber: 1,
    gameSpecificState: null,
    winner: null,
    scores: null,
    randomSeed: "test-seed",
  };
}

describe("GameCache", () => {
  let cache: GameCache;

  beforeEach(() => {
    cache = new GameCache();
  });

  describe("get", () => {
    it("returns null for a game that is not in cache", () => {
      expect(cache.get("nonexistent")).toBeNull();
    });

    it("returns the state after set", () => {
      const state = makeState("game-1");
      cache.set("game-1", state);
      expect(cache.get("game-1")).toBe(state);
    });

    it("returns null and deletes an entry that has exceeded inactivityThresholdMs", () => {
      vi.useFakeTimers();
      const timedCache = new GameCache({ inactivityThresholdMs: 5_000 });
      timedCache.set("stale-game", makeState("stale-game"));

      vi.advanceTimersByTime(6_000);

      expect(timedCache.get("stale-game")).toBeNull();
      expect(timedCache.has("stale-game")).toBe(false);

      vi.useRealTimers();
    });

    it("returns state for an entry within the inactivity threshold", () => {
      vi.useFakeTimers();
      const timedCache = new GameCache({ inactivityThresholdMs: 5_000 });
      const state = makeState("active-game");
      timedCache.set("active-game", state);

      vi.advanceTimersByTime(3_000);

      expect(timedCache.get("active-game")).toBe(state);

      vi.useRealTimers();
    });

    it("updates lastAccessedAt on successful get, preventing expiry", () => {
      vi.useFakeTimers();
      const timedCache = new GameCache({ inactivityThresholdMs: 5_000 });
      timedCache.set("active-game", makeState("active-game"));

      // Access at 3s (before threshold)
      vi.advanceTimersByTime(3_000);
      timedCache.get("active-game");

      // Advance another 4s — total 7s but last access was only 4s ago
      vi.advanceTimersByTime(4_000);

      expect(timedCache.get("active-game")).not.toBeNull();

      vi.useRealTimers();
    });
  });

  describe("set", () => {
    it("stores state and marks it as clean", () => {
      const state = makeState("game-2");
      cache.set("game-2", state);
      expect(cache.getDirtyEntries()).toHaveLength(0);
    });

    it("overwrites an existing entry and clears dirty flag", () => {
      const s1 = makeState("game-3", 1);
      const s2 = makeState("game-3", 2);
      cache.set("game-3", s1);
      cache.update("game-3", s1); // mark dirty
      cache.set("game-3", s2);
      expect(cache.get("game-3")).toBe(s2);
      expect(cache.getDirtyEntries()).toHaveLength(0);
    });

    it("evicts inactive entries before checking capacity", () => {
      vi.useFakeTimers();
      const timedCache = new GameCache({
        maxEntries: 2,
        inactivityThresholdMs: 5_000,
      });
      timedCache.set("stale-a", makeState("stale-a"));
      timedCache.set("stale-b", makeState("stale-b"));

      vi.advanceTimersByTime(6_000);

      // Both entries are now stale. Adding a new one should succeed without
      // LRU-evicting stale-a or stale-b (they get cleaned by evictInactive first).
      timedCache.set("fresh", makeState("fresh"));

      expect(timedCache.has("fresh")).toBe(true);

      vi.useRealTimers();
    });
  });

  describe("update", () => {
    it("marks the entry dirty", () => {
      const state = makeState("game-4");
      cache.set("game-4", state);
      cache.update("game-4", state);
      const dirty = cache.getDirtyEntries();
      expect(dirty).toHaveLength(1);
      expect(dirty[0]!.gameId).toBe("game-4");
    });

    it("replaces the stored state", () => {
      const s1 = makeState("game-5", 1);
      const s2 = makeState("game-5", 2);
      cache.set("game-5", s1);
      cache.update("game-5", s2);
      expect(cache.get("game-5")).toBe(s2);
    });

    it("creates entry if game was not previously in cache", () => {
      const state = makeState("game-new");
      cache.update("game-new", state);
      expect(cache.get("game-new")).toBe(state);
      expect(cache.getDirtyEntries()).toHaveLength(1);
    });
  });

  describe("markClean", () => {
    it("clears the dirty flag after update", () => {
      const state = makeState("game-6");
      cache.set("game-6", state);
      cache.update("game-6", state);
      expect(cache.getDirtyEntries()).toHaveLength(1);
      cache.markClean("game-6");
      expect(cache.getDirtyEntries()).toHaveLength(0);
    });

    it("is a no-op for non-existent game", () => {
      expect(() => cache.markClean("ghost")).not.toThrow();
    });
  });

  describe("evict", () => {
    it("removes entry so get returns null", () => {
      const state = makeState("game-7");
      cache.set("game-7", state);
      cache.evict("game-7");
      expect(cache.get("game-7")).toBeNull();
    });

    it("is a no-op for non-existent game", () => {
      expect(() => cache.evict("ghost")).not.toThrow();
    });
  });

  describe("has", () => {
    it("returns true for cached game", () => {
      cache.set("game-8", makeState("game-8"));
      expect(cache.has("game-8")).toBe(true);
    });

    it("returns false for non-cached game", () => {
      expect(cache.has("game-9")).toBe(false);
    });

    it("returns false after eviction", () => {
      cache.set("game-10", makeState("game-10"));
      cache.evict("game-10");
      expect(cache.has("game-10")).toBe(false);
    });
  });

  describe("getDirtyEntries", () => {
    it("returns empty array when no dirty entries", () => {
      cache.set("game-11", makeState("game-11"));
      expect(cache.getDirtyEntries()).toHaveLength(0);
    });

    it("returns only dirty entries when multiple games exist", () => {
      cache.set("clean-game", makeState("clean-game"));
      cache.set("dirty-game", makeState("dirty-game"));
      cache.update("dirty-game", makeState("dirty-game", 2));
      const dirty = cache.getDirtyEntries();
      expect(dirty).toHaveLength(1);
      expect(dirty[0]!.gameId).toBe("dirty-game");
    });
  });

  describe("capacity overflow eviction", () => {
    it("evicts the least-recently-accessed entry when max is reached", () => {
      const smallCache = new GameCache({ maxEntries: 2 });
      const s1 = makeState("lru-1");
      const s2 = makeState("lru-2");
      const s3 = makeState("lru-3");

      smallCache.set("lru-1", s1);
      // Access lru-2 last so lru-1 is older
      smallCache.set("lru-2", s2);
      // lru-1 was set first — inserting lru-3 must evict lru-1
      smallCache.set("lru-3", s3);

      expect(smallCache.has("lru-1")).toBe(false);
      expect(smallCache.has("lru-2")).toBe(true);
      expect(smallCache.has("lru-3")).toBe(true);
    });

    it("does not evict when under max capacity", () => {
      const smallCache = new GameCache({ maxEntries: 3 });
      smallCache.set("a", makeState("a"));
      smallCache.set("b", makeState("b"));
      expect(smallCache.has("a")).toBe(true);
      expect(smallCache.has("b")).toBe(true);
    });

    it("cache size never exceeds maxEntries", () => {
      const smallCache = new GameCache({ maxEntries: 3 });
      for (let i = 0; i < 10; i++) {
        smallCache.set(`game-${i}`, makeState(`game-${i}`));
      }
      // We verify this by checking that only 3 are in cache (no public size accessor,
      // but getDirtyEntries + set pattern verifies capacity constraint via LRU eviction)
      let count = 0;
      for (let i = 0; i < 10; i++) {
        if (smallCache.has(`game-${i}`)) count++;
      }
      expect(count).toBe(3);
    });
  });

  describe("no active handles after construction", () => {
    it("does not create a setInterval during construction", () => {
      // If a setInterval were created, fake timers would fire it.
      // We verify no timer-driven side-effects occur by confirming
      // the cache behaves purely lazily with fake timers.
      vi.useFakeTimers();
      const timedCache = new GameCache({ inactivityThresholdMs: 1_000 });
      timedCache.set("g", makeState("g"));

      // Advance time without calling get — entry should still be in has()
      vi.advanceTimersByTime(5_000);
      // has() doesn't check expiry (it's a raw map check), so it returns true
      expect(timedCache.has("g")).toBe(true);
      // get() is what triggers lazy eviction
      expect(timedCache.get("g")).toBeNull();

      vi.useRealTimers();
    });
  });
});
