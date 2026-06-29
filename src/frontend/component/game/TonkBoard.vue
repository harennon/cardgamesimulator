<template>
  <div
    v-if="!tonkState"
    class="tonk-board tonk-board--loading"
    data-testid="tonk-board-loading"
  >
    Loading…
  </div>

  <div
    v-else
    class="tonk-board"
    :class="{ 'tonk-board--mobile': isMobile }"
    data-testid="tonk-board"
  >
    <div class="tonk-board__opponents">
      <RoomCodeChip :code="displayCode" />
      <TonkSeatRail
        :players="gameState.players"
        :tallies="tonkState.tallies"
        :current-player-index="gameState.currentPlayerIndex"
        :my-player-index="myPlayerIndex"
        :turn-phase="tonkState.turnPhase"
        :turn-deadline="turnDeadline"
        :total-seconds="totalSeconds"
      />
    </div>

    <div class="tonk-board__table">
      <TonkPhaseBanner
        :turn-phase="tonkState.turnPhase"
        :trick-number="tonkState.trickNumber"
        :current-player-name="currentPlayerName"
        :is-my-turn="isMyTurn"
      />
      <TonkPiles
        :stock-count="tonkState.stockCount"
        :discard-top="tonkState.discardTop"
        :discard-count="tonkState.discardCount"
        :last-discard-count="tonkState.lastDiscardCount"
        :last-discard-player-index="tonkState.lastDiscardPlayerIndex"
        :drawable-discard="tonkState.drawableDiscard"
        :turn-phase="tonkState.turnPhase"
        :players="gameState.players"
      />
    </div>

    <div class="tonk-board__hand">
      <div v-if="hasHand" class="tonk-board__hand-label">
        Your hand ({{ myHand.length }})
      </div>
      <TonkHand v-if="hasHand" :cards="myHand" />
    </div>

    <div class="tonk-board__log">
      <TonkTallyPanel
        :players="gameState.players"
        :tallies="tonkState.tallies"
        :trick-number="tonkState.trickNumber"
      />
    </div>

    <div class="tonk-board__actions">
      <div class="tonk-board__status">
        {{ turnStatusLine }}
      </div>
    </div>
  </div>

  <!-- Mobile log drawer (teleported to body to escape the fixed stacking context) -->
  <Teleport v-if="tonkState" to="body">
    <div
      v-if="isMobile"
      class="tonk-log-drawer"
      :class="{ 'tonk-log-drawer--open': logDrawerOpen }"
    >
      <div class="tonk-log-drawer__header">
        <span>Game Log</span>
        <button class="tonk-log-drawer__close" @click="logDrawerOpen = false">
          &times;
        </button>
      </div>
      <TonkLog :entries="tonkState.log" :players="gameState.players" />
    </div>
  </Teleport>

  <button
    v-if="tonkState && isMobile"
    class="tonk-log-toggle"
    aria-label="Open game log"
    @click="logDrawerOpen = !logDrawerOpen"
  >
    &#9776;
  </button>
</template>

<script lang="ts" setup>
import { computed, ref, watch, onMounted, onUnmounted } from "vue";
import type { EnrichedPlayerView } from "@shared/socket-events";
import type { TonkCard, TonkPublicState } from "@shared/tonk-types";
import RoomCodeChip from "@/component/game-ui/RoomCodeChip.vue";
import TonkSeatRail from "@/component/game-ui/TonkSeatRail.vue";
import TonkPhaseBanner from "@/component/game-ui/TonkPhaseBanner.vue";
import TonkPiles from "@/component/game-ui/TonkPiles.vue";
import TonkHand from "@/component/game-ui/TonkHand.vue";
import TonkTallyPanel from "@/component/game-ui/TonkTallyPanel.vue";
import TonkLog from "@/component/game-ui/TonkLog.vue";
import { phaseLabel, turnLabel } from "@/component/game-ui/tonkDisplay";

const props = defineProps<{
  gameState: EnrichedPlayerView;
  turnTimerSeconds: number | null;
  roomCode: string;
}>();

const tonkState = computed<TonkPublicState | null>(() => {
  if (
    props.gameState.gameType === "tonk" &&
    props.gameState.gameSpecificPublicState
  ) {
    return props.gameState.gameSpecificPublicState as TonkPublicState;
  }
  return null;
});

const myPlayerIndex = computed(() =>
  props.gameState.players.findIndex(
    (p) => p.playerId === props.gameState.you?.playerId,
  ),
);

// The shared PlayerView types `you.hand` as Card[]; for Tonk it may contain
// jokers at runtime. Narrow to TonkCard[] for the joker-aware TonkHand.
const myHand = computed<readonly TonkCard[]>(
  () => (props.gameState.you?.hand ?? []) as readonly TonkCard[],
);

// Render the hand zone only for a local player (spectator-style render has no
// own hand: myPlayerIndex === -1 — E11).
const hasHand = computed(() => myPlayerIndex.value !== -1);

const isMyTurn = computed(
  () => props.gameState.currentPlayerIndex === myPlayerIndex.value,
);

const currentPlayerName = computed(() => {
  const player = props.gameState.players[props.gameState.currentPlayerIndex];
  return player?.displayName ?? "";
});

const turnStatusLine = computed(() => {
  if (!tonkState.value) return "";
  return `${turnLabel(currentPlayerName.value, isMyTurn.value)} · ${phaseLabel(
    tonkState.value.turnPhase,
  )}`;
});

const displayCode = computed<string>(
  () => props.gameState.joinCode ?? props.roomCode,
);

const turnDeadline = computed<number | null>(
  () => props.gameState.turnDeadline ?? null,
);

const totalSeconds = computed<number>(() => props.turnTimerSeconds ?? 0);

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

.tonk-board {
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
}

.tonk-board--loading {
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-ui);
  color: var(--text-muted);
}

.tonk-board::before {
  content: "";
  position: absolute;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg width='4' height='4' xmlns='http://www.w3.org/2000/svg'%3E%3Crect width='4' height='4' fill='none'/%3E%3Ccircle cx='1' cy='1' r='0.5' fill='rgba(0,0,0,0.08)'/%3E%3Ccircle cx='3' cy='3' r='0.3' fill='rgba(255,255,255,0.02)'/%3E%3C/svg%3E");
  pointer-events: none;
  z-index: 0;
}

.tonk-board::after {
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

.tonk-board > * {
  position: relative;
  z-index: 1;
}

.tonk-board__opponents {
  grid-area: opponents;
  position: relative;
}

.tonk-board__table {
  grid-area: table;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.tonk-board__hand {
  grid-area: hand;
  display: flex;
  flex-direction: column;
  justify-content: center;
  background: var(--felt-light);
  border-top: 2px solid var(--table-rim-light);
}

.tonk-board__log {
  grid-area: log;
}

.tonk-board__actions {
  grid-area: actions;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tonk-board__status {
  font-family: var(--font-ui);
  font-size: 0.85rem;
  color: var(--text-primary);
}

.tonk-board__hand-label {
  font-family: var(--font-ui);
  font-size: 0.6rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  padding-left: 12px;
  margin-bottom: 2px;
}

@media (max-width: 767px) {
  .tonk-board--mobile {
    top: 0;
    bottom: auto;
    height: 100vh;
    height: 100dvh;

    grid-template-rows:
      var(--mobile-opponent-height) 1fr var(--mobile-hand-height)
      var(--mobile-actions-height);
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "opponents"
      "table"
      "hand"
      "actions";

    overflow: hidden;
    overflow: clip;
  }

  .tonk-board--mobile .tonk-board__table {
    min-height: 0;
  }

  .tonk-board--mobile::after {
    border-width: var(--mobile-rim-width);
  }

  .tonk-board--mobile > * {
    min-width: 0;
  }

  .tonk-board--mobile .tonk-board__log {
    display: none;
  }

  .tonk-board--mobile .tonk-board__hand {
    align-items: flex-start;
    overflow: hidden;
  }
}
</style>

<style>
.tonk-log-toggle {
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

.tonk-log-toggle:active {
  background: rgba(201, 168, 76, 0.2);
  border-color: var(--gold-accent);
}

.tonk-log-drawer {
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

.tonk-log-drawer--open {
  transform: translateX(0);
}

.tonk-log-drawer__header {
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

.tonk-log-drawer__close {
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
  .tonk-log-drawer {
    transition: none;
  }
}
</style>
