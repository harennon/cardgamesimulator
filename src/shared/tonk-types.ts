import type { Card, PlayerId } from "./engine-types.js";

/** A joker — value 0, and the TRUE-LOSER token. Tonk-local; shared Card/Rank untouched. */
export interface TonkJoker {
  readonly joker: true;
  readonly id: number; // 0..(2*numDecks-1), stable identity within a trick's deck
}

/** A Tonk card is a standard Card or a joker. */
export type TonkCard = Card | TonkJoker;

export function isJoker(c: TonkCard): c is TonkJoker {
  return (c as TonkJoker).joker === true;
}

export type TonkTurnPhase = "discard" | "draw";
export type TonkDrawSource = "stock" | "discard";

export interface TonkLogEntry {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly kind: "discard" | "draw" | "callTonk" | "trickResult";
  readonly cards?: readonly TonkCard[]; // discard: cards placed
  readonly drawSource?: TonkDrawSource; // draw: where from (not WHICH card — hidden)
  readonly trickNumber?: number;
  readonly deltas?: readonly number[]; // trickResult: per-seat tally delta this trick
  readonly revealedHands?: readonly (readonly TonkCard[])[]; // trickResult: all hands at trick end
}

/** gameSpecificPublicState in PlayerView/SpectatorView. No hands, no stock contents. */
export interface TonkPublicState {
  readonly discardTop: TonkCard | null; // live pile top (visual)
  readonly discardCount: number;
  readonly lastDiscardCount: number;
  readonly lastDiscardPlayerIndex: number | null;
  readonly drawableDiscard: TonkCard | null; // turn-start snapshot (face-up, public)
  readonly stockCount: number; // COUNT ONLY — never the cards
  readonly opponentHandCounts: readonly number[]; // by seat (your own seat included as count too)
  readonly turnPhase: TonkTurnPhase;
  readonly trickNumber: number;
  readonly trickTurnCount: number;
  readonly tonkGateOpen: boolean;
  readonly tallies: readonly number[];
  readonly tonkCallerIndex: number | null;
  readonly trueLoserIndex: number | null; // null until COMPLETED
  readonly log: readonly TonkLogEntry[];
}

export interface TonkDiscardAction {
  readonly type: "discard";
  readonly playerId: PlayerId;
  readonly cards: readonly TonkCard[]; // 1+ cards, all same rank (jokers group only with jokers)
}
export interface TonkDrawAction {
  readonly type: "draw";
  readonly playerId: PlayerId;
  readonly source: TonkDrawSource;
}
export interface TonkCallTonkAction {
  readonly type: "callTonk";
  readonly playerId: PlayerId;
}
export type TonkActionPayload =
  | TonkDiscardAction
  | TonkDrawAction
  | TonkCallTonkAction;
