import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all .vue components so routes.ts can be imported in a Node environment
vi.mock("@/component/CreateGameView.vue", () => ({ default: {} }));
vi.mock("@/component/JoinGameView.vue", () => ({ default: {} }));
vi.mock("@/component/LoginView.vue", () => ({ default: {} }));
vi.mock("@/component/SignupView.vue", () => ({ default: {} }));
vi.mock("@/component/AboutView.vue", () => ({ default: {} }));
vi.mock("@/component/HomeView.vue", () => ({ default: {} }));
vi.mock("@/component/game/GameView.vue", () => ({ default: {} }));
vi.mock("@/component/GuestEntryView.vue", () => ({ default: {} }));

vi.mock("vue-router", () => ({
  createRouter: vi.fn(() => ({
    beforeEach: vi.fn(),
  })),
  createWebHistory: vi.fn(),
}));

vi.mock("@/service/authService", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/service/http", () => ({
  axiosInstance: {
    post: vi.fn(),
  },
}));

vi.mock("@/service/guestService", () => ({
  restoreGuestSession: vi.fn(),
}));

import { joinRouteGuard } from "../../src/frontend/routes.js";
import { getSession } from "../../src/frontend/service/authService.js";
import { axiosInstance } from "../../src/frontend/service/http.js";
import type { RouteLocationNormalized } from "vue-router";
import type { Session } from "@supabase/supabase-js";

const mockGetSession = vi.mocked(getSession);
const mockAxiosPost = vi.mocked(axiosInstance.post);

function makeRoute(gameId: string): RouteLocationNormalized {
  return {
    params: { gameId },
    path: `/game/${gameId}/join`,
    fullPath: `/game/${gameId}/join`,
    query: {},
    hash: "",
    matched: [],
    meta: {},
    name: undefined,
    redirectedFrom: undefined,
  } as unknown as RouteLocationNormalized;
}

function makeSession(): Session {
  return { access_token: "token-abc" } as unknown as Session;
}

describe("joinRouteGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects authenticated user to game view on successful join", async () => {
    mockGetSession.mockResolvedValue(makeSession());
    mockAxiosPost.mockResolvedValue({ data: {} });

    const result = await joinRouteGuard(makeRoute("game-123"));

    expect(result).toEqual({ path: "/game/game-123" });
    expect(mockAxiosPost).toHaveBeenCalledWith("/api/joinGame", {
      gameId: "game-123",
    });
  });

  it("returns undefined for unauthenticated user (falls through to GuestEntryView)", async () => {
    mockGetSession.mockResolvedValue(null);

    const result = await joinRouteGuard(makeRoute("game-123"));

    expect(result).toBeUndefined();
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it("redirects to home with error query when join returns 404 (game not found)", async () => {
    mockGetSession.mockResolvedValue(makeSession());
    mockAxiosPost.mockRejectedValue({ response: { status: 404 } });

    const result = await joinRouteGuard(makeRoute("game-xyz"));

    expect(result).toEqual({ path: "/", query: { error: "game-not-found" } });
  });

  it("redirects to game view when join returns 409 (game full)", async () => {
    mockGetSession.mockResolvedValue(makeSession());
    mockAxiosPost.mockRejectedValue({ response: { status: 409 } });

    const result = await joinRouteGuard(makeRoute("game-abc"));

    expect(result).toEqual({ path: "/game/game-abc" });
  });

  it("redirects to game view on network error (no response)", async () => {
    mockGetSession.mockResolvedValue(makeSession());
    mockAxiosPost.mockRejectedValue(new Error("Network Error"));

    const result = await joinRouteGuard(makeRoute("game-net"));

    expect(result).toEqual({ path: "/game/game-net" });
  });
});
