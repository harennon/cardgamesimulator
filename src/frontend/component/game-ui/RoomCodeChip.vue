<template>
  <button
    v-if="code"
    class="room-code-chip"
    type="button"
    :aria-label="`Room code ${code}. Tap to copy.`"
    data-testid="ingame-room-code-chip"
    @click="copyCode"
  >
    <span class="room-code-chip__label">
      <span class="room-code-chip__label-text">Room Code</span>
      <svg
        class="room-code-chip__copy"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15V5a2 2 0 0 1 2-2h10" />
      </svg>
    </span>
    <span class="room-code-chip__code">{{ code }}</span>
    <span
      v-if="codeCopied"
      class="room-code-chip__toast"
      data-testid="ingame-room-code-copied"
      >Copied!</span
    >
    <span v-if="clipboardFallback" class="room-code-chip__toast"
      >Long-press to copy.</span
    >
  </button>
</template>

<script lang="ts" setup>
import { ref } from "vue";

const props = defineProps<{
  code: string;
}>();

const codeCopied = ref(false);
const clipboardFallback = ref(false);

async function copyCode(): Promise<void> {
  clipboardFallback.value = false;
  try {
    await navigator.clipboard.writeText(props.code);
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
</script>

<style scoped>
@import "@/styles/game-variables.css";

.room-code-chip {
  position: absolute;
  left: 14px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 4px 6px;
  border-radius: 6px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-family: var(--font-ui);
  z-index: 30;
  transition: background 0.15s ease;
}

.room-code-chip:hover {
  background: rgba(201, 168, 76, 0.1);
}

.room-code-chip__label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.5rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-muted);
  line-height: 1;
}

.room-code-chip__copy {
  width: 9px;
  height: 9px;
  opacity: 0.5;
  transition: opacity 0.15s ease;
}

.room-code-chip:hover .room-code-chip__copy {
  opacity: 1;
}

.room-code-chip__code {
  font-family: "Courier New", Courier, monospace;
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: 0.22em;
  color: var(--gold-accent);
  line-height: 1;
  text-transform: uppercase;
}

.room-code-chip__toast {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  font-size: 0.6rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--gold-accent);
  background: rgba(10, 8, 5, 0.92);
  border: 1px solid var(--gold-accent);
  padding: 3px 8px;
  border-radius: 5px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 40;
}

@media (max-width: 767px) {
  .room-code-chip {
    left: 7px;
    padding: 2px 4px;
  }

  .room-code-chip__label-text {
    /* "ROOM CODE" collapses to "ROOM" on mobile to stay compact */
    font-size: 0;
  }

  .room-code-chip__label-text::before {
    content: "Room";
    font-size: 0.4rem;
  }

  .room-code-chip__copy {
    display: none;
  }

  .room-code-chip__code {
    font-size: 0.74rem;
    letter-spacing: 0.12em;
  }
}
</style>
