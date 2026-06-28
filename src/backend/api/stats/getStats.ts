import { type Request, type Response } from "@/util/types";
import { Handler } from "@/api/handler";
import type { GameStatsEntry, GetStatsResponse } from "@shared/model";
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
    const allStats = await statsRepo.getAllStats(userId);

    const games: GameStatsEntry[] = allStats.map((stats) => ({
      gameType: stats.gameType,
      gamesPlayed: stats.gamesPlayed,
      gamesWon: stats.gamesWon,
      gamesLost: stats.gamesLost,
      totalScore: stats.totalScore,
      winRate:
        stats.gamesPlayed > 0
          ? Math.round((stats.gamesWon / stats.gamesPlayed) * 1000) / 1000
          : 0,
      lastPlayedAt: stats.lastPlayedAt?.toISOString() ?? null,
    }));

    const result: GetStatsResponse = { userId, games };

    response.status(200).json(result);
  }
}
