import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // stdout JSON — no transport in prod (Railway captures stdout)
});

export interface LogContext {
  correlationId?: string;
  gameId?: string;
  requestId?: string;
}

/** Returns a child logger bound to the given identifiers. */
export function withContext(ctx: LogContext): pino.Logger {
  return logger.child(ctx);
}
