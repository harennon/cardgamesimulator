import { describe, it, expect } from "vitest";
import { windowCutoff } from "../../src/backend/api/stats/windowCutoff.js";

// ---------------------------------------------------------------------------
// LLD 101: windowCutoff is a pure, UTC, deterministic helper. `now` is injected
// so there is no clock dependency. UTC, never local server time (E6).
// ---------------------------------------------------------------------------

describe("windowCutoff", () => {
  it("returns null for 'lifetime' (no date filter)", () => {
    expect(windowCutoff("lifetime", new Date("2026-06-30T12:00:00.000Z"))).toBe(
      null,
    );
  });

  it("returns exactly now - 30 days for '30d'", () => {
    const now = new Date("2026-06-30T12:34:56.789Z");
    const cutoff = windowCutoff("30d", now);
    expect(cutoff).not.toBeNull();
    // 30 * 24 * 60 * 60 * 1000 ms before `now`.
    expect(cutoff!.getTime()).toBe(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    // Spot-check the resolved instant: 30 days before Jun 30 12:34:56.789Z.
    expect(cutoff!.toISOString()).toBe("2026-05-31T12:34:56.789Z");
  });

  it("returns Jan 1 00:00:00.000Z of now's UTC year for 'ytd' (mid-year)", () => {
    const cutoff = windowCutoff("ytd", new Date("2026-06-30T12:00:00.000Z"));
    expect(cutoff!.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("handles the Jan boundary: 'ytd' on Jan 2 still cuts at Jan 1 00:00:00Z (E6)", () => {
    const cutoff = windowCutoff("ytd", new Date("2026-01-02T03:04:05.006Z"));
    expect(cutoff!.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("uses UTC, not local time, for the 'ytd' year boundary (E6)", () => {
    // An instant just before midnight UTC on Dec 31 belongs to that UTC year;
    // a moment just after midnight UTC on Jan 1 belongs to the next year.
    const lastSecondOf2025 = new Date("2025-12-31T23:59:59.999Z");
    expect(windowCutoff("ytd", lastSecondOf2025)!.toISOString()).toBe(
      "2025-01-01T00:00:00.000Z",
    );

    const firstInstantOf2026 = new Date("2026-01-01T00:00:00.000Z");
    expect(windowCutoff("ytd", firstInstantOf2026)!.toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });
});
