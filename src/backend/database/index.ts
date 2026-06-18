import { SupabaseDB } from "./supabaseDb";
import {
  GameRepository,
  PlayerStatsRepository,
  FeedbackRepository,
} from "./database";

export type { GameRepository, PlayerStatsRepository, FeedbackRepository };
export const gameRepo: GameRepository = SupabaseDB.INSTANCE;
export const statsRepo: PlayerStatsRepository = SupabaseDB.INSTANCE;
export const feedbackRepo: FeedbackRepository = SupabaseDB.INSTANCE;
