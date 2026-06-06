<template>
    <p>GameId: {{ prop.gameId }}</p>
    <GameLobbyView v-if="status === 'CREATED'" :gameId="gameId"/>
</template>

<script lang="ts" setup>
import { onMounted, ref, defineProps } from 'vue';
import GameLobbyView from '@/component/game/GameLobbyView.vue';
import { axiosInstance } from '@/main';
import { GetGameStateRequest, GetGameStateResponse } from '@shared/model';

const prop = defineProps({
    gameId: {
        type: String,
        required: true,
    },
});

const status = ref("");
onMounted(async () => {
    const getGameStateRequest: GetGameStateRequest = {
        gameId: prop.gameId,
    }
    await axiosInstance.get<GetGameStateResponse>('/api/getGameState', { params: getGameStateRequest }).then((response) => {
        status.value = response.data.gameState.status;
    });
})
</script>
