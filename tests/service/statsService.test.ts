import { describe, it, expect, vi, beforeEach } from "vitest";
import { StatsService } from "../../src/backend/service/statsService.js";
import type {
  PlayerStatsRepository,
  StatsDelta,
  GameHistoryRow,
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
    getAllStats: vi.fn().mockResolvedValue([]),
    incrementStats: vi.fn().mockResolvedValue(undefined),
    recordGameHistory: vi.fn().mockResolvedValue(undefined),
    getWindowedStats: vi.fn().mockResolvedValue([]),
    getTrackingSince: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function makeGuestSessionStore(guestIds: string[] = []): GuestSessionStore {
  return {
    get: vi.fn((id: string) => (guestIds.includes(id) ? { id } : null)),
    set: vi.fn(),
    delete: vi.fn(),
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

  // U1: incrementStats receives state.gameType for each non-guest player.
  it("passes state.gameType ('big2') to incrementStats for every player", async () => {
    const repo = makeStatsRepo();
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    await service.recordGameCompletion(makeCompletedState());

    const calls = vi.mocked(repo.incrementStats).mock.calls;
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call[1]).toBe("big2");
    }
  });

  // U2: a state with gameType "tonk" causes incrementStats(..., "tonk", ...).
  // Pure mapping test — does not exercise any Tonk derivation logic.
  it("passes 'tonk' to incrementStats when state.gameType is 'tonk'", async () => {
    const repo = makeStatsRepo();
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    await service.recordGameCompletion(
      makeCompletedState({ gameType: "tonk" }),
    );

    const calls = vi.mocked(repo.incrementStats).mock.calls;
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call[1]).toBe("tonk");
    }
  });

  // U4: the StatsDelta shape passed to the repo is unchanged
  // ({ gamesPlayed, gamesWon, gamesLost, totalScore }) regardless of game type.
  // Locks the §7 "counters independent / delta shape unchanged" contract.
  it("passes an unchanged StatsDelta shape (keys) to incrementStats", async () => {
    const repo = makeStatsRepo();
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    await service.recordGameCompletion(makeCompletedState());

    const calls = vi.mocked(repo.incrementStats).mock.calls;
    const winnerCall = calls.find((c) => c[0] === "player-a");
    const delta = winnerCall![2] as StatsDelta;
    expect(Object.keys(delta).sort()).toEqual(
      ["gamesLost", "gamesPlayed", "gamesWon", "totalScore"].sort(),
    );
  });

  it("winner gets gamesWon: 1 and gamesLost: 0", async () => {
    const repo = makeStatsRepo();
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    await service.recordGameCompletion(makeCompletedState());

    const calls = vi.mocked(repo.incrementStats).mock.calls;
    const winnerCall = calls.find((c) => c[0] === "player-a");
    expect(winnerCall).toBeDefined();
    const winnerDelta = winnerCall![2] as StatsDelta;
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
    const loserDelta = loserCall![2] as StatsDelta;
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
    expect((aCall![2] as StatsDelta).totalScore).toBe(10);
    expect((bCall![2] as StatsDelta).totalScore).toBe(5);
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
      "big2",
      expect.any(Object),
    );
    expect(repo.incrementStats).not.toHaveBeenCalledWith(
      "player-b",
      expect.any(String),
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

  // -------------------------------------------------------------------------
  // LLD 94: loss-centric (Tonk) win/loss derivation from breakdown.trueLoser
  // -------------------------------------------------------------------------

  // Tonk: multiple 150-crossers, but exactly one TRUE LOSER (joker-drawer).
  // Every other player — including the second 150-crosser — won.
  it("Tonk: only the true loser gets gamesLost:1; all others (incl. other 150-crossers) get gamesWon:1", async () => {
    const repo = makeStatsRepo();
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    const tonkState = makeCompletedState({
      gameType: "tonk",
      // winner is DISPLAY-only (lowest tally). Set it to a NON-true-loser to
      // prove derivation ignores state.winner.
      winner: "player-c",
      players: [
        { playerId: "player-a", displayName: "Alice" },
        { playerId: "player-b", displayName: "Bob" },
        { playerId: "player-c", displayName: "Carol" },
      ],
      scores: [
        // player-a crossed 150 AND is the true loser
        {
          playerId: "player-a",
          score: 160,
          breakdown: { lost: 1, trueLoser: 1, finalTally: 160 },
        },
        // player-b ALSO crossed 150 but is NOT the true loser -> still won
        {
          playerId: "player-b",
          score: 155,
          breakdown: { lost: 1, trueLoser: 0, finalTally: 155 },
        },
        // player-c did not cross -> won
        {
          playerId: "player-c",
          score: 40,
          breakdown: { lost: 0, trueLoser: 0, finalTally: 40 },
        },
      ],
    });

    await service.recordGameCompletion(tonkState);

    const calls = vi.mocked(repo.incrementStats).mock.calls;
    const aDelta = calls.find((c) => c[0] === "player-a")![2] as StatsDelta;
    const bDelta = calls.find((c) => c[0] === "player-b")![2] as StatsDelta;
    const cDelta = calls.find((c) => c[0] === "player-c")![2] as StatsDelta;

    // true loser
    expect(aDelta.gamesLost).toBe(1);
    expect(aDelta.gamesWon).toBe(0);

    // second 150-crosser still won
    expect(bDelta.gamesLost).toBe(0);
    expect(bDelta.gamesWon).toBe(1);

    // non-crosser (and the display-only winner) won
    expect(cDelta.gamesLost).toBe(0);
    expect(cDelta.gamesWon).toBe(1);

    // across all players: exactly one loss, N-1 wins
    const allDeltas = [aDelta, bDelta, cDelta];
    expect(allDeltas.filter((d) => d.gamesLost === 1)).toHaveLength(1);
    expect(allDeltas.filter((d) => d.gamesWon === 1)).toHaveLength(2);
  });

  // Tonk: gamesPlayed and totalScore (final tally) pass-through, delta keys unchanged.
  it("Tonk: gamesPlayed:1 and totalScore == final tally for every player", async () => {
    const repo = makeStatsRepo();
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    const tonkState = makeCompletedState({
      gameType: "tonk",
      winner: "player-b",
      players: [
        { playerId: "player-a", displayName: "Alice" },
        { playerId: "player-b", displayName: "Bob" },
      ],
      scores: [
        {
          playerId: "player-a",
          score: 160,
          breakdown: { lost: 1, trueLoser: 1, finalTally: 160 },
        },
        {
          playerId: "player-b",
          score: 35,
          breakdown: { lost: 0, trueLoser: 0, finalTally: 35 },
        },
      ],
    });

    await service.recordGameCompletion(tonkState);

    const calls = vi.mocked(repo.incrementStats).mock.calls;
    const aDelta = calls.find((c) => c[0] === "player-a")![2] as StatsDelta;
    const bDelta = calls.find((c) => c[0] === "player-b")![2] as StatsDelta;

    expect(aDelta.gamesPlayed).toBe(1);
    expect(bDelta.gamesPlayed).toBe(1);
    expect(aDelta.totalScore).toBe(160);
    expect(bDelta.totalScore).toBe(35);

    expect(Object.keys(aDelta).sort()).toEqual(
      ["gamesLost", "gamesPlayed", "gamesWon", "totalScore"].sort(),
    );
  });

  // Defensive: breakdown present but lacking the trueLoser key -> single-winner path.
  it("falls back to state.winner derivation when breakdown lacks a trueLoser key", async () => {
    const repo = makeStatsRepo();
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    const state = makeCompletedState({
      gameType: "tonk",
      winner: "player-a",
      players: [
        { playerId: "player-a", displayName: "Alice" },
        { playerId: "player-b", displayName: "Bob" },
      ],
      scores: [
        { playerId: "player-a", score: 10, breakdown: { lost: 0 } },
        { playerId: "player-b", score: 50, breakdown: { lost: 1 } },
      ],
    });

    await service.recordGameCompletion(state);

    const calls = vi.mocked(repo.incrementStats).mock.calls;
    const aDelta = calls.find((c) => c[0] === "player-a")![2] as StatsDelta;
    const bDelta = calls.find((c) => c[0] === "player-b")![2] as StatsDelta;

    // winner (player-a) by state.winner
    expect(aDelta.gamesWon).toBe(1);
    expect(aDelta.gamesLost).toBe(0);
    // non-winner
    expect(bDelta.gamesWon).toBe(0);
    expect(bDelta.gamesLost).toBe(1);
  });

  // Guest who is the true loser is skipped; non-guest players still recorded correctly.
  it("Tonk: a guest true loser is skipped; non-guests recorded with correct win/loss", async () => {
    const repo = makeStatsRepo();
    // player-a (the true loser) is a guest
    const guestStore = makeGuestSessionStore(["player-a"]);
    const service = new StatsService(repo, guestStore);

    const tonkState = makeCompletedState({
      gameType: "tonk",
      winner: "player-b",
      players: [
        { playerId: "player-a", displayName: "Alice" },
        { playerId: "player-b", displayName: "Bob" },
        { playerId: "player-c", displayName: "Carol" },
      ],
      scores: [
        {
          playerId: "player-a",
          score: 160,
          breakdown: { lost: 1, trueLoser: 1, finalTally: 160 },
        },
        {
          playerId: "player-b",
          score: 30,
          breakdown: { lost: 0, trueLoser: 0, finalTally: 30 },
        },
        {
          playerId: "player-c",
          score: 80,
          breakdown: { lost: 0, trueLoser: 0, finalTally: 80 },
        },
      ],
    });

    await service.recordGameCompletion(tonkState);

    const calls = vi.mocked(repo.incrementStats).mock.calls;
    // guest true loser not recorded
    expect(calls.find((c) => c[0] === "player-a")).toBeUndefined();
    expect(repo.incrementStats).toHaveBeenCalledTimes(2);

    // non-guest non-losers recorded as wins
    const bDelta = calls.find((c) => c[0] === "player-b")![2] as StatsDelta;
    const cDelta = calls.find((c) => c[0] === "player-c")![2] as StatsDelta;
    expect(bDelta.gamesWon).toBe(1);
    expect(bDelta.gamesLost).toBe(0);
    expect(cDelta.gamesWon).toBe(1);
    expect(cDelta.gamesLost).toBe(0);
  });

  // Edge case 4: trueLoser present but value !== 1 (e.g. 0) -> win.
  it("Tonk: trueLoser value other than 1 yields a win", async () => {
    const repo = makeStatsRepo();
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    const state = makeCompletedState({
      gameType: "tonk",
      winner: "player-a",
      players: [{ playerId: "player-a", displayName: "Alice" }],
      scores: [
        {
          playerId: "player-a",
          score: 20,
          breakdown: { lost: 0, trueLoser: 0, finalTally: 20 },
        },
      ],
    });

    await service.recordGameCompletion(state);

    const calls = vi.mocked(repo.incrementStats).mock.calls;
    const aDelta = calls.find((c) => c[0] === "player-a")![2] as StatsDelta;
    expect(aDelta.gamesWon).toBe(1);
    expect(aDelta.gamesLost).toBe(0);
  });

  // -------------------------------------------------------------------------
  // LLD 101: history append rides the same per-player loop as the aggregate.
  // -------------------------------------------------------------------------

  // Both writes fire once per non-guest player, from the SAME derived values.
  it("writes both incrementStats and recordGameHistory once per non-guest player (Big2 winner-centric)", async () => {
    const repo = makeStatsRepo();
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    await service.recordGameCompletion(makeCompletedState());

    expect(repo.incrementStats).toHaveBeenCalledTimes(2);
    expect(repo.recordGameHistory).toHaveBeenCalledTimes(2);

    const histCalls = vi.mocked(repo.recordGameHistory).mock.calls;
    const winnerRow = histCalls.find(
      (c) => (c[0] as GameHistoryRow).userId === "player-a",
    )![0] as GameHistoryRow;
    const loserRow = histCalls.find(
      (c) => (c[0] as GameHistoryRow).userId === "player-b",
    )![0] as GameHistoryRow;

    expect(winnerRow).toEqual({
      userId: "player-a",
      gameType: "big2",
      won: true,
      lost: false,
      score: 10,
    });
    expect(loserRow).toEqual({
      userId: "player-b",
      gameType: "big2",
      won: false,
      lost: true,
      score: 5,
    });
  });

  // Tonk loss-centric branch: history won/lost mirror the same trueLoser derivation.
  it("recordGameHistory uses the loss-centric (Tonk) derivation, matching the aggregate", async () => {
    const repo = makeStatsRepo();
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    const tonkState = makeCompletedState({
      gameType: "tonk",
      winner: "player-c",
      players: [
        { playerId: "player-a", displayName: "Alice" },
        { playerId: "player-b", displayName: "Bob" },
        { playerId: "player-c", displayName: "Carol" },
      ],
      scores: [
        {
          playerId: "player-a",
          score: 160,
          breakdown: { lost: 1, trueLoser: 1, finalTally: 160 },
        },
        {
          playerId: "player-b",
          score: 155,
          breakdown: { lost: 1, trueLoser: 0, finalTally: 155 },
        },
        {
          playerId: "player-c",
          score: 40,
          breakdown: { lost: 0, trueLoser: 0, finalTally: 40 },
        },
      ],
    });

    await service.recordGameCompletion(tonkState);

    const histCalls = vi.mocked(repo.recordGameHistory).mock.calls;
    const rows = histCalls.map((c) => c[0] as GameHistoryRow);

    expect(rows).toHaveLength(3);
    const a = rows.find((r) => r.userId === "player-a")!;
    const b = rows.find((r) => r.userId === "player-b")!;
    const c = rows.find((r) => r.userId === "player-c")!;

    // true loser
    expect(a).toEqual({
      userId: "player-a",
      gameType: "tonk",
      won: false,
      lost: true,
      score: 160,
    });
    // second 150-crosser still won
    expect(b).toEqual({
      userId: "player-b",
      gameType: "tonk",
      won: true,
      lost: false,
      score: 155,
    });
    // non-crosser won
    expect(c).toEqual({
      userId: "player-c",
      gameType: "tonk",
      won: true,
      lost: false,
      score: 40,
    });

    // Exactly one lost row, N-1 won rows.
    expect(rows.filter((r) => r.lost)).toHaveLength(1);
    expect(rows.filter((r) => r.won)).toHaveLength(2);
  });

  // E3: guests trigger NEITHER write.
  it("skips guests for both incrementStats and recordGameHistory", async () => {
    const repo = makeStatsRepo();
    const guestStore = makeGuestSessionStore(["player-b"]);
    const service = new StatsService(repo, guestStore);

    await service.recordGameCompletion(makeCompletedState());

    expect(repo.incrementStats).toHaveBeenCalledTimes(1);
    expect(repo.recordGameHistory).toHaveBeenCalledTimes(1);
    const histCalls = vi.mocked(repo.recordGameHistory).mock.calls;
    expect((histCalls[0]![0] as GameHistoryRow).userId).toBe("player-a");
    expect(
      histCalls.find((c) => (c[0] as GameHistoryRow).userId === "player-b"),
    ).toBeUndefined();
  });

  // E4: a failing recordGameHistory does NOT prevent incrementStats for the
  // same player, nor processing of other players.
  it("a rejecting recordGameHistory does not skip incrementStats or other players", async () => {
    const repo = makeStatsRepo({
      recordGameHistory: vi.fn().mockRejectedValue(new Error("history down")),
    });
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    await expect(
      service.recordGameCompletion(makeCompletedState()),
    ).resolves.toBeUndefined();

    // Both players' aggregate increments still happened.
    expect(repo.incrementStats).toHaveBeenCalledTimes(2);
    // Both players' history was attempted.
    expect(repo.recordGameHistory).toHaveBeenCalledTimes(2);
  });

  // E4 (vice-versa): a failing incrementStats does NOT prevent recordGameHistory
  // for the same player, nor processing of other players.
  it("a rejecting incrementStats does not skip recordGameHistory or other players", async () => {
    const repo = makeStatsRepo({
      incrementStats: vi.fn().mockRejectedValue(new Error("aggregate down")),
    });
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    await expect(
      service.recordGameCompletion(makeCompletedState()),
    ).resolves.toBeUndefined();

    expect(repo.incrementStats).toHaveBeenCalledTimes(2);
    expect(repo.recordGameHistory).toHaveBeenCalledTimes(2);
  });

  // History is NOT written when the game is not COMPLETED / scores empty.
  it("does not write history when status is not COMPLETED", async () => {
    const repo = makeStatsRepo();
    const guestStore = makeGuestSessionStore();
    const service = new StatsService(repo, guestStore);

    await service.recordGameCompletion(
      makeCompletedState({ status: "IN_PROGRESS" }),
    );

    expect(repo.recordGameHistory).not.toHaveBeenCalled();
  });
});
