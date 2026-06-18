import { SupabaseDB } from "./supabaseDb";
import {
  GameRepository,
  PlayerStatsRepository,
  FeedbackRepository,
  JoinCodeRepository,
} from "./database";

export type {
  GameRepository,
  PlayerStatsRepository,
  FeedbackRepository,
  JoinCodeRepository,
};
export const gameRepo: GameRepository = SupabaseDB.INSTANCE;
export const statsRepo: PlayerStatsRepository = SupabaseDB.INSTANCE;
export const feedbackRepo: FeedbackRepository = SupabaseDB.INSTANCE;
export const joinCodeRepo: JoinCodeRepository = SupabaseDB.INSTANCE;
