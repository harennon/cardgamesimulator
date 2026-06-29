import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GameStatsEntry, GetStatsResponse } from "@shared/model";
import type { Session } from "@supabase/supabase-js";

// Project pattern (node env, no component mounting): transcribe StatsView.vue's
// load() state machine and assert one PageState per branch. Keep this in lockstep
// with the component's <script setup>.

type PageState =
  | { status: "loading" }
  | { status: "guest" }
  | { status: "error" }
  | { status: "ready"; games: GameStatsEntry[] };

interface Deps {
  getSession: () => Promise<Session | null>;
  fetchStats: () => Promise<GetStatsResponse>;
}

async function load(
  setState: (s: PageState) => void,
  deps: Deps,
): Promise<void> {
  const session = await deps.getSession();
  if (!session) {
    setState({ status: "guest" });
    return;
  }

  setState({ status: "loading" });
  try {
    const response = await deps.fetchStats();
    setState({ status: "ready", games: response.games });
  } catch {
    setState({ status: "error" });
  }
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

describe("StatsView load() state machine", () => {
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

    await load(setState, { getSession, fetchStats });

    expect(state.status).toBe("guest");
    expect(fetchStats).not.toHaveBeenCalled();
  });

  it("registered + populated: ready state with the returned entries", async () => {
    getSession.mockResolvedValue(fakeSession);
    const games = [makeEntry("big2"), makeEntry("tonk")];
    fetchStats.mockResolvedValue({ userId: "u", games });

    await load(setState, { getSession, fetchStats });

    expect(state).toEqual({ status: "ready", games });
  });

  it("registered + empty: ready state with an empty games array (no error)", async () => {
    getSession.mockResolvedValue(fakeSession);
    fetchStats.mockResolvedValue({ userId: "u", games: [] });

    await load(setState, { getSession, fetchStats });

    expect(state).toEqual({ status: "ready", games: [] });
  });

  it("loading: state is loading while the request is in flight", async () => {
    getSession.mockResolvedValue(fakeSession);
    let resolve!: (v: GetStatsResponse) => void;
    fetchStats.mockReturnValue(
      new Promise<GetStatsResponse>((r) => {
        resolve = r;
      }),
    );

    const inFlight = load(setState, { getSession, fetchStats });
    await Promise.resolve(); // let getSession resolve and loading be set

    expect(state.status).toBe("loading");

    resolve({ userId: "u", games: [] });
    await inFlight;
    expect(state.status).toBe("ready");
  });

  it("error: fetchStats rejects -> error state; retry re-invokes fetchStats", async () => {
    getSession.mockResolvedValue(fakeSession);
    fetchStats.mockRejectedValueOnce({ response: { status: 500 } });

    await load(setState, { getSession, fetchStats });
    expect(state.status).toBe("error");
    expect(fetchStats).toHaveBeenCalledTimes(1);

    // Retry: re-run load(); succeeds this time.
    fetchStats.mockResolvedValueOnce({
      userId: "u",
      games: [makeEntry("big2")],
    });
    await load(setState, { getSession, fetchStats });

    expect(fetchStats).toHaveBeenCalledTimes(2);
    expect(state.status).toBe("ready");
  });

  it("401 token expired mid-session is treated as error (not silently blanked)", async () => {
    getSession.mockResolvedValue(fakeSession);
    fetchStats.mockRejectedValue({ response: { status: 401 } });

    await load(setState, { getSession, fetchStats });

    expect(state.status).toBe("error");
  });
});
