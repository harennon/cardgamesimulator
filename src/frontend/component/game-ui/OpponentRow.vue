<template>
  <div class="opponent-row">
    <div
      v-for="player in opponents"
      :key="player.playerId"
      class="opponent"
      :class="{ 'opponent--active': isActive(player.originalIndex) }"
    >
      <div class="opponent__cards">
        <div
          v-for="n in Math.min(player.cardCount, 13)"
          :key="n"
          class="card card--small card-back"
        ></div>
      </div>
      <div class="opponent__info">
        <span class="opponent__name">{{ player.displayName }}</span>
        <span class="opponent__count">{{ player.cardCount }} cards</span>
        <span v-if="!player.isConnected" class="opponent__disconnected"
          >disconnected</span
        >
      </div>
      <div
        v-if="isActive(player.originalIndex)"
        class="opponent__turn-indicator"
      ></div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import type { PlayerPublicInfo } from "@shared/engine-types";
import { computed } from "vue";

const props = defineProps<{
  players: readonly PlayerPublicInfo[];
  currentPlayerIndex: number;
  myPlayerIndex: number;
}>();

const opponents = computed(() =>
  props.players
    .map((p, i) => ({ ...p, originalIndex: i }))
    .filter((p) => p.originalIndex !== props.myPlayerIndex),
);

function isActive(originalIndex: number): boolean {
  return originalIndex === props.currentPlayerIndex;
}
</script>

<style scoped>
@import "@/styles/game-variables.css";

.opponent-row {
  display: flex;
  gap: 24px;
  align-items: center;
  justify-content: center;
  padding: 8px 16px;
  background: var(--table-rim);
  border-bottom: 2px solid var(--table-rim-light);
}

.opponent {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 2px solid transparent;
  transition: border-color 0.2s ease;
  position: relative;
}

.opponent--active {
  border-color: var(--gold-accent);
  background: rgba(201, 168, 76, 0.08);
}

.opponent__cards {
  display: flex;
}

.opponent__cards .card-back {
  width: 28px;
  height: 40px;
  margin-left: -10px;
  border-radius: 4px;
  border: 1px solid var(--gold-accent);
  background: linear-gradient(135deg, #8b1a1a 0%, #5c1010 100%);
  position: relative;
  overflow: hidden;
  flex-shrink: 0;
}

.opponent__cards .card-back:first-child {
  margin-left: 0;
}

.opponent__cards .card-back::after {
  content: "";
  position: absolute;
  inset: 3px;
  border: 1px solid rgba(201, 168, 76, 0.3);
  border-radius: 2px;
}

.opponent__info {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.opponent__name {
  font-family: var(--font-ui);
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-primary);
}

.opponent__count {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  color: var(--text-muted);
}

.opponent__disconnected {
  font-family: var(--font-ui);
  font-size: 0.65rem;
  color: #e05555;
}

.opponent__turn-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--gold-accent);
  box-shadow: 0 0 8px var(--gold-accent);
  position: absolute;
  top: 4px;
  right: 4px;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.6;
    transform: scale(1.3);
  }
}
</style>
