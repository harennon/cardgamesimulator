<script setup lang="ts">
import { onMounted, ref } from "vue";
import { getSession } from "@/service/authService";

const signedIn = ref(false);
const displayName = ref("");

onMounted(async () => {
  const session = await getSession();
  if (session) {
    signedIn.value = true;
    displayName.value =
      session.user.user_metadata?.display_name ?? session.user.email ?? "";
  }
});
</script>

<template>
  <div class="flow-page flow-page--center">
    <div class="home">
      <h1 class="home__title" data-testid="home-title">Card Game Simulator</h1>

      <p v-if="signedIn" class="home__subtitle" data-testid="welcome-message">
        Welcome back, {{ displayName }}
      </p>

      <div v-if="signedIn" class="home__actions">
        <router-link
          to="/create-game"
          class="btn-primary home__btn"
          data-testid="create-game-link"
        >
          Create Game
        </router-link>
        <router-link
          to="/join-game"
          class="btn-secondary home__btn"
          data-testid="join-game-link"
        >
          Join Game
        </router-link>
        <router-link
          to="/stats"
          class="btn-secondary home__btn"
          data-testid="stats-link"
        >
          Your Stats
        </router-link>
      </div>

      <div v-else class="home__auth-prompt">
        <p class="home__description">
          Play Big2 with friends. Create an account to host games, or join via
          an invite link as a guest.
        </p>
        <router-link to="/login" class="btn-primary home__btn">
          Log In
        </router-link>
        <router-link to="/signup" class="btn-secondary home__btn">
          Sign Up
        </router-link>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home {
  text-align: center;
  max-width: 500px;
  width: 100%;
}

.home__title {
  font-family: var(--font-ui);
  font-size: 2rem;
  font-weight: 700;
  color: var(--gold-accent);
  margin: 0 0 8px;
}

.home__subtitle {
  font-family: var(--font-ui);
  font-size: 1rem;
  color: var(--text-primary);
  margin: 0 0 32px;
}

.home__description {
  font-family: var(--font-ui);
  font-size: 0.95rem;
  color: var(--text-muted);
  margin: 0 0 24px;
  line-height: 1.5;
}

.home__actions {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 300px;
  margin: 0 auto;
}

.home__btn {
  display: block;
  width: 100%;
  box-sizing: border-box;
  text-align: center;
  text-decoration: none;
}

.home__auth-prompt {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  max-width: 300px;
  margin: 0 auto;
}
</style>
