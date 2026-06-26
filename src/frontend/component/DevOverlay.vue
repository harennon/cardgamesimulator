<template>
  <Teleport to="body">
    <div
      v-if="enabled"
      class="dev-overlay"
      :class="{ 'dev-overlay--collapsed': collapsed }"
    >
      <div class="dev-overlay__header" @click="collapsed = !collapsed">
        <span>DBG</span>
        <span class="dev-overlay__toggle">{{ collapsed ? "+" : "-" }}</span>
      </div>
      <div v-if="!collapsed" class="dev-overlay__body">
        <div class="dev-overlay__section">
          <div class="dev-overlay__label">Selection</div>
          <div class="dev-overlay__value">{{ selectionDisplay }}</div>
        </div>
        <div class="dev-overlay__section">
          <div class="dev-overlay__label">Events (last {{ maxEvents }})</div>
          <div class="dev-overlay__events">
            <div
              v-for="(evt, i) in events"
              :key="i"
              class="dev-overlay__event"
              :class="`dev-overlay__event--${evt.type}`"
            >
              <span class="dev-overlay__event-time">{{ evt.time }}</span>
              <span class="dev-overlay__event-msg">{{ evt.msg }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script lang="ts" setup>
import { ref, watch, computed, onMounted } from "vue";

const props = defineProps<{
  selectedIndices: Set<number>;
  isMyTurn: boolean;
}>();

const enabled = ref(false);
const collapsed = ref(false);
const maxEvents = 20;

interface DebugEvent {
  type: "touch" | "state" | "info";
  time: string;
  msg: string;
}

const events = ref<DebugEvent[]>([]);

onMounted(() => {
  const params = new URLSearchParams(window.location.search);
  enabled.value = params.has("debug");
});

function timestamp(): string {
  const d = new Date();
  return `${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}.${d.getMilliseconds().toString().padStart(3, "0")}`;
}

function pushEvent(type: DebugEvent["type"], msg: string) {
  events.value = [{ type, time: timestamp(), msg }, ...events.value].slice(
    0,
    maxEvents,
  );
}

const selectionDisplay = computed(() => {
  const indices = [...props.selectedIndices].sort((a, b) => a - b);
  return indices.length === 0 ? "(none)" : indices.join(", ");
});

watch(
  () => props.selectedIndices,
  (next, prev) => {
    const added = [...next].filter((i) => !prev?.has(i));
    const removed = prev ? [...prev].filter((i) => !next.has(i)) : [];
    if (added.length)
      pushEvent(
        "state",
        `+[${added.join(",")}] → {${[...next].sort((a, b) => a - b).join(",")}}`,
      );
    if (removed.length)
      pushEvent(
        "state",
        `-[${removed.join(",")}] → {${[...next].sort((a, b) => a - b).join(",")}}`,
      );
  },
);

watch(
  () => props.isMyTurn,
  (val) => pushEvent("info", val ? "Your turn" : "Not your turn"),
);

// Expose a global for touch-event instrumentation from PlayerHand
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__devOverlayPush = pushEvent;
}

defineExpose({ pushEvent });
</script>

<style>
.dev-overlay {
  position: fixed;
  bottom: 70px;
  left: 4px;
  z-index: 9999;
  width: 220px;
  max-height: 50vh;
  background: rgba(0, 0, 0, 0.88);
  border: 1px solid #444;
  border-radius: 6px;
  font-family: monospace;
  font-size: 10px;
  color: #eee;
  overflow: hidden;
  pointer-events: auto;
  touch-action: auto;
}

.dev-overlay--collapsed {
  width: auto;
  max-height: none;
}

.dev-overlay__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 8px;
  background: #222;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.dev-overlay__toggle {
  font-size: 14px;
  line-height: 1;
}

.dev-overlay__body {
  padding: 4px 8px 8px;
  overflow-y: auto;
  max-height: calc(50vh - 28px);
}

.dev-overlay__section {
  margin-bottom: 6px;
}

.dev-overlay__label {
  color: #888;
  margin-bottom: 2px;
}

.dev-overlay__value {
  color: #7df;
  word-break: break-all;
}

.dev-overlay__events {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.dev-overlay__event {
  display: flex;
  gap: 6px;
}

.dev-overlay__event-time {
  color: #666;
  flex-shrink: 0;
}

.dev-overlay__event--touch .dev-overlay__event-msg {
  color: #f9a;
}

.dev-overlay__event--state .dev-overlay__event-msg {
  color: #9f9;
}

.dev-overlay__event--info .dev-overlay__event-msg {
  color: #ff9;
}
</style>
