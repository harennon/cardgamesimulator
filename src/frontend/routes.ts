import { createRouter, createWebHistory, RouteRecordSingleView } from "vue-router";
import CreateGameView from "@/component/CreateGameView.vue"
import LoadGameView from "@/component/LoadGameView.vue"
import JoinGameView from "@/component/JoinGameView.vue"
import LoginView from "@/component/LoginView.vue";
import SignupView from "@/component/SignupView.vue";
import AboutView from "@/component/AboutView.vue";
import HelloWorld from "@/component/HelloWorld.vue";
import HomeView from "@/component/HomeView.vue";
import GameView from "@/component/game/GameView.vue";
import { getUsernameFromJwtCookie } from "@/util/cookie";


const routes: RouteRecordSingleView[] = [
    { path: '/', component: HomeView, meta: { requiresAuth: false } },
    { path: '/login', component: LoginView, meta: { requiresAuth: false } },
    { path: '/signup', component: SignupView, meta: { requiresAuth: false } },
    { path: '/about', component: AboutView, meta: { requiresAuth: false } },
    { path: '/echo', component: HelloWorld, meta: { requiresAuth: true } },
    { path: '/create-game', component: CreateGameView, meta: { requiresAuth: true } },
    { path: '/join-game', component: JoinGameView, meta: { requiresAuth: true } },
    { path: '/load-game', component: LoadGameView, meta: { requiresAuth: true } },
    { path: '/game/:gameId', component: GameView, meta: { requiresAuth: true }, props: true },
];

export const router = createRouter({
    history: createWebHistory(),
    routes,
});

router.beforeEach(async (to, _from) => {
    const isAuthenticated = getUsernameFromJwtCookie() !== "";
    if (!isAuthenticated && to.meta.requiresAuth) {
        return { 
            path: '/login',
            // save the location we were at to come back later
            query: { redirect: to.fullPath },
        }
    }
})