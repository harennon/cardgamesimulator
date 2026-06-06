import jwt from "jsonwebtoken";
import { Request, Response, Next } from "@/util/types";
import { UnauthorizedError } from "@/util/errors";

// Fail fast at module load (server startup) — not on first request.
const jwtSecret = process.env.SUPABASE_JWT_SECRET;
if (!jwtSecret) {
  throw new Error("SUPABASE_JWT_SECRET is required");
}

export interface SupabaseJWTPayload {
  sub: string; // user UUID (from auth.users)
  email: string;
  role: string; // 'authenticated' or 'anon'
  aud: string; // 'authenticated'
  iat: number;
  exp: number;
  user_metadata: {
    display_name?: string;
  };
}

export function authMiddleware(req: Request, _res: Response, next: Next): void {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : undefined;

  if (!token) {
    throw new UnauthorizedError();
  }

  let decoded: SupabaseJWTPayload;
  try {
    decoded = jwt.verify(token, jwtSecret as string, {
      algorithms: ["HS256"],
    }) as unknown as SupabaseJWTPayload;
  } catch {
    throw new UnauthorizedError();
  }

  if (decoded.role !== "authenticated") {
    throw new UnauthorizedError();
  }

  req.userId = decoded.sub;
  req.displayName = decoded.user_metadata?.display_name ?? decoded.email;
  next();
}
