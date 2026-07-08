import { ref } from "vue";
import type { Ref } from "vue";
import type { Card } from "@shared/engine-types";
import type { TonkCard, TonkDrawSource } from "@shared/tonk-types";
import type {
  GameStartResponse,
  GameActionResponse,
  GameRematchResponse,
} from "@shared/socket-events";
import type { TypedClientSocket } from "./useSocket";

interface UseGameActionsReturn {
  startGame(gameId: string): Promise<{ success: boolean; error?: string }>;
  rematch(gameId: string): Promise<{
    success: boolean;
    newGameId?: string;
    error?: string;
  }>;
  playCards(
    gameId: string,
    cards: readonly Card[],
  ): Promise<{ success: boolean; error?: string }>;
  pass(gameId: string): Promise<{ success: boolean; error?: string }>;
  discard(
    gameId: string,
    cards: readonly TonkCard[],
  ): Promise<{ success: boolean; error?: string }>;
  drawCard(
    gameId: string,
    source: TonkDrawSource,
  ): Promise<{ success: boolean; error?: string }>;
  callTonk(gameId: string): Promise<{ success: boolean; error?: string }>;
  actionError: Ref<string | null>;
  actionPending: Ref<boolean>;
  bind(socket: TypedClientSocket): void;
  unbind(): void;
}

const ACTION_ACK_TIMEOUT_MS = 8000;
const TIMEOUT_ERROR_MSG = "Couldn't reach the server — reconnecting…";

/**
 * Wraps a socket emit in a race against an 8s timeout.
 * The emitFn receives a resolver; call it with the ack response.
 * On timeout, onTimeout() supplies the fallback response.
 * A late-arriving ack after the timeout fires is silently ignored (E6).
 */
function emitWithTimeout<R extends { success: boolean; error?: string }>(
  emitFn: (resolve: (r: R) => void) => void,
  onTimeout: () => R,
): Promise<R> {
  return new Promise<R>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeout());
    }, ACTION_ACK_TIMEOUT_MS);
    emitFn((r) => {
      if (settled) return; // ack arrived after timeout → ignore (E6)
      settled = true;
      clearTimeout(timer);
      resolve(r);
    });
  });
}

function timeoutResult<R extends { success: boolean; error?: string }>(
  extra?: Partial<R>,
): R {
  return { success: false, error: TIMEOUT_ERROR_MSG, ...extra } as R;
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
      const result = await emitWithTimeout<GameStartResponse>(
        (resolve) => {
          socket.emit("game:start", { gameId }, (response: GameStartResponse) =>
            resolve(response),
          );
        },
        () => timeoutResult<GameStartResponse>(),
      );
      if (!result.success) {
        actionError.value = result.error ?? "Failed to start game";
      }
      return result;
    } finally {
      actionPending.value = false;
    }
  }

  async function rematch(
    gameId: string,
  ): Promise<{ success: boolean; newGameId?: string; error?: string }> {
    const socket = requireSocket();
    actionError.value = null;
    actionPending.value = true;
    try {
      const result = await emitWithTimeout<GameRematchResponse>(
        (resolve) => {
          socket.emit(
            "game:rematch",
            { gameId },
            (response: GameRematchResponse) => resolve(response),
          );
        },
        () => timeoutResult<GameRematchResponse>(),
      );
      if (!result.success) {
        actionError.value = result.error ?? "Failed to start rematch";
      }
      return result;
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
      const result = await emitWithTimeout<GameActionResponse>(
        (resolve) => {
          socket.emit(
            "game:action",
            {
              gameId,
              action: { type: "playCards", cards: [...cards], playerId: "" },
            },
            (response: GameActionResponse) => resolve(response),
          );
        },
        () => timeoutResult<GameActionResponse>(),
      );
      if (!result.success) {
        actionError.value = result.error ?? "Invalid play";
      }
      return result;
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
      const result = await emitWithTimeout<GameActionResponse>(
        (resolve) => {
          socket.emit(
            "game:action",
            { gameId, action: { type: "pass", playerId: "" } },
            (response: GameActionResponse) => resolve(response),
          );
        },
        () => timeoutResult<GameActionResponse>(),
      );
      if (!result.success) {
        actionError.value = result.error ?? "Cannot pass";
      }
      return result;
    } finally {
      actionPending.value = false;
    }
  }

  async function discard(
    gameId: string,
    cards: readonly TonkCard[],
  ): Promise<{ success: boolean; error?: string }> {
    const socket = requireSocket();
    actionError.value = null;
    actionPending.value = true;
    try {
      const result = await emitWithTimeout<GameActionResponse>(
        (resolve) => {
          socket.emit(
            "game:action",
            {
              gameId,
              action: { type: "discard", cards: [...cards], playerId: "" },
            },
            (response: GameActionResponse) => resolve(response),
          );
        },
        () => timeoutResult<GameActionResponse>(),
      );
      if (!result.success) {
        actionError.value = result.error ?? "Invalid discard";
      }
      return result;
    } finally {
      actionPending.value = false;
    }
  }

  async function drawCard(
    gameId: string,
    source: TonkDrawSource,
  ): Promise<{ success: boolean; error?: string }> {
    const socket = requireSocket();
    actionError.value = null;
    actionPending.value = true;
    try {
      const result = await emitWithTimeout<GameActionResponse>(
        (resolve) => {
          socket.emit(
            "game:action",
            { gameId, action: { type: "draw", source, playerId: "" } },
            (response: GameActionResponse) => resolve(response),
          );
        },
        () => timeoutResult<GameActionResponse>(),
      );
      if (!result.success) {
        actionError.value = result.error ?? "Cannot draw";
      }
      return result;
    } finally {
      actionPending.value = false;
    }
  }

  async function callTonk(
    gameId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const socket = requireSocket();
    actionError.value = null;
    actionPending.value = true;
    try {
      const result = await emitWithTimeout<GameActionResponse>(
        (resolve) => {
          socket.emit(
            "game:action",
            { gameId, action: { type: "callTonk", playerId: "" } },
            (response: GameActionResponse) => resolve(response),
          );
        },
        () => timeoutResult<GameActionResponse>(),
      );
      if (!result.success) {
        actionError.value = result.error ?? "Cannot call TONK";
      }
      return result;
    } finally {
      actionPending.value = false;
    }
  }

  return {
    startGame,
    rematch,
    playCards,
    pass,
    discard,
    drawCard,
    callTonk,
    actionError,
    actionPending,
    bind,
    unbind,
  };
}
