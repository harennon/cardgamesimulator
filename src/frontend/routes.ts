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
import HomeView from "@/component/HomeView.vue";
import GameView from "@/component/game/GameView.vue";
import GuestEntryView from "@/component/GuestEntryView.vue";
import { getSession } from "@/service/authService";
import { restoreGuestSession } from "@/service/guestService";
import { axiosInstance } from "@/service/http";
import type { JoinGameRequest, JoinGameResponse } from "@shared/model";
import type { RouteLocationNormalized, RouteLocationRaw } from "vue-router";

export async function joinRouteGuard(
  to: RouteLocationNormalized,
): Promise<RouteLocationRaw | undefined> {
  const session = await getSession();
  if (!session) return undefined; // Not authenticated — show GuestEntryView

  const gameId = to.params.gameId as string;
  try {
    const joinRequest: JoinGameRequest = { gameId };
    await axiosInstance.post<JoinGameResponse>("/api/joinGame", joinRequest);
    return { path: `/game/${gameId}` };
  } catch (error: unknown) {
    const e = error as { response?: { status?: number } };
    if (e.response?.status === 404) {
      return { path: "/", query: { error: "game-not-found" } };
    }
    // 409 (game full / already joined) or any other error: redirect to game view
    return { path: `/game/${gameId}` };
  }
}

const routes: RouteRecordSingleView[] = [
  { path: "/", component: HomeView, meta: { requiresAuth: false } },
  { path: "/login", component: LoginView, meta: { requiresAuth: false } },
  { path: "/signup", component: SignupView, meta: { requiresAuth: false } },
  { path: "/about", component: AboutView, meta: { requiresAuth: false } },
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

  // For /game/:gameId: allow Supabase sessions and guest sessions; redirect others to join
  if (to.path.match(/^\/game\/[^/]+$/)) {
    const session = await getSession();
    if (session) return; // registered user — allow through

    // Try to restore guest session from cookie
    const gameId = to.params.gameId as string;
    const guestSession = restoreGuestSession();
    if (guestSession && guestSession.gameId === gameId) return; // guest session for THIS game — allow through

    // No valid session for this game — redirect to guest entry screen
    return { path: `/game/${gameId}/join` };
  }
});
