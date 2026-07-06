/**
 * LLD 137 — Delayer unit tests.
 *
 * Covers:
 * - RealDelayer fast-path for delay(0) / delay(negative)
 * - RealDelayer timer-based delay (using fake timers)
 * - ImmediateDelayer always resolves immediately
 * - Pacing insertion in autoPlayAbandoned (via RecordingDelayer + setupHandlersWithAction)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  RealDelayer,
  ImmediateDelayer,
  type Delayer,
} from "../../src/backend/websocket/delayer.js";
import type {
  TypedServer,
  TypedSocket,
} from "../../src/backend/websocket/socketServer.js";
import type { ConnectionManager } from "../../src/backend/websocket/connectionManager.js";
import type { GameService } from "../../src/backend/service/gameService.js";
import type { TurnTimerService } from "../../src/backend/timer/turnTimerService.js";
import {
  registerSocketHandlers,
  DEFAULT_AI_MOVE_DELAY_MS,
  MAX_AI_MOVE_DELAY_MS,
} from "../../src/backend/websocket/socketHandler.js";
import { Game } from "../../src/backend/database/entities/Game.js";

vi.mock("../../src/backend/engine/game-engine-factory.js", () => {
  const mockEngine = {
    gameType: "big2",
    getPlayerView: vi.fn().mockReturnValue({ players: [] }),
    getSpectatorView: vi.fn().mockReturnValue({ players: [] }),
    getAutoTimeoutAction: vi.fn().mockReturnValue({
      type: "pass",
      playerId: "host-id",
    }),
    getAiMoveAction: vi.fn().mockReturnValue({
      type: "pass",
      playerId: "ai-id",
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
// RecordingDelayer — captures every delay(ms) call for assertions
// ---------------------------------------------------------------------------

class RecordingDelayer implements Delayer {
  readonly recordedDelays: number[] = [];
  delay(ms: number): Promise<void> {
    this.recordedDelays.push(ms);
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Helpers (mirrored from socketHandler.test.ts)
// ---------------------------------------------------------------------------

function makeGame(overrides: Partial<Game> = {}): Game {
  const game = new Game();
  game.gameId = "game-1";
  game.gameType = "big2";
  game.playerIds = ["host-id", "ai-id"];
  game.playerDisplayNames = { "host-id": "Host", "ai-id": "CPU 1" };
  game.maxPlayers = 4;
  game.status = "IN_PROGRESS";
  game.version = 1;
  game.gameConfig = {};
  Object.assign(game, overrides);
  return game;
}

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
    getConnectedPlayerIds: vi.fn().mockReturnValue([]),
  } as unknown as ConnectionManager;
}

function makeTurnTimerService(): TurnTimerService {
  return {
    getDeadline: vi.fn().mockReturnValue(null),
    registerGame: vi.fn(),
    startTurn: vi.fn(),
    hasTimer: vi.fn().mockReturnValue(false),
    unregisterGame: vi.fn(),
  } as unknown as TurnTimerService;
}

function makeSocket(userId: string): TypedSocket {
  return {
    id: `sock-${userId}`,
    recovered: false,
    data: { userId, displayName: userId },
    join: vi.fn().mockResolvedValue(undefined),
    emit: vi.fn().mockReturnValue(true),
    to: vi.fn().mockReturnValue({ emit: vi.fn() }),
    on: vi.fn(),
  } as unknown as TypedSocket;
}

/**
 * Sets up registerSocketHandlers with a custom delayer and returns a helper
 * that fires game:action directly.
 */
function setupHandlersWithAction(
  gameService: GameService,
  connectionManager: ConnectionManager,
  turnTimerService: TurnTimerService,
  delayer: Delayer,
): {
  fireGameAction: (
    socket: TypedSocket,
    gameId: string,
    action: { type: string; playerId: string },
    ack: (r: { success: boolean; error?: string }) => void,
  ) => Promise<void>;
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

  registerSocketHandlers(
    io,
    gameService,
    connectionManager,
    turnTimerService,
    delayer,
  );

  const fireGameAction = (
    socket: TypedSocket,
    gameId: string,
    action: { type: string; playerId: string },
    ack: (r: { success: boolean; error?: string }) => void,
  ): Promise<void> => {
    if (!onConnection) throw new Error("onConnection not captured");

    let gameActionHandler: (
      payload: { gameId: string; action: { type: string; playerId: string } },
      ack: (r: { success: boolean; error?: string }) => void,
    ) => void = () => {};

    const proxySocket = new Proxy(socket, {
      get(target, prop) {
        if (prop === "on") {
          return (event: string, handler: (...args: unknown[]) => void) => {
            if (event === "game:action") {
              gameActionHandler = handler as typeof gameActionHandler;
            }
          };
        }
        return (target as Record<string | symbol, unknown>)[prop];
      },
    });

    onConnection(proxySocket);

    return new Promise<void>((resolve) => {
      gameActionHandler({ gameId, action }, (response) => {
        ack(response);
        resolve();
      });
    });
  };

  return { fireGameAction };
}

// ---------------------------------------------------------------------------
// Delayer unit tests
// ---------------------------------------------------------------------------

describe("RealDelayer", () => {
  it("delay(0) resolves immediately without scheduling a real timer", async () => {
    const delayer = new RealDelayer();
    let resolved = false;
    const p = delayer.delay(0).then(() => {
      resolved = true;
    });
    // The promise returned for ms<=0 is an already-resolved Promise.resolve()
    // so microtask queue is enough
    await p;
    expect(resolved).toBe(true);
  });

  it("delay(-1) resolves immediately (negative is treated as 0)", async () => {
    const delayer = new RealDelayer();
    let resolved = false;
    await delayer.delay(-1).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
  });

  it("delay(50) resolves after the timeout fires", async () => {
    vi.useFakeTimers();
    try {
      const delayer = new RealDelayer();
      let resolved = false;
      const p = delayer.delay(50).then(() => {
        resolved = true;
      });
      expect(resolved).toBe(false);
      vi.advanceTimersByTime(50);
      await p;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ImmediateDelayer", () => {
  it("delay(anything) resolves immediately", async () => {
    const delayer = new ImmediateDelayer();
    let resolved = false;
    await delayer.delay(999999).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
  });

  it("delay(0) resolves immediately", async () => {
    const delayer = new ImmediateDelayer();
    let resolved = false;
    await delayer.delay(0).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pacing insertion in autoPlayAbandoned
// ---------------------------------------------------------------------------

const AI_ID = "ai:00000000-0000-0000-0000-000000000001";
const HUMAN_ID = "host-id";

function makeAiCurrentState(version = 2) {
  return {
    gameId: "game-1",
    gameType: "big2",
    status: "IN_PROGRESS" as const,
    version,
    players: [
      { playerId: HUMAN_ID, displayName: "Host" },
      { playerId: AI_ID, displayName: "CPU 1" },
    ],
    currentPlayerIndex: 1, // AI is current
    turnNumber: 2,
    gameSpecificState: null,
    winner: null,
    scores: null,
    randomSeed: "seed",
  };
}

describe("autoPlayAbandoned pacing via RecordingDelayer", () => {
  let connectionManager: ConnectionManager;
  let turnTimerService: TurnTimerService;

  beforeEach(() => {
    connectionManager = makeConnectionManager();
    turnTimerService = makeTurnTimerService();
  });

  it("paced between AI moves: delay called once per applied auto-move with DEFAULT_AI_MOVE_DELAY_MS", async () => {
    const aiState = makeAiCurrentState(2);
    const humanTurnState = { ...aiState, currentPlayerIndex: 0, version: 3 };

    let getStateCount = 0;
    const gameService = {
      getGame: vi
        .fn()
        .mockResolvedValue(makeGame({ gameConfig: {} /* no aiMoveDelayMs */ })),
      getJoinCode: vi.fn().mockResolvedValue(null),
      getGameState: vi.fn().mockImplementation(async () => {
        const n = ++getStateCount;
        if (n <= 4) return aiState;
        return humanTurnState;
      }),
      getPlayerView: vi.fn().mockResolvedValue({ players: [] }),
      getSpectatorView: vi.fn().mockResolvedValue(null),
      applyAction: vi.fn().mockResolvedValue(humanTurnState),
      isAiSeat: vi
        .fn()
        .mockImplementation(async (_gId: string, pId: string) => pId === AI_ID),
      getAiSeatIds: vi.fn().mockResolvedValue(new Set([AI_ID])),
    } as unknown as GameService;

    const recorder = new RecordingDelayer();
    const { fireGameAction } = setupHandlersWithAction(
      gameService,
      connectionManager,
      turnTimerService,
      recorder,
    );

    await fireGameAction(
      makeSocket(HUMAN_ID),
      "game-1",
      { type: "pass", playerId: HUMAN_ID },
      () => {},
    );

    // One AI move was applied → delay called once with default
    expect(recorder.recordedDelays).toHaveLength(1);
    expect(recorder.recordedDelays[0]).toBe(DEFAULT_AI_MOVE_DELAY_MS);
  });

  it("zero latency for human-only game: delay never called", async () => {
    const humanState = {
      gameId: "game-1",
      gameType: "big2",
      status: "IN_PROGRESS" as const,
      version: 1,
      players: [
        { playerId: HUMAN_ID, displayName: "Host" },
        { playerId: "player-b", displayName: "Bob" },
      ],
      currentPlayerIndex: 0,
      turnNumber: 1,
      gameSpecificState: null,
      winner: null,
      scores: null,
      randomSeed: "seed",
    };
    const nextHumanState = {
      ...humanState,
      currentPlayerIndex: 1,
      version: 2,
    };

    const gameService = {
      getGame: vi.fn().mockResolvedValue(makeGame({ gameConfig: {} })),
      getJoinCode: vi.fn().mockResolvedValue(null),
      getGameState: vi.fn().mockResolvedValue(nextHumanState),
      getPlayerView: vi.fn().mockResolvedValue({ players: [] }),
      getSpectatorView: vi.fn().mockResolvedValue(null),
      applyAction: vi.fn().mockResolvedValue(nextHumanState),
      isAiSeat: vi.fn().mockResolvedValue(false),
      getAiSeatIds: vi.fn().mockResolvedValue(new Set()),
    } as unknown as GameService;

    const recorder = new RecordingDelayer();
    const { fireGameAction } = setupHandlersWithAction(
      gameService,
      connectionManager,
      turnTimerService,
      recorder,
    );

    await fireGameAction(
      makeSocket(HUMAN_ID),
      "game-1",
      { type: "pass", playerId: HUMAN_ID },
      () => {},
    );

    expect(recorder.recordedDelays).toHaveLength(0);
  });

  it("config override: aiMoveDelayMs=500 → delay called with 500", async () => {
    const aiState = makeAiCurrentState(2);
    const humanTurnState = { ...aiState, currentPlayerIndex: 0, version: 3 };

    let getStateCount = 0;
    const gameService = {
      getGame: vi
        .fn()
        .mockResolvedValue(makeGame({ gameConfig: { aiMoveDelayMs: 500 } })),
      getJoinCode: vi.fn().mockResolvedValue(null),
      getGameState: vi.fn().mockImplementation(async () => {
        const n = ++getStateCount;
        if (n <= 4) return aiState;
        return humanTurnState;
      }),
      getPlayerView: vi.fn().mockResolvedValue({ players: [] }),
      getSpectatorView: vi.fn().mockResolvedValue(null),
      applyAction: vi.fn().mockResolvedValue(humanTurnState),
      isAiSeat: vi
        .fn()
        .mockImplementation(async (_gId: string, pId: string) => pId === AI_ID),
      getAiSeatIds: vi.fn().mockResolvedValue(new Set([AI_ID])),
    } as unknown as GameService;

    const recorder = new RecordingDelayer();
    const { fireGameAction } = setupHandlersWithAction(
      gameService,
      connectionManager,
      turnTimerService,
      recorder,
    );

    await fireGameAction(
      makeSocket(HUMAN_ID),
      "game-1",
      { type: "pass", playerId: HUMAN_ID },
      () => {},
    );

    expect(recorder.recordedDelays).toHaveLength(1);
    expect(recorder.recordedDelays[0]).toBe(500);
  });

  it("aiMoveDelayMs=0 → delay called with 0 (opt-out)", async () => {
    const aiState = makeAiCurrentState(2);
    const humanTurnState = { ...aiState, currentPlayerIndex: 0, version: 3 };

    let getStateCount = 0;
    const gameService = {
      getGame: vi
        .fn()
        .mockResolvedValue(makeGame({ gameConfig: { aiMoveDelayMs: 0 } })),
      getJoinCode: vi.fn().mockResolvedValue(null),
      getGameState: vi.fn().mockImplementation(async () => {
        const n = ++getStateCount;
        if (n <= 4) return aiState;
        return humanTurnState;
      }),
      getPlayerView: vi.fn().mockResolvedValue({ players: [] }),
      getSpectatorView: vi.fn().mockResolvedValue(null),
      applyAction: vi.fn().mockResolvedValue(humanTurnState),
      isAiSeat: vi
        .fn()
        .mockImplementation(async (_gId: string, pId: string) => pId === AI_ID),
      getAiSeatIds: vi.fn().mockResolvedValue(new Set([AI_ID])),
    } as unknown as GameService;

    const recorder = new RecordingDelayer();
    const { fireGameAction } = setupHandlersWithAction(
      gameService,
      connectionManager,
      turnTimerService,
      recorder,
    );

    await fireGameAction(
      makeSocket(HUMAN_ID),
      "game-1",
      { type: "pass", playerId: HUMAN_ID },
      () => {},
    );

    expect(recorder.recordedDelays).toHaveLength(1);
    expect(recorder.recordedDelays[0]).toBe(0);
  });

  it("absurd aiMoveDelayMs (999999) → clamped to MAX_AI_MOVE_DELAY_MS", async () => {
    const aiState = makeAiCurrentState(2);
    const humanTurnState = { ...aiState, currentPlayerIndex: 0, version: 3 };

    let getStateCount = 0;
    const gameService = {
      getGame: vi
        .fn()
        .mockResolvedValue(makeGame({ gameConfig: { aiMoveDelayMs: 999999 } })),
      getJoinCode: vi.fn().mockResolvedValue(null),
      getGameState: vi.fn().mockImplementation(async () => {
        const n = ++getStateCount;
        if (n <= 4) return aiState;
        return humanTurnState;
      }),
      getPlayerView: vi.fn().mockResolvedValue({ players: [] }),
      getSpectatorView: vi.fn().mockResolvedValue(null),
      applyAction: vi.fn().mockResolvedValue(humanTurnState),
      isAiSeat: vi
        .fn()
        .mockImplementation(async (_gId: string, pId: string) => pId === AI_ID),
      getAiSeatIds: vi.fn().mockResolvedValue(new Set([AI_ID])),
    } as unknown as GameService;

    const recorder = new RecordingDelayer();
    const { fireGameAction } = setupHandlersWithAction(
      gameService,
      connectionManager,
      turnTimerService,
      recorder,
    );

    await fireGameAction(
      makeSocket(HUMAN_ID),
      "game-1",
      { type: "pass", playerId: HUMAN_ID },
      () => {},
    );

    expect(recorder.recordedDelays).toHaveLength(1);
    expect(recorder.recordedDelays[0]).toBe(MAX_AI_MOVE_DELAY_MS);
  });

  it("no delay on completion: AI move that yields COMPLETED → delay not called", async () => {
    const aiState = makeAiCurrentState(2);
    const completedState = {
      ...aiState,
      status: "COMPLETED" as const,
      version: 5,
      winner: HUMAN_ID,
      scores: { [HUMAN_ID]: 0, [AI_ID]: 13 },
    };

    const turnTimerServiceLocal = {
      ...makeTurnTimerService(),
      hasTimer: vi.fn().mockReturnValue(true),
      startTurn: vi.fn(),
      unregisterGame: vi.fn(),
      getDeadline: vi.fn().mockReturnValue(null),
    } as unknown as TurnTimerService;

    let getStateCount = 0;
    const gameService = {
      getGame: vi.fn().mockResolvedValue(makeGame({ gameConfig: {} })),
      getJoinCode: vi.fn().mockResolvedValue(null),
      getGameState: vi.fn().mockImplementation(async () => {
        const n = ++getStateCount;
        if (n <= 4) return aiState;
        return completedState;
      }),
      getPlayerView: vi.fn().mockResolvedValue({ players: [] }),
      getSpectatorView: vi.fn().mockResolvedValue(null),
      applyAction: vi.fn().mockResolvedValue(completedState),
      isAiSeat: vi
        .fn()
        .mockImplementation(async (_gId: string, pId: string) => pId === AI_ID),
      getAiSeatIds: vi.fn().mockResolvedValue(new Set([AI_ID])),
    } as unknown as GameService;

    const recorder = new RecordingDelayer();
    const { fireGameAction } = setupHandlersWithAction(
      gameService,
      makeConnectionManager(),
      turnTimerServiceLocal,
      recorder,
    );

    await fireGameAction(
      makeSocket(HUMAN_ID),
      "game-1",
      { type: "pass", playerId: HUMAN_ID },
      () => {},
    );

    // The completing move: broadcast happens, then return — delay must NOT be called
    expect(recorder.recordedDelays).toHaveLength(0);
    // unregisterGame called (game is COMPLETED)
    expect(turnTimerServiceLocal.unregisterGame).toHaveBeenCalledWith("game-1");
  });

  it("no delay on B1 exit (null auto-action): armFallbackTimer called, delay not called", async () => {
    const { engineFactory: engineFactoryMock } =
      await import("../../src/backend/engine/game-engine-factory.js");
    (
      engineFactoryMock.getEngine as ReturnType<typeof vi.fn>
    ).mockReturnValueOnce({
      gameType: "big2",
      getPlayerView: vi.fn().mockReturnValue({ players: [] }),
      getSpectatorView: vi.fn().mockReturnValue({ players: [] }),
      getAutoTimeoutAction: vi.fn().mockReturnValue(null),
      getAiMoveAction: vi.fn().mockReturnValue(null),
    });

    const aiState = makeAiCurrentState(3);
    const postActionState = { ...aiState, version: 4 };

    const turnTimerServiceLocal = {
      ...makeTurnTimerService(),
      hasTimer: vi.fn().mockReturnValue(true),
      startTurn: vi.fn(),
      unregisterGame: vi.fn(),
      getDeadline: vi.fn().mockReturnValue(null),
    } as unknown as TurnTimerService;

    const gameService = {
      getGame: vi.fn().mockResolvedValue(makeGame({ gameConfig: {} })),
      getJoinCode: vi.fn().mockResolvedValue(null),
      getGameState: vi
        .fn()
        .mockResolvedValueOnce(postActionState)
        .mockResolvedValue(aiState),
      getPlayerView: vi.fn().mockResolvedValue({ players: [] }),
      getSpectatorView: vi.fn().mockResolvedValue(null),
      applyAction: vi.fn().mockResolvedValue(postActionState),
      isAiSeat: vi
        .fn()
        .mockImplementation(async (_gId: string, pId: string) => pId === AI_ID),
      getAiSeatIds: vi.fn().mockResolvedValue(new Set([AI_ID])),
    } as unknown as GameService;

    const recorder = new RecordingDelayer();
    const { fireGameAction } = setupHandlersWithAction(
      gameService,
      makeConnectionManager(),
      turnTimerServiceLocal,
      recorder,
    );

    await fireGameAction(
      makeSocket(HUMAN_ID),
      "game-1",
      { type: "pass", playerId: HUMAN_ID },
      () => {},
    );

    // B1: armFallbackTimer called
    const startTurnCalls = (
      turnTimerServiceLocal.startTurn as ReturnType<typeof vi.fn>
    ).mock.calls;
    const fallbackCall = startTurnCalls.find(
      (c: unknown[]) => c[0] === "game-1" && c[1] === false,
    );
    expect(fallbackCall).toBeDefined();
    // delay must NOT have been called on B1 exit
    expect(recorder.recordedDelays).toHaveLength(0);
  });

  it("no delay on B2 exit (applyAction throws): armFallbackTimer called, delay not called", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const aiState = makeAiCurrentState(3);
    const postActionState = { ...aiState, version: 4 };

    let applyCount = 0;
    const turnTimerServiceLocal = {
      ...makeTurnTimerService(),
      hasTimer: vi.fn().mockReturnValue(true),
      startTurn: vi.fn(),
      unregisterGame: vi.fn(),
      getDeadline: vi.fn().mockReturnValue(null),
    } as unknown as TurnTimerService;

    const gameService = {
      getGame: vi.fn().mockResolvedValue(makeGame({ gameConfig: {} })),
      getJoinCode: vi.fn().mockResolvedValue(null),
      getGameState: vi
        .fn()
        .mockResolvedValueOnce(postActionState)
        .mockResolvedValue(aiState),
      getPlayerView: vi.fn().mockResolvedValue({ players: [] }),
      getSpectatorView: vi.fn().mockResolvedValue(null),
      applyAction: vi.fn().mockImplementation(async () => {
        const n = ++applyCount;
        if (n === 1) return postActionState; // human's action succeeds
        throw new Error("engine rejected action");
      }),
      isAiSeat: vi
        .fn()
        .mockImplementation(async (_gId: string, pId: string) => pId === AI_ID),
      getAiSeatIds: vi.fn().mockResolvedValue(new Set([AI_ID])),
    } as unknown as GameService;

    const recorder = new RecordingDelayer();
    const { fireGameAction } = setupHandlersWithAction(
      gameService,
      makeConnectionManager(),
      turnTimerServiceLocal,
      recorder,
    );

    await fireGameAction(
      makeSocket(HUMAN_ID),
      "game-1",
      { type: "pass", playerId: HUMAN_ID },
      () => {},
    );

    // B2: armFallbackTimer called
    const startTurnCalls = (
      turnTimerServiceLocal.startTurn as ReturnType<typeof vi.fn>
    ).mock.calls;
    const fallbackCall = startTurnCalls.find(
      (c: unknown[]) => c[0] === "game-1" && c[1] === false,
    );
    expect(fallbackCall).toBeDefined();
    // delay must NOT have been called on B2 exit
    expect(recorder.recordedDelays).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it("abandoned-human pacing: abandoned (non-AI) driven seat → delay is called", async () => {
    const abandonedHumanId = "player-b";
    const currentPlayerState = {
      gameId: "game-1",
      gameType: "big2",
      status: "IN_PROGRESS" as const,
      version: 2,
      players: [
        { playerId: HUMAN_ID, displayName: "Host" },
        { playerId: abandonedHumanId, displayName: "Bob" },
      ],
      currentPlayerIndex: 1, // abandoned human is current after host's action
      turnNumber: 2,
      gameSpecificState: null,
      winner: null,
      scores: null,
      randomSeed: "seed",
    };
    const hostTurnState = {
      ...currentPlayerState,
      currentPlayerIndex: 0,
      version: 3,
    };

    // abandonedHumanId is marked abandoned (not AI)
    const connectionManagerLocal = makeConnectionManager();
    (
      connectionManagerLocal.isAbandoned as ReturnType<typeof vi.fn>
    ).mockImplementation(
      (_gameId: string, playerId: string) => playerId === abandonedHumanId,
    );

    let getStateCount = 0;
    const gameService = {
      getGame: vi.fn().mockResolvedValue(makeGame({ gameConfig: {} })),
      getJoinCode: vi.fn().mockResolvedValue(null),
      getGameState: vi.fn().mockImplementation(async () => {
        const n = ++getStateCount;
        if (n <= 4) return currentPlayerState;
        return hostTurnState;
      }),
      getPlayerView: vi.fn().mockResolvedValue({ players: [] }),
      getSpectatorView: vi.fn().mockResolvedValue(null),
      applyAction: vi.fn().mockResolvedValue(hostTurnState),
      isAiSeat: vi.fn().mockResolvedValue(false), // not an AI seat
      getAiSeatIds: vi.fn().mockResolvedValue(new Set()),
    } as unknown as GameService;

    const recorder = new RecordingDelayer();
    const { fireGameAction } = setupHandlersWithAction(
      gameService,
      connectionManagerLocal,
      makeTurnTimerService(),
      recorder,
    );

    await fireGameAction(
      makeSocket(HUMAN_ID),
      "game-1",
      { type: "pass", playerId: HUMAN_ID },
      () => {},
    );

    // Abandoned human pacing: delay should have been called once
    expect(recorder.recordedDelays).toHaveLength(1);
    expect(recorder.recordedDelays[0]).toBe(DEFAULT_AI_MOVE_DELAY_MS);
  });
});
