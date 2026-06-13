<template>
  <div class="game-board" data-testid="game-board">
    <div class="game-board__opponents">
      <OpponentRow
        :players="gameState.players"
        :current-player-index="gameState.currentPlayerIndex"
        :my-player-index="myPlayerIndex"
      />
    </div>

    <div class="game-board__table">
      <PlayArea
        :last-play="big2State?.lastPlay ?? null"
        :is-my-turn="isMyTurn"
        :current-player-name="currentPlayerName"
        :players="gameState.players"
      />
    </div>

    <div class="game-board__hand">
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
</template>

<script lang="ts" setup>
import { computed } from "vue";
import type { PlayerView } from "@shared/engine-types";
import type { Big2PublicState } from "@shared/big2-types";
import OpponentRow from "@/component/game-ui/OpponentRow.vue";
import PlayArea from "@/component/game-ui/PlayArea.vue";
import PlayerHand from "@/component/game-ui/PlayerHand.vue";
import GameLog from "@/component/game-ui/GameLog.vue";
import ActionPanel from "@/component/game-ui/ActionPanel.vue";

const props = defineProps<{
  gameState: PlayerView;
  selectedIndices: Set<number>;
  selectionCount: number;
  actionError: string | null;
  actionPending: boolean;
}>();

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

const isFinished = computed(() => {
  const finishedIndices = big2State.value?.finishedPlayerIndices ?? [];
  return finishedIndices.includes(myPlayerIndex.value);
});

function toggleCard(index: number): void {
  emit("toggle-card", index);
}

function onPlay(): void {
  emit("play");
}

function onPass(): void {
  emit("pass");
}
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
</style>
