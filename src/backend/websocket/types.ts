import type { PlayerId } from "@shared/engine-types";

/** Attached to socket.data after successful auth middleware */
export interface SocketData {
  userId: PlayerId;
  displayName: string;
  isGuest: boolean; // true for guest sessions, false for Supabase-authenticated users
}
