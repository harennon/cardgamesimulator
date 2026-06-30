import type { StatsWindow } from "@shared/model";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The inclusive lower bound (`played_at >= cutoff`) for a windowed stats query.
 * Pure, UTC, unit-testable; `now` is injected for deterministic tests.
 *
 * - "lifetime" -> null  (no date filter; reads the aggregate fast path instead)
 * - "30d"      -> now - 30*24h
 * - "ytd"      -> Jan 1 00:00:00.000Z of now's UTC year
 *
 * UTC, never local server time (LLD 101 E6).
 */
export function windowCutoff(window: StatsWindow, now: Date): Date | null {
  switch (window) {
    case "lifetime":
      return null;
    case "30d":
      return new Date(now.getTime() - THIRTY_DAYS_MS);
    case "ytd":
      return new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
  }
}
