import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  GameRepository,
  PlayerStatsRepository,
  FeedbackRepository,
  StatsDelta,
  GameHistoryRow,
} from "@/database/database";
import { Game } from "@/database/entities/Game";
import { PlayerStats } from "@/database/entities/PlayerStats";
import { Feedback } from "@/database/entities/Feedback";
import { OptimisticLockError } from "@/util/errors";
import type { GameType } from "@shared/engine-types";
import type { GameConfig } from "@shared/model";

export class SupabaseDB
  implements GameRepository, PlayerStatsRepository, FeedbackRepository
{
  public static readonly INSTANCE = new SupabaseDB();
  private client: SupabaseClient | undefined;

  private constructor() {}

  /**
   * Synchronous initialization — constructs the Supabase HTTP client.
   * Unlike TypeORM's async initialize() (which opens TCP connections),
   * this only validates env vars and creates the client object.
   */
  public initialize(): void {
    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url) {
      throw new Error("SUPABASE_URL environment variable is required");
    }
    if (!serviceRoleKey) {
      throw new Error(
        "SUPABASE_SERVICE_ROLE_KEY environment variable is required",
      );
    }
    this.client = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  private get db(): SupabaseClient {
    if (!this.client)
      throw new Error("SupabaseDB not initialized — call initialize() first");
    return this.client;
  }

  public async createGame(
    gameId: string,
    gameType: GameType,
    creatorId: string,
    maxPlayers: number,
    creatorDisplayName: string,
    turnTimerSeconds: number | null,
    joinCode: string | null,
    gameConfig: GameConfig,
  ): Promise<Game> {
    const row = {
      game_id: gameId,
      game_type: gameType,
      player_ids: [creatorId],
      player_display_names: { [creatorId]: creatorDisplayName },
      max_players: maxPlayers,
      status: "CREATED",
      state: {},
      turn_timer_seconds: turnTimerSeconds,
      join_code: joinCode,
      game_config: gameConfig,
    };
    const { data, error } = await this.db
      .from("games")
      .insert(row)
      .select()
      .single();
    if (error) throw new Error(`createGame failed: ${error.message}`);
    return this.mapGame(data as Record<string, unknown>);
  }

  public async getGame(gameId: string): Promise<Game | null> {
    const { data, error } = await this.db
      .from("games")
      .select("*")
      .eq("game_id", gameId)
      .maybeSingle();
    if (error) throw new Error(`getGame failed: ${error.message}`);
    if (!data) return null;
    return this.mapGame(data as Record<string, unknown>);
  }

  public async getGameByJoinCode(code: string): Promise<Game | null> {
    const { data, error } = await this.db
      .from("games")
      .select("*")
      .eq("join_code", code)
      .maybeSingle();
    if (error) throw new Error(`getGameByJoinCode failed: ${error.message}`);
    if (!data) return null;
    return this.mapGame(data as Record<string, unknown>);
  }

  public async saveGame(game: Game): Promise<Game> {
    const expectedVersion = game.version;
    const { data, error } = await this.db
      .from("games")
      .update({
        game_type: game.gameType,
        player_ids: game.playerIds,
        player_display_names: game.playerDisplayNames,
        max_players: game.maxPlayers,
        status: game.status,
        state: game.state,
        turn_timer_seconds: game.turnTimerSeconds,
        game_config: game.gameConfig,
        version: expectedVersion + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("game_id", game.gameId)
      .eq("version", expectedVersion)
      .select()
      .single();

    if (error) {
      // PostgREST returns PGRST116 when .single() matches 0 rows
      if (error.code === "PGRST116") {
        throw new OptimisticLockError(game.gameId, expectedVersion);
      }
      throw new Error(`saveGame failed: ${error.message}`);
    }
    return this.mapGame(data as Record<string, unknown>);
  }

  public async clearJoinCode(gameId: string): Promise<void> {
    const { error } = await this.db
      .from("games")
      .update({ join_code: null, updated_at: new Date().toISOString() })
      .eq("game_id", gameId);
    if (error) throw new Error(`clearJoinCode failed: ${error.message}`);
  }

  public async getStats(
    userId: string,
    gameType: GameType,
  ): Promise<PlayerStats | null> {
    const { data, error } = await this.db
      .from("player_stats")
      .select("*")
      .eq("user_id", userId)
      .eq("game_type", gameType)
      .maybeSingle();
    if (error) throw new Error(`getStats failed: ${error.message}`);
    if (!data) return null;
    return this.mapPlayerStats(data as Record<string, unknown>);
  }

  public async getAllStats(userId: string): Promise<PlayerStats[]> {
    const { data, error } = await this.db
      .from("player_stats")
      .select("*")
      .eq("user_id", userId);
    if (error) throw new Error(`getAllStats failed: ${error.message}`);
    return (data ?? []).map((row) =>
      this.mapPlayerStats(row as Record<string, unknown>),
    );
  }

  public async incrementStats(
    userId: string,
    gameType: GameType,
    delta: StatsDelta,
  ): Promise<void> {
    const { error } = await this.db.rpc("increment_player_stats", {
      p_user_id: userId,
      p_game_type: gameType,
      p_games_played: delta.gamesPlayed,
      p_games_won: delta.gamesWon,
      p_games_lost: delta.gamesLost,
      p_total_score: delta.totalScore,
    });
    if (error) throw new Error(`incrementStats failed: ${error.message}`);
  }

  public async recordGameHistory(row: GameHistoryRow): Promise<void> {
    const { error } = await this.db.from("game_history").insert({
      user_id: row.userId,
      game_type: row.gameType,
      won: row.won,
      lost: row.lost,
      score: row.score,
    });
    if (error) throw new Error(`recordGameHistory failed: ${error.message}`);
  }

  public async getWindowedStats(
    userId: string,
    since: Date,
  ): Promise<PlayerStats[]> {
    const { data, error } = await this.db.rpc("get_windowed_stats", {
      p_user_id: userId,
      p_since: since.toISOString(),
    });
    if (error) throw new Error(`getWindowedStats failed: ${error.message}`);
    return ((data ?? []) as Record<string, unknown>[]).map((row) => {
      const stats = new PlayerStats();
      stats.userId = userId;
      stats.gameType = row.game_type as GameType;
      stats.gamesPlayed = Number(row.games_played);
      stats.gamesWon = Number(row.games_won);
      stats.gamesLost = Number(row.games_lost);
      stats.totalScore = Number(row.total_score);
      stats.lastPlayedAt = new Date(row.last_played_at as string);
      return stats;
    });
  }

  public async getTrackingSince(userId: string): Promise<Date | null> {
    const { data, error } = await this.db
      .from("game_history")
      .select("played_at")
      .eq("user_id", userId)
      .order("played_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`getTrackingSince failed: ${error.message}`);
    if (!data) return null;
    return new Date((data as { played_at: string }).played_at);
  }

  public async createFeedback(feedback: Feedback): Promise<Feedback> {
    const { data, error } = await this.db
      .from("feedback")
      .insert({
        category: feedback.category,
        description: feedback.description,
        metadata: feedback.metadata,
        user_id: feedback.userId,
      })
      .select()
      .single();
    if (error) throw new Error(`createFeedback failed: ${error.message}`);
    return this.mapFeedback(data as Record<string, unknown>);
  }

  public async getAllFeedback(): Promise<Feedback[]> {
    const { data, error } = await this.db
      .from("feedback")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(`getAllFeedback failed: ${error.message}`);
    return (data ?? []).map((row) =>
      this.mapFeedback(row as Record<string, unknown>),
    );
  }

  public async deleteFeedback(id: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("feedback")
      .delete()
      .eq("id", id)
      .select("id");
    if (error) throw new Error(`deleteFeedback failed: ${error.message}`);
    return (data ?? []).length > 0;
  }

  // --- Row mappers (snake_case DB columns -> camelCase domain objects) ---

  private mapGame(row: Record<string, unknown>): Game {
    const game = new Game();
    game.gameId = row.game_id as string;
    game.gameType = row.game_type as GameType;
    game.playerIds = row.player_ids as string[];
    game.playerDisplayNames = row.player_display_names as Record<
      string,
      string
    >;
    game.maxPlayers = row.max_players as number;
    game.status = row.status as Game["status"];
    game.state = row.state as Record<string, unknown>;
    game.turnTimerSeconds = row.turn_timer_seconds as number | null;
    game.joinCode = (row.join_code as string) ?? null;
    game.gameConfig = (row.game_config as GameConfig) ?? {};
    game.createdAt = new Date(row.created_at as string);
    game.updatedAt = new Date(row.updated_at as string);
    game.version = row.version as number;
    return game;
  }

  private mapPlayerStats(row: Record<string, unknown>): PlayerStats {
    const stats = new PlayerStats();
    stats.userId = row.user_id as string;
    stats.gameType = row.game_type as GameType;
    stats.gamesPlayed = row.games_played as number;
    stats.gamesWon = row.games_won as number;
    stats.gamesLost = row.games_lost as number;
    stats.totalScore = row.total_score as number;
    stats.lastPlayedAt = new Date(row.last_played_at as string);
    return stats;
  }

  private mapFeedback(row: Record<string, unknown>): Feedback {
    const fb = new Feedback();
    fb.id = row.id as string;
    fb.category = row.category as Feedback["category"];
    fb.description = row.description as string;
    fb.metadata = row.metadata as Feedback["metadata"];
    fb.userId = row.user_id as string | null;
    fb.createdAt = new Date(row.created_at as string);
    return fb;
  }
}
