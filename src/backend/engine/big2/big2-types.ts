import type { Card, PlayerId, GameAction } from "@shared/engine-types";
import type { HandType } from "./hand-types.js";

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

/** A play that was made (cards + their detected hand type) */
export interface Big2Play {
  readonly cards: readonly Card[];
  readonly handType: HandType;
  readonly playerId: PlayerId;
}

/** Entry in the game history log (sent to all players and spectators) */
export interface Big2HistoryEntry {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly action: "play" | "pass";
  readonly cards?: readonly Card[];
  readonly handType?: HandType["kind"];
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

/** Public game state visible to all players and spectators */
export interface Big2PublicState {
  readonly lastPlay: Big2Play | null;
  readonly consecutivePasses: number;
  readonly isFreePlay: boolean;
  readonly isFirstPlayOfGame: boolean;
  readonly playHistory: readonly Big2HistoryEntry[];
  readonly finishedPlayerIndices: readonly number[];
}
