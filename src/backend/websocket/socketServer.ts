import type { Server as HttpServer } from "http";
import type * as https from "https";
import { Server, Socket } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@shared/socket-events";
import type { SocketData } from "./types.js";

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

let connectionCapRejections = 0;

export function getConnectionMetrics(io: TypedServer) {
  return {
    current: io.engine.clientsCount,
    max: MAX_CONNECTIONS,
    rejections: connectionCapRejections,
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
      connectionCapRejections++;
      console.warn(
        `Connection rejected: cap reached (${io.engine.clientsCount}/${MAX_CONNECTIONS})`,
      );
      return next(new Error("SERVER_FULL"));
    }
    next();
  });

  return io;
}
