<template>
    <p>GameId: {{ prop.gameId }}</p>
    <GameLobbyView v-if="status === 'CREATED'":gameId="gameId"/>
</template>

<script lang="ts" setup>
import { onMounted, ref, defineProps } from 'vue';
import GameLobbyView from '@/component/game/GameLobbyView.vue';
import { axiosInstance } from '@/main';
import { GetGameStateRequest, GetGameStateResponse, BatchGetUsernameRequest, BatchGetUsernameResponse } from '@shared/model';
import { getAccountIdFromJwtCookie } from '@/util/cookie';

const prop = defineProps({
    gameId: {
        type: String,
        required: true,
    },
});

const status = ref("");
const players = ref<string[]>([]);
onMounted(async () => {
    const getGameStateRequest: GetGameStateRequest = {
        accountId: getAccountIdFromJwtCookie(),
        gameId: prop.gameId,
    }
    await axiosInstance.get<GetGameStateResponse>('/api/getGameState', { params: getGameStateRequest }).then((response) => {
        status.value = response.data.gameState.status;
        const accountIds = response.data.gameState.accountIds;
        const request: BatchGetUsernameRequest = { accountIds: accountIds };
        axiosInstance.post<BatchGetUsernameResponse>('/api/auth/batchGetUsername', request).then((batchGetUsernameResponse) => {
            if (batchGetUsernameResponse.data.failures.length !== 0) {
                console.error(`Error getting usernames for accounts ${batchGetUsernameResponse.data.failures.map(failure => failure.accountId)}`);
            };
            players.value.push(...batchGetUsernameResponse.data.accounts.map(account => account.username));
        });
    });
})
</script>