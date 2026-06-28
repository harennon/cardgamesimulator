import type { Card, PlayerId } from "./engine-types.js";

/**
 * Discriminated union of valid Big2 hand types.
 * The backend hand-types.ts re-exports this type — both must stay in sync.
 */
export type HandType =
  | { kind: "single"; card: Card }
  | { kind: "pair"; rank: string; highCard: Card }
  | { kind: "straight"; highCard: Card }
  | { kind: "fullHouse"; tripleRank: string; highCard: Card }
  | { kind: "fourOfAKind"; quadRank: string; highCard: Card }
  | { kind: "straightFlush"; highCard: Card };

/** Convenience union of the kind literals for display purposes. */
export type HandTypeKind = HandType["kind"];

export interface Big2Play {
  readonly cards: readonly Card[];
  readonly handType: HandType;
  readonly playerId: PlayerId;
}

export interface Big2HistoryEntry {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly action: "play" | "pass";
  readonly cards?: readonly Card[];
  readonly handType?: HandTypeKind;
}

export interface Big2PublicState {
  readonly lastPlay: Big2Play | null;
  readonly consecutivePasses: number;
  readonly isFreePlay: boolean;
  readonly isFirstPlayOfGame: boolean;
  readonly playHistory: readonly Big2HistoryEntry[];
  readonly finishedPlayerIndices: readonly number[];
  /** Index into playHistory where the current (in-progress) trick begins.
   *  currentTrick === playHistory.slice(trickStartIndex). Set by the engine
   *  at game start (0) and on every trick close. Append-only history means
   *  0 <= trickStartIndex <= playHistory.length. */
  readonly trickStartIndex: number;
}
