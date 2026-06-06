import { PostgresDB } from './postgres';
import { GameRepository, PlayerStatsRepository } from './database';

export type { GameRepository, PlayerStatsRepository };
export const gameRepo: GameRepository = PostgresDB.INSTANCE;
export const statsRepo: PlayerStatsRepository = PostgresDB.INSTANCE;
