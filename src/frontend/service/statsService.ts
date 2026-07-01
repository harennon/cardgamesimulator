import type { GetStatsResponse, StatsWindow } from "@shared/model";
import { axiosInstance } from "@/service/http";

// GET /api/stats[?window=30d|ytd] — auth token attached by the axiosInstance
// interceptor. Lifetime issues the identical no-query request as before; only
// 30d/ytd append the query string. Throws on network/HTTP error (caller maps to
// the error state).
export async function fetchStats(
  window: StatsWindow,
): Promise<GetStatsResponse> {
  const url =
    window === "lifetime" ? "/api/stats" : `/api/stats?window=${window}`;
  const response = await axiosInstance.get<GetStatsResponse>(url);
  return response.data;
}
