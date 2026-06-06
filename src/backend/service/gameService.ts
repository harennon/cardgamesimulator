import type {
  InternalGameState,
  GameAction,
  PlayerView,
  SpectatorView,
  PlayerId,
} from "@shared/engine-types";
import type { GameCache } from "@/engine/game-cache";
import type { GameEngineFactory } from "@/engine/game-engine-factory";
import type { GameRepository } from "@/database/database";
import type { Game } from "@/database/entities/Game";
import { SeededPRNG } from "@/engine/prng";

export class GameService {
  constructor(
    private readonly cache: GameCache,
    private readonly engineFactory: GameEngineFactory,
    private readonly gameRepo: GameRepository,
  ) {}

  /**
   * Load game state — cache-first, fallback to DB.
   * Returns null if game does not exist.
   */
  async getGameState(gameId: string): Promise<InternalGameState | null> {
    const cached = this.cache.get(gameId);
    if (cached) return cached;

    const game = await this.gameRepo.getGame(gameId);
    if (!game) return null;
    if (!game.state || Object.keys(game.state).length === 0) return null;

    const state = game.state as unknown as InternalGameState;
    this.cache.set(gameId, state);
    return state;
  }

  /**
   * Load the Game DB record (for lobby metadata like playerIds, maxPlayers, status).
   * Returns null if not found.
   */
  async getGame(gameId: string): Promise<Game | null> {
    return this.gameRepo.getGame(gameId);
  }

  /**
   * Start a game: initialize the engine, cache state, persist to DB.
   * Throws if game is not in CREATED status, caller is not host, or not enough players.
   */
  async startGame(
    gameId: string,
    requesterId: PlayerId,
  ): Promise<InternalGameState> {
    const game = await this.gameRepo.getGame(gameId);
    if (!game) {
      throw new Error("GAME_NOT_FOUND");
    }

    if (game.status !== "CREATED") {
      throw new Error("GAME_ALREADY_STARTED");
    }

    // Host is the first player in the playerIds array
    if (game.playerIds[0] !== requesterId) {
      throw new Error("NOT_HOST");
    }

    const engine = this.engineFactory.getEngine(game.gameType);
    const minPlayers = 2; // engines validate their own min, but we guard here too
    if (game.playerIds.length < minPlayers) {
      throw new Error("NOT_ENOUGH_PLAYERS");
    }

    const players = game.playerIds.map((id, i) => ({
      playerId: id,
      displayName: game.playerDisplayNames?.[id] ?? `Player ${i + 1}`,
    }));

    const prng = new SeededPRNG();
    const config = { maxPlayers: game.maxPlayers, minPlayers, options: {} };

    const state = engine.initialize(gameId, players, config, prng);

    this.cache.set(gameId, state);

    game.status = "IN_PROGRESS";
    game.state = state as unknown as Record<string, unknown>;
    await this.gameRepo.saveGame(game);
    this.cache.markClean(gameId);

    return state;
  }

  /**
   * Apply a game action. Returns the new state on success.
   * Throws on invalid action or game not found.
   */
  async applyAction(
    gameId: string,
    action: GameAction,
  ): Promise<InternalGameState> {
    const state = await this.getGameState(gameId);
    if (!state) {
      throw new Error("GAME_NOT_FOUND");
    }

    const engine = this.engineFactory.getEngine(state.gameType);
    const result = engine.applyAction(state, action);

    if (!result.success || !result.newState) {
      throw new Error(result.error ?? "INVALID_ACTION");
    }

    this.cache.update(gameId, result.newState);

    const game = await this.gameRepo.getGame(gameId);
    if (game) {
      game.state = result.newState as unknown as Record<string, unknown>;
      if (result.newState.status === "COMPLETED") {
        game.status = "COMPLETED";
      }
      await this.gameRepo.saveGame(game);
      this.cache.markClean(gameId);
    }

    return result.newState;
  }

  /**
   * Get the filtered view for a specific player.
   */
  async getPlayerView(
    gameId: string,
    playerId: PlayerId,
  ): Promise<PlayerView | null> {
    const state = await this.getGameState(gameId);
    if (!state) return null;

    const engine = this.engineFactory.getEngine(state.gameType);
    return engine.getPlayerView(state, playerId);
  }

  /**
   * Get the spectator view.
   */
  async getSpectatorView(
    gameId: string,
    spectatorCount: number,
  ): Promise<SpectatorView | null> {
    const state = await this.getGameState(gameId);
    if (!state) return null;

    const engine = this.engineFactory.getEngine(state.gameType);
    return engine.getSpectatorView(state, spectatorCount);
  }
}
