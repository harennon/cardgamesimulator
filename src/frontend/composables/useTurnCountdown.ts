import { ref, computed, watch, onScopeDispose } from "vue";
import type { Ref } from "vue";

export type Urgency = "calm" | "warning" | "critical";

export interface UseTurnCountdownReturn {
  /** Seconds remaining (integer, >= 0). Updates every 1s. */
  remainingSeconds: Ref<number>;
  /** Fraction remaining [0..1]. 1 = full time, 0 = expired. */
  fraction: Ref<number>;
  /** Urgency level based on remaining time. */
  urgency: Ref<Urgency>;
}

/**
 * Reactive countdown from an absolute deadline.
 *
 * @param turnDeadline - Epoch ms of when the turn expires. null = no timer (all refs go to 0/calm).
 * @param totalSeconds - Total configured timer duration in seconds. Used to compute fraction.
 */
export function useTurnCountdown(
  turnDeadline: Ref<number | null>,
  totalSeconds: Ref<number>,
): UseTurnCountdownReturn {
  function computeRemaining(): number {
    if (turnDeadline.value === null) return 0;
    return Math.max(0, Math.ceil((turnDeadline.value - Date.now()) / 1000));
  }

  const remainingSeconds = ref(computeRemaining());

  const fraction = computed<number>(() => {
    const total = totalSeconds.value;
    if (total <= 0) return 0;
    return Math.min(1, remainingSeconds.value / total);
  });

  const urgency = computed<Urgency>(() => {
    if (turnDeadline.value === null) return "calm";
    const r = remainingSeconds.value;
    if (r <= 5) return "critical";
    if (r <= 10) return "warning";
    return "calm";
  });

  const intervalId = setInterval(() => {
    remainingSeconds.value = computeRemaining();
  }, 1000);

  watch(
    turnDeadline,
    () => {
      remainingSeconds.value = computeRemaining();
    },
    { immediate: false },
  );

  onScopeDispose(() => {
    clearInterval(intervalId);
  });

  return { remainingSeconds, fraction, urgency };
}
