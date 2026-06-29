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
import type { StatsService } from "@/service/statsService";

export class GameService {
  // Read-through cache of the immutable join code per game. The join code is set
  // once at creation (LLD 28) and never changes, so it is safe to memoize. This
  // avoids an uncached DB read on the per-broadcast hot path (getGame is not
  // cache-backed, unlike getGameState) when surfacing the code on game:state.
  private readonly joinCodeCache: Map<string, string | null> = new Map();

  constructor(
    private readonly cache: GameCache,
    private readonly engineFactory: GameEngineFactory,
    private readonly gameRepo: GameRepository,
    private readonly statsService: StatsService,
  ) {}

  /**
   * Resolve the immutable 4-char join code for a game. Cached after first read.
   * Returns null if the game has no code (legacy / pre-LLD-28) or does not exist.
   */
  async getJoinCode(gameId: string): Promise<string | null> {
    const cached = this.joinCodeCache.get(gameId);
    if (cached !== undefined) return cached;

    const game = await this.gameRepo.getGame(gameId);
    const joinCode = game?.joinCode ?? null;
    if (game) this.joinCodeCache.set(gameId, joinCode);
    return joinCode;
  }

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
    const config = {
      maxPlayers: game.maxPlayers,
      minPlayers,
      options: { deckRoundsTarget: game.gameConfig.deckRoundsTarget ?? 8 },
    };

    const state = engine.initialize(gameId, players, config, prng);

    this.cache.set(gameId, state);

    game.status = "IN_PROGRESS";
    game.state = state as unknown as Record<string, unknown>;
    await this.gameRepo.saveGame(game);
    this.cache.markClean(gameId);

    return state;
  }

  /**
   * Create and start a fresh game from a finished one.
   * - requesterId must be the finished game's host (playerIds[0]).
   * - oldGame.status must be COMPLETED.
   * - connectedPlayerIds is the eligible roster (connected players from the old
   *   game), passed in by the socket layer (the service has no connection knowledge).
   * - Reuses oldGame.joinCode (transferred), maxPlayers, gameType, turnTimerSeconds.
   * Returns the new game's id and started state.
   * Throws: GAME_NOT_FOUND, NOT_HOST, GAME_NOT_FINISHED, REMATCH_ALREADY_STARTED,
   *   NOT_ENOUGH_PLAYERS.
   */
  async createRematch(
    oldGameId: string,
    requesterId: PlayerId,
    connectedPlayerIds: readonly PlayerId[],
  ): Promise<{ newGameId: string; state: InternalGameState }> {
    const oldGame = await this.gameRepo.getGame(oldGameId);
    if (!oldGame) {
      throw new Error("GAME_NOT_FOUND");
    }
    if (oldGame.status !== "COMPLETED") {
      throw new Error("GAME_NOT_FINISHED");
    }
    if (oldGame.playerIds[0] !== requesterId) {
      throw new Error("NOT_HOST");
    }
    // Idempotency guard: a finished game may be rematched at most once. A prior
    // rematch transferred the code away, leaving join_code === null.
    if (oldGame.joinCode === null) {
      throw new Error("REMATCH_ALREADY_STARTED");
    }
    const transferCode = oldGame.joinCode;

    // Carry over only connected players, preserving old order, host first.
    const connectedSet = new Set(connectedPlayerIds);
    const rematchPlayerIds = oldGame.playerIds.filter((id) =>
      connectedSet.has(id),
    );
    const hostIndex = rematchPlayerIds.indexOf(requesterId);
    if (hostIndex > 0) {
      rematchPlayerIds.splice(hostIndex, 1);
      rematchPlayerIds.unshift(requesterId);
    }
    if (rematchPlayerIds.length < 2) {
      throw new Error("NOT_ENOUGH_PLAYERS");
    }

    const newGameId = crypto.randomUUID();

    // Free the code on the old row and invalidate its cache entry BEFORE inserting
    // the new row, so the partial unique index on join_code is satisfied.
    await this.gameRepo.clearJoinCode(oldGameId);
    this.joinCodeCache.set(oldGameId, null);

    const hostDisplayName =
      oldGame.playerDisplayNames?.[requesterId] ?? requesterId;
    const newGame = await this.gameRepo.createGame(
      newGameId,
      oldGame.gameType,
      requesterId,
      oldGame.maxPlayers,
      hostDisplayName,
      oldGame.turnTimerSeconds,
      transferCode,
      oldGame.gameConfig,
    );

    // Attach the remaining carried-over players (createGame only seeds the host).
    newGame.playerIds = [...rematchPlayerIds];
    newGame.playerDisplayNames = Object.fromEntries(
      rematchPlayerIds.map((id) => [
        id,
        oldGame.playerDisplayNames?.[id] ?? id,
      ]),
    );
    await this.gameRepo.saveGame(newGame);

    this.joinCodeCache.set(newGameId, transferCode);

    const state = await this.startGame(newGameId, requesterId);

    return { newGameId, state };
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
        // Fire-and-forget: don't block game state persistence on stats
        this.statsService
          .recordGameCompletion(result.newState)
          .catch((err: unknown) =>
            console.error("Stats recording failed:", err),
          );
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
