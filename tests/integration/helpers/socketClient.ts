import { io, type Socket } from "socket.io-client";
import type {
  ServerToClientEvents,
  ClientToServerEvents,
} from "../../../src/shared/socket-events.js";

export type TypedClientSocket = Socket<
  ServerToClientEvents,
  ClientToServerEvents
>;

/**
 * Creates an authenticated Socket.IO client connected to the test server.
 * Waits for the connection to be established before returning.
 */
export async function createAuthenticatedSocket(
  baseUrl: string,
  token: string,
): Promise<TypedClientSocket> {
  const socket: TypedClientSocket = io(baseUrl, {
    auth: { token },
    transports: ["websocket"],
    reconnection: false,
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", (err) => {
      reject(new Error(`Socket connection failed: ${err.message}`));
    });
  });

  return socket;
}

/**
 * Disconnects and cleans up a socket client.
 */
export function disconnectSocket(socket: TypedClientSocket): void {
  if (socket.connected) {
    socket.disconnect();
  }
}
