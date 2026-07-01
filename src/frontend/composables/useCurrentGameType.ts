import { ref, readonly } from "vue";
import type { Ref, DeepReadonly } from "vue";
import type { GameType } from "@shared/engine-types";

// Module-scoped singleton (same pattern as useFeedbackContext). Carries ONLY the
// gameType enum so the walkthrough shell can pick which content to show without
// ever touching live game state (LLD 111 decision 7). Defaults to "big2" when
// not in a game (home, stats, create-game before selection).
const currentGameType = ref<GameType>("big2");

export function useCurrentGameType(): {
  currentGameType: DeepReadonly<Ref<GameType>>;
  setCurrentGameType(t: GameType): void;
  resetCurrentGameType(): void;
} {
  return {
    currentGameType: readonly(currentGameType),
    setCurrentGameType: (t) => {
      currentGameType.value = t;
    },
    resetCurrentGameType: () => {
      currentGameType.value = "big2";
    },
  };
}
