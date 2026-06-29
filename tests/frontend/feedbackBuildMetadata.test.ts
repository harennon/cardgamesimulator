import { describe, it, expect, vi, afterEach } from "vitest";
import { useFeedbackContext } from "../../src/frontend/composables/useFeedbackContext.js";
import type { FeedbackGamePhase } from "../../src/frontend/composables/useFeedbackContext.js";

// ---------------------------------------------------------------------------
// Tests for buildMetadata() in FeedbackWidget.vue.
//
// Project frontend tests run in a node environment without jsdom and without
// @vue/test-utils, so we mirror the load-bearing buildMetadata() logic here
// (same pattern as roomCodeChip.test.ts / gameOverTransition.test.ts) while
// wiring it to the REAL useFeedbackContext composable. That makes the
// shared-store coupling and the gamePhase read genuine, not stubbed.
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

/**
 * Mirrors buildMetadata() from FeedbackWidget.vue. getSession / restoreGuestSession
 * / route are injected to mirror what the component reads from those services;
 * gamePhase comes from the real shared composable.
 */
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
  return {
    route: deps.route.fullPath,
    gameId: (deps.route.params.gameId as string) || undefined,
    gamePhase: gamePhase.value,
    userType: guestSession ? "guest" : "registered",
    authState: session ? "authenticated" : "anonymous",
    browser: navigator.userAgent.slice(0, 200),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    timestamp: new Date().toISOString(),
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

function authenticated(): () => Promise<FakeSession> {
  return () => Promise.resolve({ access_token: "token-abc" });
}

function unauthenticated(): () => Promise<null> {
  return () => Promise.resolve(null);
}

describe("FeedbackWidget buildMetadata", () => {
  afterEach(() => {
    useFeedbackContext().clearGamePhase();
    vi.clearAllMocks();
  });

  describe("gamePhase", () => {
    it.each<FeedbackGamePhase>(["lobby", "in-progress", "game-over"])(
      "captures store phase %s on a game route",
      async (phase) => {
        useFeedbackContext().setGamePhase(phase);

        const meta = await buildMetadata({
          getSession: authenticated(),
          restoreGuestSession: () => null,
          route: gameRoute,
        });

        expect(meta.gamePhase).toBe(phase);
      },
    );

    it("distinguishes the three phases from one another", async () => {
      const phases: FeedbackGamePhase[] = ["lobby", "in-progress", "game-over"];
      const captured: (FeedbackGamePhase | undefined)[] = [];
      for (const phase of phases) {
        useFeedbackContext().setGamePhase(phase);
        const meta = await buildMetadata({
          getSession: authenticated(),
          restoreGuestSession: () => null,
          route: gameRoute,
        });
        captured.push(meta.gamePhase);
      }
      expect(captured).toEqual(["lobby", "in-progress", "game-over"]);
      expect(new Set(captured).size).toBe(3);
    });

    it("is undefined off the game route (store cleared)", async () => {
      // Store is undefined (cleared in afterEach / never set).
      const meta = await buildMetadata({
        getSession: authenticated(),
        restoreGuestSession: () => null,
        route: homeRoute,
      });

      expect(meta.gamePhase).toBeUndefined();
    });
  });

  describe("authState", () => {
    it("is 'authenticated' when a session is present", async () => {
      const meta = await buildMetadata({
        getSession: authenticated(),
        restoreGuestSession: () => null,
        route: homeRoute,
      });

      expect(meta.authState).toBe("authenticated");
    });

    it("is 'anonymous' when no session is present", async () => {
      const meta = await buildMetadata({
        getSession: unauthenticated(),
        restoreGuestSession: () => null,
        route: homeRoute,
      });

      expect(meta.authState).toBe("anonymous");
    });

    it("falls back to 'anonymous' (and does not throw) when getSession rejects (Edge Case 6)", async () => {
      const meta = await buildMetadata({
        getSession: () => Promise.reject(new Error("auth backend down")),
        restoreGuestSession: () => null,
        route: homeRoute,
      });

      expect(meta.authState).toBe("anonymous");
    });
  });

  describe("authState and userType are independent axes", () => {
    it("registered-but-signed-out yields userType 'registered' with authState 'anonymous'", async () => {
      const meta = await buildMetadata({
        getSession: unauthenticated(), // signed out -> anonymous
        restoreGuestSession: () => null, // no guest session -> registered path
        route: homeRoute,
      });

      expect(meta.userType).toBe("registered");
      expect(meta.authState).toBe("anonymous");
    });

    it("guest user yields userType 'guest' with authState 'anonymous'", async () => {
      const meta = await buildMetadata({
        getSession: unauthenticated(),
        restoreGuestSession: () => ({ guestId: "guest-1" }),
        route: homeRoute,
      });

      expect(meta.userType).toBe("guest");
      expect(meta.authState).toBe("anonymous");
    });

    it("authenticated registered user yields userType 'registered' with authState 'authenticated'", async () => {
      const meta = await buildMetadata({
        getSession: authenticated(),
        restoreGuestSession: () => null,
        route: homeRoute,
      });

      expect(meta.userType).toBe("registered");
      expect(meta.authState).toBe("authenticated");
    });
  });

  describe("pre-existing keys are preserved and unchanged", () => {
    it("retains route, gameId, userType, browser, viewport, timestamp", async () => {
      const meta = await buildMetadata({
        getSession: authenticated(),
        restoreGuestSession: () => null,
        route: gameRoute,
      });

      expect(meta.route).toBe("/game/abc-123");
      expect(meta.gameId).toBe("abc-123");
      expect(meta.userType).toBe("registered");
      expect(meta.browser).toBe("TestAgent/1.0");
      expect(meta.viewport).toEqual({ width: 1024, height: 768 });
      expect(typeof meta.timestamp).toBe("string");
      expect(Number.isNaN(Date.parse(meta.timestamp))).toBe(false);
    });

    it("gameId is undefined off the game route", async () => {
      const meta = await buildMetadata({
        getSession: authenticated(),
        restoreGuestSession: () => null,
        route: homeRoute,
      });

      expect(meta.gameId).toBeUndefined();
    });
  });
});
