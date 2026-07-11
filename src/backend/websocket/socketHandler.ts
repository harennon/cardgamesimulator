import type { TypedServer, TypedSocket } from "./socketServer.js";
import type { ConnectionManager } from "./connectionManager.js";
import type { GameService } from "@/service/gameService";
import { engineFactory } from "@/engine/game-engine-factory";
import { logger, withContext } from "@/util/logger";
import type {
  PlayerPublicInfo,
  PlayerInfo,
  PlayerId,
} from "@shared/engine-types";
import type {
  GameJoinPayload,
  GameJoinResponse,
  GameActionPayload,
  GameActionResponse,
  GameStartPayload,
  GameStartResponse,
  GameRematchPayload,
  GameRematchResponse,
  GameLeavePayload,
  TimerExpiredPayload,
} from "@shared/socket-events";
import type { TurnTimerService } from "@/timer/turnTimerService";
import { injectBoardAi, buildLobbyPlayers } from "@/websocket/socketAiUtils";
import type { Delayer } from "@/websocket/delayer";

/**
 * Maximum hand size for Big2 (13 cards per player in a 4-player game).
 * Used to size the auto-play loop ceiling so it covers driving all remaining
 * seats to completion without truncating a legitimate play-out.
 */
const MAX_HAND_SIZE = 13;

/**
 * Returns a child logger carrying the socket's correlation/request identifiers.
 * Reads socket.data.{correlationId,requestId} which are set in socketAuth.ts.
 * gameId is optional — only pass it when the handler has a gameId in scope.
 */
function socketLog(
  socket: TypedSocket,
  gameId?: string,
): ReturnType<typeof withContext> {
  return withContext({
    correlationId: socket.data.correlationId,
    requestId: socket.data.requestId,
    gameId,
  });
}

/** Default pace between successive auto-driven moves (ms). */
export const DEFAULT_AI_MOVE_DELAY_MS = 1000;

/** Maximum configurable pace; clamps absurd values from hand-crafted configs. */
export const MAX_AI_MOVE_DELAY_MS = 3000;

function emitSpectatorCount(
  io: TypedServer,
  gameId: string,
  connectionManager: ConnectionManager,
): void {
  const count = connectionManager.getSpectatorCount(gameId);
  io.to(`game:${gameId}`).emit("game:spectatorCount", { gameId, count });
}

function injectConnectionStatus<
  T extends { players: readonly PlayerPublicInfo[] },
>(
  view: T,
  gameId: string,
  connectionManager: ConnectionManager,
  aiIds?: ReadonlySet<string>,
): T {
  const withConnection = view.players.map((p) => ({
    ...p,
    isConnected: connectionManager.isPlayerConnected(gameId, p.playerId),
  }));
  const players =
    aiIds != null && aiIds.size > 0
      ? injectBoardAi(withConnection, aiIds)
      : withConnection;
  return { ...view, players };
}

async function broadcastGameState(
  io: TypedServer,
  gameId: string,
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
): Promise<void> {
  const state = await gameService.getGameState(gameId);
  if (!state) return;

  // getGameState returns engine state (InternalGameState), which by design has no
  // joinCode. Resolve the room code via the cached, immutable join-code lookup so
  // the per-player view carries it on every broadcast without an uncached DB read.
  const joinCode = await gameService.getJoinCode(gameId);

  // Build the AI-seat set once per broadcast; derived from persisted config, never
  // from client input. The engine stays pure (no AI knowledge) — isAi is injected
  // here at the serialization boundary alongside isConnected.
  // Use the cache-backed getAiSeatIds (same aiSeatCache as isAiSeat) to avoid an
  // uncached DB read on every broadcast. getGame is not cache-backed; this is.
  const aiIds = await gameService.getAiSeatIds(gameId);

  const engine = engineFactory.getEngine(state.gameType);
  const playerSockets = connectionManager.getPlayerSockets(gameId);
  const spectatorCount = connectionManager.getSpectatorCount(gameId);
  const turnDeadline = turnTimerService.getDeadline(gameId);

  for (const { playerId, socket } of playerSockets) {
    const view = engine.getPlayerView(state, playerId);
    socket.emit("game:state", {
      ...injectConnectionStatus(view, gameId, connectionManager, aiIds),
      turnDeadline,
      joinCode,
    });
  }

  const spectatorView = engine.getSpectatorView(state, spectatorCount);
  io.to(`spectators:${gameId}`).emit("game:spectatorState", {
    ...injectConnectionStatus(spectatorView, gameId, connectionManager, aiIds),
    turnDeadline,
  });
}

/**
 * Returns true if the player's turn should be driven automatically:
 * either it is an AI seat or it is an abandoned human.
 */
async function shouldAutoPlay(
  gameId: string,
  playerId: PlayerId,
  gameService: GameService,
  connectionManager: ConnectionManager,
): Promise<boolean> {
  if (connectionManager.isAbandoned(gameId, playerId)) return true;
  return gameService.isAiSeat(gameId, playerId);
}

/**
 * Arm a 1x turn timer as a fallback when the auto-play loop exits while a
 * driven seat is still current, so the game advances on the next tick rather
 * than stalling. No-op when the game has no timer configured (hasTimer false).
 */
function armFallbackTimer(
  gameId: string,
  turnTimerService: TurnTimerService,
): void {
  if (turnTimerService.hasTimer(gameId)) {
    turnTimerService.startTurn(gameId, false);
  }
}

/**
 * After a state change, if the new current player should be auto-driven
 * (AI seat or abandoned), play them immediately.
 * Loops until a non-driven player's turn or game completion.
 *
 * The loop ceiling is sized to cover driving all remaining seats to completion
 * (players * (maxHandSize + players) comfortably exceeds any legitimate play-out).
 * A version-progress check detects genuine non-progress (engine not advancing)
 * independently of the count, so the ceiling is only a last-resort safety net.
 *
 * The delayer introduces a non-blocking pause between successive auto-driven
 * moves so each move is broadcast before the next one resolves, making AI
 * play human-readable. In tests inject ImmediateDelayer for zero wall-clock delay.
 */
async function autoPlayAbandoned(
  io: TypedServer,
  gameId: string,
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
  delayer: Delayer,
): Promise<void> {
  const state = await gameService.getGameState(gameId);
  const playerCount = state?.players.length ?? 4;
  // Ceiling: generous enough to drive all remaining seats through their entire
  // hands across multiple tricks; much larger than the old playerCount * 2 cap.
  const maxIterations = playerCount * (MAX_HAND_SIZE + playerCount);

  // Resolve delay once per invocation from the game config; immutable during play.
  const game = await gameService.getGame(gameId);
  const configuredDelay = game?.gameConfig?.aiMoveDelayMs;
  const delayMs = Math.min(
    Math.max(configuredDelay ?? DEFAULT_AI_MOVE_DELAY_MS, 0),
    MAX_AI_MOVE_DELAY_MS,
  );

  let lastVersion = state?.version ?? -1;

  for (let i = 0; i < maxIterations; i++) {
    const currentState = await gameService.getGameState(gameId);
    if (!currentState || currentState.status !== "IN_PROGRESS") return;

    const currentPlayer = currentState.players[currentState.currentPlayerIndex];
    if (
      !currentPlayer ||
      !(await shouldAutoPlay(
        gameId,
        currentPlayer.playerId,
        gameService,
        connectionManager,
      ))
    ) {
      // Non-driven player reached — start their turn timer only if we actually auto-played
      if (i > 0) {
        turnTimerService.startTurn(gameId, false);
      }
      return;
    }

    const engine = engineFactory.getEngine(currentState.gameType);
    const isAi = await gameService.isAiSeat(gameId, currentPlayer.playerId);
    const autoAction = isAi
      ? engine.getAiMoveAction(currentState)
      : engine.getAutoTimeoutAction(currentState);
    if (!autoAction) {
      // B1: engine returned null for a live driven seat — should not happen in
      // normal Big2/Tonk play; arm fallback so the seat is retried on next tick.
      armFallbackTimer(gameId, turnTimerService);
      return;
    }

    try {
      await gameService.applyAction(gameId, autoAction);
    } catch (err: unknown) {
      // B2: engine rejected the auto-action — a real defect, not a benign race
      // for AI/auto seats which are single-threaded. Arm fallback for bounded retry.
      logger.warn(
        { gameId, err },
        "autoPlayAbandoned: auto-action rejected by engine; armed fallback timer",
      );
      armFallbackTimer(gameId, turnTimerService);
      return;
    }

    const newState = await gameService.getGameState(gameId);
    if (newState?.status === "COMPLETED") {
      turnTimerService.unregisterGame(gameId);
      connectionManager.clearGameAbandoned(gameId);
      await broadcastGameState(
        io,
        gameId,
        gameService,
        connectionManager,
        turnTimerService,
      );
      // No pacing delay after the completing move (LLD 122 timing preserved).
      return;
    }

    // Version-progress check: if a successful applyAction failed to advance the
    // engine state, treat it as divergence (B3) rather than looping forever.
    if (newState != null && newState.version === lastVersion) {
      logger.warn(
        { gameId, iterations: i + 1 },
        "autoPlayAbandoned: divergence guard hit (version stall); armed fallback timer",
      );
      armFallbackTimer(gameId, turnTimerService);
      return;
    }
    lastVersion = newState?.version ?? lastVersion;

    await broadcastGameState(
      io,
      gameId,
      gameService,
      connectionManager,
      turnTimerService,
    );

    // Pace between successive auto-driven moves so clients can follow each one.
    // Non-blocking: other games' handlers and socket events run during the gap.
    await delayer.delay(delayMs);

    // Loop continues to check the next player
  }

  // B3: absolute ceiling exhausted — genuine engine non-progress.
  logger.warn(
    { gameId, maxIterations },
    "autoPlayAbandoned: divergence guard hit (max iterations); armed fallback timer",
  );
  armFallbackTimer(gameId, turnTimerService);
}

async function handleGameJoin(
  socket: TypedSocket,
  io: TypedServer,
  payload: GameJoinPayload,
  ack: (response: GameJoinResponse) => void,
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
  delayer: Delayer,
): Promise<void> {
  const { gameId, role } = payload;
  const { userId, displayName } = socket.data;

  if (!gameId) {
    ack({ success: false, error: "gameId is required" });
    return;
  }

  const game = await gameService.getGame(gameId);
  if (!game) {
    ack({ success: false, error: "Game not found" });
    return;
  }

  if (role === "player") {
    if (!game.playerIds.includes(userId)) {
      ack({ success: false, error: "You are not a player in this game" });
      return;
    }

    // Idempotent: if already registered (e.g. socket recovery), skip re-registration
    if (
      !connectionManager.isPlayerConnected(gameId, userId) ||
      !socket.recovered
    ) {
      connectionManager.addPlayerSocket(gameId, userId, socket);
    }

    await socket.join(`game:${gameId}`);

    if (game.status === "CREATED") {
      // Send full lobby state to the joining socket for reconciliation.
      // Tag AI seats from persisted config — never trusted from client.
      const aiIds = new Set(game.gameConfig?.aiPlayerIds ?? []);
      const players: PlayerInfo[] = buildLobbyPlayers(
        game.playerIds,
        game.playerDisplayNames,
        aiIds,
      );
      socket.emit("lobby:state", {
        players,
        maxPlayers: game.maxPlayers,
        joinCode: game.joinCode ?? "",
      });

      // Notify others (incremental update)
      socket.to(`game:${gameId}`).emit("lobby:playerJoined", {
        player: { playerId: userId, displayName },
        playerCount: game.playerIds.length,
      });
      ack({ success: true });
    } else {
      if (game.status === "IN_PROGRESS") {
        // Timer recovery: if the game has a timer but no active deadline, the server
        // likely slept and lost the in-memory timer. Treat the missed turn as expired.
        if (
          game.turnTimerSeconds != null &&
          turnTimerService.getDeadline(gameId) === null &&
          !turnTimerService.hasTimer(gameId)
        ) {
          turnTimerService.registerGame(gameId, {
            turnTimerSeconds: game.turnTimerSeconds,
          });
          await handleTimerExpired(
            io,
            gameId,
            gameService,
            connectionManager,
            turnTimerService,
            delayer,
          );
        }
      }

      // IN_PROGRESS or COMPLETED: send current game state
      const view = await gameService.getPlayerView(gameId, userId);
      if (view) {
        const turnDeadline = turnTimerService.getDeadline(gameId);
        const reconnectAiIds = new Set(game.gameConfig?.aiPlayerIds ?? []);
        socket.emit("game:state", {
          ...injectConnectionStatus(
            view,
            gameId,
            connectionManager,
            reconnectAiIds,
          ),
          turnDeadline,
          joinCode: game.joinCode ?? null,
        });
      }

      if (game.status === "IN_PROGRESS") {
        // Clear abandoned status on reconnect
        connectionManager.clearAbandoned(gameId, userId);
        socket.to(`game:${gameId}`).emit("game:playerReconnected", {
          playerId: userId,
          displayName,
        });
        // Broadcast updated connection status (isConnected flips to true)
        await broadcastGameState(
          io,
          gameId,
          gameService,
          connectionManager,
          turnTimerService,
        );
      }

      ack({ success: true });
    }
  } else {
    // Spectator
    if (game.playerIds.includes(userId)) {
      // Already a player — reject spectator join
      ack({ success: false, error: "You are already a player in this game" });
      return;
    }

    // Reject spectating a game that hasn't started yet — nothing to watch
    if (game.status === "CREATED") {
      ack({ success: false, error: "SPECTATING_NOT_AVAILABLE" });
      return;
    }

    connectionManager.addSpectatorSocket(gameId, socket);
    await socket.join(`spectators:${gameId}`);

    const spectatorCount = connectionManager.getSpectatorCount(gameId);
    const spectatorView = await gameService.getSpectatorView(
      gameId,
      spectatorCount,
    );
    if (spectatorView) {
      const turnDeadline = turnTimerService.getDeadline(gameId);
      const spectatorAiIds = new Set(game.gameConfig?.aiPlayerIds ?? []);
      socket.emit("game:spectatorState", {
        ...injectConnectionStatus(
          spectatorView,
          gameId,
          connectionManager,
          spectatorAiIds,
        ),
        turnDeadline,
      });
    }

    emitSpectatorCount(io, gameId, connectionManager);

    ack({ success: true });
  }
}

async function handleGameStart(
  socket: TypedSocket,
  io: TypedServer,
  payload: GameStartPayload,
  ack: (response: GameStartResponse) => void,
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
  delayer: Delayer,
): Promise<void> {
  const { gameId } = payload;
  const { userId } = socket.data;

  if (!gameId) {
    ack({ success: false, error: "gameId is required" });
    return;
  }

  if (connectionManager.isSpectator(socket.id)) {
    ack({ success: false, error: "SPECTATOR_CANNOT_ACT" });
    return;
  }

  try {
    const initialState = await gameService.startGame(gameId, userId);

    // Register timer for later human turns. Start it immediately only if the
    // first seat is human; if the first seat is AI, defer arming until
    // autoPlayAbandoned stops at a human (so no redundant timer is armed).
    const game = await gameService.getGame(gameId);
    if (game?.turnTimerSeconds != null) {
      turnTimerService.registerGame(gameId, {
        turnTimerSeconds: game.turnTimerSeconds,
      });
      const firstSeatId =
        initialState.players[initialState.currentPlayerIndex]?.playerId;
      const firstIsAi =
        firstSeatId != null &&
        (await gameService.isAiSeat(gameId, firstSeatId));
      if (!firstIsAi) {
        turnTimerService.startTurn(gameId, true);
      }
    }

    // Broadcast game:started to all players in the room
    io.to(`game:${gameId}`).emit("game:started");

    // Then broadcast each player's individual state
    await broadcastGameState(
      io,
      gameId,
      gameService,
      connectionManager,
      turnTimerService,
    );

    // If the first seat to act is AI (or abandoned), drive turns now.
    await autoPlayAbandoned(
      io,
      gameId,
      gameService,
      connectionManager,
      turnTimerService,
      delayer,
    );

    ack({ success: true });
  } catch (err: unknown) {
    const code = err instanceof Error ? err.message : "INTERNAL_ERROR";
    ack({ success: false, error: code });
  }
}

async function handleGameRematch(
  socket: TypedSocket,
  io: TypedServer,
  payload: GameRematchPayload,
  ack: (response: GameRematchResponse) => void,
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
  delayer: Delayer,
): Promise<void> {
  const { gameId } = payload;
  const { userId } = socket.data;

  if (!gameId) {
    ack({ success: false, error: "gameId is required" });
    return;
  }

  if (connectionManager.isSpectator(socket.id)) {
    ack({ success: false, error: "SPECTATOR_CANNOT_ACT" });
    return;
  }

  try {
    const connectedPlayerIds = connectionManager.getConnectedPlayerIds(gameId);
    const { newGameId, state } = await gameService.createRematch(
      gameId,
      userId,
      connectedPlayerIds,
    );

    // Register and conditionally start the timer for the new game, mirroring
    // handleGameStart: if the first dealt seat is AI, defer arming the timer
    // until autoPlayAbandoned stops at a human (so no redundant timer is armed).
    const newGame = await gameService.getGame(newGameId);
    if (newGame?.turnTimerSeconds != null) {
      turnTimerService.registerGame(newGameId, {
        turnTimerSeconds: newGame.turnTimerSeconds,
      });
      const firstSeatId = state.players[state.currentPlayerIndex]?.playerId;
      const firstIsAi =
        firstSeatId != null &&
        (await gameService.isAiSeat(newGameId, firstSeatId));
      if (!firstIsAi) {
        turnTimerService.startTurn(newGameId, true);
      }
    }

    // Broadcast to the old room so every connected client navigates to the new game.
    io.to(`game:${gameId}`).emit("game:rematchStarted", { newGameId });

    ack({ success: true, newGameId });

    // Drive any CPU-first (or all-CPU-until-human) opening turns, exactly as
    // handleGameStart does after broadcasting game:started.
    await autoPlayAbandoned(
      io,
      newGameId,
      gameService,
      connectionManager,
      turnTimerService,
      delayer,
    );
  } catch (err: unknown) {
    const code = err instanceof Error ? err.message : "INTERNAL_ERROR";
    ack({ success: false, error: code });
  }
}

async function handleGameAction(
  socket: TypedSocket,
  io: TypedServer,
  payload: GameActionPayload,
  ack: (response: GameActionResponse) => void,
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
  delayer: Delayer,
): Promise<void> {
  const { gameId, action } = payload;
  const { userId } = socket.data;

  if (!gameId || !action) {
    ack({ success: false, error: "gameId and action are required" });
    return;
  }

  if (connectionManager.isSpectator(socket.id)) {
    ack({ success: false, error: "SPECTATOR_CANNOT_ACT" });
    return;
  }

  // Override client-supplied playerId with authenticated userId (anti-spoofing)
  const safeAction = { ...action, playerId: userId };

  try {
    await gameService.applyAction(gameId, safeAction);

    const newState = await gameService.getGameState(gameId);
    if (newState?.status === "COMPLETED") {
      turnTimerService.unregisterGame(gameId);
      connectionManager.clearGameAbandoned(gameId);
      await broadcastGameState(
        io,
        gameId,
        gameService,
        connectionManager,
        turnTimerService,
      );
      ack({ success: true });
      return;
    }

    // Check if the next current player should be auto-driven (AI or abandoned).
    if (newState) {
      const nextPlayer = newState.players[newState.currentPlayerIndex];
      if (
        nextPlayer &&
        (await shouldAutoPlay(
          gameId,
          nextPlayer.playerId,
          gameService,
          connectionManager,
        ))
      ) {
        await broadcastGameState(
          io,
          gameId,
          gameService,
          connectionManager,
          turnTimerService,
        );
        await autoPlayAbandoned(
          io,
          gameId,
          gameService,
          connectionManager,
          turnTimerService,
          delayer,
        );
        ack({ success: true });
        return;
      }
    }

    if (turnTimerService.hasTimer(gameId)) {
      turnTimerService.startTurn(gameId, false);
    }

    await broadcastGameState(
      io,
      gameId,
      gameService,
      connectionManager,
      turnTimerService,
    );
    ack({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "INVALID_ACTION";
    ack({ success: false, error: message });
  }
}

async function handleGameLeave(
  socket: TypedSocket,
  io: TypedServer,
  payload: GameLeavePayload,
  connectionManager: ConnectionManager,
  gameService: GameService,
  turnTimerService: TurnTimerService,
): Promise<void> {
  const { gameId } = payload;
  const { userId, displayName } = socket.data;

  // Must check spectator status BEFORE removeSocket (which deletes the metadata)
  const spectatorGameId = connectionManager.getSpectatorGameId(socket.id);
  if (spectatorGameId) {
    socket.leave(`spectators:${spectatorGameId}`);
    connectionManager.removeSocket(socket.id);
    emitSpectatorCount(io, spectatorGameId, connectionManager);
    return;
  }

  socket.leave(`game:${gameId}`);
  connectionManager.removeSocket(socket.id);

  if (!connectionManager.isPlayerConnected(gameId, userId)) {
    const game = await gameService.getGame(gameId);
    if (game && game.status === "CREATED") {
      io.to(`game:${gameId}`).emit("lobby:playerLeft", {
        playerId: userId,
        playerCount: game.playerIds.length,
      });
    } else if (game && game.status === "IN_PROGRESS") {
      io.to(`game:${gameId}`).emit("game:playerDisconnected", {
        playerId: userId,
        displayName,
      });
      await broadcastGameState(
        io,
        gameId,
        gameService,
        connectionManager,
        turnTimerService,
      );
    } else {
      io.to(`game:${gameId}`).emit("game:playerDisconnected", {
        playerId: userId,
        displayName,
      });
    }
  }
}

async function handleDisconnect(
  socket: TypedSocket,
  io: TypedServer,
  connectionManager: ConnectionManager,
  gameService: GameService,
  turnTimerService: TurnTimerService,
): Promise<void> {
  const meta = connectionManager.removeSocket(socket.id);
  if (!meta) return;

  const { gameId, playerId, role } = meta;

  if (role === "spectator") {
    emitSpectatorCount(io, gameId, connectionManager);
    return;
  }

  if (
    role === "player" &&
    !connectionManager.isPlayerConnected(gameId, playerId)
  ) {
    // Only broadcast disconnect if the player has no remaining connections
    const displayName = socket.data.displayName;
    const game = await gameService.getGame(gameId);
    if (game && game.status === "CREATED") {
      io.to(`game:${gameId}`).emit("lobby:playerLeft", {
        playerId,
        playerCount: game.playerIds.length,
      });
    } else if (game && game.status === "IN_PROGRESS") {
      io.to(`game:${gameId}`).emit("game:playerDisconnected", {
        playerId,
        displayName,
      });
      // Broadcast updated connection status (isConnected flips to false)
      await broadcastGameState(
        io,
        gameId,
        gameService,
        connectionManager,
        turnTimerService,
      );
    } else {
      io.to(`game:${gameId}`).emit("game:playerDisconnected", {
        playerId,
        displayName,
      });
    }
  }
}

export async function handleTimerExpired(
  io: TypedServer,
  gameId: string,
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
  delayer: Delayer,
): Promise<void> {
  const state = await gameService.getGameState(gameId);
  if (!state || state.status !== "IN_PROGRESS") return;

  const engine = engineFactory.getEngine(state.gameType);
  const autoAction = engine.getAutoTimeoutAction(state);
  if (!autoAction) return;

  try {
    await gameService.applyAction(gameId, autoAction);
  } catch (err: unknown) {
    // If applyAction throws (e.g., concurrent player action already advanced the turn),
    // return silently. The concurrent action's handler already restarted the timer.
    logger.warn(
      { gameId, err },
      "Timer auto-action failed (likely concurrent action)",
    );
    return;
  }

  // If the timed-out player was disconnected, mark them abandoned
  if (!connectionManager.isPlayerConnected(gameId, autoAction.playerId)) {
    connectionManager.markAbandoned(gameId, autoAction.playerId);
  }

  const timerExpiredPayload: TimerExpiredPayload = {
    gameId,
    playerId: autoAction.playerId,
    action: autoAction.type,
  };
  io.to(`game:${gameId}`)
    .to(`spectators:${gameId}`)
    .emit("game:timerExpired", timerExpiredPayload);

  const newState = await gameService.getGameState(gameId);
  if (newState?.status === "COMPLETED") {
    turnTimerService.unregisterGame(gameId);
    connectionManager.clearGameAbandoned(gameId);
  } else if (newState) {
    const nextPlayer = newState.players[newState.currentPlayerIndex];
    if (
      nextPlayer &&
      (await shouldAutoPlay(
        gameId,
        nextPlayer.playerId,
        gameService,
        connectionManager,
      ))
    ) {
      // Skip timer — autoPlayAbandoned will handle this player and start timer for the next connected one
    } else {
      turnTimerService.startTurn(gameId, false);
    }
  }

  await broadcastGameState(
    io,
    gameId,
    gameService,
    connectionManager,
    turnTimerService,
  );

  // After timer-based auto-pass, check if the next player is also abandoned
  await autoPlayAbandoned(
    io,
    gameId,
    gameService,
    connectionManager,
    turnTimerService,
    delayer,
  );
}

export function registerSocketHandlers(
  io: TypedServer,
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
  delayer: Delayer,
): void {
  io.on("connection", (socket) => {
    socket.on("game:join", (payload, ack) => {
      handleGameJoin(
        socket,
        io,
        payload,
        ack,
        gameService,
        connectionManager,
        turnTimerService,
        delayer,
      ).catch((err: unknown) => {
        socketLog(socket, payload?.gameId).error({ err }, "game:join error");
        ack({ success: false, error: "INTERNAL_ERROR" });
      });
    });

    socket.on("game:start", (payload, ack) => {
      handleGameStart(
        socket,
        io,
        payload,
        ack,
        gameService,
        connectionManager,
        turnTimerService,
        delayer,
      ).catch((err: unknown) => {
        socketLog(socket, payload?.gameId).error({ err }, "game:start error");
        ack({ success: false, error: "INTERNAL_ERROR" });
      });
    });

    socket.on("game:rematch", (payload, ack) => {
      handleGameRematch(
        socket,
        io,
        payload,
        ack,
        gameService,
        connectionManager,
        turnTimerService,
        delayer,
      ).catch((err: unknown) => {
        socketLog(socket, payload?.gameId).error({ err }, "game:rematch error");
        ack({ success: false, error: "INTERNAL_ERROR" });
      });
    });

    socket.on("game:action", (payload, ack) => {
      handleGameAction(
        socket,
        io,
        payload,
        ack,
        gameService,
        connectionManager,
        turnTimerService,
        delayer,
      ).catch((err: unknown) => {
        socketLog(socket, payload?.gameId).error({ err }, "game:action error");
        ack({ success: false, error: "INVALID_ACTION" });
      });
    });

    socket.on("game:leave", (payload) => {
      handleGameLeave(
        socket,
        io,
        payload,
        connectionManager,
        gameService,
        turnTimerService,
      ).catch((err: unknown) => {
        socketLog(socket, payload?.gameId).error({ err }, "game:leave error");
      });
    });

    socket.on("disconnect", () => {
      handleDisconnect(
        socket,
        io,
        connectionManager,
        gameService,
        turnTimerService,
      ).catch((err: unknown) => {
        socketLog(socket).error({ err }, "disconnect error");
      });
    });
  });
}
