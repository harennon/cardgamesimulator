import { DataSource } from "typeorm";

import {
  GameRepository,
  PlayerStatsRepository,
  FeedbackRepository,
  StatsDelta,
} from "@/database/database";
import { Game } from "@/database/entities/Game";
import type { GameType } from "@shared/engine-types";
import { PlayerStats } from "@/database/entities/PlayerStats";
import { Feedback } from "@/database/entities/Feedback";

export class PostgresDB
  implements GameRepository, PlayerStatsRepository, FeedbackRepository
{
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
      entities: [Game, PlayerStats, Feedback],
      synchronize: process.env.NODE_ENV !== "production",
      logging: process.env.NODE_ENV === "development" ? "all" : ["error"],
    }).initialize();
  }

  public async createGame(
    gameId: string,
    gameType: GameType,
    creatorId: string,
    maxPlayers: number,
    creatorDisplayName: string,
    turnTimerSeconds: number | null,
  ): Promise<Game> {
    const game = new Game();
    game.gameId = gameId;
    game.gameType = gameType;
    game.playerIds = [creatorId];
    game.playerDisplayNames = { [creatorId]: creatorDisplayName };
    game.maxPlayers = maxPlayers;
    game.status = "CREATED";
    game.turnTimerSeconds = turnTimerSeconds;
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

  public async incrementStats(
    userId: string,
    delta: StatsDelta,
  ): Promise<void> {
    await this.dataSource!.query(
      `INSERT INTO player_stats ("userId", "gamesPlayed", "gamesWon", "gamesLost", "totalScore", "lastPlayedAt")
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT ("userId") DO UPDATE SET
         "gamesPlayed" = player_stats."gamesPlayed" + $2,
         "gamesWon" = player_stats."gamesWon" + $3,
         "gamesLost" = player_stats."gamesLost" + $4,
         "totalScore" = player_stats."totalScore" + $5,
         "lastPlayedAt" = NOW()`,
      [
        userId,
        delta.gamesPlayed,
        delta.gamesWon,
        delta.gamesLost,
        delta.totalScore,
      ],
    );
  }

  public async createFeedback(feedback: Feedback): Promise<Feedback> {
    return this.dataSource!.getRepository(Feedback).save(feedback);
  }

  public async getAllFeedback(): Promise<Feedback[]> {
    return this.dataSource!.getRepository(Feedback).find({
      order: { createdAt: "DESC" },
    });
  }
}
