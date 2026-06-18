<template>
  <div v-if="joinError" class="game-view__error">
    <p>{{ joinError }}</p>
    <a href="/">Back to Home</a>
  </div>

  <div
    v-else-if="!initialized && effectiveStatus !== 'CREATED'"
    class="game-view__loading"
  >
    Connecting...
  </div>

  <GameLobbyView
    v-else-if="effectiveStatus === 'CREATED'"
    :game-id="gameId"
    :players="lobbyPlayers"
    :max-players="maxPlayers"
    :is-host="isHost"
    :action-pending="actionPending"
    @start="onStartGame"
  />

  <GameBoard
    v-else-if="effectiveStatus === 'IN_PROGRESS' && gameState"
    :game-state="gameState"
    :selected-indices="selectedIndices"
    :selection-count="selectionCount"
    :action-error="actionError"
    :action-pending="actionPending"
    @toggle-card="toggleCard"
    @play="onPlay"
    @pass="onPass"
  />

  <GameOverView
    v-else-if="effectiveStatus === 'COMPLETED' && gameState"
    :scores="gameState.scores ?? []"
    :winner="winnerDisplayName"
    :players="gameState.players"
    :is-guest="isGuest"
    :game-id="gameId"
  />
</template>

<script lang="ts" setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import type { PlayerInfo } from "@shared/engine-types";
import { axiosInstance } from "@/service/http";
import type { GetGameStateRequest, GetGameStateResponse } from "@shared/model";
import type { AxiosResponse } from "axios";
import { useSocket } from "@/composables/useSocket";
import { useGameState } from "@/composables/useGameState";
import { useGameActions } from "@/composables/useGameActions";
import { useCardSelection } from "@/composables/useCardSelection";
import { getSession } from "@/service/authService";
import { restoreGuestSession } from "@/service/guestService";
import GameLobbyView from "@/component/game/GameLobbyView.vue";
import GameBoard from "@/component/game/GameBoard.vue";
import GameOverView from "@/component/game/GameOverView.vue";

const props = defineProps<{
  gameId: string;
}>();

const { socket, error: socketError, connect, disconnect } = useSocket();

watch(socketError, (err) => {
  if (err) joinError.value = err;
});
const {
  gameState,
  status,
  initialized,
  bind: bindState,
  unbind: unbindState,
} = useGameState();
const {
  startGame,
  playCards,
  pass,
  actionError,
  actionPending,
  bind: bindActions,
  unbind: unbindActions,
} = useGameActions();

const hand = computed(() => gameState.value?.you.hand ?? []);
const {
  selectedIndices,
  selectedCards,
  selectionCount,
  toggleCard,
  clearSelection,
} = useCardSelection(hand);

const joinError = ref<string | null>(null);
const lobbyPlayers = ref<PlayerInfo[]>([]);
const maxPlayers = ref(4);
const isHost = ref(false);
const isGuest = ref(false);

// REST-fetched status is used for initial CREATED render before socket connects.
// Once useGameState receives a game:state event, status.value takes precedence.
const restStatus = ref<string | null>(null);
const effectiveStatus = computed(() => status.value ?? restStatus.value);

const winnerDisplayName = computed(() => {
  if (!gameState.value?.winner) return "";
  const player = gameState.value.players.find(
    (p) => p.playerId === gameState.value!.winner,
  );
  return player?.displayName ?? gameState.value.winner;
});

onMounted(async () => {
  // Resolve the current player's ID from the auth source eagerly, before the
  // socket connects. gameState.value is null at join-ack time, so we cannot
  // derive the ID from it for the isHost check.
  let currentPlayerId = "";
  const session = await getSession();
  if (session) {
    currentPlayerId = session.user.id;
  } else {
    const guestSession = restoreGuestSession();
    if (guestSession) {
      currentPlayerId = guestSession.guestId;
      isGuest.value = true;
    }
  }

  const request: GetGameStateRequest = { gameId: props.gameId };
  let initialPlayerIds: string[] = [];

  try {
    const response: AxiosResponse<GetGameStateResponse> =
      await axiosInstance.get("/api/getGameState", { params: request });
    const game = response.data.gameState;
    maxPlayers.value = game.maxPlayers;
    initialPlayerIds = game.playerIds;

    lobbyPlayers.value = initialPlayerIds.map((id) => ({
      playerId: id,
      displayName: game.playerDisplayNames[id] ?? id,
    }));

    restStatus.value = game.status;
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 401) {
      joinError.value = "Not authorized. Please log in or join as a guest.";
    } else {
      joinError.value = "Game not found.";
    }
    return;
  }

  await connect();

  const s = socket.value;
  if (!s) {
    joinError.value = "Could not connect to server.";
    return;
  }

  s.on("lobby:state", (payload) => {
    lobbyPlayers.value = payload.players;
    maxPlayers.value = payload.maxPlayers;
  });

  s.on("lobby:playerJoined", (payload) => {
    if (
      !lobbyPlayers.value.find((p) => p.playerId === payload.player.playerId)
    ) {
      lobbyPlayers.value = [...lobbyPlayers.value, payload.player];
    }
  });

  s.on("lobby:playerLeft", (payload) => {
    lobbyPlayers.value = lobbyPlayers.value.filter(
      (p) => p.playerId !== payload.playerId,
    );
  });

  // Bind listeners BEFORE emitting game:join so we don't miss the initial game:state
  // event (server emits it before the ack for IN_PROGRESS/COMPLETED games).
  bindState(s);
  bindActions(s);

  s.emit("game:join", { gameId: props.gameId, role: "player" }, (response) => {
    if (!response.success) {
      joinError.value = response.error ?? "Failed to join game.";
      unbindState();
      unbindActions();
      return;
    }

    isHost.value =
      currentPlayerId !== "" &&
      initialPlayerIds.length > 0 &&
      initialPlayerIds[0] === currentPlayerId;
  });
});

onUnmounted(() => {
  unbindState();
  unbindActions();
  disconnect();
});

async function onStartGame(): Promise<void> {
  await startGame(props.gameId);
}

async function onPlay(): Promise<void> {
  const result = await playCards(props.gameId, selectedCards.value);
  if (result.success) {
    clearSelection();
  }
}

async function onPass(): Promise<void> {
  await pass(props.gameId);
}
</script>

<style scoped>
@import "@/styles/game-variables.css";

.game-view__error {
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  background: var(--felt);
  font-family: var(--font-ui);
  color: var(--text-primary);
}

.game-view__error a {
  color: var(--gold-accent);
  text-decoration: underline;
}

.game-view__loading {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--felt);
  font-family: var(--font-ui);
  color: var(--text-muted);
  font-size: 1rem;
}
</style>
