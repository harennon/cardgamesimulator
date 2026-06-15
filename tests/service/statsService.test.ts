import { describe, it, expect, vi, beforeEach } from "vitest";
import { StatsService } from "../../src/backend/service/statsService.js";
import type {
  PlayerStatsRepository,
  StatsDelta,
} from "../../src/backend/database/database.js";
import type { GuestSessionStore } from "../../src/backend/guest/guestSessionStore.js";
import type { InternalGameState } from "../../src/shared/engine-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatsRepo(
  overrides: Partial<PlayerStatsRepository> = {},
): PlayerStatsRepository {
  return {
    getStats: vi.fn().mockResolvedValue(null),
    incrementStats: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeGuestSessionStore(guestIds: string[] = []): GuestSessionStore {
  return {
    get: vi.fn((id: string) => (guestIds.includes(id) ? { id } : null)),
    set: vi.fn(),
    delete: vi.fn(),
    startCleanupLoop: vi.fn(),
    stopCleanupLoop: vi.fn(),
  } as unknown as GuestSessionStore;
}

function makeCompletedState(
  overrides: Partial<InternalGameState> = {},
): InternalGameState {
  return {
    gameId: "game-1",
    gameType: "big2",
    status: "COMPLETED",
    version: 5,
    players: [
      { playerId: "player-a", displayName: "Alice" },
      { playerId: "player-b", displayName: "Bob" },
    ],
    currentPlayerIndex: 0,
    turnNumber: 20,
    gameSpecificState: null,
    winner: "player-a",
    scores: [
      { playerId: "player-a", score: 10 },
      { playerId: "player-b", score: 5 },
    ],
    randomSeed: "seed-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StatsService.recordGameCompletion", () => {
  it("calls incrementStats once per player in a completed game", async () => {
    const repo = makeStatsRepo();
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    await service.recordGameCompletion(makeCompletedState());

    expect(repo.incrementStats).toHaveBeenCalledTimes(2);
  });

  it("winner gets gamesWon: 1 and gamesLost: 0", async () => {
    const repo = makeStatsRepo();
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    await service.recordGameCompletion(makeCompletedState());

    const calls = vi.mocked(repo.incrementStats).mock.calls;
    const winnerCall = calls.find((c) => c[0] === "player-a");
    expect(winnerCall).toBeDefined();
    const winnerDelta = winnerCall![1] as StatsDelta;
    expect(winnerDelta.gamesWon).toBe(1);
    expect(winnerDelta.gamesLost).toBe(0);
    expect(winnerDelta.gamesPlayed).toBe(1);
  });

  it("non-winner gets gamesWon: 0 and gamesLost: 1", async () => {
    const repo = makeStatsRepo();
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    await service.recordGameCompletion(makeCompletedState());

    const calls = vi.mocked(repo.incrementStats).mock.calls;
    const loserCall = calls.find((c) => c[0] === "player-b");
    expect(loserCall).toBeDefined();
    const loserDelta = loserCall![1] as StatsDelta;
    expect(loserDelta.gamesWon).toBe(0);
    expect(loserDelta.gamesLost).toBe(1);
    expect(loserDelta.gamesPlayed).toBe(1);
  });

  it("correct totalScore is extracted from PlayerScore for each player", async () => {
    const repo = makeStatsRepo();
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    await service.recordGameCompletion(makeCompletedState());

    const calls = vi.mocked(repo.incrementStats).mock.calls;
    const aCall = calls.find((c) => c[0] === "player-a");
    const bCall = calls.find((c) => c[0] === "player-b");
    expect((aCall![1] as StatsDelta).totalScore).toBe(10);
    expect((bCall![1] as StatsDelta).totalScore).toBe(5);
  });

  it("skips guest players — incrementStats not called for guests", async () => {
    const repo = makeStatsRepo();
    // player-b is a guest
    const guestStore = makeGuestSessionStore(["player-b"]);
    const service = new StatsService(repo, guestStore);

    await service.recordGameCompletion(makeCompletedState());

    expect(repo.incrementStats).toHaveBeenCalledTimes(1);
    expect(repo.incrementStats).toHaveBeenCalledWith(
      "player-a",
      expect.any(Object),
    );
    expect(repo.incrementStats).not.toHaveBeenCalledWith(
      "player-b",
      expect.any(Object),
    );
  });

  it("returns early without calling incrementStats when status is not COMPLETED", async () => {
    const repo = makeStatsRepo();
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    await service.recordGameCompletion(
      makeCompletedState({ status: "IN_PROGRESS" }),
    );

    expect(repo.incrementStats).not.toHaveBeenCalled();
  });

  it("returns early without calling incrementStats when scores array is empty", async () => {
    const repo = makeStatsRepo();
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    await service.recordGameCompletion(makeCompletedState({ scores: [] }));

    expect(repo.incrementStats).not.toHaveBeenCalled();
  });

  it("returns early without calling incrementStats when scores is null", async () => {
    const repo = makeStatsRepo();
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    await service.recordGameCompletion(makeCompletedState({ scores: null }));

    expect(repo.incrementStats).not.toHaveBeenCalled();
  });

  it("continues recording other players' stats when one player's incrementStats throws", async () => {
    let callCount = 0;
    const repo = makeStatsRepo({
      incrementStats: vi.fn().mockImplementation(async (userId: string) => {
        callCount++;
        if (userId === "player-a") {
          throw new Error("DB connection lost");
        }
      }),
    });
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    // Should not throw even though player-a's increment fails
    await expect(
      service.recordGameCompletion(makeCompletedState()),
    ).resolves.toBeUndefined();

    // Both players were attempted
    expect(callCount).toBe(2);
  });
});
