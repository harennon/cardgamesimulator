<template>
  <div
    class="game-board"
    :class="{ 'game-board--mobile': isMobile }"
    data-testid="game-board"
  >
    <div class="game-board__opponents">
      <RoomCodeChip :code="displayCode" />
      <OpponentRow
        :players="gameState.players"
        :current-player-index="gameState.currentPlayerIndex"
        :my-player-index="myPlayerIndex"
        :turn-deadline="turnDeadline"
        :total-seconds="totalSeconds"
        :game-over="props.gameOver"
      />
    </div>

    <div class="game-board__table">
      <PlayArea
        :last-play="big2State?.lastPlay ?? null"
        :is-my-turn="isMyTurn"
        :current-player-name="currentPlayerName"
        :players="gameState.players"
        :turn-deadline="turnDeadline"
        :total-seconds="totalSeconds"
        :play-history="big2State?.playHistory ?? []"
        :trick-start-index="big2State?.trickStartIndex ?? 0"
        :game-over="props.gameOver"
      />
    </div>

    <div class="game-board__hand">
      <div class="game-board__hand-label">
        Your hand ({{ gameState.you.hand.length }})
      </div>
      <div v-if="isFinished" class="game-board__finished">
        Finished — waiting for others.
      </div>
      <PlayerHand
        v-else
        :cards="gameState.you.hand"
        :selected-indices="selectedIndices"
        :interactive="isMyTurn"
        @toggle-card="toggleCard"
      />
    </div>

    <div class="game-board__log">
      <GameLog :entries="big2State?.playHistory ?? []" />
    </div>

    <div class="game-board__actions">
      <ActionPanel
        :valid-actions="gameState.validActions"
        :selected-card-count="selectionCount"
        :is-my-turn="isMyTurn"
        :action-error="actionError"
        :action-pending="actionPending"
        @play="onPlay"
        @pass="onPass"
      />
    </div>
  </div>

  <!-- Mobile log drawer (teleported to body to escape fixed game-board stacking context) -->
  <Teleport to="body">
    <div
      v-if="isMobile"
      class="log-drawer"
      :class="{ 'log-drawer--open': logDrawerOpen }"
    >
      <div class="log-drawer__header">
        <span>Game Log</span>
        <button class="log-drawer__close" @click="logDrawerOpen = false">
          &times;
        </button>
      </div>
      <GameLog :entries="big2State?.playHistory ?? []" />
    </div>
  </Teleport>

  <!-- Log toggle button (mobile only, fixed position) -->
  <button
    v-if="isMobile"
    class="log-toggle"
    aria-label="Open game log"
    @click="logDrawerOpen = !logDrawerOpen"
  >
    &#9776;
  </button>

  <DevOverlay
    v-if="isDev"
    :selected-indices="selectedIndices"
    :is-my-turn="isMyTurn"
  />
</template>

<script lang="ts" setup>
import { computed, ref, watch, onMounted, onUnmounted } from "vue";
import type { EnrichedPlayerView } from "@shared/socket-events";
import type { Big2PublicState } from "@shared/big2-types";
import OpponentRow from "@/component/game-ui/OpponentRow.vue";
import RoomCodeChip from "@/component/game-ui/RoomCodeChip.vue";
import PlayArea from "@/component/game-ui/PlayArea.vue";
import PlayerHand from "@/component/game-ui/PlayerHand.vue";
import GameLog from "@/component/game-ui/GameLog.vue";
import ActionPanel from "@/component/game-ui/ActionPanel.vue";
import DevOverlay from "@/component/DevOverlay.vue";

const isDev = import.meta.env.DEV;

const props = withDefaults(
  defineProps<{
    gameState: EnrichedPlayerView;
    selectedIndices: Set<number>;
    selectionCount: number;
    actionError: string | null;
    actionPending: boolean;
    turnTimerSeconds: number | null;
    roomCode: string;
    gameOver?: boolean;
  }>(),
  { gameOver: false },
);

const emit = defineEmits<{
  "toggle-card": [index: number];
  play: [];
  pass: [];
}>();

const big2State = computed<Big2PublicState | null>(() => {
  if (
    props.gameState.gameType === "big2" &&
    props.gameState.gameSpecificPublicState
  ) {
    return props.gameState.gameSpecificPublicState as Big2PublicState;
  }
  return null;
});

const myPlayerIndex = computed(() =>
  props.gameState.players.findIndex(
    (p) => p.playerId === props.gameState.you.playerId,
  ),
);

const isMyTurn = computed(
  () => props.gameState.currentPlayerIndex === myPlayerIndex.value,
);

const currentPlayerName = computed(() => {
  const player = props.gameState.players[props.gameState.currentPlayerIndex];
  return player?.displayName ?? "";
});

// Prefer the authoritative live socket value; fall back to the REST-seeded prop.
const displayCode = computed<string>(
  () => props.gameState.joinCode ?? props.roomCode,
);

const isFinished = computed(() => {
  const finishedIndices = big2State.value?.finishedPlayerIndices ?? [];
  return finishedIndices.includes(myPlayerIndex.value);
});

const turnDeadline = computed<number | null>(
  () => props.gameState.turnDeadline ?? null,
);

const totalSeconds = computed<number>(() => props.turnTimerSeconds ?? 0);

function toggleCard(index: number): void {
  emit("toggle-card", index);
}

function onPlay(): void {
  emit("play");
}

function onPass(): void {
  emit("pass");
}

const isMobile = ref(false);
const logDrawerOpen = ref(false);

const mql = window.matchMedia("(max-width: 767px)");
const handleMediaChange = (e: MediaQueryListEvent) => {
  isMobile.value = e.matches;
};

onMounted(() => {
  isMobile.value = mql.matches;
  mql.addEventListener("change", handleMediaChange);
});

onUnmounted(() => {
  mql.removeEventListener("change", handleMediaChange);
});

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") logDrawerOpen.value = false;
}

watch(logDrawerOpen, (open) => {
  if (open) {
    document.addEventListener("keydown", onKeydown);
  } else {
    document.removeEventListener("keydown", onKeydown);
  }
});
</script>

<style scoped>
@import "@/styles/game-variables.css";

.game-board {
  position: fixed;
  inset: 0;
  display: grid;
  grid-template-rows: 80px 1fr 220px 64px;
  grid-template-columns: 1fr 280px;
  grid-template-areas:
    "opponents opponents"
    "table     log"
    "hand      log"
    "actions   actions";
  background: radial-gradient(
    ellipse 80% 60% at 50% 50%,
    var(--felt-light) 0%,
    var(--felt) 50%,
    #0f2e1c 100%
  );
  overflow: hidden;
  padding: var(--board-rim-inset);
}

/* Felt texture overlay */
.game-board::before {
  content: "";
  position: absolute;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg width='4' height='4' xmlns='http://www.w3.org/2000/svg'%3E%3Crect width='4' height='4' fill='none'/%3E%3Ccircle cx='1' cy='1' r='0.5' fill='rgba(0,0,0,0.08)'/%3E%3Ccircle cx='3' cy='3' r='0.3' fill='rgba(255,255,255,0.02)'/%3E%3C/svg%3E");
  pointer-events: none;
  z-index: 0;
}

/* Wood rim border */
.game-board::after {
  content: "";
  position: absolute;
  inset: 0;
  border: 12px solid var(--table-rim);
  border-image: linear-gradient(
      135deg,
      var(--table-rim-light),
      var(--table-rim),
      #1a0f08
    )
    1;
  pointer-events: none;
  z-index: 100;
}

.game-board > * {
  position: relative;
  z-index: 1;
}

.game-board__opponents {
  grid-area: opponents;
  position: relative;
}

.game-board__table {
  grid-area: table;
}

.game-board__hand {
  grid-area: hand;
  display: flex;
  align-items: center;
  background: var(--felt-light);
  border-top: 2px solid var(--table-rim-light);
}

.game-board__finished {
  font-family: var(--font-ui);
  font-size: 0.9rem;
  color: var(--text-muted);
  font-style: italic;
  padding: 0 24px;
}

.game-board__log {
  grid-area: log;
}

.game-board__actions {
  grid-area: actions;
}

.game-board__hand-label {
  font-family: var(--font-ui);
  font-size: 0.6rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  padding-left: 12px;
  margin-bottom: 2px;
}

@media (max-width: 767px) {
  .game-board--mobile {
    /* Override inset: 0 block axis — use dvh for Firefox URL bar compat */
    top: 0;
    bottom: auto;
    height: 100vh; /* fallback for older browsers */
    height: 100dvh; /* dynamic viewport height — accounts for URL bar */

    grid-template-rows:
      var(--mobile-opponent-height) 1fr var(--mobile-hand-height)
      var(--mobile-actions-height);
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "opponents"
      "table"
      "hand"
      "actions";

    /* clip prevents scroll context creation; hidden is fallback */
    overflow: hidden;
    overflow: clip;
    padding: var(--mobile-rim-width);
  }

  .game-board--mobile .game-board__table {
    min-height: 0; /* Allow 1fr row to shrink on Firefox */
  }

  .game-board--mobile::after {
    border-width: var(--mobile-rim-width);
  }

  .game-board--mobile > * {
    min-width: 0;
  }

  .game-board--mobile .game-board__log {
    display: none;
  }

  .game-board--mobile .game-board__hand {
    flex-direction: column;
    align-items: flex-start;
    overflow: hidden; /* contain within grid cell */
  }
}
</style>

<style>
.log-toggle {
  position: fixed;
  top: 60px;
  right: 8px;
  z-index: 200;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--panel-bg);
  border: 1.5px solid var(--text-muted);
  color: var(--text-primary);
  font-size: 1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.log-toggle:active {
  background: rgba(201, 168, 76, 0.2);
  border-color: var(--gold-accent);
}

.log-drawer {
  position: fixed;
  top: 0;
  right: 0;
  width: 280px;
  height: 100%;
  z-index: 300;
  background: var(--panel-bg);
  border-left: 1.5px solid var(--table-rim-light);
  display: flex;
  flex-direction: column;
  backdrop-filter: blur(8px);
  transform: translateX(100%);
  transition: transform 0.25s ease;
}

.log-drawer--open {
  transform: translateX(0);
}

.log-drawer__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  font-family: var(--font-ui);
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-primary);
  border-bottom: 1px solid var(--table-rim-light);
}

.log-drawer__close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 1.4rem;
  cursor: pointer;
  padding: 4px 8px;
  min-width: 44px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}

@media (prefers-reduced-motion: reduce) {
  .log-drawer {
    transition: none;
  }
}
</style>
