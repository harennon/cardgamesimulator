import type { PlayerId } from "@shared/engine-types";

/** Attached to socket.data after successful auth middleware */
export interface SocketData {
  userId: PlayerId;
  displayName: string;
  isGuest: boolean; // true for guest sessions, false for Supabase-authenticated users
  correlationId?: string; // client-supplied session correlation id (cx_<8-char>)
  requestId?: string; // per-connection nanoid, minted in auth middleware
}
