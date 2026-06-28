import type { TonkCard, TonkTurnPhase, TonkLogEntry } from "@shared/tonk-types";
import type { GameAction } from "@shared/engine-types";

export type {
  TonkCard,
  TonkJoker,
  TonkTurnPhase,
  TonkDrawSource,
  TonkLogEntry,
  TonkPublicState,
} from "@shared/tonk-types";

/** Full server-side Tonk state. Stored in InternalGameState.gameSpecificState. */
export interface TonkState {
  readonly hands: readonly (readonly TonkCard[])[]; // HIDDEN per-player
  readonly stock: readonly TonkCard[]; // HIDDEN (count only public)
  readonly discardPile: readonly TonkCard[]; // PUBLIC (top = most recent)
  readonly drawableDiscard: TonkCard | null; // PUBLIC turn-start snapshot (§3.3)
  readonly lastDiscardCount: number;
  readonly lastDiscardPlayerIndex: number | null;
  readonly turnPhase: TonkTurnPhase;
  readonly trickNumber: number; // 1-based
  readonly trickTurnCount: number; // turns taken this trick (TONK gate = >= players.length)
  readonly trickDeckSize: number; // cards in play this trick (for card-conservation invariant)
  readonly tallies: readonly number[]; // running match score per seat (lower better)
  readonly deckRoundsTarget: number; // resolved & clamped at initialize (5..12)
  readonly numDecks: number; // ceil(players/5) + extraDecks
  readonly tonkCallerIndex: number | null;
  readonly lostPlayerIndices: readonly number[]; // tally >=150 at match end
  readonly trueLoserIndex: number | null;
  readonly log: readonly TonkLogEntry[];
}

// Internal action union — the engine narrows GameAction to this in applyAction.
export type {
  TonkDiscardAction,
  TonkDrawAction,
  TonkCallTonkAction,
  TonkActionPayload,
} from "@shared/tonk-types";
export type TonkAction = import("@shared/tonk-types").TonkActionPayload &
  GameAction;
