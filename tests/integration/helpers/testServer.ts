import * as http from "http";
import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import { Handler } from "../../../src/backend/api/handler.js";
import { EchoHandler } from "../../../src/backend/api/echo.js";
import { ServeAppHandler } from "../../../src/backend/api/serveApp.js";
import { SupabaseDB } from "../../../src/backend/database/supabaseDb.js";
import { errorHandler } from "../../../src/backend/middleware/errorHandler.js";
import {
  createAuthMiddleware,
  registeredOnlyMiddleware,
} from "../../../src/backend/middleware/authMiddleware.js";
import { CreateGameHandler } from "../../../src/backend/api/game/createGame.js";
import { JoinGameHandler } from "../../../src/backend/api/game/joinGame.js";
import { GetGameStateHandler } from "../../../src/backend/api/game/getGameState.js";
import {
  createSocketServer,
  type TypedServer,
} from "../../../src/backend/websocket/socketServer.js";
import { createSocketAuthMiddleware } from "../../../src/backend/websocket/socketAuth.js";
import {
  registerSocketHandlers,
  handleTimerExpired,
} from "../../../src/backend/websocket/socketHandler.js";
import { ConnectionManager } from "../../../src/backend/websocket/connectionManager.js";
import { GameService } from "../../../src/backend/service/gameService.js";
import { StatsService } from "../../../src/backend/service/statsService.js";
import { GameCache } from "../../../src/backend/engine/game-cache.js";
import { engineFactory } from "../../../src/backend/engine/game-engine-factory.js";
import { GuestSessionStore } from "../../../src/backend/guest/guestSessionStore.js";
import { createSessionRouter } from "../../../src/backend/api/guest/createSession.js";
import { createClaimRouter } from "../../../src/backend/api/guest/claimSession.js";
import { getCachedJwksKey } from "../../../src/backend/middleware/authMiddleware.js";
import { GetStatsHandler } from "../../../src/backend/api/stats/getStats.js";
import { FeedbackHandler } from "../../../src/backend/api/feedback/submitFeedback.js";
import { FakeTimerProvider } from "../../../src/backend/timer/fakeTimerProvider.js";
import { TurnTimerService } from "../../../src/backend/timer/turnTimerService.js";
import { createSeedStateRouter } from "../../../src/backend/api/test/seedState.js";
import { JoinCodeService } from "../../../src/backend/service/joinCodeService.js";

export interface TestServerContext {
  app: Express;
  httpServer: http.Server;
  io: TypedServer;
  baseUrl: string;
  timerProvider: FakeTimerProvider;
  turnTimerService: TurnTimerService;
  connectionManager: ConnectionManager;
  gameCache: GameCache;
  gameService: GameService;
  close: () => Promise<void>;
}

// Shared DB instance across test files — initialized only once per process.
let dbInitialized = false;

function ensureDbInitialized(): void {
  if (dbInitialized) return;
  SupabaseDB.INSTANCE.initialize();
  dbInitialized = true;
}

/**
 * Boots a fully-wired server (Express + Socket.IO + DB) on an ephemeral port.
 * Uses the same wiring as the production Server class but exposes internals for testing.
 * Each call returns a new server instance; the DB connection is shared across instances.
 * Optionally accepts a TimerProvider override (defaults to FakeTimerProvider for test control).
 */
export async function createTestServer(
  timerProviderOverride?: FakeTimerProvider,
): Promise<TestServerContext> {
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!jwtSecret) {
    throw new Error(
      "SUPABASE_JWT_SECRET is not set. Export it from `supabase status`.",
    );
  }

  const app = express();
  app.use(express.json());
  app.use(helmet());
  app.use(cors({ origin: "*" }));

  const guestSessionStore = new GuestSessionStore();
  const authMiddleware = createAuthMiddleware(guestSessionStore);

  new Map<string, Handler>([
    ["/", ServeAppHandler.INSTANCE],
    ["/echo", EchoHandler.INSTANCE],
  ]).forEach((handler: Handler, path: string) => {
    app.use(path, handler.router);
  });

  // Guest session creation (no auth required)
  app.use(
    "/guest/session",
    createSessionRouter(guestSessionStore, SupabaseDB.INSTANCE),
  );

  // Guest claim (registered users only)
  app.use(
    "/guest/claim",
    authMiddleware,
    registeredOnlyMiddleware,
    createClaimRouter(SupabaseDB.INSTANCE),
  );

  new Map<string, Handler>([
    ["/joinGame", JoinGameHandler.INSTANCE],
    ["/getGameState", GetGameStateHandler.INSTANCE],
  ]).forEach((handler: Handler, path: string) => {
    app.use(path, authMiddleware, handler.router);
  });

  app.use(
    "/createGame",
    authMiddleware,
    registeredOnlyMiddleware,
    CreateGameHandler.INSTANCE.router,
  );

  // Stats route (auth required, guests allowed)
  app.use("/stats", authMiddleware, GetStatsHandler.INSTANCE.router);

  // Feedback route (auth required, guests allowed)
  app.use("/feedback", authMiddleware, FeedbackHandler.INSTANCE.router);

  const httpServer = http.createServer(app);
  const io = createSocketServer(httpServer);
  io.use(createSocketAuthMiddleware(guestSessionStore));

  const gameCache = new GameCache();
  const statsService = new StatsService(SupabaseDB.INSTANCE, guestSessionStore);
  const gameService = new GameService(
    gameCache,
    engineFactory,
    SupabaseDB.INSTANCE,
    statsService,
  );

  // Seed endpoint (test-only) — registered after gameCache/gameService are created
  app.use(
    "/test/seed-state",
    createSeedStateRouter(gameCache, SupabaseDB.INSTANCE),
  );

  app.use(errorHandler);
  const connectionManager = new ConnectionManager();
  const timerProvider = timerProviderOverride ?? new FakeTimerProvider();
  const turnTimerService = new TurnTimerService(timerProvider, (gameId) => {
    handleTimerExpired(
      io,
      gameId,
      gameService,
      connectionManager,
      turnTimerService,
    ).catch((err: unknown) => console.error("Timer expired error:", err));
  });
  const joinCodeService = new JoinCodeService(SupabaseDB.INSTANCE);
  registerSocketHandlers(
    io,
    gameService,
    connectionManager,
    turnTimerService,
    joinCodeService,
  );

  // Initialize DB (idempotent across test files in the same process)
  ensureDbInitialized();

  // Start on ephemeral port
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));

  // Wait for the JWKS key to be fetched (kicked off at module load in authMiddleware).
  // Without this, WebSocket auth falls back to HS256 and rejects real ES256 tokens.
  if (process.env.SUPABASE_URL) {
    const deadline = Date.now() + 5000;
    while (getCachedJwksKey() === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to get server address after listen");
  }
  const baseUrl = `http://localhost:${address.port}`;

  const close = (): Promise<void> => {
    timerProvider.cancelAll();
    io.disconnectSockets(true);
    return new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  return {
    app,
    httpServer,
    io,
    baseUrl,
    timerProvider,
    turnTimerService,
    connectionManager,
    gameCache,
    gameService,
    close,
  };
}
