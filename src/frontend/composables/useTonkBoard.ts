import { computed } from "vue";
import type { Ref, ComputedRef } from "vue";
import type { EnrichedPlayerView } from "@shared/socket-events";
import type { TonkCard, TonkPublicState } from "@shared/tonk-types";

/**
 * Pure, read-only derivations for the Tonk board. All values come straight from
 * the server-provided view — no game rules, no legality, no scoring are computed
 * here (architecture-principles #1). Factored into a composable so the component
 * and its tests share one source of truth (project test pattern: assert the real
 * derivation logic, never a copy).
 */
export interface UseTonkBoardReturn {
  tonkState: ComputedRef<TonkPublicState | null>;
  myHand: ComputedRef<readonly TonkCard[]>;
  myPlayerIndex: ComputedRef<number>;
  isSpectator: ComputedRef<boolean>;
  isMyTurn: ComputedRef<boolean>;
  currentName: ComputedRef<string>;
  phaseLabel: ComputedRef<string>;
  turnBanner: ComputedRef<string>;
  trickNumber: ComputedRef<number>;
  stockCount: ComputedRef<number>;
  discardTop: ComputedRef<TonkCard | null>;
  discardCount: ComputedRef<number>;
  drawableDiscard: ComputedRef<TonkCard | null>;
  hasDrawable: ComputedRef<boolean>;
  tallyForSeat: (seatIndex: number) => number;
  isCompactSeating: ComputedRef<boolean>;
}

export const COMPACT_SEAT_THRESHOLD = 6;

export function useTonkBoard(
  gameState: Ref<EnrichedPlayerView>,
): UseTonkBoardReturn {
  const tonkState = computed<TonkPublicState | null>(() =>
    gameState.value.gameType === "tonk" &&
    gameState.value.gameSpecificPublicState
      ? (gameState.value.gameSpecificPublicState as TonkPublicState)
      : null,
  );

  const myPlayerIndex = computed<number>(() => {
    const me = gameState.value.you?.playerId;
    if (!me) return -1;
    return gameState.value.players.findIndex((p) => p.playerId === me);
  });

  const isSpectator = computed<boolean>(() => myPlayerIndex.value === -1);

  const myHand = computed<readonly TonkCard[]>(() =>
    isSpectator.value
      ? []
      : ((gameState.value.you?.hand ?? []) as readonly TonkCard[]),
  );

  const isMyTurn = computed<boolean>(
    () =>
      myPlayerIndex.value !== -1 &&
      myPlayerIndex.value === gameState.value.currentPlayerIndex,
  );

  const currentName = computed<string>(
    () =>
      gameState.value.players[gameState.value.currentPlayerIndex]
        ?.displayName ?? "",
  );

  const phaseLabel = computed<string>(() => {
    const phase = tonkState.value?.turnPhase;
    if (phase === "discard") return "discard phase";
    if (phase === "draw") return "draw phase";
    return "";
  });

  const turnBanner = computed<string>(() => {
    if (!tonkState.value) return "";
    const who = isMyTurn.value ? "Your" : `${currentName.value}'s`;
    return phaseLabel.value
      ? `${who} turn — ${phaseLabel.value}`
      : `${who} turn`;
  });

  const trickNumber = computed<number>(() => tonkState.value?.trickNumber ?? 0);
  const stockCount = computed<number>(() => tonkState.value?.stockCount ?? 0);
  const discardTop = computed<TonkCard | null>(
    () => tonkState.value?.discardTop ?? null,
  );
  const discardCount = computed<number>(
    () => tonkState.value?.discardCount ?? 0,
  );
  const drawableDiscard = computed<TonkCard | null>(
    () => tonkState.value?.drawableDiscard ?? null,
  );
  const hasDrawable = computed<boolean>(() => drawableDiscard.value !== null);

  function tallyForSeat(seatIndex: number): number {
    return tonkState.value?.tallies[seatIndex] ?? 0;
  }

  const isCompactSeating = computed<boolean>(
    () => gameState.value.players.length >= COMPACT_SEAT_THRESHOLD,
  );

  return {
    tonkState,
    myHand,
    myPlayerIndex,
    isSpectator,
    isMyTurn,
    currentName,
    phaseLabel,
    turnBanner,
    trickNumber,
    stockCount,
    discardTop,
    discardCount,
    drawableDiscard,
    hasDrawable,
    tallyForSeat,
    isCompactSeating,
  };
}
