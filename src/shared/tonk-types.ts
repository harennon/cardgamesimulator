import type { Card, PlayerId } from "./engine-types.js";

/** Tonk-local card: a standard Card OR a Joker. Does NOT touch shared Card/Rank. */
export type TonkCard = Card | TonkJoker;

export interface TonkJoker {
  readonly joker: true;
  /** Stable id so two jokers in a 2-deck pool are distinct (e.g. 0..2*numDecks-1). */
  readonly id: number;
}

export function isJoker(c: TonkCard): c is TonkJoker {
  return (c as TonkJoker).joker === true;
}

export type TonkActionType = "discard" | "draw" | "callTonk";
export type TonkDrawSource = "stock" | "discard";
export type TonkTurnPhase = "discard" | "draw";

/** Public per-action log entry (no hidden info). */
export interface TonkLogEntry {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly type: TonkActionType;
  readonly discarded?: readonly TonkCard[]; // face-up, public
  readonly discardCount?: number;
  readonly drawSource?: TonkDrawSource; // public which source; drawn card NOT logged (hidden)
  readonly trickResult?: TonkTrickResult; // appended at trick end (all hands revealed)
}

/** Appended to the log when a trick ends (TONK or stock-out); hands are revealed here. */
export interface TonkTrickResult {
  readonly trickNumber: number;
  readonly reason: "tonk" | "stockout";
  readonly tonkCallerIndex: number | null;
  readonly revealedHands: readonly (readonly TonkCard[])[]; // by seat index
  readonly handValues: readonly number[]; // by seat index
  readonly tallyDeltas: readonly number[]; // points added this trick, by seat index
}

/** What getPlayerView/getSpectatorView expose for Tonk. Hidden info absent by construction. */
export interface TonkPublicState {
  readonly turnPhase: TonkTurnPhase;
  readonly trickNumber: number;
  readonly trickTurnCount: number;
  readonly tonkGateOpen: boolean; // trickTurnCount >= players.length
  readonly stockCount: number; // count ONLY — never the cards
  readonly discardTop: TonkCard | null; // live pile top (the current player's own once discarded)
  readonly discardCount: number;
  readonly lastDiscardCount: number;
  readonly lastDiscardPlayerIndex: number | null;
  readonly drawableDiscard: TonkCard | null; // turn-start snapshot (face-up, public)
  readonly tallies: readonly number[]; // running match score by seat (lower better)
  readonly log: readonly TonkLogEntry[];
}
