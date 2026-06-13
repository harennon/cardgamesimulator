<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { signIn } from "@/service/authService";

const email = ref("");
const password = ref("");

const attemptedLogin = ref(false);
const errorMessage = ref("");
const route = useRoute();
const router = useRouter();

async function sendLogin() {
  signIn(email.value, password.value)
    .then(() => {
      // redirect to previous page
      const redirectedFrom = route.query.redirect;
      if (redirectedFrom !== undefined && typeof redirectedFrom === "string") {
        console.log("Redirecting to previous page");
        router.push(redirectedFrom);
      } else {
        // redirect to homepage otherwise
        router.push("/");
      }
    })
    .catch((error) => {
      console.error(error);
      if (error.response) {
        errorMessage.value = `Failed to sign in because of error ${error.response.data}`;
      } else {
        errorMessage.value = `Failed to login`;
      }
    })
    .finally(() => {
      attemptedLogin.value = true;
    });
}
</script>

<style lang="css" scoped>
#errorMessage {
  color: red;
}
.login-screen {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
}
form {
  display: block;
  @media only screen and (min-width: 750px) {
    width: 300px;
  }

  & > div {
    margin: 10px 0;
    display: flex;
    justify-content: space-between;
  }

  label {
    margin: 5px;
  }
}
</style>

<template>
  <div class="login-screen">
    <form @submit.prevent="sendLogin">
      <div>
        <label for="email">Email:</label>
        <input
          id="email"
          type="email"
          required
          v-model="email"
          data-testid="email-input"
        />
      </div>
      <div>
        <label for="password">Password:</label>
        <input
          type="password"
          required
          v-model="password"
          data-testid="password-input"
        />
      </div>
      <button type="submit" data-testid="login-button">Login</button>
    </form>
    <p id="errorMessage" v-if="attemptedLogin">{{ errorMessage }}</p>
    <p>New user? <router-link to="/signup">Register Now</router-link></p>
  </div>
</template>
