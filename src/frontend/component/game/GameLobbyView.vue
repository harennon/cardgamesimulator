<template>
    <h2>Game Lobby</h2>
    <ul>
        <li v-for="user in usernames">
            {{  user  }}
        </li>
    </ul>
    <button @click="startGame">Start Game</button>
</template>

<style lang="css" scoped>
ul {
    display: flex;
    background-color: #05445E;
    width: 50%;
    padding: 0 5px 0 0;
    border-left: 5px solid #D4F1F4;
    border-radius: 5px;
    flex-direction: column;
    align-items: start;
    list-style-type: none;

    li {
        width: 100%;
        color: #BBBAC6;
        border-bottom: 2px solid #D4F1F4;
        padding: 5px 0 5px 5px;
    }
}
</style>

<script lang="ts" setup>
import { axiosInstance } from '@/main';
import { getAccountIdFromJwtCookie } from '@/util/cookie';
import { EventSourceSingleton } from '@/util/sse';
import { BatchGetUsernameRequest, BatchGetUsernameResponse, GetGameStateRequest, GetGameStateResponse, SerializableGame } from '@shared/model';
import { defineProps, onMounted, ref } from 'vue';

const props = defineProps({
    gameId: {
        type: String,
        required: true,
    }
});

const usernames = ref<string[]>([]);


onMounted(async () => {
    const getGameStateRequest: GetGameStateRequest = {
        accountId: getAccountIdFromJwtCookie(),
        gameId: props.gameId,
    }
    await axiosInstance.get<GetGameStateResponse>('/api/getGameState', { params: getGameStateRequest }).then((response) => {
        const accountIds = response.data.gameState.accountIds;
         getUsernames(accountIds);
    });
});

EventSourceSingleton.getInstance().getEventSource().addEventListener('game-state', async (event) => {
    const accountIds = (JSON.parse(event.data) as SerializableGame).accountIds;
    await getUsernames(accountIds);
});

async function getUsernames(accountIds: string[]) {
    const request: BatchGetUsernameRequest = { accountIds: accountIds };
    await axiosInstance.post<BatchGetUsernameResponse>('/api/auth/batchGetUsername', request).then((batchGetUsernameResponse) => {
        if (batchGetUsernameResponse.data.failures.length !== 0) {
            console.error(`Error getting usernames for accounts ${batchGetUsernameResponse.data.failures.map(failure => failure.accountId)}`);
        };
        usernames.value = batchGetUsernameResponse.data.accounts.map(account => account.username);
    });
}

function startGame() {}
</script>