import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OptimisticLockError } from "../../src/backend/util/errors.js";

// ---------------------------------------------------------------------------
// OptimisticLockError unit tests (test 7 from LLD)
// ---------------------------------------------------------------------------

describe("OptimisticLockError", () => {
  it("has status 409", () => {
    const err = new OptimisticLockError("game-abc", 3);
    expect(err.status).toBe(409);
  });

  it("message includes gameId and expectedVersion", () => {
    const err = new OptimisticLockError("game-abc", 3);
    expect(err.message).toContain("game-abc");
    expect(err.message).toContain("3");
  });

  it("name is OptimisticLockError", () => {
    const err = new OptimisticLockError("game-xyz", 7);
    expect(err.name).toBe("OptimisticLockError");
  });

  it("instanceof check works correctly", () => {
    const err = new OptimisticLockError("game-xyz", 1);
    expect(err instanceof OptimisticLockError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SupabaseDB mapper + initialization unit tests (tests 1-6 from LLD)
// We access the private mappers by constructing via initialize() with mocked env,
// then triggering each method with a mocked Supabase client.
// ---------------------------------------------------------------------------

// We need to test the mappers indirectly through the public methods.
// The cleanest approach: mock the supabase-js createClient, then call the methods.

const mockSingle = vi.fn();
const mockSelect = vi.fn(() => ({ single: mockSingle }));
const mockInsert = vi.fn(() => ({ select: mockSelect }));
const mockMaybeSingle = vi.fn();
const mockSelectFrom = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockUpdate = vi.fn();
const mockEqGame = vi.fn();
const mockEqVersion = vi.fn();
const mockUpdateSelect = vi.fn();
const mockUpdateSingle = vi.fn();
const mockOrder = vi.fn();
const mockRpc = vi.fn();

// We build a flexible mock that supports chaining for each method path.
function makeChainedMock() {
  // For .from("games").insert(row).select().single()
  // For .from("games").select("*").eq("game_id", id).maybeSingle()
  // For .from("games").update({...}).eq(...).eq(...).select().single()
  // etc.

  const chainObj: Record<string, unknown> = {};

  chainObj.select = vi.fn(() => ({
    single: mockSingle,
    maybeSingle: mockMaybeSingle,
    order: mockOrder,
    eq: vi.fn(() => ({ maybeSingle: mockMaybeSingle, single: mockSingle })),
  }));

  chainObj.insert = vi.fn(() => ({
    select: vi.fn(() => ({ single: mockSingle })),
  }));

  chainObj.update = vi.fn(() => ({
    eq: vi.fn(() => ({
      eq: vi.fn(() => ({
        select: vi.fn(() => ({ single: mockUpdateSingle })),
      })),
    })),
  }));

  chainObj.order = mockOrder;

  return chainObj;
}

const mockFrom = vi.fn(() => makeChainedMock());

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: mockFrom,
    rpc: mockRpc,
  })),
}));

// Import AFTER mocking
const { SupabaseDB } = await import("../../src/backend/database/supabaseDb.js");

// SupabaseDB has a private constructor. Bypass it for unit testing only.
// All methods called on `db` below are public — no further casting needed.
type SupabaseDBInstance = InstanceType<typeof SupabaseDB>;
function makeTestInstance(): SupabaseDBInstance {
  return new (SupabaseDB as unknown as new () => SupabaseDBInstance)();
}

describe("SupabaseDB.initialize()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    process.env.SUPABASE_URL = originalEnv.SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY =
      originalEnv.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("throws when SUPABASE_URL is missing", () => {
    const db = makeTestInstance();
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "some-key";
    expect(() => db.initialize()).toThrow("SUPABASE_URL");
  });

  it("throws when SUPABASE_SERVICE_ROLE_KEY is missing", () => {
    const db = makeTestInstance();
    process.env.SUPABASE_URL = "http://localhost:54321";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => db.initialize()).toThrow("SUPABASE_SERVICE_ROLE_KEY");
  });
});

// ---------------------------------------------------------------------------
// Mapper tests — test the mappers via public methods with mocked client
// ---------------------------------------------------------------------------

// We need an initialized SupabaseDB with a mock client injected.
// Since the client is private, we initialize with valid env vars (mocked createClient).

describe("SupabaseDB mappers", () => {
  let db: SupabaseDBInstance;

  beforeEach(() => {
    db = makeTestInstance();
    process.env.SUPABASE_URL = "http://localhost:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    db.initialize();
    vi.clearAllMocks();
  });

  describe("mapGame", () => {
    it("correctly maps snake_case row to Game instance", async () => {
      const row = {
        game_id: "abc-123",
        game_type: "big2",
        player_ids: ["uid-1"],
        player_display_names: { "uid-1": "Alice" },
        max_players: 4,
        status: "CREATED",
        state: { round: 1 },
        turn_timer_seconds: 30,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
        version: 2,
      };

      // Mock the from().select("*").eq().maybeSingle() chain
      mockFrom.mockReturnValueOnce({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi
              .fn()
              .mockResolvedValueOnce({ data: row, error: null }),
          })),
        })),
      });

      const game = await db.getGame("abc-123");

      expect(game).not.toBeNull();
      expect(game!.gameId).toBe("abc-123");
      expect(game!.gameType).toBe("big2");
      expect(game!.playerIds).toEqual(["uid-1"]);
      expect(game!.playerDisplayNames).toEqual({ "uid-1": "Alice" });
      expect(game!.maxPlayers).toBe(4);
      expect(game!.status).toBe("CREATED");
      expect(game!.state).toEqual({ round: 1 });
      expect(game!.turnTimerSeconds).toBe(30);
      expect(game!.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(game!.updatedAt.toISOString()).toBe("2026-01-02T00:00:00.000Z");
      expect(game!.version).toBe(2);
    });

    it("returns null when game is not found", async () => {
      mockFrom.mockReturnValueOnce({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi
              .fn()
              .mockResolvedValueOnce({ data: null, error: null }),
          })),
        })),
      });

      const result = await db.getGame("no-such-game");
      expect(result).toBeNull();
    });

    it("maps game_config onto Game.gameConfig when present", async () => {
      const row = {
        game_id: "tonk-1",
        game_type: "tonk",
        player_ids: ["uid-1"],
        player_display_names: { "uid-1": "Alice" },
        max_players: 4,
        status: "CREATED",
        state: {},
        turn_timer_seconds: 30,
        game_config: { deckRoundsTarget: 10 },
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        version: 1,
      };
      mockFrom.mockReturnValueOnce({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi
              .fn()
              .mockResolvedValueOnce({ data: row, error: null }),
          })),
        })),
      });

      const game = await db.getGame("tonk-1");
      expect(game!.gameConfig).toEqual({ deckRoundsTarget: 10 });
    });

    it("coalesces a null/absent game_config to {}", async () => {
      const row = {
        game_id: "legacy-1",
        game_type: "big2",
        player_ids: ["uid-1"],
        player_display_names: { "uid-1": "Alice" },
        max_players: 4,
        status: "CREATED",
        state: {},
        turn_timer_seconds: 30,
        game_config: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        version: 1,
      };
      mockFrom.mockReturnValueOnce({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi
              .fn()
              .mockResolvedValueOnce({ data: row, error: null }),
          })),
        })),
      });

      const game = await db.getGame("legacy-1");
      expect(game!.gameConfig).toEqual({});
    });
  });

  describe("mapPlayerStats", () => {
    it("correctly maps snake_case row to PlayerStats instance", async () => {
      const row = {
        user_id: "user-42",
        game_type: "big2",
        games_played: 10,
        games_won: 4,
        games_lost: 6,
        total_score: 25,
        last_played_at: "2026-05-15T12:00:00.000Z",
      };

      // getStats now filters by user_id AND game_type: .eq().eq().maybeSingle()
      mockFrom.mockReturnValueOnce({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi
                .fn()
                .mockResolvedValueOnce({ data: row, error: null }),
            })),
          })),
        })),
      });

      const stats = await db.getStats("user-42", "big2");

      expect(stats).not.toBeNull();
      expect(stats!.userId).toBe("user-42");
      expect(stats!.gameType).toBe("big2");
      expect(stats!.gamesPlayed).toBe(10);
      expect(stats!.gamesWon).toBe(4);
      expect(stats!.gamesLost).toBe(6);
      expect(stats!.totalScore).toBe(25);
      expect(stats!.lastPlayedAt.toISOString()).toBe(
        "2026-05-15T12:00:00.000Z",
      );
    });
  });

  describe("mapFeedback", () => {
    it("correctly maps snake_case row to Feedback instance", async () => {
      const row = {
        id: "fb-uuid-1",
        category: "bug",
        description: "Something broke",
        metadata: {
          route: "/game/x",
          userType: "registered",
          browser: "Chrome",
        },
        user_id: "user-99",
        created_at: "2026-03-10T08:00:00.000Z",
      };

      mockFrom.mockReturnValueOnce({
        select: vi.fn(() => ({
          order: vi.fn().mockResolvedValueOnce({ data: [row], error: null }),
        })),
      });

      const feedbacks = await db.getAllFeedback();

      expect(feedbacks).toHaveLength(1);
      const fb = feedbacks[0]!;
      expect(fb.id).toBe("fb-uuid-1");
      expect(fb.category).toBe("bug");
      expect(fb.description).toBe("Something broke");
      expect(fb.userId).toBe("user-99");
      expect(fb.createdAt.toISOString()).toBe("2026-03-10T08:00:00.000Z");
    });
  });

  describe("saveGame optimistic lock", () => {
    it("throws OptimisticLockError when Supabase returns PGRST116", async () => {
      const { Game } =
        await import("../../src/backend/database/entities/Game.js");
      const game = new Game();
      game.gameId = "game-lock-test";
      game.version = 5;

      mockFrom.mockReturnValueOnce({
        update: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              select: vi.fn(() => ({
                single: vi.fn().mockResolvedValueOnce({
                  data: null,
                  error: { code: "PGRST116", message: "0 rows" },
                }),
              })),
            })),
          })),
        })),
      });

      await expect(db.saveGame(game)).rejects.toBeInstanceOf(
        OptimisticLockError,
      );
    });

    it("throws generic Error on other Supabase errors", async () => {
      const { Game } =
        await import("../../src/backend/database/entities/Game.js");
      const game = new Game();
      game.gameId = "game-error-test";
      game.version = 1;

      mockFrom.mockReturnValueOnce({
        update: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              select: vi.fn(() => ({
                single: vi.fn().mockResolvedValueOnce({
                  data: null,
                  error: { code: "PGRST500", message: "Internal error" },
                }),
              })),
            })),
          })),
        })),
      });

      await expect(db.saveGame(game)).rejects.toThrow("saveGame failed");
    });
  });
});
