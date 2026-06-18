import {
  createRouter,
  createWebHistory,
  RouteRecordSingleView,
} from "vue-router";
import CreateGameView from "@/component/CreateGameView.vue";
import JoinGameView from "@/component/JoinGameView.vue";
import LoginView from "@/component/LoginView.vue";
import SignupView from "@/component/SignupView.vue";
import AboutView from "@/component/AboutView.vue";
import HelloWorld from "@/component/HelloWorld.vue";
import HomeView from "@/component/HomeView.vue";
import GameView from "@/component/game/GameView.vue";
import GuestEntryView from "@/component/GuestEntryView.vue";
import { getSession } from "@/service/authService";
import { restoreGuestSession } from "@/service/guestService";
import { axiosInstance } from "@/service/http";
import type {
  JoinGameRequest,
  JoinGameResponse,
  ResolveJoinCodeResponse,
} from "@shared/model";
import type { RouteLocationNormalized, RouteLocationRaw } from "vue-router";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveGameId(param: string): Promise<string | null> {
  if (UUID_REGEX.test(param)) return param.toLowerCase();
  try {
    const res = await axiosInstance.get<ResolveJoinCodeResponse>(
      `/api/games/join/${param.toUpperCase()}`,
    );
    return res.data.gameId;
  } catch {
    return null;
  }
}

export async function joinRouteGuard(
  to: RouteLocationNormalized,
): Promise<RouteLocationRaw | undefined> {
  const session = await getSession();
  if (!session) return undefined; // Not authenticated — show GuestEntryView

  const param = to.params.gameId as string;
  const gameId = await resolveGameId(param);
  if (!gameId) return { path: "/", query: { error: "game-not-found" } };

  // Redirect to canonical UUID path if entered via short code
  const canonicalPath = `/game/${gameId}`;

  try {
    const joinRequest: JoinGameRequest = { gameId };
    await axiosInstance.post<JoinGameResponse>("/api/joinGame", joinRequest);
    return { path: canonicalPath };
  } catch (error: unknown) {
    const e = error as { response?: { status?: number } };
    if (e.response?.status === 404) {
      return { path: "/", query: { error: "game-not-found" } };
    }
    // 409 (game full / already joined) or any other error: redirect to game view
    return { path: canonicalPath };
  }
}

const routes: RouteRecordSingleView[] = [
  { path: "/", component: HomeView, meta: { requiresAuth: false } },
  { path: "/login", component: LoginView, meta: { requiresAuth: false } },
  { path: "/signup", component: SignupView, meta: { requiresAuth: false } },
  { path: "/about", component: AboutView, meta: { requiresAuth: false } },
  { path: "/echo", component: HelloWorld, meta: { requiresAuth: true } },
  {
    path: "/create-game",
    component: CreateGameView,
    meta: { requiresAuth: true },
  },
  { path: "/join-game", component: JoinGameView, meta: { requiresAuth: true } },
  {
    path: "/game/:gameId/join",
    component: GuestEntryView,
    meta: { requiresAuth: false },
    props: true,
    beforeEnter: joinRouteGuard,
  },
  {
    path: "/game/:gameId",
    component: GameView,
    meta: { requiresAuth: false },
    props: true,
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to, _from) => {
  if (to.meta.requiresAuth) {
    const session = await getSession();
    if (!session) {
      return { path: "/login", query: { redirect: to.fullPath } };
    }
    return;
  }

  // For /game/:gameId: resolve short codes, allow sessions, redirect others to join
  if (to.path.match(/^\/game\/[^/]+$/)) {
    const param = to.params.gameId as string;

    // If param is a short code, resolve and redirect to canonical UUID path
    if (!UUID_REGEX.test(param)) {
      const gameId = await resolveGameId(param);
      if (!gameId) return { path: "/", query: { error: "game-not-found" } };
      return { path: `/game/${gameId}` };
    }

    const session = await getSession();
    if (session) return; // registered user — allow through

    // Try to restore guest session from cookie
    const gameId = param;
    const guestSession = restoreGuestSession();
    if (guestSession && guestSession.gameId === gameId) return; // guest session for THIS game — allow through

    // No valid session for this game — redirect to guest entry screen
    return { path: `/game/${gameId}/join` };
  }
});
