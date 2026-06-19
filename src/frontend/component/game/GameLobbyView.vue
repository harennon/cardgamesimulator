<template>
  <div class="lobby" data-testid="game-lobby">
    <div class="lobby__panel">
      <h2 class="lobby__title">Game Lobby</h2>

      <div class="lobby__chip-container" data-testid="join-code-container">
        <span class="lobby__chip-label">ROOM CODE</span>
        <button
          class="lobby__chip"
          :aria-label="`Room code ${joinCode}. Tap to copy.`"
          data-testid="join-code-chip"
          @click="copyJoinCode"
        >
          {{ joinCode }}
        </button>
        <span
          v-if="codeCopied"
          class="lobby__copied"
          data-testid="code-copied-toast"
          >Copied!</span
        >
        <span v-if="clipboardFallback" class="lobby__copied"
          >Long-press to copy.</span
        >
      </div>

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
          data-testid="start-game-button"
        >
          Start Game
        </button>
        <span v-else class="lobby__waiting">Waiting for host to start...</span>
      </div>

      <div class="lobby__invite">
        <button
          class="lobby__btn lobby__btn--copy"
          @click="copyInviteLink"
          data-testid="copy-invite-button"
        >
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
  joinCode: string;
}>();

const emit = defineEmits<{
  start: [];
}>();

const copied = ref(false);
const codeCopied = ref(false);
const clipboardFallback = ref(false);
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

async function copyJoinCode(): Promise<void> {
  clipboardFallback.value = false;
  try {
    await navigator.clipboard.writeText(props.joinCode);
    codeCopied.value = true;
    setTimeout(() => {
      codeCopied.value = false;
    }, 2000);
  } catch {
    clipboardFallback.value = true;
    setTimeout(() => {
      clipboardFallback.value = false;
    }, 3000);
  }
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

.lobby__chip-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.lobby__chip-label {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--text-muted);
  text-transform: uppercase;
}

.lobby__chip {
  font-family: "Courier New", Courier, monospace;
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: 0.3em;
  color: var(--gold-accent);
  background: transparent;
  border: 3px solid var(--gold-accent);
  border-radius: 12px;
  padding: 12px 24px;
  cursor: pointer;
  transition: background 0.15s ease;
  text-transform: uppercase;
  line-height: 1;
}

.lobby__chip:hover {
  background: rgba(212, 180, 90, 0.1);
}

@media (max-width: 480px) {
  .lobby__chip {
    font-size: 1.6rem;
    padding: 10px 20px;
  }
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

@media (max-width: 767px) {
  .lobby__panel {
    min-width: unset;
    width: calc(100% - 32px);
    padding: 28px 20px;
  }

  .lobby__btn {
    min-height: 48px;
    font-size: 16px;
  }

  .lobby__btn--start {
    width: 100%;
  }

  .lobby__btn--copy {
    width: 100%;
  }

  .lobby__invite {
    width: 100%;
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
