import { type Request, type Response } from "@/util/types";
import { Handler } from "@/api/handler";
import type { GetStatsResponse } from "@shared/model";
import { statsRepo } from "@/database";

export class GetStatsHandler extends Handler {
  public static INSTANCE: GetStatsHandler = new GetStatsHandler();
  private constructor() {
    super();
  }

  public override async get(
    request: Request,
    response: Response<GetStatsResponse>,
  ) {
    const userId = request.userId!;
    const stats = await statsRepo.getStats(userId);

    const result: GetStatsResponse = {
      userId,
      gamesPlayed: stats?.gamesPlayed ?? 0,
      gamesWon: stats?.gamesWon ?? 0,
      gamesLost: stats?.gamesLost ?? 0,
      totalScore: stats?.totalScore ?? 0,
      winRate:
        stats && stats.gamesPlayed > 0
          ? Math.round((stats.gamesWon / stats.gamesPlayed) * 1000) / 1000
          : 0,
      lastPlayedAt: stats?.lastPlayedAt?.toISOString() ?? null,
    };

    response.status(200).json(result);
  }
}
