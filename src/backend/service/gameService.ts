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
import { aiNameForOrdinal } from "@shared/aiNames";
import { logger } from "@/util/logger";

// Per-engine minimum player counts. Centralised here so startGame can guard
// correctly without hardcoding 2 everywhere (Tonk requires 3).
const ENGINE_MIN_PLAYERS: Record<string, number> = {
  big2: 2,
  tonk: 3,
};

export class GameService {
  // Read-through cache of the immutable join code per game. The join code is set
  // once at creation (LLD 28) and never changes, so it is safe to memoize. This
  // avoids an uncached DB read on the per-broadcast hot path (getGame is not
  // cache-backed, unlike getGameState) when surfacing the code on game:state.
  private readonly joinCodeCache: Map<string, string | null> = new Map();

  // Memoised set of AI player ids per game, populated only once a game is
  // IN_PROGRESS. Immutable post-start; safe to cache indefinitely.
  private readonly aiSeatCache: Map<string, ReadonlySet<string>> = new Map();

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
    const engineMin = ENGINE_MIN_PLAYERS[game.gameType] ?? 2;

    // Guard: at least one human must be present (no all-AI games).
    const aiIds = new Set(game.gameConfig.aiPlayerIds ?? []);
    const humanCount = game.playerIds.filter((id) => !aiIds.has(id)).length;
    if (humanCount < 1) {
      throw new Error("NO_HUMAN_PLAYERS");
    }

    // Guard: total seats (humans + AI) must satisfy the engine minimum.
    if (game.playerIds.length < engineMin) {
      throw new Error("NOT_ENOUGH_PLAYERS");
    }

    const players = game.playerIds.map((id, i) => ({
      playerId: id,
      displayName: game.playerDisplayNames?.[id] ?? `Player ${i + 1}`,
    }));

    const prng = new SeededPRNG();
    const config = {
      maxPlayers: game.maxPlayers,
      minPlayers: engineMin,
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

    // Determine practice-ness and AI count from the finished game. Both are
    // read from the persisted config — authoritative, not client-supplied.
    const oldAiIds = oldGame.gameConfig.aiPlayerIds ?? [];
    const aiSeatCount = oldAiIds.length;
    const isPractice = oldGame.gameConfig.practice === true;

    // Build the connected-human roster exactly as before: filter oldGame.playerIds
    // to connectedPlayerIds (AI ids are never connected, so this already yields
    // humans only), then put the host first.
    const connectedSet = new Set(connectedPlayerIds);
    const rematchHumanIds = oldGame.playerIds.filter((id) =>
      connectedSet.has(id),
    );
    const hostIndex = rematchHumanIds.indexOf(requesterId);
    if (hostIndex > 0) {
      rematchHumanIds.splice(hostIndex, 1);
      rematchHumanIds.unshift(requesterId);
    }

    // Roster-total-aware count guard. For practice games the projected total
    // includes the AI seats that will be re-seated.
    const projectedTotal =
      rematchHumanIds.length + (isPractice ? aiSeatCount : 0);
    const engineMin = ENGINE_MIN_PLAYERS[oldGame.gameType] ?? 2;
    if (rematchHumanIds.length < 1 || projectedTotal < engineMin) {
      throw new Error("NOT_ENOUGH_PLAYERS");
    }

    const newGameId = crypto.randomUUID();

    // Free the code on the old row and invalidate its cache entry BEFORE inserting
    // the new row, so the partial unique index on join_code is satisfied.
    await this.gameRepo.clearJoinCode(oldGameId);
    this.joinCodeCache.set(oldGameId, null);

    const hostDisplayName =
      oldGame.playerDisplayNames?.[requesterId] ?? requesterId;

    // Strip practice/aiPlayerIds from the config passed to createGame. For a
    // practice game, addAiSeats (step below) will re-populate both fields with
    // fresh ids. For a human-only game this is a no-op. Either way, other
    // game-mechanic config (e.g. deckRoundsTarget) is preserved.
    const {
      practice: _p,
      aiPlayerIds: _ai,
      ...rematchConfig
    } = oldGame.gameConfig;
    void _p;
    void _ai;

    const newGame = await this.gameRepo.createGame(
      newGameId,
      oldGame.gameType,
      requesterId,
      oldGame.maxPlayers,
      hostDisplayName,
      oldGame.turnTimerSeconds,
      transferCode,
      rematchConfig,
    );

    // Attach the remaining carried-over human players (createGame only seeds the host).
    newGame.playerIds = [...rematchHumanIds];
    newGame.playerDisplayNames = Object.fromEntries(
      rematchHumanIds.map((id) => [id, oldGame.playerDisplayNames?.[id] ?? id]),
    );
    await this.gameRepo.saveGame(newGame);

    // Re-seat AI for practice games. addAiSeats mints fresh ai: ids, assigns
    // display names, sets practice: true, and populates aiPlayerIds — the same
    // path as POST /createGame + numAiSeats. The new game is still CREATED here
    // so addAiSeats's status guard passes. maxPlayers headroom is guaranteed
    // because humans + aiSeatCount ≤ old total ≤ maxPlayers.
    if (isPractice && aiSeatCount >= 1) {
      await this.addAiSeats(newGameId, aiSeatCount);
    }

    this.joinCodeCache.set(newGameId, transferCode);

    const state = await this.startGame(newGameId, requesterId);

    return { newGameId, state };
  }

  /**
   * Seat `count` AI players onto a CREATED game and mark it as practice.
   * Throws GAME_NOT_FOUND, GAME_ALREADY_STARTED, GAME_FULL, INVALID_AI_COUNT.
   */
  async addAiSeats(gameId: string, count: number): Promise<Game> {
    if (count < 1) {
      throw new Error("INVALID_AI_COUNT");
    }

    const game = await this.gameRepo.getGame(gameId);
    if (!game) {
      throw new Error("GAME_NOT_FOUND");
    }
    if (game.status !== "CREATED") {
      throw new Error("GAME_ALREADY_STARTED");
    }
    if (game.playerIds.length + count > game.maxPlayers) {
      throw new Error("GAME_FULL");
    }

    const existingAiCount = (game.gameConfig.aiPlayerIds ?? []).length;
    for (let i = 0; i < count; i++) {
      const aiId = crypto.randomUUID();
      const displayName = aiNameForOrdinal(existingAiCount + i);
      game.playerIds.push(aiId);
      game.playerDisplayNames[aiId] = displayName;
      game.gameConfig = {
        ...game.gameConfig,
        practice: true,
        aiPlayerIds: [...(game.gameConfig.aiPlayerIds ?? []), aiId],
      };
    }

    await this.gameRepo.saveGame(game);
    return game;
  }

  /**
   * Returns true if playerId is an AI seat in gameId.
   * Memoised after first read once the game is IN_PROGRESS; reads through
   * without caching while the game is still CREATED (seats may still be added).
   */
  async isAiSeat(gameId: string, playerId: PlayerId): Promise<boolean> {
    const cached = this.aiSeatCache.get(gameId);
    if (cached !== undefined) return cached.has(playerId);

    const game = await this.gameRepo.getGame(gameId);
    if (!game) return false;

    const aiIds = new Set(game.gameConfig.aiPlayerIds ?? []);
    // Only memoize once the game has left CREATED so we never cache an
    // incomplete set from an in-progress lobby.
    if (game.status !== "CREATED") {
      this.aiSeatCache.set(gameId, aiIds);
    }
    return aiIds.has(playerId);
  }

  /**
   * Returns the set of AI player ids for a game.
   * Uses the same aiSeatCache as isAiSeat — a single DB read per game, memoised
   * once the game is IN_PROGRESS. Safe to call on every broadcast without
   * incurring an uncached DB round-trip (unlike getGame which is never cached).
   */
  async getAiSeatIds(gameId: string): Promise<ReadonlySet<string>> {
    const cached = this.aiSeatCache.get(gameId);
    if (cached !== undefined) return cached;

    const game = await this.gameRepo.getGame(gameId);
    if (!game) return new Set();

    const aiIds = new Set(game.gameConfig.aiPlayerIds ?? []);
    if (game.status !== "CREATED") {
      this.aiSeatCache.set(gameId, aiIds);
    }
    return aiIds;
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
        const practice = game.gameConfig.practice === true;
        // Fire-and-forget: don't block game state persistence on stats
        this.statsService
          .recordGameCompletion(result.newState, practice)
          .catch((err: unknown) =>
            logger.error({ gameId, err }, "Stats recording failed"),
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
