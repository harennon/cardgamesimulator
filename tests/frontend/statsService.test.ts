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

  it("calls GET /api/stats and returns the parsed response body", async () => {
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

    const result = await fetchStats();

    expect(mockGet).toHaveBeenCalledWith("/api/stats");
    expect(result).toEqual(body);
  });

  it("propagates HTTP errors to the caller", async () => {
    mockGet.mockRejectedValue({ response: { status: 500 } });

    await expect(fetchStats()).rejects.toEqual({ response: { status: 500 } });
  });
});
