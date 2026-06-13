import type { Card, GameAction } from "@shared/engine-types";
import type { Big2Play, Big2HistoryEntry } from "@shared/big2-types";

export type { HandType } from "./hand-types.js";
export type {
  Big2Play,
  Big2HistoryEntry,
  Big2PublicState,
} from "@shared/big2-types";

/** The game-specific state stored in InternalGameState.gameSpecificState */
export interface Big2State {
  readonly hands: readonly (readonly Card[])[];
  readonly lastPlay: Big2Play | null;
  readonly lastPlayPlayerIndex: number | null;
  readonly consecutivePasses: number;
  readonly isFreePlay: boolean;
  readonly isFirstPlayOfGame: boolean;
  readonly playHistory: readonly Big2HistoryEntry[];
  readonly finishedPlayerIndices: readonly number[];
}

/** Big2-specific actions */
export interface Big2PlayCardsAction extends GameAction {
  readonly type: "playCards";
  readonly cards: readonly Card[];
}

export interface Big2PassAction extends GameAction {
  readonly type: "pass";
}

export type Big2Action = Big2PlayCardsAction | Big2PassAction;
