import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";

import { Handler } from "@/api/handler";
import { EchoHandler } from "@/api/echo";
import { ServeAppHandler } from "@/api/serveApp";
import { PostgresDB } from "@/database/postgres";
import { errorHandler } from "@/middleware/errorHandler";
import {
  createAuthMiddleware,
  registeredOnlyMiddleware,
} from "@/middleware/authMiddleware";
import { CreateGameHandler } from "@/api/game/createGame";
import { JoinGameHandler } from "@/api/game/joinGame";
import { GetGameStateHandler } from "@/api/game/getGameState";
import { createSocketServer, type TypedServer } from "@/websocket/socketServer";
import { createSocketAuthMiddleware } from "@/websocket/socketAuth";
import {
  registerSocketHandlers,
  handleTimerExpired,
} from "@/websocket/socketHandler";
import { ConnectionManager } from "@/websocket/connectionManager";
import { GameService } from "@/service/gameService";
import { StatsService } from "@/service/statsService";
import { GameCache } from "@/engine/game-cache";
import { engineFactory } from "@/engine/game-engine-factory";
import { gameRepo, statsRepo } from "@/database";
import { GuestSessionStore } from "@/guest/guestSessionStore";
import { createSessionRouter } from "@/api/guest/createSession";
import { createClaimRouter } from "@/api/guest/claimSession";
import { GetStatsHandler } from "@/api/stats/getStats";
import { FeedbackHandler } from "@/api/feedback/submitFeedback";
import { RealTimerProvider } from "@/timer/realTimerProvider";
import { TurnTimerService } from "@/timer/turnTimerService";

export class Server {
  private readonly app: Express;
  private readonly server: https.Server | http.Server;
  private readonly io: TypedServer;
  private readonly guestSessionStore: GuestSessionStore;
  private readonly timerProvider: RealTimerProvider;

  constructor() {
    this.app = express();
    // add middleware
    this.app.use(express.json());
    this.app.use(helmet());
    this.app.use(cors({ origin: "http://frontend:80" }));
    this.app.use(morgan(":method :url", { immediate: true }));
    this.app.use(
      morgan(":method :url :status :res[content-length] - :response-time ms"),
    );

    // Set up guest session store and auth middleware (dependency injection)
    this.guestSessionStore = new GuestSessionStore();
    this.guestSessionStore.startCleanupLoop();
    const authMiddleware = createAuthMiddleware(this.guestSessionStore);

    // register api handlers
    new Map<string, Handler>([
      ["/", ServeAppHandler.INSTANCE],
      ["/echo", EchoHandler.INSTANCE],
    ]).forEach((handler: Handler, path: string) => {
      this.app.use(path, handler.router);
    });

    // Guest routes (no auth — createSession creates the auth)
    this.app.use(
      "/guest/session",
      createSessionRouter(this.guestSessionStore, gameRepo),
    );

    // Guest claim route (requires Supabase JWT — registered users only)
    this.app.use(
      "/guest/claim",
      authMiddleware,
      registeredOnlyMiddleware,
      createClaimRouter(gameRepo),
    );

    new Map<string, Handler>([
      ["/joinGame", JoinGameHandler.INSTANCE],
      ["/getGameState", GetGameStateHandler.INSTANCE],
    ]).forEach((handler: Handler, path: string) => {
      this.app.use(path, authMiddleware, handler.router);
    });

    // createGame requires a registered (non-guest) user
    this.app.use(
      "/createGame",
      authMiddleware,
      registeredOnlyMiddleware,
      CreateGameHandler.INSTANCE.router,
    );

    // Stats route (auth required, guests allowed — returns zeroed stats)
    this.app.use("/stats", authMiddleware, GetStatsHandler.INSTANCE.router);

    // Feedback route (auth required, guests allowed for POST; admin-only for GET)
    this.app.use("/feedback", authMiddleware, FeedbackHandler.INSTANCE.router);

    // register error middleware
    this.app.use(errorHandler);

    // initialize server
    this.server = this.createServer(this.app);

    // Socket.IO setup
    this.io = createSocketServer(this.server);
    this.io.use(createSocketAuthMiddleware(this.guestSessionStore));

    const gameCache = new GameCache();
    gameCache.startEvictionLoop();
    const statsService = new StatsService(statsRepo, this.guestSessionStore);
    const gameService = new GameService(
      gameCache,
      engineFactory,
      gameRepo,
      statsService,
    );
    const connectionManager = new ConnectionManager();
    this.timerProvider = new RealTimerProvider();
    const turnTimerService = new TurnTimerService(
      this.timerProvider,
      (gameId) => {
        handleTimerExpired(
          this.io,
          gameId,
          gameService,
          connectionManager,
          turnTimerService,
        ).catch((err: unknown) => console.error("Timer expired error", err));
      },
    );
    registerSocketHandlers(
      this.io,
      gameService,
      connectionManager,
      turnTimerService,
    );

    // Seed endpoint — only loaded in test environments
    if (process.env.NODE_ENV === "test") {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createSeedStateRouter } = require("./api/test/seedState.js");
      this.app.use(
        "/test/seed-state",
        createSeedStateRouter(gameCache, gameRepo),
      );
    }
  }

  public async start() {
    // initialize database
    await PostgresDB.INSTANCE.initialize();

    // start server
    const port = process.env.BACKEND_PORT || 3000;
    console.log(`Listening on port ${port}`);
    this.server.listen(port);
  }

  public close(force: boolean, callback: (force: boolean) => void) {
    // callback function to close dependencies
    callback(force);
    this.guestSessionStore.stopCleanupLoop();
    this.timerProvider.cancelAll();
    this.server.close();
  }

  private createServer(app: Express): https.Server | http.Server {
    if (process.env.KEY_PATH && process.env.CERT_PATH) {
      const options = {
        key: fs.readFileSync(process.env.KEY_PATH),
        cert: fs.readFileSync(process.env.CERT_PATH),
      };
      return https.createServer(options, app);
    } else {
      console.log(
        "Please set up valid certificates to create an HTTPS server.",
      );
      return http.createServer(app);
    }
  }
}
