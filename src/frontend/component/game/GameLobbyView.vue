<template>
  <div class="lobby" data-testid="game-lobby">
    <div class="lobby__panel">
      <div class="lobby__header">
        <h2 class="lobby__title">Game Lobby</h2>
        <span
          class="lobby__type-badge"
          :data-type="gameType"
          data-testid="lobby-type-badge"
          >{{ typeBadge }}</span
        >
      </div>

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

      <div class="lobby__count" data-testid="lobby-count">
        Players <b>{{ players.length }}</b> / {{ maxPlayers }}
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
        <template v-if="isHost">
          <button
            class="lobby__btn lobby__btn--start"
            :disabled="!canStart || actionPending"
            @click="onStart"
            data-testid="start-game-button"
          >
            Start Game
          </button>
          <span
            v-if="!canStart && playersNeeded > 0"
            class="lobby__hint"
            data-testid="lobby-start-hint"
          >
            {{ typeLabel }} needs at least {{ minPlayers }} players to start ({{
              playersNeeded
            }}
            more)
          </span>
        </template>
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
import type { PlayerInfo, GameType } from "@shared/engine-types";
import { gameTypeLabel } from "@/component/statsView";

const props = defineProps<{
  gameId: string;
  players: readonly PlayerInfo[];
  maxPlayers: number;
  minPlayers: number;
  gameType: GameType;
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

const canStart = computed(
  () => props.isHost && props.players.length >= props.minPlayers,
);

const playersNeeded = computed(() =>
  Math.max(0, props.minPlayers - props.players.length),
);

const typeLabel = computed(() => gameTypeLabel(props.gameType));

const typeBadge = computed(
  () => `${typeLabel.value} · up to ${props.maxPlayers}`,
);

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
  box-sizing: border-box;
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--felt);
  /* border-box so the 16px breathing room is carved out of the 100vh height
     rather than added to it (otherwise the page overflows by 32px). Combined
     with the panel max-height this guarantees no page scroll at 8 seats. */
  padding: 16px;
}

.lobby__panel {
  box-sizing: border-box;
  background: var(--panel-bg);
  border: 2px solid var(--table-rim-light);
  border-radius: 12px;
  padding: 32px 40px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  min-width: 360px;
  /* The panel itself never forces the page to scroll: it is bounded to the
     viewport (border-box so padding/border are included) and the player list
     (the only growable region) scrolls within it at the Tonk max of 8 seats. */
  max-height: calc(100vh - 32px);
  max-width: 440px;
  width: 100%;
}

.lobby__header {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.lobby__title {
  font-family: var(--font-ui);
  font-size: 1.6rem;
  font-weight: 700;
  color: var(--gold-accent);
  margin: 0;
}

.lobby__type-badge {
  font-family: var(--font-ui);
  font-size: 0.74rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-primary);
  background: rgba(63, 208, 216, 0.1);
  border: 1px solid rgba(63, 208, 216, 0.5);
  border-radius: 999px;
  padding: 4px 12px;
}

.lobby__type-badge[data-type="big2"] {
  color: var(--gold-accent);
  background: rgba(201, 168, 76, 0.1);
  border-color: rgba(201, 168, 76, 0.5);
}

.lobby__count {
  font-family: var(--font-ui);
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-muted);
  align-self: flex-start;
  flex-shrink: 0;
}

.lobby__count b {
  color: var(--text-primary);
}

.lobby__chip-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
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
  /* The only growable/shrinkable region: at the Tonk max of 8 seats the list
     scrolls within itself rather than pushing the chip, count, Start, and
     invite controls off-screen. flex: 1 1 auto + min-height: 0 lets it shrink
     below content height inside the viewport-capped panel so the page never
     gains a scrollbar (LLD 97 E5). */
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.lobby__player {
  flex-shrink: 0;
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
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.lobby__waiting {
  font-family: var(--font-ui);
  font-size: 0.9rem;
  color: var(--text-muted);
  font-style: italic;
}

.lobby__hint {
  font-family: var(--font-ui);
  font-size: 0.78rem;
  color: var(--text-muted);
  font-style: italic;
  margin-top: 8px;
  text-align: center;
}

.lobby__invite {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
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
