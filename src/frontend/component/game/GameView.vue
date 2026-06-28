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
    v-else-if="displayPhase === 'CREATED'"
    :game-id="gameId"
    :players="lobbyPlayers"
    :max-players="maxPlayers"
    :is-host="isHost"
    :action-pending="actionPending"
    :join-code="lobbyJoinCode"
    @start="onStartGame"
  />

  <div
    v-else-if="
      (displayPhase === 'IN_PROGRESS' || displayPhase === 'SHOW_FINAL_PLAY') &&
      gameState
    "
    class="game-view__board-container"
  >
    <GameBoard
      :game-state="gameState"
      :selected-indices="selectedIndices"
      :selection-count="selectionCount"
      :action-error="actionError"
      :action-pending="actionPending"
      :turn-timer-seconds="turnTimerSeconds"
      :room-code="roomCode"
      @toggle-card="toggleCard"
      @play="onPlay"
      @pass="onPass"
    />

    <div
      v-if="displayPhase === 'SHOW_FINAL_PLAY'"
      class="game-view__final-play-overlay"
      data-testid="final-play-overlay"
    >
      <div class="game-view__final-play-content">
        <h2 class="game-view__final-play-winner">
          {{ winnerDisplayName }} wins!
        </h2>
        <button
          class="game-view__final-play-btn"
          data-testid="continue-to-results"
          @click="skipToResults"
        >
          Continue to Results
        </button>
        <div class="game-view__final-play-progress">
          <div class="game-view__final-play-progress-bar"></div>
        </div>
      </div>
    </div>
  </div>

  <GameOverView
    v-else-if="displayPhase === 'COMPLETED' && gameState"
    :scores="gameState.scores ?? []"
    :winner="winnerDisplayName"
    :players="gameState.players"
    :is-guest="isGuest"
    :game-id="gameId"
    :play-history="gameOverPlayHistory"
    :current-player-id="gameState.you.playerId"
    :total-turns="gameState.turnNumber"
  />
</template>

<script lang="ts" setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import type { PlayerInfo } from "@shared/engine-types";
import type { Big2PublicState } from "@shared/big2-types";
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

type DisplayPhase = "CREATED" | "IN_PROGRESS" | "SHOW_FINAL_PLAY" | "COMPLETED";

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
const lobbyJoinCode = ref("");
// Resolved 4-char room code shown in-game. Seeded from REST on mount, kept in
// sync from lobby:state, and superseded by game:state.joinCode (GameBoard prefers
// the live socket value). "" means unknown / no code → chip renders nothing.
const roomCode = ref("");
const maxPlayers = ref(4);
const isHost = ref(false);
const isGuest = ref(false);
const turnTimerSeconds = ref<number | null>(null);

// REST-fetched status is used for initial CREATED render before socket connects.
// Once useGameState receives a game:state event, status.value takes precedence.
const restStatus = ref<string | null>(null);
const effectiveStatus = computed(() => status.value ?? restStatus.value);

const displayPhase = ref<DisplayPhase>("CREATED");
const finalPlayTimerId = ref<ReturnType<typeof setTimeout> | null>(null);

watch(effectiveStatus, (newStatus, oldStatus) => {
  if (newStatus === "COMPLETED" && oldStatus === "IN_PROGRESS") {
    displayPhase.value = "SHOW_FINAL_PLAY";
    finalPlayTimerId.value = setTimeout(() => {
      displayPhase.value = "COMPLETED";
      finalPlayTimerId.value = null;
    }, 4000);
  } else if (newStatus === "COMPLETED") {
    displayPhase.value = "COMPLETED";
  } else if (newStatus === "IN_PROGRESS") {
    displayPhase.value = "IN_PROGRESS";
  } else if (newStatus === "CREATED") {
    displayPhase.value = "CREATED";
  }
});

function skipToResults(): void {
  if (finalPlayTimerId.value) {
    clearTimeout(finalPlayTimerId.value);
    finalPlayTimerId.value = null;
  }
  displayPhase.value = "COMPLETED";
}

const winnerDisplayName = computed(() => {
  if (!gameState.value?.winner) return "";
  const player = gameState.value.players.find(
    (p) => p.playerId === gameState.value!.winner,
  );
  return player?.displayName ?? gameState.value.winner;
});

const gameOverPlayHistory = computed(() => {
  if (!gameState.value?.gameSpecificPublicState) return undefined;
  const publicState = gameState.value
    .gameSpecificPublicState as Big2PublicState;
  return publicState.playHistory;
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
    turnTimerSeconds.value = game.turnTimerSeconds;
    roomCode.value = game.joinCode ?? "";
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
    lobbyJoinCode.value = payload.joinCode;
    roomCode.value = payload.joinCode;
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
  if (finalPlayTimerId.value) clearTimeout(finalPlayTimerId.value);
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
  clearSelection();
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

.game-view__board-container {
  position: relative;
  width: 100vw;
  height: 100vh;
}

.game-view__final-play-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  animation: overlayFadeIn 200ms ease forwards;
}

.game-view__final-play-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  padding: 32px 48px;
}

.game-view__final-play-winner {
  font-family: var(--font-ui);
  font-size: 2rem;
  font-weight: 700;
  color: var(--gold-accent);
  margin: 0;
  text-shadow: 0 0 24px var(--gold-glow);
}

.game-view__final-play-btn {
  font-family: var(--font-ui);
  font-size: 0.95rem;
  font-weight: 600;
  padding: 12px 32px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  background: var(--gold-accent);
  color: #1a0f06;
  min-height: 48px;
  transition: background 0.15s ease;
}

.game-view__final-play-btn:hover {
  background: #d4b45a;
}

.game-view__final-play-progress {
  width: 200px;
  height: 4px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
  overflow: hidden;
}

.game-view__final-play-progress-bar {
  width: 100%;
  height: 100%;
  background: var(--gold-accent);
  animation: shrink 4s linear forwards;
  transform-origin: left;
}

@keyframes overlayFadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes shrink {
  from {
    transform: scaleX(1);
  }
  to {
    transform: scaleX(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .game-view__final-play-overlay {
    animation: none;
  }
}

@media (max-width: 767px) {
  .game-view__final-play-winner {
    font-size: 1.5rem;
  }

  .game-view__final-play-content {
    padding: 24px 20px;
  }

  .game-view__final-play-btn {
    font-size: 16px;
  }
}
</style>
