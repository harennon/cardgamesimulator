import { DataSource } from "typeorm";

import { GameRepository, PlayerStatsRepository } from "@/database/database";
import { Game } from "@/database/entities/Game";
import type { GameType } from "@shared/engine-types";
import { PlayerStats } from "@/database/entities/PlayerStats";

export class PostgresDB implements GameRepository, PlayerStatsRepository {
  public static readonly INSTANCE = new PostgresDB();
  private dataSource: DataSource | undefined;

  private constructor() {}

  public async initialize(): Promise<void> {
    if (this.dataSource) throw new Error("Database already initialized");

    this.dataSource = await new DataSource({
      type: "postgres",
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT || "54322"),
      username: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "postgres",
      database: process.env.DB_NAME || "postgres",
      entities: [Game, PlayerStats],
      synchronize: process.env.NODE_ENV !== "production",
      logging: process.env.NODE_ENV !== "production" ? "all" : ["error"],
    }).initialize();
  }

  public async createGame(
    gameId: string,
    gameType: GameType,
    creatorId: string,
    maxPlayers: number,
  ): Promise<Game> {
    const game = new Game();
    game.gameId = gameId;
    game.gameType = gameType;
    game.playerIds = [creatorId];
    game.maxPlayers = maxPlayers;
    game.status = "CREATED";
    return this.dataSource!.getRepository(Game).save(game);
  }

  public async getGame(gameId: string): Promise<Game | null> {
    return this.dataSource!.getRepository(Game).findOneBy({ gameId });
  }

  public async saveGame(game: Game): Promise<Game> {
    return this.dataSource!.manager.transaction(async (manager) => {
      await manager.findOne(Game, {
        where: { gameId: game.gameId },
        lock: { mode: "optimistic", version: game.version },
      });
      return manager.save(game);
    });
  }

  public async getStats(userId: string): Promise<PlayerStats | null> {
    return this.dataSource!.getRepository(PlayerStats).findOneBy({ userId });
  }

  public async upsertStats(stats: PlayerStats): Promise<PlayerStats> {
    return this.dataSource!.getRepository(PlayerStats).save(stats);
  }
}
