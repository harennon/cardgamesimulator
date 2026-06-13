import { shallowRef, ref, readonly } from "vue";
import type { ShallowRef, Ref, DeepReadonly } from "vue";
import type { PlayerView, GameStatus } from "@shared/engine-types";
import type { TypedClientSocket } from "./useSocket";

interface UseGameStateReturn {
  gameState: DeepReadonly<ShallowRef<PlayerView | null>>;
  status: Ref<GameStatus | null>;
  initialized: Ref<boolean>;
  bind(socket: TypedClientSocket): void;
  unbind(): void;
}

export function useGameState(): UseGameStateReturn {
  const gameState = shallowRef<PlayerView | null>(null);
  const status = ref<GameStatus | null>(null);
  const initialized = ref(false);

  let boundSocket: TypedClientSocket | null = null;

  function onGameState(view: PlayerView): void {
    gameState.value = view;
    status.value = view.status;
    initialized.value = true;
  }

  function bind(socket: TypedClientSocket): void {
    boundSocket = socket;
    socket.on("game:state", onGameState);
  }

  function unbind(): void {
    boundSocket?.off("game:state", onGameState);
    boundSocket = null;
  }

  return {
    gameState: readonly(gameState),
    status,
    initialized,
    bind,
    unbind,
  };
}
