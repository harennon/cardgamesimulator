import type { TypedServer, TypedSocket } from "./socketServer.js";
import type { ConnectionManager } from "./connectionManager.js";
import type { GameService } from "@/service/gameService";
import { engineFactory } from "@/engine/game-engine-factory";
import type { PlayerPublicInfo, PlayerInfo } from "@shared/engine-types";
import type {
  GameJoinPayload,
  GameJoinResponse,
  GameActionPayload,
  GameActionResponse,
  GameStartPayload,
  GameStartResponse,
  GameLeavePayload,
  TimerExpiredPayload,
} from "@shared/socket-events";
import type { TurnTimerService } from "@/timer/turnTimerService";

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
>(view: T, gameId: string, connectionManager: ConnectionManager): T {
  const players = view.players.map((p) => ({
    ...p,
    isConnected: connectionManager.isPlayerConnected(gameId, p.playerId),
  }));
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

  const engine = engineFactory.getEngine(state.gameType);
  const playerSockets = connectionManager.getPlayerSockets(gameId);
  const spectatorCount = connectionManager.getSpectatorCount(gameId);
  const turnDeadline = turnTimerService.getDeadline(gameId);

  for (const { playerId, socket } of playerSockets) {
    const view = engine.getPlayerView(state, playerId);
    socket.emit("game:state", {
      ...injectConnectionStatus(view, gameId, connectionManager),
      turnDeadline,
      joinCode,
    });
  }

  const spectatorView = engine.getSpectatorView(state, spectatorCount);
  io.to(`spectators:${gameId}`).emit("game:spectatorState", {
    ...injectConnectionStatus(spectatorView, gameId, connectionManager),
    turnDeadline,
  });
}

/**
 * After a state change, if the new current player is abandoned, auto-play them immediately.
 * Loops until a non-abandoned player's turn or game completion.
 */
async function autoPlayAbandoned(
  io: TypedServer,
  gameId: string,
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
): Promise<void> {
  const state = await gameService.getGameState(gameId);
  // Loop bounded by player count to prevent infinite loops
  const maxIterations = state?.players.length ?? 4;

  for (let i = 0; i < maxIterations; i++) {
    const currentState = await gameService.getGameState(gameId);
    if (!currentState || currentState.status !== "IN_PROGRESS") return;

    const currentPlayer = currentState.players[currentState.currentPlayerIndex];
    if (
      !currentPlayer ||
      !connectionManager.isAbandoned(gameId, currentPlayer.playerId)
    ) {
      // Connected player reached — start their turn timer only if we actually auto-played
      if (i > 0) {
        turnTimerService.startTurn(gameId, false);
      }
      return;
    }

    const engine = engineFactory.getEngine(currentState.gameType);
    const autoAction = engine.getAutoTimeoutAction(currentState);
    if (!autoAction) return;

    try {
      await gameService.applyAction(gameId, autoAction);
    } catch {
      return; // Concurrent action already advanced the turn
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
      return;
    }

    await broadcastGameState(
      io,
      gameId,
      gameService,
      connectionManager,
      turnTimerService,
    );
    // Loop continues to check the next player
  }
}

async function handleGameJoin(
  socket: TypedSocket,
  io: TypedServer,
  payload: GameJoinPayload,
  ack: (response: GameJoinResponse) => void,
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
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
      // Send full lobby state to the joining socket for reconciliation
      const players: PlayerInfo[] = game.playerIds.map((id) => ({
        playerId: id,
        displayName: game.playerDisplayNames[id] ?? id,
      }));
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
          );
        }
      }

      // IN_PROGRESS or COMPLETED: send current game state
      const view = await gameService.getPlayerView(gameId, userId);
      if (view) {
        const turnDeadline = turnTimerService.getDeadline(gameId);
        socket.emit("game:state", {
          ...injectConnectionStatus(view, gameId, connectionManager),
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
      socket.emit("game:spectatorState", {
        ...injectConnectionStatus(spectatorView, gameId, connectionManager),
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
    await gameService.startGame(gameId, userId);

    // Register and start timer after game starts
    const game = await gameService.getGame(gameId);
    if (game?.turnTimerSeconds != null) {
      turnTimerService.registerGame(gameId, {
        turnTimerSeconds: game.turnTimerSeconds,
      });
      turnTimerService.startTurn(gameId, true);
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

    ack({ success: true });
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

    // Check if the next current player is abandoned — if so, skip turn timer and auto-play
    if (newState) {
      const nextPlayer = newState.players[newState.currentPlayerIndex];
      if (
        nextPlayer &&
        connectionManager.isAbandoned(gameId, nextPlayer.playerId)
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
    console.warn("Timer auto-action failed (likely concurrent action):", err);
    return;
  }

  // If the timed-out player was disconnected, mark them abandoned
  if (!connectionManager.isPlayerConnected(gameId, autoAction.playerId)) {
    connectionManager.markAbandoned(gameId, autoAction.playerId);
  }

  const timerExpiredPayload: TimerExpiredPayload = {
    gameId,
    playerId: autoAction.playerId,
    action: autoAction.type as "pass" | "playCards",
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
      connectionManager.isAbandoned(gameId, nextPlayer.playerId)
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
  );
}

export function registerSocketHandlers(
  io: TypedServer,
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
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
      ).catch((err: unknown) => {
        console.error("game:join error", err);
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
      ).catch((err: unknown) => {
        console.error("game:start error", err);
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
      ).catch((err: unknown) => {
        console.error("game:action error", err);
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
        console.error("game:leave error", err);
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
        console.error("disconnect error", err);
      });
    });
  });
}
