import type { GameAction } from "@shared/engine-types";
import type {
  TonkCard,
  TonkDrawSource,
  TonkTurnPhase,
  TonkLogEntry,
} from "@shared/tonk-types.js";

export type * from "@shared/tonk-types.js"; // re-export public shapes (Big2 pattern)

/** Full server-only Tonk state in InternalGameState.gameSpecificState. */
export interface TonkState {
  readonly hands: readonly (readonly TonkCard[])[]; // HIDDEN per-player
  readonly stock: readonly TonkCard[]; // HIDDEN (count only public)
  readonly discardPile: readonly TonkCard[]; // PUBLIC, top = most recent
  readonly drawableDiscard: TonkCard | null; // PUBLIC turn-start snapshot (§3.3)
  readonly lastDiscardCount: number;
  readonly lastDiscardPlayerIndex: number | null;
  readonly turnPhase: TonkTurnPhase;
  readonly trickNumber: number; // 1-based
  readonly trickTurnCount: number; // turns taken this trick; TONK gate = >= players.length
  readonly tallies: readonly number[];
  readonly tonkCallerIndex: number | null;
  readonly lostPlayerIndices: readonly number[]; // tally >= 150 at match end
  readonly trueLoserIndex: number | null;
  readonly trickDeckSize: number; // size of THIS trick's dealt+stock deck (card-conservation)
  readonly log: readonly TonkLogEntry[];
}

export interface TonkDiscardAction extends GameAction {
  readonly type: "discard";
  readonly cards: readonly TonkCard[]; // >=1, all same rank (jokers group only with jokers)
}

export interface TonkDrawAction extends GameAction {
  readonly type: "draw";
  readonly source: TonkDrawSource; // "stock" | "discard"
}

export interface TonkCallTonkAction extends GameAction {
  readonly type: "callTonk";
}

export type TonkAction =
  | TonkDiscardAction
  | TonkDrawAction
  | TonkCallTonkAction;
