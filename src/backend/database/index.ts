import { PostgresDB } from "./postgres";
import {
  GameRepository,
  PlayerStatsRepository,
  FeedbackRepository,
} from "./database";

export type { GameRepository, PlayerStatsRepository, FeedbackRepository };
export const gameRepo: GameRepository = PostgresDB.INSTANCE;
export const statsRepo: PlayerStatsRepository = PostgresDB.INSTANCE;
export const feedbackRepo: FeedbackRepository = PostgresDB.INSTANCE;
