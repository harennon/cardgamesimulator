<template>
  <h2>Join a game</h2>
  <form @submit.prevent="joinGame">
    <div>
      <label for="game-id">Game ID:</label>
      <input v-model="gameId" id="game-id" required />
    </div>
    <p id="errorMessage">{{ errorMessage }}</p>
    <input type="submit" />
  </form>
</template>

<style lang="css" scoped>
#errorMessage {
  color: red;
}
form {
  display: block;
  @media only screen and (min-width: 750px) {
    width: 50%;
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

<script setup lang="ts">
import { axiosInstance } from "@/main";
import { JoinGameRequest, JoinGameResponse } from "@shared/model";
import { ref } from "vue";
import { useRouter } from "vue-router";

const router = useRouter();
const errorMessage = ref("");
const gameId = ref("");

async function joinGame() {
  const joinGameRequest: JoinGameRequest = {
    gameId: gameId.value,
  };
  await axiosInstance
    .post<JoinGameResponse>("/api/joinGame", joinGameRequest)
    .then((response) => {
      router.push(`/game/${response.data.gameId}`);
    })
    .catch((error) => {
      if (!error.response) {
        errorMessage.value = "Network error. Please try again.";
        return;
      }
      switch (error.response.status) {
        case 400: {
          errorMessage.value = "Game is full.";
          break;
        }
        case 404: {
          errorMessage.value = "Game not found.";
          break;
        }
        default: {
          errorMessage.value = "Something went wrong. Please try again.";
          break;
        }
      }
    });
}
</script>
