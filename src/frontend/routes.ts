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
