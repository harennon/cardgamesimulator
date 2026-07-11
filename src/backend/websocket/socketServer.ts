import type { Server as HttpServer } from "http";
import type * as https from "https";
import { Server, Socket } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@shared/socket-events";
import type { SocketData } from "./types.js";
import { logger } from "@/util/logger";

export type TypedServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
export type TypedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

const MAX_CONNECTIONS = 1000;
const REJECTION_WINDOW_MS = 60_000;

const rejectionTimestamps: number[] = [];

export function getConnectionMetrics(io: TypedServer) {
  const now = Date.now();
  while (
    rejectionTimestamps.length > 0 &&
    rejectionTimestamps[0]! < now - REJECTION_WINDOW_MS
  ) {
    rejectionTimestamps.shift();
  }
  return {
    current: io.engine.clientsCount,
    max: MAX_CONNECTIONS,
    rejectionsLastMinute: rejectionTimestamps.length,
  };
}

export function createSocketServer(
  httpServer: HttpServer | https.Server,
): TypedServer {
  const io: TypedServer = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN || "http://localhost:5173",
      credentials: true,
    },
    // Transparently restore room membership and replay missed events
    // for short disconnects (< 30s). Falls back to manual game:join if recovery fails.
    connectionStateRecovery: {
      maxDisconnectionDuration: 30_000,
    },
  });

  io.use((socket, next) => {
    if (io.engine.clientsCount >= MAX_CONNECTIONS) {
      rejectionTimestamps.push(Date.now());
      logger.warn(
        { current: io.engine.clientsCount, max: MAX_CONNECTIONS },
        "Connection rejected: cap reached",
      );
      return next(new Error("SERVER_FULL"));
    }
    next();
  });

  return io;
}
