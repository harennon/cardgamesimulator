<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter, useRoute } from "vue-router";
import { type Session } from "@supabase/supabase-js";
import { getSession, signOut, supabase } from "@/service/authService";
import HelpCluster from "@/component/howto/HelpCluster.vue";

const router = useRouter();
const route = useRoute();
const isAuthenticated = ref(false);
const displayName = ref("");

const showNav = computed(() => !route.path.match(/^\/game\/[^/]+$/));

// Force a fresh GameView mount when the gameId changes (e.g. on rematch
// navigation from /game/<old> to /game/<new>), so the component re-runs its
// join flow. Other routes share a stable key — no remount-on-navigation change.
const routeViewKey = computed(() =>
  route.path.match(/^\/game\/[^/]+$/) ? route.path : "app",
);

onMounted(async () => {
  const session = await getSession();
  updateAuthState(session);

  supabase.auth.onAuthStateChange((_event, session) => {
    updateAuthState(session);
  });
});

function updateAuthState(session: Session | null) {
  isAuthenticated.value = !!session;
  displayName.value =
    session?.user?.user_metadata?.display_name ?? session?.user?.email ?? "";
}

async function logout() {
  await signOut();
  router.push("/login");
}
</script>

<template>
  <div class="app-shell">
    <nav v-if="showNav" class="app-nav" data-testid="app-nav">
      <router-link to="/" class="app-nav__logo" data-testid="app-nav-logo">
        Card Game Simulator
      </router-link>
      <div class="app-nav__links">
        <template v-if="isAuthenticated">
          <span class="app-nav__user" data-testid="app-nav-user">{{
            displayName
          }}</span>
          <button
            class="app-nav__logout"
            @click="logout"
            data-testid="logout-button"
          >
            Log out
          </button>
        </template>
        <template v-else>
          <router-link to="/login">Log in</router-link>
          <router-link to="/signup">Sign up</router-link>
        </template>
      </div>
    </nav>
    <router-view :key="routeViewKey" />
    <HelpCluster />
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--bg-dark);
}

.app-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  background: rgba(20, 12, 8, 0.95);
  border-bottom: 1px solid var(--table-rim-light);
}

.app-nav__logo {
  font-family: var(--font-ui);
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--gold-accent);
  text-decoration: none;
}

.app-nav__links {
  display: flex;
  align-items: center;
  gap: 16px;
}

.app-nav__user {
  font-family: var(--font-ui);
  font-size: 0.9rem;
  color: var(--text-primary);
}

.app-nav__logout {
  font-family: var(--font-ui);
  font-size: 0.85rem;
  background: transparent;
  border: 1px solid var(--text-muted);
  border-radius: 4px;
  padding: 4px 12px;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    color 0.15s ease,
    border-color 0.15s ease;
}

.app-nav__logout:hover {
  color: var(--text-primary);
  border-color: var(--text-primary);
}

.app-nav__links a {
  font-family: var(--font-ui);
  font-size: 0.9rem;
  color: var(--text-primary);
  text-decoration: none;
  padding: 4px 8px;
}

.app-nav__links a:hover {
  color: var(--gold-accent);
}
</style>
