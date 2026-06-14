<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { signIn } from "@/service/authService";

const email = ref("");
const password = ref("");
const loading = ref(false);
const errorMessage = ref("");
const route = useRoute();
const router = useRouter();

async function sendLogin() {
  loading.value = true;
  errorMessage.value = "";
  try {
    await signIn(email.value, password.value);
    const redirectedFrom = route.query.redirect;
    if (redirectedFrom !== undefined && typeof redirectedFrom === "string") {
      router.push(redirectedFrom);
    } else {
      router.push("/");
    }
  } catch (error: unknown) {
    const e = error as { message?: string };
    errorMessage.value = e.message ?? "Failed to log in.";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flow-page">
    <form class="form-card" @submit.prevent="sendLogin">
      <h2 class="form-card__title">Log In</h2>

      <div class="form-card__field">
        <label class="form-card__label" for="email">Email</label>
        <input
          class="form-card__input"
          id="email"
          type="email"
          required
          v-model="email"
          data-testid="email-input"
          placeholder="you@example.com"
        />
      </div>

      <div class="form-card__field">
        <label class="form-card__label" for="password">Password</label>
        <input
          class="form-card__input"
          id="password"
          type="password"
          required
          v-model="password"
          data-testid="password-input"
        />
      </div>

      <p v-if="errorMessage" class="form-card__error" data-testid="login-error">
        {{ errorMessage }}
      </p>

      <button
        type="submit"
        class="btn-primary"
        :disabled="loading"
        data-testid="login-button"
      >
        {{ loading ? "Signing in..." : "Log In" }}
      </button>

      <p class="form-card__footer">
        New here?
        <router-link to="/signup" data-testid="login-signup-link"
          >Create an account</router-link
        >
      </p>
      <p class="form-card__footer">
        Just want to play?
        <router-link to="/">Join as guest via invite link</router-link>
      </p>
    </form>
  </div>
</template>
