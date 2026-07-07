<template>
  <div class="turn-alert-menu">
    <button
      class="turn-alert-menu__gear"
      aria-label="Alert settings"
      :aria-expanded="open"
      @click.stop="open = !open"
    >
      ⚙
    </button>

    <div
      v-if="open"
      class="turn-alert-menu__popover"
      role="dialog"
      aria-label="Alert settings"
    >
      <!-- Sound row -->
      <div class="turn-alert-menu__row">
        <div class="turn-alert-menu__row-label">
          <span class="turn-alert-menu__label">Turn sound</span>
          <span class="turn-alert-menu__hint"
            >Soft chime when it's your turn &amp; tab is hidden</span
          >
        </div>
        <label class="turn-alert-menu__switch">
          <input
            type="checkbox"
            :checked="soundEnabled"
            @change="
              emit(
                'update:soundEnabled',
                ($event.target as HTMLInputElement).checked,
              )
            "
          />
          <span class="turn-alert-menu__slider" />
        </label>
      </div>

      <!-- Desktop alerts row (hidden when unsupported) -->
      <div v-if="notifState !== 'unsupported'" class="turn-alert-menu__row">
        <div class="turn-alert-menu__row-label">
          <span class="turn-alert-menu__label">Desktop alerts</span>
          <span class="turn-alert-menu__hint"
            >Browser notification when it's your turn</span
          >
        </div>
        <div class="turn-alert-menu__notif-ctrl">
          <button
            v-if="notifState === 'default'"
            class="turn-alert-menu__enable-btn"
            @click="emit('request-notifications')"
          >
            Enable
          </button>
          <span
            v-else-if="notifState === 'granted'"
            class="turn-alert-menu__chip turn-alert-menu__chip--on"
            >On</span
          >
          <span
            v-else-if="notifState === 'denied'"
            class="turn-alert-menu__chip turn-alert-menu__chip--blocked"
            >Blocked</span
          >
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, onMounted, onUnmounted } from "vue";
import type { NotifState } from "@/composables/useTurnAlert";

const props = defineProps<{
  soundEnabled: boolean;
  notifState: NotifState;
}>();

const emit = defineEmits<{
  "update:soundEnabled": [value: boolean];
  "request-notifications": [];
}>();

// Suppress unused props warning — props is accessed via template
void props;

const open = ref(false);

function onDocClick(): void {
  open.value = false;
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") open.value = false;
}

onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKeydown);
});
</script>

<style scoped>
@import "@/styles/game-variables.css";

.turn-alert-menu {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 50;
}

.turn-alert-menu__gear {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--text-muted);
  color: var(--text-muted);
  font-size: 0.85rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    border-color 0.15s,
    color 0.15s;
}

.turn-alert-menu__gear:hover,
.turn-alert-menu__gear:focus-visible {
  border-color: var(--gold-accent);
  color: var(--gold-accent);
  outline: none;
}

.turn-alert-menu__popover {
  position: absolute;
  top: 36px;
  right: 0;
  width: 240px;
  background: var(--panel-bg);
  border: 1px solid var(--table-rim-light);
  border-radius: 6px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
}

.turn-alert-menu__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.turn-alert-menu__row-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.turn-alert-menu__label {
  font-family: var(--font-ui);
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-primary);
}

.turn-alert-menu__hint {
  font-family: var(--font-ui);
  font-size: 0.68rem;
  color: var(--text-muted);
  line-height: 1.3;
}

/* Toggle switch */
.turn-alert-menu__switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  flex-shrink: 0;
}

.turn-alert-menu__switch input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.turn-alert-menu__switch input:focus-visible + .turn-alert-menu__slider {
  outline: 2px solid var(--gold-accent);
  outline-offset: 2px;
}

.turn-alert-menu__slider {
  display: inline-block;
  width: 36px;
  height: 20px;
  border-radius: 10px;
  background: var(--text-muted);
  transition: background 0.15s;
  position: relative;
}

.turn-alert-menu__slider::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s;
}

.turn-alert-menu__switch input:checked + .turn-alert-menu__slider {
  background: var(--gold-accent);
}

.turn-alert-menu__switch input:checked + .turn-alert-menu__slider::after {
  transform: translateX(16px);
}

/* Notification controls */
.turn-alert-menu__notif-ctrl {
  flex-shrink: 0;
}

.turn-alert-menu__enable-btn {
  font-family: var(--font-ui);
  font-size: 0.75rem;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 4px;
  background: var(--gold-accent);
  color: #1a0f08;
  border: none;
  cursor: pointer;
  transition: opacity 0.15s;
}

.turn-alert-menu__enable-btn:hover {
  opacity: 0.85;
}

.turn-alert-menu__chip {
  font-family: var(--font-ui);
  font-size: 0.72rem;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 12px;
  display: inline-block;
}

.turn-alert-menu__chip--on {
  background: rgba(201, 168, 76, 0.2);
  color: var(--gold-accent);
  border: 1px solid var(--gold-accent);
}

.turn-alert-menu__chip--blocked {
  background: rgba(180, 60, 60, 0.15);
  color: #e07070;
  border: 1px solid #e07070;
}
</style>
