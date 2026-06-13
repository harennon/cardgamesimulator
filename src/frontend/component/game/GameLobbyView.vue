<template>
  <div class="lobby">
    <div class="lobby__panel">
      <h2 class="lobby__title">Game Lobby</h2>

      <div class="lobby__players">
        <div
          v-for="player in players"
          :key="player.playerId"
          class="lobby__player"
        >
          {{ player.displayName }}
        </div>
        <div
          v-for="n in emptySlots"
          :key="`empty-${n}`"
          class="lobby__player lobby__player--empty"
        >
          Waiting for player...
        </div>
      </div>

      <div v-if="errorMessage" class="lobby__error">{{ errorMessage }}</div>

      <div class="lobby__actions">
        <button
          v-if="isHost"
          class="lobby__btn lobby__btn--start"
          :disabled="!canStart || actionPending"
          @click="onStart"
        >
          Start Game
        </button>
        <span v-else class="lobby__waiting">Waiting for host to start...</span>
      </div>

      <div class="lobby__invite">
        <button class="lobby__btn lobby__btn--copy" @click="copyInviteLink">
          Copy Invite Link
        </button>
        <span v-if="copied" class="lobby__copied">Copied!</span>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, computed } from "vue";
import type { PlayerInfo } from "@shared/engine-types";

const props = defineProps<{
  gameId: string;
  players: readonly PlayerInfo[];
  maxPlayers: number;
  isHost: boolean;
  actionPending: boolean;
}>();

const emit = defineEmits<{
  start: [];
}>();

const copied = ref(false);
const errorMessage = ref<string | null>(null);

const canStart = computed(() => props.isHost && props.players.length >= 2);

const emptySlots = computed(() =>
  Math.max(0, props.maxPlayers - props.players.length),
);

const inviteLink = computed(
  () => `${window.location.origin}/game/${props.gameId}/join`,
);

function onStart(): void {
  emit("start");
}

async function copyInviteLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(inviteLink.value);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    errorMessage.value = "Could not copy link";
  }
}
</script>

<style scoped>
@import "@/styles/game-variables.css";

.lobby {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--felt);
}

.lobby__panel {
  background: var(--panel-bg);
  border: 2px solid var(--table-rim-light);
  border-radius: 12px;
  padding: 40px 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  min-width: 360px;
}

.lobby__title {
  font-family: var(--font-ui);
  font-size: 1.6rem;
  font-weight: 700;
  color: var(--gold-accent);
  margin: 0;
}

.lobby__players {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.lobby__player {
  font-family: var(--font-ui);
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-primary);
  padding: 10px 16px;
  background: rgba(45, 24, 16, 0.6);
  border: 1px solid var(--table-rim-light);
  border-radius: 6px;
}

.lobby__player--empty {
  color: var(--text-muted);
  font-weight: 400;
  font-style: italic;
}

.lobby__error {
  font-family: var(--font-ui);
  font-size: 0.85rem;
  color: #e05555;
  text-align: center;
}

.lobby__actions {
  width: 100%;
  display: flex;
  justify-content: center;
}

.lobby__waiting {
  font-family: var(--font-ui);
  font-size: 0.9rem;
  color: var(--text-muted);
  font-style: italic;
}

.lobby__invite {
  display: flex;
  align-items: center;
  gap: 12px;
}

.lobby__copied {
  font-family: var(--font-ui);
  font-size: 0.8rem;
  color: var(--gold-accent);
}

.lobby__btn {
  font-family: var(--font-ui);
  font-size: 0.95rem;
  font-weight: 600;
  padding: 10px 28px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  transition:
    background 0.15s ease,
    opacity 0.15s ease;
}

.lobby__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.lobby__btn--start {
  background: var(--gold-accent);
  color: #1a0f06;
  width: 100%;
}

.lobby__btn--start:not(:disabled):hover {
  background: #d4b45a;
}

.lobby__btn--copy {
  background: transparent;
  color: var(--text-primary);
  border: 1.5px solid var(--text-muted);
  font-size: 0.85rem;
  padding: 8px 16px;
}

.lobby__btn--copy:hover {
  border-color: var(--text-primary);
  background: rgba(232, 220, 200, 0.08);
}
</style>
