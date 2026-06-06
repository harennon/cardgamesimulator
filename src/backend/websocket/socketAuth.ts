import jwt from "jsonwebtoken";
import type { TypedSocket } from "./socketServer.js";
import type { SupabaseJWTPayload } from "@/middleware/authMiddleware";

// Fail fast at module load — not on first connection.
const jwtSecret = process.env.SUPABASE_JWT_SECRET;
if (!jwtSecret) {
  throw new Error("SUPABASE_JWT_SECRET is required");
}

/**
 * Socket.IO middleware that verifies the JWT from the handshake auth payload.
 * Reuses the same verification logic as the REST authMiddleware.
 */
export function socketAuthMiddleware(
  socket: TypedSocket,
  next: (err?: Error) => void,
): void {
  const token = socket.handshake.auth?.token;

  if (!token || typeof token !== "string") {
    next(new Error("UNAUTHORIZED: No token provided"));
    return;
  }

  try {
    const decoded = jwt.verify(token, jwtSecret as string, {
      algorithms: ["HS256"],
    }) as unknown as SupabaseJWTPayload;

    if (decoded.role !== "authenticated") {
      next(new Error("UNAUTHORIZED: Invalid role"));
      return;
    }

    socket.data.userId = decoded.sub;
    socket.data.displayName =
      decoded.user_metadata?.display_name ?? decoded.email;
    next();
  } catch {
    next(new Error("UNAUTHORIZED: Invalid token"));
  }
}
