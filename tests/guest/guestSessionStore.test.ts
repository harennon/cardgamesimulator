import { describe, it, expect, vi, afterEach } from "vitest";
import { GuestSessionStore } from "../../src/backend/guest/guestSessionStore.js";

const DISPLAY_NAME = "Alice";
const GAME_ID = "game-uuid-1234-5678-90ab-cdef12345678";
const ONE_HOUR_MS = 3_600_000;

afterEach(() => {
  vi.useRealTimers();
});

describe("GuestSessionStore.create", () => {
  it("returns a session with the correct fields", () => {
    const store = new GuestSessionStore();
    const before = Date.now();
    const session = store.create(DISPLAY_NAME, GAME_ID, ONE_HOUR_MS);
    const after = Date.now();

    expect(session.displayName).toBe(DISPLAY_NAME);
    expect(session.gameId).toBe(GAME_ID);
    expect(session.createdAt).toBeGreaterThanOrEqual(before);
    expect(session.createdAt).toBeLessThanOrEqual(after);
    expect(session.expiresAt).toBeGreaterThan(session.createdAt);
  });

  it("returns a session with a valid UUID guestId", () => {
    const store = new GuestSessionStore();
    const session = store.create(DISPLAY_NAME, GAME_ID, ONE_HOUR_MS);
    expect(session.guestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("generates a unique guestId on each call", () => {
    const store = new GuestSessionStore();
    const s1 = store.create(DISPLAY_NAME, GAME_ID, ONE_HOUR_MS);
    const s2 = store.create(DISPLAY_NAME, GAME_ID, ONE_HOUR_MS);
    expect(s1.guestId).not.toBe(s2.guestId);
  });
});

describe("GuestSessionStore.get", () => {
  it("returns the session for a valid guestId", () => {
    const store = new GuestSessionStore();
    const created = store.create(DISPLAY_NAME, GAME_ID, ONE_HOUR_MS);
    const found = store.get(created.guestId);
    expect(found).not.toBeNull();
    expect(found!.guestId).toBe(created.guestId);
  });

  it("returns null for an unknown guestId", () => {
    const store = new GuestSessionStore();
    expect(store.get("unknown-guest-id")).toBeNull();
  });

  it("returns null and deletes the entry for an expired session", () => {
    vi.useFakeTimers();
    const store = new GuestSessionStore();
    const session = store.create(DISPLAY_NAME, GAME_ID, 1000);
    vi.advanceTimersByTime(2000);
    expect(store.get(session.guestId)).toBeNull();
    // Verify it was deleted (a second call also returns null)
    expect(store.get(session.guestId)).toBeNull();
  });
});

describe("GuestSessionStore.delete", () => {
  it("removes the session so subsequent get returns null", () => {
    const store = new GuestSessionStore();
    const session = store.create(DISPLAY_NAME, GAME_ID, ONE_HOUR_MS);
    store.delete(session.guestId);
    expect(store.get(session.guestId)).toBeNull();
  });

  it("does not throw when deleting a non-existent id", () => {
    const store = new GuestSessionStore();
    expect(() => store.delete("nonexistent")).not.toThrow();
  });
});

describe("GuestSessionStore.getByGame", () => {
  it("returns all active sessions for a specific game", () => {
    const store = new GuestSessionStore();
    const s1 = store.create("Alice", GAME_ID, ONE_HOUR_MS);
    const s2 = store.create("Bob", GAME_ID, ONE_HOUR_MS);
    store.create("Charlie", "other-game-id", ONE_HOUR_MS);

    const result = store.getByGame(GAME_ID);
    expect(result).toHaveLength(2);
    const ids = result.map((s) => s.guestId);
    expect(ids).toContain(s1.guestId);
    expect(ids).toContain(s2.guestId);
  });

  it("excludes expired sessions from results", () => {
    vi.useFakeTimers();
    const store = new GuestSessionStore();
    store.create("Alice", GAME_ID, 500);
    const active = store.create("Bob", GAME_ID, ONE_HOUR_MS);

    vi.advanceTimersByTime(1000);

    const result = store.getByGame(GAME_ID);
    expect(result).toHaveLength(1);
    expect(result[0]!.guestId).toBe(active.guestId);
  });

  it("deletes expired sessions encountered during scan", () => {
    vi.useFakeTimers();
    const store = new GuestSessionStore();
    const expired = store.create("Alice", GAME_ID, 500);
    store.create("Bob", GAME_ID, ONE_HOUR_MS);

    vi.advanceTimersByTime(1000);

    store.getByGame(GAME_ID);

    // Expired session should have been deleted from the store
    expect(store.get(expired.guestId)).toBeNull();
  });

  it("returns empty array when no sessions exist for game", () => {
    const store = new GuestSessionStore();
    expect(store.getByGame("no-such-game")).toEqual([]);
  });

  it("does not create a setInterval during construction", () => {
    vi.useFakeTimers();
    const store = new GuestSessionStore();
    const session = store.create(DISPLAY_NAME, GAME_ID, 500);

    // Advance time without calling getByGame — no interval should fire and delete it
    vi.advanceTimersByTime(5_000);

    // get() does lazy eviction inline, not via a timer
    expect(store.get(session.guestId)).toBeNull();
  });
});
