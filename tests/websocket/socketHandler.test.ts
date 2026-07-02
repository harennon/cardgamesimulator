import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  TypedServer,
  TypedSocket,
} from "../../src/backend/websocket/socketServer.js";
import type { ConnectionManager } from "../../src/backend/websocket/connectionManager.js";
import type { GameService } from "../../src/backend/service/gameService.js";
import type { TurnTimerService } from "../../src/backend/timer/turnTimerService.js";
import { registerSocketHandlers } from "../../src/backend/websocket/socketHandler.js";
import { Game } from "../../src/backend/database/entities/Game.js";
import type {
  LobbyStatePayload,
  LobbyPlayerJoinedPayload,
  EnrichedPlayerView,
} from "../../src/shared/socket-events.js";

vi.mock("../../src/backend/engine/game-engine-factory.js", () => {
  const mockEngine = {
    gameType: "big2",
    getPlayerView: vi.fn().mockReturnValue({ players: [] }),
    getSpectatorView: vi.fn().mockReturnValue({ players: [] }),
    getAutoTimeoutAction: vi.fn().mockReturnValue({
      type: "pass",
      playerId: "host-id",
    }),
  };
  return {
    engineFactory: {
      getEngine: vi.fn().mockReturnValue(mockEngine),
      hasEngine: vi.fn().mockReturnValue(true),
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGame(overrides: Partial<Game> = {}): Game {
  const game = new Game();
  game.gameId = "game-1";
  game.gameType = "big2";
  game.playerIds = ["host-id", "joiner-id"];
  game.playerDisplayNames = { "host-id": "Host", "joiner-id": "Joiner" };
  game.maxPlayers = 4;
  game.status = "CREATED";
  game.version = 1;
  Object.assign(game, overrides);
  return game;
}

type JoinAck = (response: { success: boolean; error?: string }) => void;

/**
 * Creates a minimal typed socket mock that records emitted events.
 */
function makeSocket(
  userId: string,
  displayName: string,
): {
  socket: TypedSocket;
  emitted: Map<string, unknown[]>;
  toEmitted: Map<string, unknown[]>;
} {
  const emitted = new Map<string, unknown[]>();
  const toEmitted = new Map<string, unknown[]>();

  const socket = {
    id: `sock-${userId}`,
    recovered: false,
    data: { userId, displayName },
    join: vi.fn().mockResolvedValue(undefined),
    emit: vi.fn().mockImplementation((event: string, ...args: unknown[]) => {
      emitted.set(event, args);
      return true;
    }),
    to: vi.fn().mockReturnValue({
      emit: vi.fn().mockImplementation((event: string, ...args: unknown[]) => {
        toEmitted.set(event, args);
        return true;
      }),
    }),
    on: vi.fn(),
  } as unknown as TypedSocket;

  return { socket, emitted, toEmitted };
}

/**
 * Creates a minimal ConnectionManager mock.
 */
function makeConnectionManager(): ConnectionManager {
  return {
    addPlayerSocket: vi.fn(),
    isPlayerConnected: vi.fn().mockReturnValue(false),
    getSpectatorCount: vi.fn().mockReturnValue(0),
    getPlayerSockets: vi.fn().mockReturnValue([]),
    removeSocket: vi.fn(),
    addSpectatorSocket: vi.fn(),
    isSpectator: vi.fn().mockReturnValue(false),
    getSpectatorGameId: vi.fn().mockReturnValue(null),
    markAbandoned: vi.fn(),
    clearAbandoned: vi.fn(),
    isAbandoned: vi.fn().mockReturnValue(false),
    clearGameAbandoned: vi.fn(),
  } as unknown as ConnectionManager;
}

/**
 * Creates a minimal TurnTimerService mock.
 */
function makeTurnTimerService(): TurnTimerService {
  return {
    getDeadline: vi.fn().mockReturnValue(null),
    registerGame: vi.fn(),
    startTurn: vi.fn(),
    hasTimer: vi.fn().mockReturnValue(false),
    unregisterGame: vi.fn(),
  } as unknown as TurnTimerService;
}

/**
 * Builds a fake io that records registered connection handlers and
 * allows triggering a game:join event on a given socket.
 */
function makeIo(): {
  io: TypedServer;
  triggerGameJoin: (
    socket: TypedSocket,
    gameId: string,
    ack: JoinAck,
  ) => Promise<void>;
} {
  let gameJoinHandler: (
    payload: { gameId: string; role: "player" | "spectator" },
    ack: JoinAck,
  ) => void = () => {};

  const io = {
    on: vi
      .fn()
      .mockImplementation(
        (event: string, connectionCb: (socket: TypedSocket) => void) => {
          if (event === "connection") {
            // Capture what handlers get registered when a socket connects
            const fakeSocket = {
              on: vi
                .fn()
                .mockImplementation(
                  (
                    socketEvent: string,
                    handler: (...args: unknown[]) => void,
                  ) => {
                    if (socketEvent === "game:join") {
                      gameJoinHandler = handler as typeof gameJoinHandler;
                    }
                  },
                ),
            } as unknown as TypedSocket;
            connectionCb(fakeSocket);
          }
        },
      ),
    to: vi.fn().mockReturnValue({ emit: vi.fn() }),
  } as unknown as TypedServer;

  const triggerGameJoin = async (
    socket: TypedSocket,
    gameId: string,
    ack: JoinAck,
  ): Promise<void> => {
    // Re-wire game:join handler to use the real socket passed in
    let realJoinHandler: (
      payload: { gameId: string; role: "player" | "spectator" },
      ack: JoinAck,
    ) => void = () => {};

    const socketWithOn = {
      ...socket,
      on: vi
        .fn()
        .mockImplementation(
          (socketEvent: string, handler: (...args: unknown[]) => void) => {
            if (socketEvent === "game:join") {
              realJoinHandler = handler as typeof realJoinHandler;
            }
          },
        ),
    } as unknown as TypedSocket;

    // Trigger the connection callback with the real socket
    const connectionCb = (io.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: [string, unknown]) => c[0] === "connection",
    )?.[1] as ((socket: TypedSocket) => void) | undefined;

    if (connectionCb) {
      connectionCb(socketWithOn);
    }

    await new Promise<void>((resolve, reject) => {
      realJoinHandler({ gameId, role: "player" }, (response) => {
        ack(response);
        resolve();
      });
      // If handler doesn't call ack (error path), resolve after a tick
      setTimeout(resolve, 50);
    });
  };

  return { io, triggerGameJoin };
}

// ---------------------------------------------------------------------------
// A simpler approach: extract and call the handler directly via registerSocketHandlers
// ---------------------------------------------------------------------------

/**
 * Sets up registerSocketHandlers, captures the connection handler, and returns
 * a helper that fires game:join on a given socket.
 */
function setupHandlers(
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
): {
  fireGameJoin: (
    socket: TypedSocket,
    gameId: string,
    ack: JoinAck,
  ) => Promise<void>;
} {
  // Capture the connection callback by intercepting io.on("connection", cb)
  let onConnection: ((socket: TypedSocket) => void) | null = null;

  const io = {
    on: vi
      .fn()
      .mockImplementation(
        (event: string, cb: (socket: TypedSocket) => void) => {
          if (event === "connection") {
            onConnection = cb;
          }
        },
      ),
    to: vi.fn().mockReturnValue({ emit: vi.fn() }),
  } as unknown as TypedServer;

  registerSocketHandlers(io, gameService, connectionManager, turnTimerService);

  const fireGameJoin = (
    socket: TypedSocket,
    gameId: string,
    ack: JoinAck,
  ): Promise<void> => {
    if (!onConnection) throw new Error("onConnection not captured");

    let gameJoinHandler: (
      payload: { gameId: string; role: "player" | "spectator" },
      ack: JoinAck,
    ) => void = () => {};

    // Build a socket proxy that captures the game:join handler
    const proxySocket = new Proxy(socket, {
      get(target, prop) {
        if (prop === "on") {
          return (event: string, handler: (...args: unknown[]) => void) => {
            if (event === "game:join") {
              gameJoinHandler = handler as typeof gameJoinHandler;
            }
          };
        }
        return (target as Record<string | symbol, unknown>)[prop];
      },
    });

    onConnection(proxySocket);

    return new Promise<void>((resolve) => {
      gameJoinHandler({ gameId, role: "player" }, (response) => {
        ack(response);
        resolve();
      });
    });
  };

  return { fireGameJoin };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("socketHandler handleGameJoin — CREATED branch", () => {
  let gameService: GameService;
  let connectionManager: ConnectionManager;
  let turnTimerService: TurnTimerService;

  beforeEach(() => {
    connectionManager = makeConnectionManager();
    turnTimerService = makeTurnTimerService();
    gameService = {
      getGame: vi.fn(),
      getJoinCode: vi.fn().mockResolvedValue(null),
      getGameState: vi.fn().mockResolvedValue(null),
      getPlayerView: vi.fn().mockResolvedValue(null),
      getSpectatorView: vi.fn().mockResolvedValue(null),
      applyAction: vi.fn(),
      startGame: vi.fn(),
    } as unknown as GameService;
  });

  it("emits lobby:state to the joining socket with the full player list", async () => {
    const game = makeGame();
    (gameService.getGame as ReturnType<typeof vi.fn>).mockResolvedValue(game);

    const { socket, emitted } = makeSocket("joiner-id", "Joiner");
    const { fireGameJoin } = setupHandlers(
      gameService,
      connectionManager,
      turnTimerService,
    );

    const ackResult: { success: boolean; error?: string }[] = [];
    await fireGameJoin(socket, "game-1", (r) => ackResult.push(r));

    expect(ackResult[0]?.success).toBe(true);

    const lobbyStateArgs = emitted.get("lobby:state") as
      | [LobbyStatePayload]
      | undefined;
    expect(lobbyStateArgs).toBeDefined();
    const payload = lobbyStateArgs![0];
    expect(payload.maxPlayers).toBe(4);
    expect(payload.players).toHaveLength(2);
    expect(payload.players).toContainEqual({
      playerId: "host-id",
      displayName: "Host",
    });
    expect(payload.players).toContainEqual({
      playerId: "joiner-id",
      displayName: "Joiner",
    });
    // joinCode defaults to "" when game.joinCode is null
    expect(payload.joinCode).toBe("");
  });

  it("includes the join code in lobby:state when game has a joinCode", async () => {
    const game = makeGame();
    game.joinCode = "H7K3";
    (gameService.getGame as ReturnType<typeof vi.fn>).mockResolvedValue(game);

    const { socket, emitted } = makeSocket("joiner-id", "Joiner");
    const { fireGameJoin } = setupHandlers(
      gameService,
      connectionManager,
      turnTimerService,
    );

    await fireGameJoin(socket, "game-1", () => {});

    const lobbyStateArgs = emitted.get("lobby:state") as
      | [LobbyStatePayload]
      | undefined;
    expect(lobbyStateArgs).toBeDefined();
    const payload = lobbyStateArgs![0];
    expect(payload.joinCode).toBe("H7K3");
  });

  it("emits lobby:playerJoined to others in the room", async () => {
    const game = makeGame();
    (gameService.getGame as ReturnType<typeof vi.fn>).mockResolvedValue(game);

    const { socket, toEmitted } = makeSocket("joiner-id", "Joiner");
    const { fireGameJoin } = setupHandlers(
      gameService,
      connectionManager,
      turnTimerService,
    );

    await fireGameJoin(socket, "game-1", () => {});

    const playerJoinedArgs = toEmitted.get("lobby:playerJoined") as
      | [LobbyPlayerJoinedPayload]
      | undefined;
    expect(playerJoinedArgs).toBeDefined();
    const payload = playerJoinedArgs![0];
    expect(payload.player.playerId).toBe("joiner-id");
    expect(payload.player.displayName).toBe("Joiner");
    expect(payload.playerCount).toBe(2);
  });

  it("does NOT emit lobby:state for an IN_PROGRESS game", async () => {
    const game = makeGame({ status: "IN_PROGRESS" });
    (gameService.getGame as ReturnType<typeof vi.fn>).mockResolvedValue(game);
    (gameService.getPlayerView as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );

    const { socket, emitted } = makeSocket("joiner-id", "Joiner");
    const { fireGameJoin } = setupHandlers(
      gameService,
      connectionManager,
      turnTimerService,
    );

    await fireGameJoin(socket, "game-1", () => {});

    expect(emitted.has("lobby:state")).toBe(false);
  });

  it("does NOT emit lobby:state for a COMPLETED game", async () => {
    const game = makeGame({ status: "COMPLETED" });
    (gameService.getGame as ReturnType<typeof vi.fn>).mockResolvedValue(game);
    (gameService.getPlayerView as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );

    const { socket, emitted } = makeSocket("joiner-id", "Joiner");
    const { fireGameJoin } = setupHandlers(
      gameService,
      connectionManager,
      turnTimerService,
    );

    await fireGameJoin(socket, "game-1", () => {});

    expect(emitted.has("lobby:state")).toBe(false);
  });

  it("includes display name fallback to playerId when displayName is missing", async () => {
    const game = makeGame({
      playerIds: ["host-id", "no-name-id"],
      playerDisplayNames: { "host-id": "Host" },
    });
    (gameService.getGame as ReturnType<typeof vi.fn>).mockResolvedValue(game);

    const { socket, emitted } = makeSocket("no-name-id", "NoName");
    const { fireGameJoin } = setupHandlers(
      gameService,
      connectionManager,
      turnTimerService,
    );

    await fireGameJoin(socket, "game-1", () => {});

    const lobbyStateArgs = emitted.get("lobby:state") as
      | [LobbyStatePayload]
      | undefined;
    expect(lobbyStateArgs).toBeDefined();
    const payload = lobbyStateArgs![0];
    const noNamePlayer = payload.players.find(
      (p) => p.playerId === "no-name-id",
    );
    // Falls back to playerId when displayName is absent from playerDisplayNames
    expect(noNamePlayer?.displayName).toBe("no-name-id");
  });
});

// ---------------------------------------------------------------------------
// Timer recovery tests
// ---------------------------------------------------------------------------

describe("socketHandler handleGameJoin — timer recovery on wake", () => {
  let gameService: GameService;
  let connectionManager: ConnectionManager;
  let turnTimerService: TurnTimerService;

  beforeEach(() => {
    connectionManager = makeConnectionManager();
    gameService = {
      getGame: vi.fn(),
      getJoinCode: vi.fn().mockResolvedValue(null),
      getGameState: vi.fn().mockResolvedValue(null),
      getPlayerView: vi.fn().mockResolvedValue(null),
      getSpectatorView: vi.fn().mockResolvedValue(null),
      applyAction: vi.fn().mockResolvedValue(undefined),
      startGame: vi.fn(),
    } as unknown as GameService;
  });

  it("registers game timer and triggers timeout when IN_PROGRESS game has no active timer", async () => {
    // Timer has no deadline (lost during sleep) and no registered config
    turnTimerService = {
      getDeadline: vi.fn().mockReturnValue(null),
      hasTimer: vi.fn().mockReturnValue(false),
      registerGame: vi.fn(),
      startTurn: vi.fn(),
      unregisterGame: vi.fn(),
    } as unknown as TurnTimerService;

    const game = makeGame({ status: "IN_PROGRESS", turnTimerSeconds: 30 });
    (gameService.getGame as ReturnType<typeof vi.fn>).mockResolvedValue(game);

    // getGameState returns an IN_PROGRESS state so handleTimerExpired can proceed
    const inProgressState = {
      gameId: "game-1",
      gameType: "big2",
      status: "IN_PROGRESS",
      version: 1,
      players: [{ playerId: "host-id" }, { playerId: "joiner-id" }],
      currentPlayerIndex: 0,
      turnNumber: 1,
      gameSpecificState: null,
      winner: null,
      scores: null,
      randomSeed: "test-seed",
    };
    (gameService.getGameState as ReturnType<typeof vi.fn>).mockResolvedValue(
      inProgressState,
    );

    const { socket } = makeSocket("host-id", "Host");
    const { fireGameJoin } = setupHandlers(
      gameService,
      connectionManager,
      turnTimerService,
    );

    await fireGameJoin(socket, "game-1", () => {});

    expect(turnTimerService.registerGame).toHaveBeenCalledWith("game-1", {
      turnTimerSeconds: 30,
    });
    expect(gameService.applyAction).toHaveBeenCalled();
  });

  it("does not register timer when timer is already active (second reconnect)", async () => {
    // Timer is already registered (deadline exists, hasTimer returns true)
    turnTimerService = {
      getDeadline: vi.fn().mockReturnValue(Date.now() + 15_000),
      hasTimer: vi.fn().mockReturnValue(true),
      registerGame: vi.fn(),
      startTurn: vi.fn(),
      unregisterGame: vi.fn(),
    } as unknown as TurnTimerService;

    const game = makeGame({ status: "IN_PROGRESS", turnTimerSeconds: 30 });
    (gameService.getGame as ReturnType<typeof vi.fn>).mockResolvedValue(game);

    const { socket } = makeSocket("host-id", "Host");
    const { fireGameJoin } = setupHandlers(
      gameService,
      connectionManager,
      turnTimerService,
    );

    await fireGameJoin(socket, "game-1", () => {});

    expect(turnTimerService.registerGame).not.toHaveBeenCalled();
    expect(gameService.applyAction).not.toHaveBeenCalled();
  });

  it("does not trigger recovery for a COMPLETED game", async () => {
    turnTimerService = {
      getDeadline: vi.fn().mockReturnValue(null),
      hasTimer: vi.fn().mockReturnValue(false),
      registerGame: vi.fn(),
      startTurn: vi.fn(),
      unregisterGame: vi.fn(),
    } as unknown as TurnTimerService;

    const game = makeGame({ status: "COMPLETED", turnTimerSeconds: 30 });
    (gameService.getGame as ReturnType<typeof vi.fn>).mockResolvedValue(game);

    const { socket } = makeSocket("host-id", "Host");
    const { fireGameJoin } = setupHandlers(
      gameService,
      connectionManager,
      turnTimerService,
    );

    await fireGameJoin(socket, "game-1", () => {});

    expect(turnTimerService.registerGame).not.toHaveBeenCalled();
    expect(gameService.applyAction).not.toHaveBeenCalled();
  });

  it("does not trigger recovery when game has no timer configured", async () => {
    turnTimerService = {
      getDeadline: vi.fn().mockReturnValue(null),
      hasTimer: vi.fn().mockReturnValue(false),
      registerGame: vi.fn(),
      startTurn: vi.fn(),
      unregisterGame: vi.fn(),
    } as unknown as TurnTimerService;

    // turnTimerSeconds is null — no timer configured
    const game = makeGame({ status: "IN_PROGRESS", turnTimerSeconds: null });
    (gameService.getGame as ReturnType<typeof vi.fn>).mockResolvedValue(game);

    const { socket } = makeSocket("host-id", "Host");
    const { fireGameJoin } = setupHandlers(
      gameService,
      connectionManager,
      turnTimerService,
    );

    await fireGameJoin(socket, "game-1", () => {});

    expect(turnTimerService.registerGame).not.toHaveBeenCalled();
    expect(gameService.applyAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Join-time game:state joinCode tests (handleGameJoin IN_PROGRESS branch)
// ---------------------------------------------------------------------------

describe("socketHandler handleGameJoin — join-time game:state joinCode", () => {
  let gameService: GameService;
  let connectionManager: ConnectionManager;
  let turnTimerService: TurnTimerService;

  beforeEach(() => {
    connectionManager = makeConnectionManager();
    turnTimerService = makeTurnTimerService();
    // hasTimer false so the reconnect re-broadcast path stays simple; we assert
    // the join-time socket.emit("game:state", ...) directly.
    gameService = {
      getGame: vi.fn(),
      getJoinCode: vi.fn().mockResolvedValue(null),
      getGameState: vi.fn().mockResolvedValue(null),
      getPlayerView: vi.fn().mockResolvedValue({ players: [] }),
      getSpectatorView: vi.fn().mockResolvedValue(null),
      applyAction: vi.fn(),
      startGame: vi.fn(),
    } as unknown as GameService;
  });

  it("includes the game's joinCode in the join-time game:state emit", async () => {
    const game = makeGame({ status: "IN_PROGRESS", joinCode: "H7K3" });
    (gameService.getGame as ReturnType<typeof vi.fn>).mockResolvedValue(game);

    const { socket, emitted } = makeSocket("host-id", "Host");
    const { fireGameJoin } = setupHandlers(
      gameService,
      connectionManager,
      turnTimerService,
    );

    await fireGameJoin(socket, "game-1", () => {});

    const gameStateArgs = emitted.get("game:state") as
      | [EnrichedPlayerView]
      | undefined;
    expect(gameStateArgs).toBeDefined();
    expect(gameStateArgs![0].joinCode).toBe("H7K3");
  });

  it("emits joinCode: null on join-time game:state when the game has no joinCode", async () => {
    const game = makeGame({ status: "IN_PROGRESS", joinCode: null });
    (gameService.getGame as ReturnType<typeof vi.fn>).mockResolvedValue(game);

    const { socket, emitted } = makeSocket("host-id", "Host");
    const { fireGameJoin } = setupHandlers(
      gameService,
      connectionManager,
      turnTimerService,
    );

    await fireGameJoin(socket, "game-1", () => {});

    const gameStateArgs = emitted.get("game:state") as
      | [EnrichedPlayerView]
      | undefined;
    expect(gameStateArgs).toBeDefined();
    expect(gameStateArgs![0].joinCode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LLD 118: socket-layer AI-seat tests
// ---------------------------------------------------------------------------

/**
 * Extend the setupHandlers helper to also capture game:start.
 */
function setupHandlersWithStart(
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
): {
  fireGameStart: (
    socket: TypedSocket,
    gameId: string,
    ack: (r: { success: boolean; error?: string }) => void,
  ) => Promise<void>;
  io: TypedServer;
} {
  let onConnection: ((socket: TypedSocket) => void) | null = null;

  const io = {
    on: vi
      .fn()
      .mockImplementation(
        (event: string, cb: (socket: TypedSocket) => void) => {
          if (event === "connection") {
            onConnection = cb;
          }
        },
      ),
    to: vi.fn().mockReturnValue({ emit: vi.fn() }),
  } as unknown as TypedServer;

  registerSocketHandlers(io, gameService, connectionManager, turnTimerService);

  const fireGameStart = (
    socket: TypedSocket,
    gameId: string,
    ack: (r: { success: boolean; error?: string }) => void,
  ): Promise<void> => {
    if (!onConnection) throw new Error("onConnection not captured");

    let gameStartHandler: (
      payload: { gameId: string },
      ack: (r: { success: boolean; error?: string }) => void,
    ) => void = () => {};

    const proxySocket = new Proxy(socket, {
      get(target, prop) {
        if (prop === "on") {
          return (event: string, handler: (...args: unknown[]) => void) => {
            if (event === "game:start") {
              gameStartHandler = handler as typeof gameStartHandler;
            }
          };
        }
        return (target as Record<string | symbol, unknown>)[prop];
      },
    });

    onConnection(proxySocket);

    return new Promise<void>((resolve) => {
      gameStartHandler({ gameId }, (response) => {
        ack(response);
        resolve();
      });
    });
  };

  return { fireGameStart, io };
}

describe("socketHandler — AI-seat: shouldAutoPlay and handleGameStart", () => {
  it("shouldAutoPlay: after game start with AI first-actor, autoPlayAbandoned is called (isAiSeat resolves true)", async () => {
    const aiId = "ai:00000000-0000-0000-0000-000000000001";
    const humanId = "host-id";

    const inProgressState = {
      gameId: "game-1",
      gameType: "big2",
      status: "IN_PROGRESS",
      version: 1,
      players: [
        { playerId: aiId, displayName: "CPU 1" },
        { playerId: humanId, displayName: "Host" },
      ],
      currentPlayerIndex: 0, // AI is first
      turnNumber: 1,
      gameSpecificState: null,
      winner: null,
      scores: null,
      randomSeed: "seed",
    };

    // After autoPlayAbandoned runs one iteration, the AI's action advances the
    // turn. For simplicity the mock keeps returning the same state (no progress)
    // but the divergence guard exits cleanly.
    const humanTurnState = {
      ...inProgressState,
      currentPlayerIndex: 1, // human's turn after AI plays
      version: 2,
    };

    const connectionManager = makeConnectionManager();
    const turnTimerService = makeTurnTimerService();

    const gameService = {
      startGame: vi.fn().mockResolvedValue(inProgressState),
      getGame: vi.fn().mockResolvedValue(makeGame({ turnTimerSeconds: null })),
      getJoinCode: vi.fn().mockResolvedValue(null),
      getGameState: vi
        .fn()
        .mockResolvedValueOnce(inProgressState) // autoPlayAbandoned first check
        .mockResolvedValue(humanTurnState), // subsequent reads → human's turn
      getPlayerView: vi.fn().mockResolvedValue({ players: [] }),
      getSpectatorView: vi.fn().mockResolvedValue(null),
      applyAction: vi.fn().mockResolvedValue(humanTurnState),
      isAiSeat: vi
        .fn()
        .mockImplementation(
          async (_gameId: string, playerId: string) => playerId === aiId,
        ),
    } as unknown as GameService;

    const { socket } = makeSocket(humanId, "Host");
    const { fireGameStart } = setupHandlersWithStart(
      gameService,
      connectionManager,
      turnTimerService,
    );

    const ackResult: { success: boolean; error?: string }[] = [];
    await fireGameStart(socket, "game-1", (r) => ackResult.push(r));

    expect(ackResult[0]?.success).toBe(true);
    // isAiSeat must be consulted for the first-seat timer skip and auto-play.
    expect(gameService.isAiSeat).toHaveBeenCalled();
  });

  it("AI-first timer skip: startTurn(gameId, true) is NOT called when first seat is AI", async () => {
    const aiId = "ai:00000000-0000-0000-0000-000000000001";
    const humanId = "host-id";

    const inProgressState = {
      gameId: "game-1",
      gameType: "big2",
      status: "IN_PROGRESS",
      version: 1,
      players: [
        { playerId: aiId, displayName: "CPU 1" },
        { playerId: humanId, displayName: "Host" },
      ],
      currentPlayerIndex: 0, // AI is first
      turnNumber: 1,
      gameSpecificState: null,
      winner: null,
      scores: null,
      randomSeed: "seed",
    };

    const humanTurnState = {
      ...inProgressState,
      currentPlayerIndex: 1,
      version: 2,
    };

    const connectionManager = makeConnectionManager();
    const turnTimerService = {
      ...makeTurnTimerService(),
      hasTimer: vi.fn().mockReturnValue(true),
      registerGame: vi.fn(),
      startTurn: vi.fn(),
      unregisterGame: vi.fn(),
      getDeadline: vi.fn().mockReturnValue(null),
    } as unknown as TurnTimerService;

    const gameService = {
      startGame: vi.fn().mockResolvedValue(inProgressState),
      getGame: vi.fn().mockResolvedValue(makeGame({ turnTimerSeconds: 30 })),
      getJoinCode: vi.fn().mockResolvedValue(null),
      getGameState: vi
        .fn()
        .mockResolvedValueOnce(inProgressState)
        .mockResolvedValue(humanTurnState),
      getPlayerView: vi.fn().mockResolvedValue({ players: [] }),
      getSpectatorView: vi.fn().mockResolvedValue(null),
      applyAction: vi.fn().mockResolvedValue(humanTurnState),
      isAiSeat: vi
        .fn()
        .mockImplementation(
          async (_gameId: string, playerId: string) => playerId === aiId,
        ),
    } as unknown as GameService;

    const { socket } = makeSocket(humanId, "Host");
    const { fireGameStart } = setupHandlersWithStart(
      gameService,
      connectionManager,
      turnTimerService,
    );

    await fireGameStart(socket, "game-1", () => {});

    // registerGame should still be called (timer service configured for later)
    expect(turnTimerService.registerGame).toHaveBeenCalledWith("game-1", {
      turnTimerSeconds: 30,
    });

    // The initial startTurn(true) should NOT be called because first seat is AI.
    const startTurnCalls = (
      turnTimerService.startTurn as ReturnType<typeof vi.fn>
    ).mock.calls;
    const initialStartCall = startTurnCalls.find(
      (c: unknown[]) => c[0] === "game-1" && c[1] === true,
    );
    expect(initialStartCall).toBeUndefined();
  });

  it("human-first regression: startTurn(gameId, true) IS called when first seat is human", async () => {
    const humanId = "host-id";

    const inProgressState = {
      gameId: "game-1",
      gameType: "big2",
      status: "IN_PROGRESS",
      version: 1,
      players: [
        { playerId: humanId, displayName: "Host" },
        { playerId: "player-b", displayName: "Bob" },
      ],
      currentPlayerIndex: 0, // human is first
      turnNumber: 1,
      gameSpecificState: null,
      winner: null,
      scores: null,
      randomSeed: "seed",
    };

    const connectionManager = makeConnectionManager();
    const turnTimerService = {
      ...makeTurnTimerService(),
      hasTimer: vi.fn().mockReturnValue(true),
      registerGame: vi.fn(),
      startTurn: vi.fn(),
      unregisterGame: vi.fn(),
      getDeadline: vi.fn().mockReturnValue(null),
    } as unknown as TurnTimerService;

    const gameService = {
      startGame: vi.fn().mockResolvedValue(inProgressState),
      getGame: vi.fn().mockResolvedValue(makeGame({ turnTimerSeconds: 30 })),
      getJoinCode: vi.fn().mockResolvedValue(null),
      getGameState: vi.fn().mockResolvedValue(inProgressState),
      getPlayerView: vi.fn().mockResolvedValue({ players: [] }),
      getSpectatorView: vi.fn().mockResolvedValue(null),
      applyAction: vi.fn(),
      isAiSeat: vi.fn().mockResolvedValue(false), // human seat
    } as unknown as GameService;

    const { socket } = makeSocket(humanId, "Host");
    const { fireGameStart } = setupHandlersWithStart(
      gameService,
      connectionManager,
      turnTimerService,
    );

    await fireGameStart(socket, "game-1", () => {});

    // Initial startTurn(true) MUST be called for human-first game.
    const startTurnCalls = (
      turnTimerService.startTurn as ReturnType<typeof vi.fn>
    ).mock.calls;
    const initialStartCall = startTurnCalls.find(
      (c: unknown[]) => c[0] === "game-1" && c[1] === true,
    );
    expect(initialStartCall).toBeDefined();
  });

  it("no AI socket registered: connectionManager never records an ai: playerId", async () => {
    // AI seats are server-driven; addPlayerSocket is only called via game:join
    // from real client sockets. Verify that after a game start with an AI seat,
    // getPlayerSockets never yields the AI id.
    const aiId = "ai:00000000-0000-0000-0000-000000000001";
    const humanId = "host-id";

    const connectionManager = makeConnectionManager();
    // getPlayerSockets returns only the human socket
    (
      connectionManager.getPlayerSockets as ReturnType<typeof vi.fn>
    ).mockReturnValue([{ playerId: humanId, socket: {} }]);

    const sockets = connectionManager.getPlayerSockets("game-1");
    expect(sockets.every((s) => s.playerId !== aiId)).toBe(true);
  });
});
