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
      <TonkHand
        v-if="hasHand"
        :cards="myHand"
        :selectable="canSelectHand"
        :selected-indices="selectedIndices"
        :dimmed-indices="dimmedIndices"
        :bad-select="badSelect"
        :dealing="dealing"
        @toggle="(index) => emit('toggleCard', index)"
      />
    </div>

    <div class="tonk-board__log">
      <div
        class="tonk-side-switch"
        role="tablist"
        data-testid="tonk-side-switch"
      >
        <button
          role="tab"
          :aria-selected="sideView === 'tallies'"
          :class="{ 'tonk-side-switch__btn--active': sideView === 'tallies' }"
          class="tonk-side-switch__btn"
          data-testid="tonk-side-switch-tallies"
          @click="sideView = 'tallies'"
        >
          Tallies
        </button>
        <button
          role="tab"
          :aria-selected="sideView === 'log'"
          :class="{ 'tonk-side-switch__btn--active': sideView === 'log' }"
          class="tonk-side-switch__btn"
          data-testid="tonk-side-switch-log"
          @click="sideView = 'log'"
        >
          Game Log
        </button>
      </div>
      <div class="tonk-board__log-body">
        <TonkTallyPanel
          v-if="sideView === 'tallies'"
          :players="gameState.players"
          :tallies="tonkState.tallies"
          :trick-number="tonkState.trickNumber"
        />
        <TonkLog v-else :entries="tonkState.log" :players="gameState.players" />
      </div>
    </div>

    <div class="tonk-board__actions">
      <TonkActionPanel
        :valid-actions="gameState.validActions"
        :turn-phase="tonkState.turnPhase"
        :is-my-turn="isMyTurn"
        :selection-count="selectionCount"
        :drawable-discard="tonkState.drawableDiscard"
        :stock-count="tonkState.stockCount"
        :current-player-name="currentPlayerName"
        :action-error="actionError"
        :action-pending="actionPending"
        :disabled-reason="disabledReason"
        @discard="emit('discard')"
        @draw="(source) => emit('draw', source)"
        @call-tonk="emit('callTonk')"
      />
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
import { isFreshDeal } from "@/composables/useCardAnimations";
import RoomCodeChip from "@/component/game-ui/RoomCodeChip.vue";
import TonkSeatRail from "@/component/game-ui/TonkSeatRail.vue";
import TonkPhaseBanner from "@/component/game-ui/TonkPhaseBanner.vue";
import TonkPiles from "@/component/game-ui/TonkPiles.vue";
import TonkHand from "@/component/game-ui/TonkHand.vue";
import TonkActionPanel from "@/component/game-ui/TonkActionPanel.vue";
import TonkTallyPanel from "@/component/game-ui/TonkTallyPanel.vue";
import TonkLog from "@/component/game-ui/TonkLog.vue";
import type { TonkDrawSource } from "@shared/tonk-types";
import {
  dimmedSelectionIndices,
  isBadSelect,
} from "@/component/game-ui/tonkDisplay";

const props = defineProps<{
  gameState: EnrichedPlayerView;
  turnTimerSeconds: number | null;
  roomCode: string;
  selectedIndices: ReadonlySet<number>;
  selectionCount: number;
  actionError: string | null;
  actionPending: boolean;
  /** Forwarded to TonkActionPanel — non-null forces all buttons disabled. */
  disabledReason?: string | null;
}>();

const emit = defineEmits<{
  toggleCard: [index: number];
  discard: [];
  draw: [source: TonkDrawSource];
  callTonk: [];
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

// The hand is selectable only on the local player's discard-phase turn. The
// server's validActions is the authority (empty when it is not our turn).
const canSelectHand = computed(
  () =>
    isMyTurn.value &&
    tonkState.value?.turnPhase === "discard" &&
    props.gameState.validActions.some((a) => a.type === "discard"),
);

// Presentational same-rank hints (LLD 99 E3/E4) — derived purely from the
// selection, never gating submission. Only meaningful while selecting.
const dimmedIndices = computed<ReadonlySet<number>>(() =>
  canSelectHand.value
    ? dimmedSelectionIndices(myHand.value, props.selectedIndices)
    : new Set<number>(),
);

const badSelect = computed<boolean>(() =>
  canSelectHand.value
    ? isBadSelect(myHand.value, props.selectedIndices)
    : false,
);

const displayCode = computed<string>(
  () => props.gameState.joinCode ?? props.roomCode,
);

const turnDeadline = computed<number | null>(
  () => props.gameState.turnDeadline ?? null,
);

const totalSeconds = computed<number>(() => props.turnTimerSeconds ?? 0);

type SideView = "tallies" | "log";
const sideView = ref<SideView>("tallies");

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
  if (dealTimer !== null) {
    clearTimeout(dealTimer);
    dealTimer = null;
  }
});

// --- Deal-in animation state (LLD 152) ---
// True for one animation window at round start; auto-cleared by timer.
// Tonk re-arms on each new deck-round (the hand goes empty→full per round).
const dealing = ref(false);
let dealTimer: ReturnType<typeof setTimeout> | null = null;

// Max animation window: (maxCards-1) * stagger + duration + slack
// Tonk deals up to 7 cards: 6 * 45ms + 260ms + 100ms = 630ms
const DEAL_CLEAR_MS = 700;

watch(
  () => myHand.value.length,
  (nextLen, prevLen) => {
    if (isFreshDeal(prevLen ?? 0, nextLen)) {
      if (dealTimer !== null) {
        clearTimeout(dealTimer);
      }
      dealing.value = true;
      dealTimer = setTimeout(() => {
        dealing.value = false;
        dealTimer = null;
      }, DEAL_CLEAR_MS);
    }
  },
  { immediate: true },
);

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
  grid-template-rows: 80px 1fr 220px auto;
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
  min-height: 0;
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
  display: flex;
  flex-direction: column;
}

.tonk-side-switch {
  display: flex;
  flex-shrink: 0;
  border-bottom: 1px solid var(--table-rim-light);
}

.tonk-side-switch__btn {
  flex: 1;
  font-family: var(--font-ui);
  font-size: 0.75rem;
  font-weight: 500;
  padding: 8px 4px;
  border: none;
  background: var(--panel-bg);
  color: var(--text-muted);
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  transition: color 0.15s ease;
}

.tonk-side-switch__btn--active {
  color: var(--gold-accent);
  border-bottom: 2px solid var(--gold-accent);
}

.tonk-board__log-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.tonk-board__actions {
  grid-area: actions;
  display: flex;
  align-items: stretch;
  justify-content: center;
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
    padding: var(--mobile-rim-width);
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
