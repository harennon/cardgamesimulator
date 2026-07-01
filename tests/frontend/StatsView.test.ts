import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  GameStatsEntry,
  GetStatsResponse,
  StatsWindow,
} from "@shared/model";
import type { Session } from "@supabase/supabase-js";
import {
  isNeverPlayed,
  isEmptyWindow,
  showTrackingSince,
} from "@/component/statsView";

// Project pattern (node env, no component mounting): transcribe StatsView.vue's
// load()/init() state machine and assert one PageState per branch. Keep this in
// lockstep with the component's <script setup>.

type PageState =
  | { status: "loading" }
  | { status: "guest" }
  | { status: "error" }
  | { status: "ready"; games: GameStatsEntry[]; trackingSince: string | null };

interface Deps {
  getSession: () => Promise<Session | null>;
  fetchStats: (window: StatsWindow) => Promise<GetStatsResponse>;
}

// Mirrors StatsView.vue: selectedWindow is separate reactive state; load() uses a
// monotonic request token so a stale response can't overwrite a newer selection.
function makeHarness(setState: (s: PageState) => void, deps: Deps) {
  let selectedWindow: StatsWindow = "lifetime";
  let requestToken = 0;

  async function load(window: StatsWindow): Promise<void> {
    const token = ++requestToken;
    setState({ status: "loading" });
    try {
      const response = await deps.fetchStats(window);
      if (token !== requestToken) return;
      setState({
        status: "ready",
        games: response.games,
        trackingSince: response.trackingSince,
      });
    } catch {
      if (token !== requestToken) return;
      setState({ status: "error" });
    }
  }

  async function init(): Promise<void> {
    const session = await deps.getSession();
    if (!session) {
      setState({ status: "guest" });
      return;
    }
    await load(selectedWindow);
  }

  function selectWindow(window: StatsWindow): Promise<void> {
    selectedWindow = window;
    return load(window);
  }

  function retry(): Promise<void> {
    return load(selectedWindow);
  }

  return { init, selectWindow, retry, getSelectedWindow: () => selectedWindow };
}

const fakeSession = {} as Session;

function makeEntry(gameType: GameStatsEntry["gameType"]): GameStatsEntry {
  return {
    gameType,
    gamesPlayed: 5,
    gamesWon: 3,
    gamesLost: 2,
    totalScore: 20,
    winRate: 0.6,
    lastPlayedAt: "2026-06-01T00:00:00.000Z",
  };
}

function response(
  window: StatsWindow,
  games: GameStatsEntry[],
  trackingSince: string | null = null,
): GetStatsResponse {
  return { userId: "u", window, trackingSince, games };
}

describe("StatsView state machine", () => {
  let getSession: ReturnType<typeof vi.fn>;
  let fetchStats: ReturnType<typeof vi.fn>;
  let state: PageState;
  const setState = (s: PageState) => {
    state = s;
  };

  beforeEach(() => {
    getSession = vi.fn();
    fetchStats = vi.fn();
    state = { status: "loading" };
  });

  it("guest (no session): sets guest state and does NOT call fetchStats", async () => {
    getSession.mockResolvedValue(null);
    const h = makeHarness(setState, { getSession, fetchStats });

    await h.init();

    expect(state.status).toBe("guest");
    expect(fetchStats).not.toHaveBeenCalled();
  });

  it("default window is lifetime; initial load calls fetchStats('lifetime')", async () => {
    getSession.mockResolvedValue(fakeSession);
    fetchStats.mockResolvedValue(response("lifetime", [makeEntry("big2")]));
    const h = makeHarness(setState, { getSession, fetchStats });

    await h.init();

    expect(h.getSelectedWindow()).toBe("lifetime");
    expect(fetchStats).toHaveBeenCalledWith("lifetime");
    expect(state.status).toBe("ready");
  });

  it("registered + populated: ready state carries games + trackingSince", async () => {
    getSession.mockResolvedValue(fakeSession);
    const games = [makeEntry("big2"), makeEntry("tonk")];
    fetchStats.mockResolvedValue(response("lifetime", games, null));
    const h = makeHarness(setState, { getSession, fetchStats });

    await h.init();

    expect(state).toEqual({ status: "ready", games, trackingSince: null });
  });

  it("selecting 30d fetches that window and carries its games + trackingSince", async () => {
    getSession.mockResolvedValue(fakeSession);
    fetchStats.mockResolvedValueOnce(response("lifetime", [makeEntry("big2")]));
    const h = makeHarness(setState, { getSession, fetchStats });
    await h.init();

    const games = [makeEntry("tonk")];
    fetchStats.mockResolvedValueOnce(
      response("30d", games, "2026-01-01T00:00:00.000Z"),
    );
    await h.selectWindow("30d");

    expect(fetchStats).toHaveBeenLastCalledWith("30d");
    expect(h.getSelectedWindow()).toBe("30d");
    expect(state).toEqual({
      status: "ready",
      games,
      trackingSince: "2026-01-01T00:00:00.000Z",
    });
  });

  it("selecting ytd fetches with 'ytd'", async () => {
    getSession.mockResolvedValue(fakeSession);
    fetchStats.mockResolvedValue(response("lifetime", []));
    const h = makeHarness(setState, { getSession, fetchStats });
    await h.init();

    fetchStats.mockResolvedValueOnce(response("ytd", [], null));
    await h.selectWindow("ytd");

    expect(fetchStats).toHaveBeenLastCalledWith("ytd");
    expect(h.getSelectedWindow()).toBe("ytd");
  });

  it("latest-wins race guard (E8): a stale earlier-window response does not overwrite the newer window", async () => {
    getSession.mockResolvedValue(fakeSession);

    // Manually control the two in-flight promises so the stale one resolves last.
    let resolve30d!: (v: GetStatsResponse) => void;
    let resolveYtd!: (v: GetStatsResponse) => void;
    fetchStats
      .mockReturnValueOnce(
        new Promise<GetStatsResponse>((r) => {
          resolve30d = r;
        }),
      )
      .mockReturnValueOnce(
        new Promise<GetStatsResponse>((r) => {
          resolveYtd = r;
        }),
      );

    const h = makeHarness(setState, { getSession, fetchStats });

    const p30 = h.selectWindow("30d"); // token 1
    const pYtd = h.selectWindow("ytd"); // token 2 (newest)

    // Newer (ytd) resolves first, then the stale (30d) resolves.
    resolveYtd(
      response("ytd", [makeEntry("tonk")], "2026-01-01T00:00:00.000Z"),
    );
    await pYtd;
    resolve30d(response("30d", [makeEntry("big2")], null));
    await p30;

    // The stale 30d response must NOT clobber the ytd view.
    expect(state).toEqual({
      status: "ready",
      games: [makeEntry("tonk")],
      trackingSince: "2026-01-01T00:00:00.000Z",
    });
  });

  it("error: fetchStats rejects -> error state; retry re-fetches the SELECTED window (not lifetime)", async () => {
    getSession.mockResolvedValue(fakeSession);
    fetchStats.mockResolvedValueOnce(response("lifetime", [makeEntry("big2")]));
    const h = makeHarness(setState, { getSession, fetchStats });
    await h.init();

    // Move to ytd, which fails.
    fetchStats.mockRejectedValueOnce({ response: { status: 500 } });
    await h.selectWindow("ytd");
    expect(state.status).toBe("error");
    expect(h.getSelectedWindow()).toBe("ytd");

    // Retry must re-fetch ytd, not lifetime.
    fetchStats.mockResolvedValueOnce(response("ytd", [makeEntry("tonk")]));
    await h.retry();

    expect(fetchStats).toHaveBeenLastCalledWith("ytd");
    expect(state.status).toBe("ready");
  });

  it("401 mid-session on a windowed fetch is treated as error (E13)", async () => {
    getSession.mockResolvedValue(fakeSession);
    fetchStats.mockResolvedValueOnce(response("lifetime", []));
    const h = makeHarness(setState, { getSession, fetchStats });
    await h.init();

    fetchStats.mockRejectedValueOnce({ response: { status: 401 } });
    await h.selectWindow("30d");

    expect(state.status).toBe("error");
  });

  it("loading: state is loading while the initial request is in flight", async () => {
    getSession.mockResolvedValue(fakeSession);
    let resolve!: (v: GetStatsResponse) => void;
    fetchStats.mockReturnValue(
      new Promise<GetStatsResponse>((r) => {
        resolve = r;
      }),
    );
    const h = makeHarness(setState, { getSession, fetchStats });

    const inFlight = h.init();
    await Promise.resolve();
    expect(state.status).toBe("loading");

    resolve(response("lifetime", []));
    await inFlight;
    expect(state.status).toBe("ready");
  });
});

describe("empty-window vs never-played discriminator (pure)", () => {
  it("games:[] on lifetime -> never-played (Create CTA), not empty-window", () => {
    expect(isNeverPlayed("lifetime", 0)).toBe(true);
    expect(isEmptyWindow("lifetime", 0)).toBe(false);
  });

  it("games:[] on 30d/ytd -> empty-window (no CTA), not never-played", () => {
    for (const w of ["30d", "ytd"] as const) {
      expect(isEmptyWindow(w, 0)).toBe(true);
      expect(isNeverPlayed(w, 0)).toBe(false);
    }
  });

  it("populated -> neither empty branch, regardless of window", () => {
    for (const w of ["lifetime", "30d", "ytd"] as const) {
      expect(isNeverPlayed(w, 2)).toBe(false);
      expect(isEmptyWindow(w, 2)).toBe(false);
    }
  });
});

describe("tracking-since visibility rule (pure)", () => {
  it("lifetime + non-null -> hidden", () => {
    expect(showTrackingSince("lifetime", "2026-01-01T00:00:00.000Z")).toBe(
      false,
    );
  });

  it("30d + null -> hidden", () => {
    expect(showTrackingSince("30d", null)).toBe(false);
  });

  it("30d + non-null -> shown", () => {
    expect(showTrackingSince("30d", "2026-01-01T00:00:00.000Z")).toBe(true);
  });

  it("ytd + non-null -> shown", () => {
    expect(showTrackingSince("ytd", "2026-01-01T00:00:00.000Z")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Structural contracts (gameLobbyScroll.test.ts idiom): read StatsView.vue as
// text and assert on markup/CSS that the node env cannot render.
// -----------------------------------------------------------------------------
describe("StatsView.vue structural contract", () => {
  const source = readFileSync(
    resolve(__dirname, "../../src/frontend/component/StatsView.vue"),
    "utf-8",
  );

  it("no-regression: the lifetime caption text is unchanged", () => {
    expect(source).toContain("Lifetime totals across all your games.");
  });

  it("renders a tablist with role=tab segments for all three windows", () => {
    expect(source).toContain('role="tablist"');
    expect(source).toContain('role="tab"');
    expect(source).toContain('data-testid="stats-window-tabs"');
  });

  it("segment labels come from the shared WINDOW_TABS constant", () => {
    expect(source).toContain("WINDOW_TABS");
  });

  it("selected tab exposes aria-selected", () => {
    expect(source).toContain("aria-selected");
  });

  it("has a :focus-visible outline on the tabs", () => {
    expect(source).toMatch(/\.stats-tabs__tab:focus-visible\s*\{/);
  });

  it("distinct empty-window state exists and omits the Create-a-Game CTA", () => {
    expect(source).toContain('data-testid="stats-empty-window"');
    expect(source).toContain("No games finished in this range yet");
    // The Create CTA belongs only to the never-played branch.
    const emptyWindowIdx = source.indexOf('data-testid="stats-empty-window"');
    const createIdx = source.indexOf('data-testid="stats-create-link"');
    const neverPlayedIdx = source.indexOf('data-testid="stats-empty"');
    // The create link is inside the never-played block, which appears after the
    // empty-window block in source order.
    expect(createIdx).toBeGreaterThan(neverPlayedIdx);
    expect(neverPlayedIdx).toBeGreaterThan(emptyWindowIdx);
  });

  it("prefers-reduced-motion disables the thumb transition and the list-swap fade", () => {
    // The media block's own closer is at column 0 (`\n}`); its inner rule
    // closers are indented, so slice from the query to the first line-start `}`.
    const start = source.indexOf("@media (prefers-reduced-motion: reduce) {");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n}", start);
    const body = source.slice(start, end);
    expect(body).toContain(".stats-tabs__thumb");
    expect(body).toContain("transition: none");
    expect(body).toContain(".stats-list");
    expect(body).toContain("animation: none");
  });

  it("wires mobile swipe via pointer events on the stats panel", () => {
    expect(source).toContain("@pointerdown");
    expect(source).toContain("@pointerup");
  });
});
