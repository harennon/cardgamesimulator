import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GetStatsResponse } from "@shared/model";

vi.mock("@/service/http", () => ({
  axiosInstance: {
    get: vi.fn(),
  },
}));

import { fetchStats } from "../../src/frontend/service/statsService.js";
import { axiosInstance } from "@/service/http";

const mockGet = vi.mocked(axiosInstance.get);

describe("fetchStats", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('fetchStats("lifetime") calls GET /api/stats with NO query string', async () => {
    const body: GetStatsResponse = {
      userId: "user-1",
      window: "lifetime",
      trackingSince: null,
      games: [
        {
          gameType: "big2",
          gamesPlayed: 3,
          gamesWon: 2,
          gamesLost: 1,
          totalScore: 12,
          winRate: 0.667,
          lastPlayedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    };
    mockGet.mockResolvedValue({ data: body });

    const result = await fetchStats("lifetime");

    // No-regression guard: the lifetime path must issue the identical no-query
    // request it always has.
    expect(mockGet).toHaveBeenCalledWith("/api/stats");
    expect(result).toEqual(body);
  });

  it('fetchStats("30d") appends ?window=30d', async () => {
    const body: GetStatsResponse = {
      userId: "user-1",
      window: "30d",
      trackingSince: "2026-01-01T00:00:00.000Z",
      games: [],
    };
    mockGet.mockResolvedValue({ data: body });

    const result = await fetchStats("30d");

    expect(mockGet).toHaveBeenCalledWith("/api/stats?window=30d");
    expect(result).toEqual(body);
  });

  it('fetchStats("ytd") appends ?window=ytd', async () => {
    const body: GetStatsResponse = {
      userId: "user-1",
      window: "ytd",
      trackingSince: "2026-01-01T00:00:00.000Z",
      games: [],
    };
    mockGet.mockResolvedValue({ data: body });

    const result = await fetchStats("ytd");

    expect(mockGet).toHaveBeenCalledWith("/api/stats?window=ytd");
    expect(result).toEqual(body);
  });

  it("returns the parsed response including window + trackingSince", async () => {
    const body: GetStatsResponse = {
      userId: "user-1",
      window: "ytd",
      trackingSince: "2026-01-01T00:00:00.000Z",
      games: [
        {
          gameType: "tonk",
          gamesPlayed: 4,
          gamesWon: 1,
          gamesLost: 3,
          totalScore: 40,
          winRate: 0.25,
          lastPlayedAt: "2026-06-15T00:00:00.000Z",
        },
      ],
    };
    mockGet.mockResolvedValue({ data: body });

    const result = await fetchStats("ytd");

    expect(result.window).toBe("ytd");
    expect(result.trackingSince).toBe("2026-01-01T00:00:00.000Z");
    expect(result.games).toEqual(body.games);
  });

  it("propagates HTTP errors to the caller", async () => {
    mockGet.mockRejectedValue({ response: { status: 500 } });

    await expect(fetchStats("lifetime")).rejects.toEqual({
      response: { status: 500 },
    });
  });
});
