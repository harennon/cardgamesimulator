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
    :min-players="minPlayers"
    :game-type="gameType"
    :is-host="isHost"
    :action-pending="actionPending"
    :join-code="lobbyJoinCode"
    @start="onStartGame"
  />

  <div
    v-else-if="
      (displayPhase === 'IN_PROGRESS' ||
        displayPhase === 'SHOW_FINAL_PLAY' ||
        displayPhase === 'SHOW_TRICK_RESULT') &&
      gameState
    "
    class="game-view__board-container"
    :class="{
      'game-view__board-container--revealing':
        (displayPhase === 'SHOW_FINAL_PLAY' && gameState.gameType === 'big2') ||
        (displayPhase === 'SHOW_TRICK_RESULT' && gameState.gameType === 'tonk'),
    }"
  >
    <TonkBoard
      v-if="gameState.gameType === 'tonk'"
      :game-state="gameState"
      :selected-indices="selectedIndices"
      :selection-count="selectionCount"
      :action-error="actionError"
      :action-pending="actionPending"
      :turn-timer-seconds="turnTimerSeconds"
      :room-code="roomCode"
      @toggle-card="toggleCard"
      @discard="onDiscard"
      @draw="onDraw"
      @call-tonk="onCallTonk"
    />
    <GameBoard
      v-else
      :game-state="gameState"
      :selected-indices="selectedIndices"
      :selection-count="selectionCount"
      :action-error="actionError"
      :action-pending="actionPending"
      :turn-timer-seconds="turnTimerSeconds"
      :room-code="roomCode"
      :game-over="displayPhase === 'SHOW_FINAL_PLAY'"
      @toggle-card="toggleCard"
      @play="onPlay"
      @pass="onPass"
    />

    <TonkTrickReveal
      v-if="
        displayPhase === 'SHOW_TRICK_RESULT' &&
        gameState.gameType === 'tonk' &&
        latestTrickResult
      "
      :trick-result="latestTrickResult"
      :players="gameState.players"
      :tallies="tonkTallies"
      :my-player-index="myTonkPlayerIndex"
      :duration-ms="REVEAL_DURATION_MS"
      data-testid="tonk-trick-reveal"
      @continue="dismissTrickReveal"
    />

    <div
      v-if="displayPhase === 'SHOW_FINAL_PLAY' && gameState.gameType === 'big2'"
      class="game-view__reveal"
      data-testid="final-play-overlay"
    >
      <div class="game-view__reveal-crown" aria-hidden="true">&#127942;</div>
      <h2 class="game-view__reveal-winner">{{ winnerDisplayName }} wins!</h2>

      <div
        v-if="finalPlay && finalPlay.cards.length > 0"
        class="game-view__reveal-final"
      >
        <span class="game-view__reveal-final-label">Final Play</span>
        <div class="game-view__reveal-card-row">
          <GameCard
            v-for="card in finalPlay.cards"
            :key="`${card.rank}-${card.suit}`"
            :card="card"
            size="medium"
          />
        </div>
        <span class="game-view__reveal-final-by">
          {{ finalPlayLabel }} &middot; played by {{ finalPlayByName }}
        </span>
      </div>

      <div class="game-view__reveal-cta">
        <button
          class="game-view__final-play-btn"
          data-testid="continue-to-results"
          @click="skipToResults"
        >
          Continue to Results
        </button>
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
    :is-host="isHost"
    :rematch-pending="actionPending"
    :rematch-error="rematchError"
    :play-history="gameOverPlayHistory"
    :current-player-id="gameState.you.playerId"
    :total-turns="gameState.turnNumber"
    :final-play="finalPlay"
    :tonk-final-move="tonkFinalMove"
    @rematch="onRematch"
  />
</template>

<script lang="ts" setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import type {
  PlayerInfo,
  GameType,
  PlayerPublicInfo,
} from "@shared/engine-types";
import { GAME_TYPE_UI_BOUNDS } from "@/component/statsView";
import type { Big2PublicState, Big2Play } from "@shared/big2-types";
import type {
  TonkPublicState,
  TonkLogEntry,
  TonkDrawSource,
  TonkCard,
  TonkTrickResult,
} from "@shared/tonk-types";

import { axiosInstance } from "@/service/http";
import type { GetGameStateRequest, GetGameStateResponse } from "@shared/model";
import type { AxiosResponse } from "axios";
import { useSocket } from "@/composables/useSocket";
import { useGameState } from "@/composables/useGameState";
import { useGameActions } from "@/composables/useGameActions";
import { useCardSelection } from "@/composables/useCardSelection";
import { useFeedbackContext } from "@/composables/useFeedbackContext";
import type { FeedbackGamePhase } from "@/composables/useFeedbackContext";
import { useCurrentGameType } from "@/composables/useCurrentGameType";
import { getSession } from "@/service/authService";
import { restoreGuestSession } from "@/service/guestService";
import { buildRestLobbyPlayers } from "@/component/game/lobbyUtils";
import GameLobbyView from "@/component/game/GameLobbyView.vue";
import GameBoard from "@/component/game/GameBoard.vue";
import TonkBoard from "@/component/game/TonkBoard.vue";
import GameOverView from "@/component/game/GameOverView.vue";
import TonkTrickReveal from "@/component/game/TonkTrickReveal.vue";
import GameCard from "@/component/game-ui/GameCard.vue";
import { shouldEnterTrickReveal } from "@/component/game-ui/tonkDisplay";

type DisplayPhase =
  | "CREATED"
  | "IN_PROGRESS"
  | "SHOW_FINAL_PLAY"
  | "SHOW_TRICK_RESULT"
  | "COMPLETED";

interface TonkFinalMove {
  entry: TonkLogEntry;
  players: readonly PlayerPublicInfo[];
}

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
  rematch,
  playCards,
  pass,
  discard,
  drawCard,
  callTonk,
  actionError,
  actionPending,
  bind: bindActions,
  unbind: unbindActions,
} = useGameActions();

const router = useRouter();

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
// Defaults to "big2" until the REST getGameState response sets the real type.
// The lobby only renders after that response resolves (see onMounted), so the
// badge/Start gate never render with a stale type.
const gameType = ref<GameType>("big2");
const minPlayers = computed(
  () => GAME_TYPE_UI_BOUNDS[gameType.value].minPlayers,
);
const isHost = ref(false);
const isGuest = ref(false);
const turnTimerSeconds = ref<number | null>(null);
const rematchError = ref<string | null>(null);
// Guards against double-navigation when the host receives both its own ack and
// the broadcast. router.push to the same path is a no-op, but this avoids racing.
let navigatedToRematch = false;

// REST-fetched status is used for initial CREATED render before socket connects.
// Once useGameState receives a game:state event, status.value takes precedence.
const restStatus = ref<string | null>(null);
const effectiveStatus = computed(() => status.value ?? restStatus.value);

const displayPhase = ref<DisplayPhase>("CREATED");

// ---------------------------------------------------------------------------
// LLD 146: Tonk per-round trick-result reveal
// ---------------------------------------------------------------------------

const REVEAL_DURATION_MS = 6000;

/** Client-local: which trick number has already been shown to this client. */
const lastRevealedTrickNumber = ref<number | null>(null);
let revealTimer: ReturnType<typeof setTimeout> | null = null;

/** Newest trick-result entry in the Tonk log, or null. */
const latestTrickResult = computed<TonkTrickResult | null>(() => {
  if (gameState.value?.gameType !== "tonk") return null;
  const tonkPublic = gameState.value.gameSpecificPublicState as
    | TonkPublicState
    | undefined;
  if (!tonkPublic) return null;
  for (let i = tonkPublic.log.length - 1; i >= 0; i--) {
    const entry = tonkPublic.log[i];
    if (entry?.trickResult) return entry.trickResult;
  }
  return null;
});

/** Running tallies from the current Tonk state. */
const tonkTallies = computed<readonly number[]>(() => {
  if (gameState.value?.gameType !== "tonk") return [];
  const tonkPublic = gameState.value.gameSpecificPublicState as
    | TonkPublicState
    | undefined;
  return tonkPublic?.tallies ?? [];
});

/** The local player's seat index in a Tonk game; -1 for spectators. */
const myTonkPlayerIndex = computed<number>(() => {
  if (!gameState.value) return -1;
  return gameState.value.players.findIndex(
    (p) => p.playerId === gameState.value!.you.playerId,
  );
});

function enterTrickReveal(): void {
  if (revealTimer !== null) {
    clearTimeout(revealTimer);
    revealTimer = null;
  }
  displayPhase.value = "SHOW_TRICK_RESULT";
  revealTimer = setTimeout(() => {
    dismissTrickReveal();
  }, REVEAL_DURATION_MS);
}

function dismissTrickReveal(): void {
  if (revealTimer !== null) {
    clearTimeout(revealTimer);
    revealTimer = null;
  }
  if (displayPhase.value === "SHOW_TRICK_RESULT") {
    displayPhase.value = "IN_PROGRESS";
  }
}

watch(effectiveStatus, (newStatus, oldStatus) => {
  if (newStatus === "COMPLETED" && oldStatus === "IN_PROGRESS") {
    // Big2 lingers on SHOW_FINAL_PLAY so the winning play stays visible behind a
    // "Continue to Results" ribbon. Tonk has no final-play concept and no such
    // affordance, so a live Tonk completion goes straight to the game-over screen
    // (otherwise the completing player is stranded on the board). The final winner
    // + tallies live on GameOverView for Tonk.
    displayPhase.value =
      gameType.value === "big2" ? "SHOW_FINAL_PLAY" : "COMPLETED";
  } else if (newStatus === "COMPLETED") {
    displayPhase.value = "COMPLETED";
  } else if (newStatus === "IN_PROGRESS") {
    displayPhase.value = "IN_PROGRESS";
  } else if (newStatus === "CREATED") {
    displayPhase.value = "CREATED";
  }
});

const { setGamePhase, clearGamePhase } = useFeedbackContext();
const { setCurrentGameType, resetCurrentGameType } = useCurrentGameType();

function toFeedbackPhase(phase: DisplayPhase): FeedbackGamePhase {
  switch (phase) {
    case "CREATED":
      return "lobby";
    case "COMPLETED":
      return "game-over";
    case "IN_PROGRESS":
    case "SHOW_FINAL_PLAY":
    case "SHOW_TRICK_RESULT":
      return "in-progress";
  }
}

watch(
  displayPhase,
  (phase) => {
    setGamePhase(toFeedbackPhase(phase));
  },
  { immediate: true },
);

function skipToResults(): void {
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

const finalPlay = computed<Big2Play | null>(() => {
  const publicState = gameState.value?.gameSpecificPublicState as
    | Big2PublicState
    | undefined;
  return publicState?.lastPlay ?? null;
});

const tonkFinalMove = computed<TonkFinalMove | null>(() => {
  if (gameState.value?.gameType !== "tonk") return null;
  const publicState = gameState.value.gameSpecificPublicState as
    | TonkPublicState
    | undefined;
  const log = publicState?.log;
  if (!log || log.length === 0) return null;
  const entry = log[log.length - 1];
  if (!entry.trickResult) return null;
  return { entry, players: gameState.value.players };
});

const HAND_TYPE_LABELS: Record<string, string> = {
  single: "Single",
  pair: "Pair",
  straight: "Straight",
  fullHouse: "Full House",
  fourOfAKind: "Four of a Kind",
  straightFlush: "Straight Flush",
};

const finalPlayLabel = computed(() => {
  if (!finalPlay.value) return "";
  return (
    HAND_TYPE_LABELS[finalPlay.value.handType.kind] ??
    finalPlay.value.handType.kind
  );
});

const finalPlayByName = computed(() => {
  if (!finalPlay.value) return "";
  const player = gameState.value?.players.find(
    (p) => p.playerId === finalPlay.value!.playerId,
  );
  return player?.displayName ?? finalPlay.value.playerId;
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
    gameType.value = game.gameType;
    setCurrentGameType(game.gameType);
    turnTimerSeconds.value = game.turnTimerSeconds;
    roomCode.value = game.joinCode ?? "";
    initialPlayerIds = game.playerIds;

    lobbyPlayers.value = buildRestLobbyPlayers(
      initialPlayerIds,
      game.playerDisplayNames,
      game.gameConfig?.aiPlayerIds,
    );

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

  // Pulls non-host clients (and the host, whichever arrives first) into the new
  // game when the host starts a rematch.
  s.on("game:rematchStarted", ({ newGameId }) => {
    navigateToRematch(newGameId);
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
  clearGamePhase();
  resetCurrentGameType();
  if (revealTimer !== null) {
    clearTimeout(revealTimer);
    revealTimer = null;
  }
});

async function onStartGame(): Promise<void> {
  await startGame(props.gameId);
}

function navigateToRematch(newGameId: string): void {
  if (navigatedToRematch) return;
  navigatedToRematch = true;
  router.push(`/game/${newGameId}`);
}

async function onRematch(): Promise<void> {
  rematchError.value = null;
  const result = await rematch(props.gameId);
  if (result.success && result.newGameId) {
    navigateToRematch(result.newGameId);
  } else {
    rematchError.value = result.error ?? "Failed to start rematch";
  }
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

async function onDiscard(): Promise<void> {
  // selectedCards is (Card | TonkCard)[]; for Tonk it is a TonkCard[].
  const result = await discard(
    props.gameId,
    selectedCards.value as readonly TonkCard[],
  );
  if (result.success) {
    clearSelection();
  }
}

async function onDraw(source: TonkDrawSource): Promise<void> {
  await drawCard(props.gameId, source);
}

async function onCallTonk(): Promise<void> {
  await callTonk(props.gameId);
}

// Defensive selection reset: when our own discard advances the phase to "draw",
// or the turn hands off to another seat, clear stale highlights (LLD 99 §D,
// E14/E15). Index-based selection stays valid across renders that do not change
// the hand, so this only fires on the two transitions above.
const tonkTurnPhase = computed<string | null>(() => {
  if (gameState.value?.gameType !== "tonk") return null;
  const publicState = gameState.value.gameSpecificPublicState as
    | TonkPublicState
    | undefined;
  return publicState?.turnPhase ?? null;
});

watch(
  () => [tonkTurnPhase.value, gameState.value?.currentPlayerIndex] as const,
  () => {
    clearSelection();
  },
);

// LLD 146: detect new trick-result arrivals and enter the reveal phase.
//
// E4 seeding: when the first game:state arrives (initialized flips true), seed
// lastRevealedTrickNumber from the current latestTrickResult so that a round
// already completed before this client joined does NOT trigger a spurious reveal.
// This must happen before the latestTrickResult watcher can fire, so we use an
// immediate watcher on `initialized` that runs once on the initial bind.
watch(
  initialized,
  (isReady) => {
    if (isReady) {
      lastRevealedTrickNumber.value =
        latestTrickResult.value?.trickNumber ?? null;
    }
  },
  { immediate: true },
);

// After the initial seed above, any subsequent change to latestTrickResult is a
// genuine new round ending. Check the guard and enter the reveal.
watch(latestTrickResult, (newResult) => {
  if (
    shouldEnterTrickReveal(
      newResult?.trickNumber ?? null,
      lastRevealedTrickNumber.value,
      effectiveStatus.value ?? "",
    )
  ) {
    lastRevealedTrickNumber.value = newResult!.trickNumber;
    enterTrickReveal();
  }
});
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
  height: 100vh; /* fallback for older browsers */
  height: 100dvh; /* dynamic viewport — accounts for mobile URL bar */
}

/* Direction A — blur + dim the live board behind the reveal layer. The blur is
   applied to the child GameBoard's root (:deep) so the reveal layer's winner,
   final cards, and CTA stay crisp on top. */
.game-view__board-container--revealing :deep(.game-board) {
  filter: blur(7px) brightness(0.55) saturate(0.8);
  transform: scale(1.02); /* hides blur-edge gutter */
  transition:
    filter 0.4s ease,
    transform 0.4s ease;
  pointer-events: none; /* board is non-interactive during reveal */
}

/* Tonk: TonkBoard uses position:fixed so it escapes the board-container.
   Apply blur via a :deep rule targeting the fixed .tonk-board root. */
.game-view__board-container--revealing :deep(.tonk-board) {
  filter: blur(7px) brightness(0.55) saturate(0.8);
  transform: scale(1.02);
  transition:
    filter 0.4s ease,
    transform 0.4s ease;
  pointer-events: none;
}

/* Direction A reveal layer — full-bleed radial scrim hosting the winner text,
   final cards, and the pinned CTA, all crisp above the blurred board. */
.game-view__reveal {
  position: absolute;
  inset: 0;
  z-index: 101; /* above the board wood-rim (z-index 100) */
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 32px;
  background: radial-gradient(
    ellipse 70% 55% at 50% 42%,
    rgba(10, 6, 3, 0.55) 0%,
    rgba(8, 5, 2, 0.82) 100%
  );
}

.game-view__reveal-crown {
  font-size: 2.4rem;
  filter: drop-shadow(0 0 14px var(--gold-glow));
  animation: revealCrownPop 0.5s cubic-bezier(0.18, 0.9, 0.3, 1.4) both;
}

.game-view__reveal-winner {
  font-family: var(--font-card);
  font-size: 1.9rem;
  font-weight: 700;
  color: var(--gold-accent);
  text-shadow: 0 0 28px var(--gold-glow);
  text-align: center;
  margin: 0;
  animation: revealRise 0.5s ease 0.05s both;
}

.game-view__reveal-final {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  animation: revealRise 0.5s ease 0.12s both;
}

.game-view__reveal-final-label {
  font-family: var(--font-ui);
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--gold-accent);
  text-transform: uppercase;
  letter-spacing: 0.14em;
}

.game-view__reveal-card-row {
  display: flex;
  gap: 4px;
}

/* Gold-rimmed lift on the final cards (mockup .reveal__final .card). */
.game-view__reveal-card-row :deep(.card) {
  outline: 1px solid rgba(201, 168, 76, 0.5);
  box-shadow:
    0 8px 28px rgba(0, 0, 0, 0.7),
    0 0 0 4px rgba(201, 168, 76, 0.12);
}

.game-view__reveal-final-by {
  font-family: var(--font-ui);
  font-size: 0.75rem;
  color: var(--text-muted);
}

/* CTA pinned to the visual-viewport bottom, safe-area-aware. */
.game-view__reveal-cta {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 18px 24px calc(18px + env(safe-area-inset-bottom, 0px));
  display: flex;
  justify-content: center;
  animation: revealRise 0.5s ease 0.2s both;
}

.game-view__final-play-btn {
  font-family: var(--font-ui);
  font-size: 0.95rem;
  font-weight: 700;
  padding: 14px 40px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  background: var(--gold-accent);
  color: #1a0f06;
  min-height: 52px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
  transition:
    background 0.15s ease,
    transform 0.1s ease;
}

.game-view__final-play-btn:hover {
  background: #d4b45a;
}

.game-view__final-play-btn:active {
  transform: translateY(1px);
}

@keyframes revealCrownPop {
  from {
    transform: scale(0.5);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

@keyframes revealRise {
  from {
    transform: translateY(14px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

@media (max-width: 767px) {
  .game-view__reveal-winner {
    font-size: 1.5rem;
  }

  .game-view__final-play-btn {
    width: 100%;
    font-size: 1rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .game-view__reveal-crown,
  .game-view__reveal-winner,
  .game-view__reveal-final,
  .game-view__reveal-cta {
    animation: none;
  }

  .game-view__board-container--revealing :deep(.game-board) {
    transition: none;
  }

  .game-view__board-container--revealing :deep(.tonk-board) {
    transition: none;
  }
}
</style>
