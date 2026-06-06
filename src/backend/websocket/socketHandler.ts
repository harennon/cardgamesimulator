import type { TypedServer, TypedSocket } from "./socketServer.js";
import type { ConnectionManager } from "./connectionManager.js";
import type { GameService } from "@/service/gameService";
import { engineFactory } from "@/engine/game-engine-factory";
import type { PlayerPublicInfo } from "@shared/engine-types";
import type {
  GameJoinPayload,
  GameJoinResponse,
  GameActionPayload,
  GameActionResponse,
  GameStartPayload,
  GameStartResponse,
  GameLeavePayload,
} from "@shared/socket-events";

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
): Promise<void> {
  const state = await gameService.getGameState(gameId);
  if (!state) return;

  const engine = engineFactory.getEngine(state.gameType);
  const playerSockets = connectionManager.getPlayerSockets(gameId);
  const spectatorCount = connectionManager.getSpectatorCount(gameId);

  for (const { playerId, socket } of playerSockets) {
    const view = engine.getPlayerView(state, playerId);
    socket.emit(
      "game:state",
      injectConnectionStatus(view, gameId, connectionManager),
    );
  }

  const spectatorView = engine.getSpectatorView(state, spectatorCount);
  io.to(`spectators:${gameId}`).emit(
    "game:spectatorState",
    injectConnectionStatus(spectatorView, gameId, connectionManager),
  );
}

async function handleGameJoin(
  socket: TypedSocket,
  io: TypedServer,
  payload: GameJoinPayload,
  ack: (response: GameJoinResponse) => void,
  gameService: GameService,
  connectionManager: ConnectionManager,
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
      // Lobby: notify others that this player joined
      socket.to(`game:${gameId}`).emit("lobby:playerJoined", {
        player: { playerId: userId, displayName },
        playerCount: game.playerIds.length,
      });
      ack({ success: true });
    } else {
      // IN_PROGRESS or COMPLETED: send current game state
      const view = await gameService.getPlayerView(gameId, userId);
      if (view) {
        socket.emit(
          "game:state",
          injectConnectionStatus(view, gameId, connectionManager),
        );
      }

      if (game.status === "IN_PROGRESS") {
        socket.to(`game:${gameId}`).emit("game:playerReconnected", {
          playerId: userId,
          displayName,
        });
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

    connectionManager.addSpectatorSocket(gameId, socket);
    await socket.join(`spectators:${gameId}`);

    if (game.status !== "CREATED") {
      const spectatorCount = connectionManager.getSpectatorCount(gameId);
      const spectatorView = await gameService.getSpectatorView(
        gameId,
        spectatorCount,
      );
      if (spectatorView) {
        socket.emit(
          "game:spectatorState",
          injectConnectionStatus(spectatorView, gameId, connectionManager),
        );
      }
    }

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
): Promise<void> {
  const { gameId } = payload;
  const { userId } = socket.data;

  if (!gameId) {
    ack({ success: false, error: "gameId is required" });
    return;
  }

  try {
    await gameService.startGame(gameId, userId);

    // Broadcast game:started to all players in the room
    io.to(`game:${gameId}`).emit("game:started");

    // Then broadcast each player's individual state
    await broadcastGameState(io, gameId, gameService, connectionManager);

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
): Promise<void> {
  const { gameId, action } = payload;
  const { userId } = socket.data;

  if (!gameId || !action) {
    ack({ success: false, error: "gameId and action are required" });
    return;
  }

  // Override client-supplied playerId with authenticated userId (anti-spoofing)
  const safeAction = { ...action, playerId: userId };

  try {
    await gameService.applyAction(gameId, safeAction);
    await broadcastGameState(io, gameId, gameService, connectionManager);
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
): Promise<void> {
  const { gameId } = payload;
  const { userId, displayName } = socket.data;

  socket.leave(`game:${gameId}`);
  socket.leave(`spectators:${gameId}`);
  connectionManager.removeSocket(socket.id);

  if (!connectionManager.isPlayerConnected(gameId, userId)) {
    const game = await gameService.getGame(gameId);
    if (game && game.status === "CREATED") {
      io.to(`game:${gameId}`).emit("lobby:playerLeft", {
        playerId: userId,
        playerCount: game.playerIds.length,
      });
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
): Promise<void> {
  const meta = connectionManager.removeSocket(socket.id);
  if (!meta) return;

  const { gameId, playerId, role } = meta;

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
    } else {
      io.to(`game:${gameId}`).emit("game:playerDisconnected", {
        playerId,
        displayName,
      });
    }
  }
}

export function registerSocketHandlers(
  io: TypedServer,
  gameService: GameService,
  connectionManager: ConnectionManager,
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
      ).catch((err: unknown) => {
        console.error("game:action error", err);
        ack({ success: false, error: "INTERNAL_ERROR" });
      });
    });

    socket.on("game:leave", (payload) => {
      handleGameLeave(
        socket,
        io,
        payload,
        connectionManager,
        gameService,
      ).catch((err: unknown) => {
        console.error("game:leave error", err);
      });
    });

    socket.on("disconnect", () => {
      handleDisconnect(socket, io, connectionManager, gameService).catch(
        (err: unknown) => {
          console.error("disconnect error", err);
        },
      );
    });
  });
}
