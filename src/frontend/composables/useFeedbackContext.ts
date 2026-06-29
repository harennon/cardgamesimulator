import { ref, readonly } from "vue";
import type { Ref, DeepReadonly } from "vue";

export type FeedbackGamePhase = "lobby" | "in-progress" | "game-over";

const gamePhase = ref<FeedbackGamePhase | undefined>(undefined);

export function useFeedbackContext(): {
  gamePhase: DeepReadonly<Ref<FeedbackGamePhase | undefined>>;
  setGamePhase(phase: FeedbackGamePhase | undefined): void;
  clearGamePhase(): void;
} {
  return {
    gamePhase: readonly(gamePhase),
    setGamePhase: (phase) => {
      gamePhase.value = phase;
    },
    clearGamePhase: () => {
      gamePhase.value = undefined;
    },
  };
}
