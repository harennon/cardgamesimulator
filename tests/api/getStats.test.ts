import { describe, it, expect, vi, beforeEach } from "vitest";
import { PlayerStats } from "../../src/backend/database/entities/PlayerStats.js";
import type { GetStatsResponse } from "../../src/shared/model.js";

// ---------------------------------------------------------------------------
// LLD 101: GET /stats window resolution (unit). Mocks the repo so this exercises
// only the handler's branch logic: lifetime → getAllStats, no history calls,
// trackingSince null; 30d/ytd → getWindowedStats with the correct cutoff +
// getTrackingSince; unknown window → 400.
// ---------------------------------------------------------------------------

const mockGetAllStats = vi.fn<(userId: string) => Promise<PlayerStats[]>>();
const mockGetWindowedStats =
  vi.fn<(userId: string, since: Date) => Promise<PlayerStats[]>>();
const mockGetTrackingSince = vi.fn<(userId: string) => Promise<Date | null>>();

vi.mock("@/database", () => ({
  statsRepo: {
    getAllStats: (userId: string) => mockGetAllStats(userId),
    getWindowedStats: (userId: string, since: Date) =>
      mockGetWindowedStats(userId, since),
    getTrackingSince: (userId: string) => mockGetTrackingSince(userId),
  },
}));

const { GetStatsHandler } =
  await import("../../src/backend/api/stats/getStats.js");

function makeStats(overrides: Partial<PlayerStats> = {}): PlayerStats {
  const s = new PlayerStats();
  s.userId = "user-1";
  s.gameType = "big2";
  s.gamesPlayed = 4;
  s.gamesWon = 1;
  s.gamesLost = 3;
  s.totalScore = 12;
  s.lastPlayedAt = new Date("2026-06-15T00:00:00.000Z");
  Object.assign(s, overrides);
  return s;
}

function makeRequest(window?: string) {
  return {
    userId: "user-1",
    query: window === undefined ? {} : { window },
    headers: {},
  } as unknown as Parameters<(typeof GetStatsHandler.INSTANCE)["get"]>[0];
}

function makeResponse() {
  const data: { statusCode?: number; body?: GetStatsResponse } = {};
  const res = {
    status(code: number) {
      data.statusCode = code;
      return res;
    },
    json(body: GetStatsResponse) {
      data.body = body;
      return res;
    },
  };
  return { res, data };
}

describe("GetStatsHandler window resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllStats.mockResolvedValue([]);
    mockGetWindowedStats.mockResolvedValue([]);
    mockGetTrackingSince.mockResolvedValue(null);
  });

  it("absent window → lifetime path: getAllStats, no history calls, trackingSince null", async () => {
    mockGetAllStats.mockResolvedValue([makeStats()]);
    const { res, data } = makeResponse();

    await GetStatsHandler.INSTANCE.get(makeRequest(), res);

    expect(data.statusCode).toBe(200);
    expect(data.body!.window).toBe("lifetime");
    expect(data.body!.trackingSince).toBeNull();
    expect(mockGetAllStats).toHaveBeenCalledOnce();
    expect(mockGetWindowedStats).not.toHaveBeenCalled();
    expect(mockGetTrackingSince).not.toHaveBeenCalled();
    expect(data.body!.games).toHaveLength(1);
    expect(data.body!.games[0]!.winRate).toBe(0.25);
  });

  it("window=lifetime → identical to absent (lifetime path)", async () => {
    const { res, data } = makeResponse();
    await GetStatsHandler.INSTANCE.get(makeRequest("lifetime"), res);

    expect(data.statusCode).toBe(200);
    expect(data.body!.window).toBe("lifetime");
    expect(mockGetAllStats).toHaveBeenCalledOnce();
    expect(mockGetWindowedStats).not.toHaveBeenCalled();
  });

  it("window=30d → getWindowedStats with a ~30-day cutoff + getTrackingSince", async () => {
    mockGetWindowedStats.mockResolvedValue([
      makeStats({ gamesPlayed: 2, gamesWon: 1 }),
    ]);
    mockGetTrackingSince.mockResolvedValue(
      new Date("2026-06-01T00:00:00.000Z"),
    );
    const { res, data } = makeResponse();

    const before = Date.now();
    await GetStatsHandler.INSTANCE.get(makeRequest("30d"), res);
    const after = Date.now();

    expect(data.statusCode).toBe(200);
    expect(data.body!.window).toBe("30d");
    expect(mockGetAllStats).not.toHaveBeenCalled();
    expect(mockGetWindowedStats).toHaveBeenCalledOnce();
    expect(mockGetTrackingSince).toHaveBeenCalledOnce();

    // The cutoff is now - 30 days, computed in the handler.
    const [, since] = mockGetWindowedStats.mock.calls[0]!;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(since.getTime()).toBeGreaterThanOrEqual(before - thirtyDaysMs);
    expect(since.getTime()).toBeLessThanOrEqual(after - thirtyDaysMs);

    expect(data.body!.trackingSince).toBe("2026-06-01T00:00:00.000Z");
    expect(data.body!.games[0]!.winRate).toBe(0.5);
  });

  it("window=ytd → getWindowedStats with a Jan-1 UTC cutoff + getTrackingSince", async () => {
    const { res, data } = makeResponse();
    await GetStatsHandler.INSTANCE.get(makeRequest("ytd"), res);

    expect(data.statusCode).toBe(200);
    expect(data.body!.window).toBe("ytd");
    expect(mockGetWindowedStats).toHaveBeenCalledOnce();
    const [, since] = mockGetWindowedStats.mock.calls[0]!;
    const iso = since.toISOString();
    expect(iso).toMatch(/^\d{4}-01-01T00:00:00\.000Z$/);
    expect(since.getUTCFullYear()).toBe(new Date().getUTCFullYear());
  });

  it("ytd with zero history rows → games [] and trackingSince null (E2)", async () => {
    mockGetWindowedStats.mockResolvedValue([]);
    mockGetTrackingSince.mockResolvedValue(null);
    const { res, data } = makeResponse();

    await GetStatsHandler.INSTANCE.get(makeRequest("ytd"), res);

    expect(data.body!.games).toEqual([]);
    expect(data.body!.trackingSince).toBeNull();
  });

  it("unknown window → 400 (E5)", async () => {
    const { res } = makeResponse();
    await expect(
      GetStatsHandler.INSTANCE.get(makeRequest("lastweek"), res),
    ).rejects.toMatchObject({ status: 400 });

    expect(mockGetAllStats).not.toHaveBeenCalled();
    expect(mockGetWindowedStats).not.toHaveBeenCalled();
  });

  it("empty-string window → 400 (E5)", async () => {
    const { res } = makeResponse();
    await expect(
      GetStatsHandler.INSTANCE.get(makeRequest(""), res),
    ).rejects.toMatchObject({ status: 400 });
  });
});
