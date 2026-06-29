import type { GetStatsResponse } from "@shared/model";
import { axiosInstance } from "@/service/http";

// GET /api/stats — auth token attached by the axiosInstance interceptor.
// Throws on network/HTTP error (caller maps to the error state).
export async function fetchStats(): Promise<GetStatsResponse> {
  const response = await axiosInstance.get<GetStatsResponse>("/api/stats");
  return response.data;
}
