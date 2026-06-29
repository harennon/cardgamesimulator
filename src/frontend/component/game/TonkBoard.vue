<template>
  <div
    class="tonk-board"
    :class="{
      'tonk-board--mobile': isMobile,
      'tonk-board--compact-seats': isCompactSeating,
    }"
    data-testid="tonk-board"
  >
    <div class="tonk-board__opponents">
      <RoomCodeChip :code="displayCode" />
      <OpponentRow
        :players="gameState.players"
        :current-player-index="gameState.currentPlayerIndex"
        :my-player-index="myPlayerIndex"
        :turn-deadline="turnDeadline"
        :total-seconds="totalSeconds"
      />
    </div>

    <div class="tonk-board__table">
      <div
        v-if="!tonkState"
        class="tonk-board__loading"
        data-testid="tonk-loading"
      >
        Loading…
      </div>
      <template v-else>
        <div class="tonk-board__banner" data-testid="tonk-turn-banner">
          {{ turnBanner }}
        </div>

        <div class="tonk-board__slots">
          <div class="tonk-slot" data-testid="tonk-stock-slot">
            <div class="tonk-slot__label">Stock</div>
            <div class="tonk-slot__card">
              <TonkCardView v-if="stockCount > 0" face-down size="large" />
              <div
                v-else
                class="tonk-slot__empty"
                data-testid="tonk-stock-empty"
              ></div>
            </div>
            <div class="tonk-slot__count" data-testid="tonk-stock-count">
              {{ stockCount }}
            </div>
          </div>

          <div class="tonk-slot" data-testid="tonk-discard-slot">
            <div class="tonk-slot__label">Top of pile</div>
            <div class="tonk-slot__card">
              <TonkCardView v-if="discardTop" :card="discardTop" size="large" />
              <div
                v-else
                class="tonk-slot__empty"
                data-testid="tonk-discard-empty"
              ></div>
            </div>
            <div class="tonk-slot__count" data-testid="tonk-discard-count">
              {{ discardCount }}
            </div>
          </div>

          <div
            class="tonk-slot tonk-slot--drawable"
            data-testid="tonk-drawable-slot"
          >
            <div class="tonk-slot__label">Drawable</div>
            <div class="tonk-slot__card">
              <TonkCardView
                v-if="hasDrawable && drawableDiscard"
                :card="drawableDiscard"
                size="large"
              />
              <div
                v-else
                class="tonk-slot__empty tonk-slot__empty--drawable"
                data-testid="tonk-drawable-empty"
              >
                No draw
              </div>
            </div>
          </div>
        </div>

        <div class="tonk-board__tallies" data-testid="tonk-tallies">
          <div class="tonk-tallies__head">
            <span>Standings</span>
            <span class="tonk-tallies__trick" data-testid="tonk-trick-number"
              >Trick {{ trickNumber }}</span
            >
          </div>
          <div
            v-for="(player, i) in gameState.players"
            :key="player.playerId"
            class="tonk-tally"
            :class="{
              'tonk-tally--current': i === gameState.currentPlayerIndex,
            }"
            :data-testid="`tonk-tally-${i}`"
          >
            <span class="tonk-tally__name">{{ player.displayName }}</span>
            <span class="tonk-tally__score">{{ tallyForSeat(i) }}</span>
          </div>
        </div>
      </template>
    </div>

    <div class="tonk-board__hand">
      <div class="tonk-board__hand-label">Your hand ({{ myHand.length }})</div>
      <div
        v-if="!isSpectator"
        class="tonk-board__hand-strip"
        data-testid="tonk-hand"
      >
        <TonkCardView
          v-for="(card, index) in myHand"
          :key="index"
          :card="card"
          size="large"
          class="tonk-board__hand-card"
          :class="{ 'tonk-board__hand-card--first': index === 0 }"
        />
      </div>
    </div>

    <div class="tonk-board__log">
      <TonkGameLog :entries="log" :seat-names="seatNames" />
    </div>
  </div>

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
      <TonkGameLog :entries="log" :seat-names="seatNames" />
    </div>
  </Teleport>

  <button
    v-if="isMobile"
    class="log-toggle"
    aria-label="Open game log"
    @click="logDrawerOpen = !logDrawerOpen"
  >
    &#9776;
  </button>
</template>

<script lang="ts" setup>
import { computed, ref, toRef, watch, onMounted, onUnmounted } from "vue";
import type { EnrichedPlayerView } from "@shared/socket-events";
import type { TonkLogEntry } from "@shared/tonk-types";
import OpponentRow from "@/component/game-ui/OpponentRow.vue";
import RoomCodeChip from "@/component/game-ui/RoomCodeChip.vue";
import TonkCardView from "@/component/game-ui/TonkCardView.vue";
import TonkGameLog from "@/component/game-ui/TonkGameLog.vue";
import { useTonkBoard } from "@/composables/useTonkBoard";

const props = defineProps<{
  gameState: EnrichedPlayerView;
  roomCode: string;
}>();

const gameStateRef = toRef(props, "gameState");

const {
  tonkState,
  myHand,
  myPlayerIndex,
  isSpectator,
  turnBanner,
  trickNumber,
  stockCount,
  discardTop,
  discardCount,
  drawableDiscard,
  hasDrawable,
  tallyForSeat,
  isCompactSeating,
} = useTonkBoard(gameStateRef);

const log = computed<readonly TonkLogEntry[]>(() => tonkState.value?.log ?? []);

const seatNames = computed<string[]>(() =>
  props.gameState.players.map((p) => p.displayName),
);

const displayCode = computed<string>(
  () => props.gameState.joinCode ?? props.roomCode,
);

const turnDeadline = computed<number | null>(
  () => props.gameState.turnDeadline ?? null,
);

const totalSeconds = computed<number>(() => 0);

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
  grid-template-rows: 80px 1fr 220px;
  grid-template-columns: 1fr 280px;
  grid-template-areas:
    "opponents opponents"
    "table     log"
    "hand      log";
  background: radial-gradient(
    ellipse 80% 60% at 50% 50%,
    var(--felt-light) 0%,
    var(--felt) 50%,
    #0f2e1c 100%
  );
  overflow: hidden;
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
  justify-content: flex-start;
  gap: 18px;
  padding: 16px;
  min-height: 0;
}

.tonk-board__loading {
  font-family: var(--font-ui);
  color: var(--text-muted);
  font-size: 0.9rem;
  margin: auto;
}

.tonk-board__banner {
  font-family: var(--font-ui);
  font-size: 1rem;
  font-weight: 600;
  color: var(--gold-accent);
  text-shadow: 0 0 16px var(--gold-glow);
  text-align: center;
}

.tonk-board__slots {
  display: flex;
  gap: 28px;
  align-items: flex-start;
  justify-content: center;
}

.tonk-slot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.tonk-slot__label {
  font-family: var(--font-ui);
  font-size: 0.6rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

.tonk-slot__card {
  display: flex;
  align-items: center;
  justify-content: center;
}

.tonk-slot__count {
  font-family: var(--font-ui);
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--text-primary);
}

.tonk-slot__empty {
  width: var(--card-hand-width);
  height: var(--card-hand-height);
  border-radius: 6px;
  border: 1.5px dashed var(--table-rim-light);
  background: rgba(0, 0, 0, 0.15);
}

.tonk-slot--drawable .tonk-slot__label {
  color: var(--gold-accent);
}

.tonk-slot--drawable .tonk-slot__card {
  padding: 3px;
  border: 2px dashed var(--gold-accent);
  border-radius: 9px;
  box-shadow: 0 0 12px var(--gold-glow);
}

.tonk-slot__empty--drawable {
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-ui);
  font-size: 0.6rem;
  color: var(--text-muted);
  border-style: dashed;
  border-color: var(--gold-accent);
}

.tonk-board__tallies {
  width: 100%;
  max-width: 360px;
  background: var(--panel-bg);
  border: 1px solid var(--table-rim-light);
  border-radius: 8px;
  padding: 8px 10px;
}

.tonk-tallies__head {
  display: flex;
  justify-content: space-between;
  font-family: var(--font-ui);
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--gold-accent);
  margin-bottom: 4px;
}

.tonk-tally {
  display: flex;
  justify-content: space-between;
  font-family: var(--font-ui);
  font-size: 0.78rem;
  color: var(--text-primary);
  padding: 2px 6px;
  border-radius: 4px;
}

.tonk-tally--current {
  background: rgba(201, 168, 76, 0.14);
  color: var(--gold-accent);
  font-weight: 600;
}

.tonk-tally__score {
  font-variant-numeric: tabular-nums;
}

.tonk-board__hand {
  grid-area: hand;
  display: flex;
  flex-direction: column;
  justify-content: center;
  background: var(--felt-light);
  border-top: 2px solid var(--table-rim-light);
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

.tonk-board__hand-strip {
  display: flex;
  align-items: flex-end;
  padding: 24px 16px 8px;
  overflow-x: auto;
}

.tonk-board__hand-card {
  margin-left: var(--card-overlap);
}

.tonk-board__hand-card--first {
  margin-left: 0;
}

.tonk-board__log {
  grid-area: log;
}

/* Compact seats at 6–8: shrink opponent fans/names so the row stays on-screen. */
.tonk-board--compact-seats :deep(.opponent__cards) {
  display: none;
}

.tonk-board--compact-seats :deep(.opponent) {
  padding: 4px 8px;
}

.tonk-board--compact-seats :deep(.opponent__name) {
  font-size: 0.68rem;
  max-width: 72px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tonk-board--compact-seats :deep(.opponent-row) {
  gap: 8px;
  flex-wrap: wrap;
}

@media (max-width: 767px) {
  .tonk-board--mobile {
    top: 0;
    bottom: auto;
    height: 100vh;
    height: 100dvh;
    grid-template-rows: var(--mobile-opponent-height) 1fr var(
        --mobile-hand-height
      );
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "opponents"
      "table"
      "hand";
    overflow: hidden;
    overflow: clip;
  }

  .tonk-board--mobile .tonk-board__table {
    min-height: 0;
    gap: 12px;
    padding: 10px;
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

  .tonk-board--mobile .tonk-board__slots {
    gap: 14px;
  }

  /* Compact tallies (approved): condensed inline standings strip on mobile. */
  .tonk-board--mobile .tonk-board__tallies {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    max-width: none;
    padding: 6px 8px;
  }

  .tonk-board--mobile .tonk-tallies__head {
    width: 100%;
    margin-bottom: 2px;
  }

  .tonk-board--mobile .tonk-tally {
    flex-direction: row;
    gap: 4px;
    padding: 1px 4px;
    font-size: 0.68rem;
  }

  .tonk-board--mobile .tonk-board__hand {
    overflow: hidden;
  }

  .tonk-board--mobile .tonk-board__hand-strip {
    width: 100%;
    padding: 16px 12px 4px;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-x;
    scrollbar-width: none;
  }

  .tonk-board--mobile .tonk-board__hand-strip::-webkit-scrollbar {
    display: none;
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
