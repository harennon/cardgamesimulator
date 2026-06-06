<template>
  <h2>Game Lobby</h2>
  <ul>
    <li v-for="playerId in playerIds" :key="playerId">
      {{ playerId }}
    </li>
  </ul>
  <button @click="startGame">Start Game</button>
</template>

<style lang="css" scoped>
ul {
  display: flex;
  background-color: #05445e;
  width: 50%;
  padding: 0 5px 0 0;
  border-left: 5px solid #d4f1f4;
  border-radius: 5px;
  flex-direction: column;
  align-items: start;
  list-style-type: none;

  li {
    width: 100%;
    color: #bbbac6;
    border-bottom: 2px solid #d4f1f4;
    padding: 5px 0 5px 5px;
  }
}
</style>

<script lang="ts" setup>
import { axiosInstance } from "@/main";
import { GetGameStateRequest, GetGameStateResponse } from "@shared/model";
import { defineProps, onMounted, ref } from "vue";

const props = defineProps({
  gameId: {
    type: String,
    required: true,
  },
});

const playerIds = ref<string[]>([]);

onMounted(async () => {
  const getGameStateRequest: GetGameStateRequest = {
    gameId: props.gameId,
  };
  await axiosInstance
    .get<GetGameStateResponse>("/api/getGameState", {
      params: getGameStateRequest,
    })
    .then((response) => {
      playerIds.value = response.data.gameState.playerIds;
    });
});

function startGame() {}
</script>
