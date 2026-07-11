import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { nanoid } from "nanoid";
import { logger, withContext } from "@/util/logger";

import { Handler } from "@/api/handler";
import { ServeAppHandler } from "@/api/serveApp";
import { SupabaseDB } from "@/database/supabaseDb";
import { errorHandler } from "@/middleware/errorHandler";
import {
  createAuthMiddleware,
  registeredOnlyMiddleware,
} from "@/middleware/authMiddleware";
import { CreateGameHandler } from "@/api/game/createGame";
import { JoinGameHandler } from "@/api/game/joinGame";
import { GetGameStateHandler } from "@/api/game/getGameState";
import {
  createSocketServer,
  getConnectionMetrics,
  type TypedServer,
} from "@/websocket/socketServer";
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
import { createResolveJoinCodeRouter } from "@/api/game/resolveJoinCode";
import { RealDelayer } from "@/websocket/delayer";

export class Server {
  private readonly app: Express;
  private readonly server: https.Server | http.Server;
  private readonly io: TypedServer;
  private readonly guestSessionStore: GuestSessionStore;
  private readonly timerProvider: RealTimerProvider;

  constructor() {
    this.app = express();
    // add middleware
    // Skip the global 100 kB JSON parser for the feedback attachment route so
    // the route-level 7 MB parser can handle large base64 image bodies (LLD 153
    // key decision 3). All other routes still get the default 100 kB limit.
    this.app.use((req, res, next) => {
      if (/^\/feedback\/[^/]+\/attachments(\/|$)/i.test(req.path)) {
        return next();
      }
      express.json()(req, res, next);
    });
    this.app.use(helmet());
    this.app.use(
      cors({
        origin: process.env.CORS_ORIGIN || "http://frontend:80",
        credentials: true,
      }),
    );
    this.app.use(morgan(":method :url", { immediate: true }));
    this.app.use(
      morgan(":method :url :status :res[content-length] - :response-time ms"),
    );

    // Per-request correlation middleware: mints requestId, reads x-correlation-id header.
    // Attaches a child logger to req so downstream handlers can use req.log.
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      const requestId = nanoid();
      const correlationId =
        typeof req.headers["x-correlation-id"] === "string"
          ? req.headers["x-correlation-id"]
          : undefined;
      (req as Request & { log: ReturnType<typeof withContext> }).log =
        withContext({ requestId, correlationId });
      next();
    });

    // Set up guest session store and auth middleware (dependency injection)
    this.guestSessionStore = new GuestSessionStore();
    const authMiddleware = createAuthMiddleware(this.guestSessionStore);

    // Build GameService early so it can be injected into the createGame route.
    const gameCache = new GameCache();
    const statsService = new StatsService(statsRepo, this.guestSessionStore);
    const gameService = new GameService(
      gameCache,
      engineFactory,
      gameRepo,
      statsService,
    );

    // Health endpoint — no auth, used by Railway + monitoring
    this.app.get("/health", (_req, res) => {
      const connections = getConnectionMetrics(this.io);
      res.status(200).json({
        status: "ok",
        uptime: process.uptime(),
        connections,
      });
    });

    // register api handlers
    const handlers = new Map<string, Handler>([]);
    if (process.env.NODE_ENV !== "production") {
      handlers.set("/", ServeAppHandler.INSTANCE);
    }
    handlers.forEach((handler: Handler, path: string) => {
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

    // createGame requires a registered (non-guest) user; wired with GameService
    // so the handler can call addAiSeats after creation when numAiSeats >= 1.
    this.app.use(
      "/createGame",
      authMiddleware,
      registeredOnlyMiddleware,
      CreateGameHandler.create(gameService).router,
    );

    // Stats route (auth required, guests allowed — returns zeroed stats)
    this.app.use("/stats", authMiddleware, GetStatsHandler.INSTANCE.router);

    // Feedback route (auth required, guests allowed for POST; admin-only for GET)
    this.app.use("/feedback", authMiddleware, FeedbackHandler.INSTANCE.router);

    // Join code resolution — no auth required (guests need to resolve before session)
    this.app.use("/games/join", createResolveJoinCodeRouter(gameRepo));

    // register error middleware
    this.app.use(errorHandler);

    // initialize server
    this.server = this.createServer(this.app);

    // Socket.IO setup
    this.io = createSocketServer(this.server);
    this.io.use(createSocketAuthMiddleware(this.guestSessionStore));

    const connectionManager = new ConnectionManager();
    this.timerProvider = new RealTimerProvider();
    const delayer = new RealDelayer();
    const turnTimerService = new TurnTimerService(
      this.timerProvider,
      (gameId) => {
        handleTimerExpired(
          this.io,
          gameId,
          gameService,
          connectionManager,
          turnTimerService,
          delayer,
        ).catch((err: unknown) => logger.error({ err }, "Timer expired error"));
      },
    );
    registerSocketHandlers(
      this.io,
      gameService,
      connectionManager,
      turnTimerService,
      delayer,
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
    SupabaseDB.INSTANCE.initialize();

    // start server
    const port = process.env.BACKEND_PORT || 3000;
    logger.info({ port }, "Listening on port");
    this.server.listen(port);
  }

  public close(force: boolean, callback: (force: boolean) => void) {
    // callback function to close dependencies
    callback(force);
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
      if (process.env.NODE_ENV !== "production") {
        logger.info(
          "Please set up valid certificates to create an HTTPS server.",
        );
      }
      return http.createServer(app);
    }
  }
}
