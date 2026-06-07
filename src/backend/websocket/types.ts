import type { PlayerId } from "@shared/engine-types";

/** Attached to socket.data after successful auth middleware */
export interface SocketData {
  userId: PlayerId;
  displayName: string;
  isGuest: boolean; // true for guest sessions, false for Supabase-authenticated users
}

/** Shape of the auth payload sent in the Socket.IO handshake */
export interface SocketAuthPayload {
  token: string; // Supabase access_token (JWT) OR guest token (prefixed "guest:")
}
