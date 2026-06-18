<template>
  <div class="lobby" data-testid="game-lobby">
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
          data-testid="start-game-button"
        >
          Start Game
        </button>
        <span v-else class="lobby__waiting">Waiting for host to start...</span>
      </div>

      <div class="invite-section">
        <span class="invite-label">Room Code</span>
        <div
          class="invite-code"
          :class="{ 'invite-code--copied': codeCopied }"
          role="button"
          tabindex="0"
          aria-label="Copy room code"
          @click="copyGameCode"
          @keydown.enter="copyGameCode"
          @keydown.space.prevent="copyGameCode"
          data-testid="invite-code"
        >
          <span class="invite-code__text" data-testid="short-code">{{
            shortCode
          }}</span>
          <span class="invite-code__icon" aria-hidden="true">
            <svg
              v-if="!codeCopied"
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path
                d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
              ></path>
            </svg>
            <svg
              v-else
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </span>
        </div>
        <span v-if="codeCopied" class="invite-toast" data-testid="invite-toast"
          >Copied to clipboard</span
        >
        <button
          class="invite-link-btn"
          @click="copyInviteLink"
          data-testid="copy-invite-button"
        >
          Copy Full Invite Link
          <span v-if="linkCopied" class="invite-link-btn__copied">Copied!</span>
        </button>
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

const codeCopied = ref(false);
const linkCopied = ref(false);
const errorMessage = ref<string | null>(null);

const canStart = computed(() => props.isHost && props.players.length >= 2);

const emptySlots = computed(() =>
  Math.max(0, props.maxPlayers - props.players.length),
);

/** First 8 hex chars of gameId, uppercased, split into groups of 4 with a space. */
const shortCode = computed(() => {
  const raw = props.gameId.replace(/-/g, "").slice(0, 8).toUpperCase();
  return `${raw.slice(0, 4)} ${raw.slice(4, 8)}`;
});

const inviteLink = computed(
  () => `${window.location.origin}/game/${props.gameId}/join`,
);

function onStart(): void {
  emit("start");
}

async function copyGameCode(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.gameId);
    codeCopied.value = true;
    setTimeout(() => {
      codeCopied.value = false;
    }, 2000);
  } catch {
    errorMessage.value = "Could not copy code";
  }
}

async function copyInviteLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(inviteLink.value);
    linkCopied.value = true;
    setTimeout(() => {
      linkCopied.value = false;
    }, 2000);
  } catch {
    errorMessage.value = "Could not copy link";
  }
}
</script>

<style scoped>
@import url("https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@700&display=swap");
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
  max-width: 100%;
  box-sizing: border-box;
}

@media (max-width: 400px) {
  .lobby__panel {
    padding: 24px 16px;
    min-width: 0;
    width: 100%;
  }
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

/* ── Invite Section ─────────────────────────────────────────────────── */

.invite-section {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.invite-label {
  font-family: var(--font-ui);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.invite-code {
  position: relative;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 14px 16px;
  box-sizing: border-box;
  cursor: pointer;
  border-radius: 10px;
  border: 2px solid var(--gold-accent, #c9a84c);
  background:
    linear-gradient(135deg, rgba(201, 168, 76, 0.08), transparent 50%),
    rgba(45, 24, 16, 0.8);
  box-shadow:
    inset 0 0 0 3px rgba(20, 12, 8, 0.9),
    inset 0 0 0 5px rgba(201, 168, 76, 0.3),
    0 4px 16px rgba(0, 0, 0, 0.4);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    transform 0.1s ease;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
}

.invite-code:hover {
  border-color: #d4b45a;
  box-shadow:
    inset 0 0 0 3px rgba(20, 12, 8, 0.9),
    inset 0 0 0 5px rgba(201, 168, 76, 0.3),
    0 4px 20px rgba(201, 168, 76, 0.25);
}

.invite-code:active {
  transform: scale(0.97);
}

.invite-code:focus-visible {
  outline: 2px solid var(--gold-accent, #c9a84c);
  outline-offset: 2px;
}

@keyframes gold-flash {
  0% {
    background:
      linear-gradient(135deg, rgba(201, 168, 76, 0.08), transparent 50%),
      rgba(45, 24, 16, 0.8);
  }
  30% {
    background:
      linear-gradient(135deg, rgba(201, 168, 76, 0.35), transparent 60%),
      rgba(45, 24, 16, 0.8);
  }
  100% {
    background:
      linear-gradient(135deg, rgba(201, 168, 76, 0.08), transparent 50%),
      rgba(45, 24, 16, 0.8);
  }
}

.invite-code--copied {
  animation: gold-flash 0.4s ease-out forwards;
}

.invite-code__text {
  font-family: "JetBrains Mono", monospace;
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  color: var(--gold-accent, #c9a84c);
}

.invite-code__icon {
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--gold-accent, #c9a84c);
  opacity: 0.6;
  display: flex;
  align-items: center;
}

.invite-toast {
  font-family: var(--font-ui);
  font-size: 0.8rem;
  color: var(--gold-accent, #c9a84c);
  animation: fade-in 0.2s ease-out;
}

@keyframes fade-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.invite-link-btn {
  font-family: var(--font-ui);
  font-size: 0.85rem;
  font-weight: 600;
  padding: 8px 16px;
  border-radius: 6px;
  border: 1.5px solid var(--text-muted);
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.invite-link-btn:hover {
  border-color: var(--text-primary);
  background: rgba(232, 220, 200, 0.08);
}

.invite-link-btn__copied {
  font-size: 0.75rem;
  color: var(--gold-accent, #c9a84c);
}
</style>
