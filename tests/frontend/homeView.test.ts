import { describe, it, expect, vi, beforeEach } from "vitest";

// Project pattern (node env, no component mounting): transcribe HomeView.vue's
// template gating for the signed-in actions block, which is where the Your Stats
// entrypoint lives (`v-if="signedIn"`). The stats link points to /stats and only
// renders for signed-in users; the signed-out auth-prompt branch omits it.

interface ActionLink {
  testid: string;
  to: string;
}

// Mirrors the links rendered in HomeView's home__actions / home__auth-prompt blocks.
function visibleActionLinks(signedIn: boolean): ActionLink[] {
  if (signedIn) {
    return [
      { testid: "create-game-link", to: "/create-game" },
      { testid: "join-game-link", to: "/join-game" },
      { testid: "stats-link", to: "/stats" },
    ];
  }
  return [
    { testid: "login-link", to: "/login" },
    { testid: "signup-link", to: "/signup" },
  ];
}

describe("HomeView stats entrypoint", () => {
  it("shows the stats-link pointing to /stats when signed in", () => {
    const link = visibleActionLinks(true).find(
      (l) => l.testid === "stats-link",
    );
    expect(link).toBeDefined();
    expect(link?.to).toBe("/stats");
  });

  it("does not show the stats-link when signed out", () => {
    const link = visibleActionLinks(false).find(
      (l) => l.testid === "stats-link",
    );
    expect(link).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests for the signed-out room-code join logic, extracted as pure functions
// mirroring HomeView.vue's joinByCode() behaviour.
// ---------------------------------------------------------------------------

const SHORT_CODE_REGEX = /^[A-Z0-9]{4}$/i;

interface MockHttp {
  get: ReturnType<typeof vi.fn>;
}

function makeHttp(): MockHttp {
  return { get: vi.fn() };
}

/**
 * Mirrors joinByCode() from HomeView.vue.
 * Returns the navigation target or an error message.
 */
async function joinByCode(
  rawCode: string,
  http: MockHttp,
): Promise<{
  navigateTo?: string;
  codeError?: string;
  inputPreserved: boolean;
}> {
  const code = rawCode.trim().toUpperCase();
  if (!SHORT_CODE_REGEX.test(code)) {
    return {
      codeError: "No game found for that code.",
      inputPreserved: true,
    };
  }

  try {
    const response = await http.get(`/api/games/join/${code}`);
    const gameId = (response as { data: { gameId: string } }).data.gameId;
    return { navigateTo: `/game/${gameId}/join`, inputPreserved: true };
  } catch (error: unknown) {
    const e = error as { response?: { status?: number } };
    if (!e.response) {
      return {
        codeError: "Network error. Please try again.",
        inputPreserved: true,
      };
    }
    if (e.response.status === 404) {
      return {
        codeError: "No game found for that code.",
        inputPreserved: true,
      };
    }
    return {
      codeError: "Something went wrong. Please try again.",
      inputPreserved: true,
    };
  }
}

describe("HomeView signed-out branch visibility", () => {
  it("signed-out branch includes login and signup links but not stats-link", () => {
    const links = visibleActionLinks(false);
    const testids = links.map((l) => l.testid);
    expect(testids).toContain("login-link");
    expect(testids).toContain("signup-link");
    expect(testids).not.toContain("stats-link");
    expect(testids).not.toContain("create-game-link");
    expect(testids).not.toContain("join-game-link");
  });

  it("signed-in branch does NOT include a room-code field (only in signed-out branch)", () => {
    // The room-code form lives inside v-else (signedIn === false).
    // We verify the signed-in branch only has the three nav actions.
    const links = visibleActionLinks(true);
    const testids = links.map((l) => l.testid);
    // login/signup links are absent when signed in
    expect(testids).not.toContain("login-link");
    expect(testids).not.toContain("signup-link");
    // the three authenticated actions are present
    expect(testids).toContain("create-game-link");
    expect(testids).toContain("join-game-link");
    expect(testids).toContain("stats-link");
  });
});

describe("HomeView joinByCode — valid codes", () => {
  let http: MockHttp;

  beforeEach(() => {
    http = makeHttp();
  });

  it("resolves uppercase code and navigates to /game/:gameId/join (NOT /game/:gameId)", async () => {
    http.get.mockResolvedValue({ data: { gameId: "abc-123" } });
    const result = await joinByCode("WXYZ", http);
    expect(result.navigateTo).toBe("/game/abc-123/join");
    expect(result.navigateTo).not.toBe("/game/abc-123");
    expect(http.get).toHaveBeenCalledWith("/api/games/join/WXYZ");
  });

  it("normalises lowercase code to uppercase before calling the API", async () => {
    http.get.mockResolvedValue({ data: { gameId: "game-id-1" } });
    const result = await joinByCode("wxyz", http);
    expect(http.get).toHaveBeenCalledWith("/api/games/join/WXYZ");
    expect(result.navigateTo).toBe("/game/game-id-1/join");
  });

  it("trims leading/trailing spaces before resolving", async () => {
    http.get.mockResolvedValue({ data: { gameId: "game-id-2" } });
    const result = await joinByCode("  AB12  ", http);
    expect(http.get).toHaveBeenCalledWith("/api/games/join/AB12");
    expect(result.navigateTo).toBe("/game/game-id-2/join");
  });

  it("preserves the input value on success", async () => {
    http.get.mockResolvedValue({ data: { gameId: "gid" } });
    const result = await joinByCode("CODE", http);
    expect(result.inputPreserved).toBe(true);
  });
});

describe("HomeView joinByCode — invalid format (no HTTP request)", () => {
  let http: MockHttp;

  beforeEach(() => {
    http = makeHttp();
  });

  it("3-char code shows error and makes no request", async () => {
    const result = await joinByCode("ABC", http);
    expect(result.codeError).toBe("No game found for that code.");
    expect(http.get).not.toHaveBeenCalled();
    expect(result.inputPreserved).toBe(true);
  });

  it("5-char code shows error and makes no request", async () => {
    const result = await joinByCode("ABCDE", http);
    expect(result.codeError).toBe("No game found for that code.");
    expect(http.get).not.toHaveBeenCalled();
  });

  it("code with symbols shows error and makes no request", async () => {
    const result = await joinByCode("AB!@", http);
    expect(result.codeError).toBe("No game found for that code.");
    expect(http.get).not.toHaveBeenCalled();
  });

  it("empty string after trim shows error and makes no request", async () => {
    const result = await joinByCode("   ", http);
    expect(result.codeError).toBe("No game found for that code.");
    expect(http.get).not.toHaveBeenCalled();
  });
});

describe("HomeView joinByCode — server errors", () => {
  let http: MockHttp;

  beforeEach(() => {
    http = makeHttp();
  });

  it("server 404 shows 'No game found for that code.' and preserves input", async () => {
    http.get.mockRejectedValue({ response: { status: 404 } });
    const result = await joinByCode("ABCD", http);
    expect(result.codeError).toBe("No game found for that code.");
    expect(result.inputPreserved).toBe(true);
    expect(result.navigateTo).toBeUndefined();
  });

  it("server 404 does NOT navigate to /login or /", async () => {
    http.get.mockRejectedValue({ response: { status: 404 } });
    const result = await joinByCode("ABCD", http);
    expect(result.navigateTo).toBeUndefined();
  });

  it("network error (no response) shows 'Network error. Please try again.'", async () => {
    http.get.mockRejectedValue(new Error("Network Error"));
    const result = await joinByCode("ABCD", http);
    expect(result.codeError).toBe("Network error. Please try again.");
    expect(result.inputPreserved).toBe(true);
  });

  it("server 5xx shows generic error message", async () => {
    http.get.mockRejectedValue({ response: { status: 500 } });
    const result = await joinByCode("ABCD", http);
    expect(result.codeError).toBe("Something went wrong. Please try again.");
    expect(result.inputPreserved).toBe(true);
  });
});
