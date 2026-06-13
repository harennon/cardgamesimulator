import { ref } from "vue";
import type { Ref } from "vue";
import type { Card } from "@shared/engine-types";
import type {
  GameStartResponse,
  GameActionResponse,
} from "@shared/socket-events";
import type { TypedClientSocket } from "./useSocket";

interface UseGameActionsReturn {
  startGame(gameId: string): Promise<{ success: boolean; error?: string }>;
  playCards(
    gameId: string,
    cards: readonly Card[],
  ): Promise<{ success: boolean; error?: string }>;
  pass(gameId: string): Promise<{ success: boolean; error?: string }>;
  actionError: Ref<string | null>;
  actionPending: Ref<boolean>;
  bind(socket: TypedClientSocket): void;
  unbind(): void;
}

export function useGameActions(): UseGameActionsReturn {
  const actionError = ref<string | null>(null);
  const actionPending = ref(false);

  let boundSocket: TypedClientSocket | null = null;

  function bind(socket: TypedClientSocket): void {
    boundSocket = socket;
  }

  function unbind(): void {
    boundSocket = null;
  }

  function requireSocket(): TypedClientSocket {
    if (!boundSocket)
      throw new Error(
        "useGameActions: bind() must be called before emitting actions",
      );
    return boundSocket;
  }

  async function startGame(
    gameId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const socket = requireSocket();
    actionError.value = null;
    actionPending.value = true;
    try {
      return await new Promise((resolve) => {
        socket.emit("game:start", { gameId }, (response: GameStartResponse) => {
          if (!response.success) {
            actionError.value = response.error ?? "Failed to start game";
          }
          resolve(response);
        });
      });
    } finally {
      actionPending.value = false;
    }
  }

  async function playCards(
    gameId: string,
    cards: readonly Card[],
  ): Promise<{ success: boolean; error?: string }> {
    const socket = requireSocket();
    actionError.value = null;
    actionPending.value = true;
    try {
      return await new Promise((resolve) => {
        socket.emit(
          "game:action",
          {
            gameId,
            action: { type: "playCards", cards: [...cards], playerId: "" },
          },
          (response: GameActionResponse) => {
            if (!response.success) {
              actionError.value = response.error ?? "Invalid play";
            }
            resolve(response);
          },
        );
      });
    } finally {
      actionPending.value = false;
    }
  }

  async function pass(
    gameId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const socket = requireSocket();
    actionError.value = null;
    actionPending.value = true;
    try {
      return await new Promise((resolve) => {
        socket.emit(
          "game:action",
          { gameId, action: { type: "pass", playerId: "" } },
          (response: GameActionResponse) => {
            if (!response.success) {
              actionError.value = response.error ?? "Cannot pass";
            }
            resolve(response);
          },
        );
      });
    } finally {
      actionPending.value = false;
    }
  }

  return {
    startGame,
    playCards,
    pass,
    actionError,
    actionPending,
    bind,
    unbind,
  };
}
