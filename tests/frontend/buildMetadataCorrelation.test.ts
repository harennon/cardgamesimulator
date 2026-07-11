/**
 * Unit tests for the correlation fields added to buildMetadata() (LLD 166).
 *
 * Mirrors the pattern in feedbackBuildMetadata.test.ts — runs in node
 * environment, mirrors the load-bearing logic with the real useCorrelation
 * composable to verify correlation fields appear in metadata.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock observability/sentry so Sentry calls are no-ops in this test
// ---------------------------------------------------------------------------

vi.mock("../../src/frontend/observability/sentry.js", () => ({
  isInitialised: () => false,
  initObservability: vi.fn(),
  recordBreadcrumb: vi.fn(),
  setSentryTag: vi.fn(),
  setSentryContext: vi.fn(),
}));

// Import the real composables after mocks
const { useCorrelation } =
  await import("../../src/frontend/composables/useCorrelation.js");
const { useFeedbackContext } =
  await import("../../src/frontend/composables/useFeedbackContext.js");

// ---------------------------------------------------------------------------
// Minimal buildMetadata mirror — same fields as FeedbackWidget.vue
// ---------------------------------------------------------------------------

interface FakeSession {
  access_token: string;
}

interface FakeGuestSession {
  guestId: string;
}

interface FakeRoute {
  fullPath: string;
  params: { gameId?: string };
}

const navigator = { userAgent: "TestAgent/1.0" };
const window = { innerWidth: 1024, innerHeight: 768 };

async function buildMetadata(deps: {
  getSession: () => Promise<FakeSession | null>;
  restoreGuestSession: () => FakeGuestSession | null;
  route: FakeRoute;
}) {
  let session: FakeSession | null = null;
  try {
    session = await deps.getSession();
  } catch {
    session = null;
  }
  const guestSession = deps.restoreGuestSession();
  const { gamePhase } = useFeedbackContext();
  const { correlationId, gameId: correlationGameId } = useCorrelation();
  return {
    route: deps.route.fullPath,
    gameId: (deps.route.params.gameId as string) || undefined,
    gamePhase: gamePhase.value,
    userType: guestSession ? "guest" : "registered",
    authState: session ? "authenticated" : "anonymous",
    browser: navigator.userAgent.slice(0, 200),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    timestamp: new Date().toISOString(),
    correlationId: correlationId.value,
    correlationGameId: correlationGameId.value,
  };
}

const gameRoute: FakeRoute = {
  fullPath: "/game/abc-123",
  params: { gameId: "abc-123" },
};

const homeRoute: FakeRoute = {
  fullPath: "/",
  params: {},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildMetadata — correlation fields", () => {
  afterEach(() => {
    useCorrelation().unbindGame();
    useFeedbackContext().clearGamePhase();
    vi.clearAllMocks();
  });

  it("includes correlationId matching the cx_ format", async () => {
    const meta = await buildMetadata({
      getSession: () => Promise.resolve({ access_token: "tok" }),
      restoreGuestSession: () => null,
      route: homeRoute,
    });

    expect(meta.correlationId).toMatch(/^cx_[A-Za-z0-9_-]{8}$/);
  });

  it("correlationId is stable across two buildMetadata calls", async () => {
    const meta1 = await buildMetadata({
      getSession: () => Promise.resolve({ access_token: "tok" }),
      restoreGuestSession: () => null,
      route: homeRoute,
    });
    const meta2 = await buildMetadata({
      getSession: () => Promise.resolve({ access_token: "tok" }),
      restoreGuestSession: () => null,
      route: homeRoute,
    });

    expect(meta1.correlationId).toBe(meta2.correlationId);
  });

  it("correlationGameId is undefined before game is bound (E5)", async () => {
    const meta = await buildMetadata({
      getSession: () => Promise.resolve({ access_token: "tok" }),
      restoreGuestSession: () => null,
      route: homeRoute,
    });

    expect(meta.correlationGameId).toBeUndefined();
  });

  it("correlationGameId reflects bound game after bindGame()", async () => {
    useCorrelation().bindGame("game-xyz");

    const meta = await buildMetadata({
      getSession: () => Promise.resolve({ access_token: "tok" }),
      restoreGuestSession: () => null,
      route: gameRoute,
    });

    expect(meta.correlationGameId).toBe("game-xyz");
  });

  it("correlationGameId is undefined after unbindGame()", async () => {
    useCorrelation().bindGame("game-xyz");
    useCorrelation().unbindGame();

    const meta = await buildMetadata({
      getSession: () => Promise.resolve({ access_token: "tok" }),
      restoreGuestSession: () => null,
      route: homeRoute,
    });

    expect(meta.correlationGameId).toBeUndefined();
  });

  it("pre-existing fields (route, gameId, userType, etc.) are unchanged", async () => {
    const meta = await buildMetadata({
      getSession: () => Promise.resolve({ access_token: "tok" }),
      restoreGuestSession: () => null,
      route: gameRoute,
    });

    expect(meta.route).toBe("/game/abc-123");
    expect(meta.gameId).toBe("abc-123");
    expect(meta.userType).toBe("registered");
    expect(meta.authState).toBe("authenticated");
    expect(meta.browser).toBe("TestAgent/1.0");
    expect(meta.viewport).toEqual({ width: 1024, height: 768 });
    expect(typeof meta.timestamp).toBe("string");
  });
});
