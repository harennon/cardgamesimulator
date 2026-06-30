import { type Request, type Response } from "@/util/types";
import { Handler } from "@/api/handler";
import type {
  GameStatsEntry,
  GetStatsResponse,
  StatsWindow,
} from "@shared/model";
import type { PlayerStats } from "@/database/entities/PlayerStats";
import { statsRepo } from "@/database";
import { BadRequestError } from "@/util/errors";
import { windowCutoff } from "@/api/stats/windowCutoff";

const VALID_WINDOWS: readonly StatsWindow[] = ["lifetime", "30d", "ytd"];

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
    const window = this.resolveWindow(request.query.window);

    let stats: PlayerStats[];
    let trackingSince: string | null;

    if (window === "lifetime") {
      // Unchanged lifetime fast path: reads the aggregate row, ignores history.
      stats = await statsRepo.getAllStats(userId);
      trackingSince = null;
    } else {
      const since = windowCutoff(window, new Date())!;
      stats = await statsRepo.getWindowedStats(userId, since);
      const earliest = await statsRepo.getTrackingSince(userId);
      trackingSince = earliest?.toISOString() ?? null;
    }

    const games: GameStatsEntry[] = stats.map((s) => ({
      gameType: s.gameType,
      gamesPlayed: s.gamesPlayed,
      gamesWon: s.gamesWon,
      gamesLost: s.gamesLost,
      totalScore: s.totalScore,
      winRate:
        s.gamesPlayed > 0
          ? Math.round((s.gamesWon / s.gamesPlayed) * 1000) / 1000
          : 0,
      lastPlayedAt: s.lastPlayedAt?.toISOString() ?? null,
    }));

    response.status(200).json({ userId, window, trackingSince, games });
  }

  /** Resolve the optional `window` query param. Absent → "lifetime"; unknown → 400 (E5). */
  private resolveWindow(raw: unknown): StatsWindow {
    if (raw === undefined) return "lifetime";
    if (
      typeof raw === "string" &&
      (VALID_WINDOWS as readonly string[]).includes(raw)
    ) {
      return raw as StatsWindow;
    }
    throw new BadRequestError();
  }
}
