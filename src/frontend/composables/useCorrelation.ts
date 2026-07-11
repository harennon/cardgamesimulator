import { ref, readonly } from "vue";
import type { Ref, DeepReadonly } from "vue";
import { nanoid } from "nanoid";
import { setSentryTag, setSentryContext } from "@/observability/sentry";

export interface UseCorrelationReturn {
  /** Session-stable id, format `cx_<8-char nanoid>`. Never changes for the tab's lifetime. */
  correlationId: DeepReadonly<Ref<string>>;
  /** Current gameId, or undefined outside a game. */
  gameId: DeepReadonly<Ref<string | undefined>>;
  /** Bind the correlation context to a game (called on join). Rebinds, does not mint a new key. */
  bindGame(gameId: string): void;
  /** Clear the game binding (called on leave / unmount). */
  unbindGame(): void;
}

// Module-singleton state — minted once at module load, mirrors useFeedbackContext pattern.
const correlationId = ref<string>(`cx_${nanoid(8)}`);
const gameId = ref<string | undefined>(undefined);

export function useCorrelation(): UseCorrelationReturn {
  function bindGame(id: string): void {
    gameId.value = id;
    setSentryTag("correlation_id", correlationId.value);
    setSentryTag("game_id", id);
    setSentryContext("correlation", {
      correlationId: correlationId.value,
      gameId: id,
    });
  }

  function unbindGame(): void {
    gameId.value = undefined;
    setSentryTag("game_id", "");
    setSentryContext("correlation", {
      correlationId: correlationId.value,
      gameId: undefined,
    });
  }

  return {
    correlationId: readonly(correlationId),
    gameId: readonly(gameId),
    bindGame,
    unbindGame,
  };
}
