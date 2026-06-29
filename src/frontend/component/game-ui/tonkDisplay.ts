// Pure display-derivation helpers shared by the Tonk board components and their
// tests. No rule computation — every value is a presentational transformation of
// public server state (LLD 88 §State Model / decision 6).

import type { PlayerPublicInfo } from "@shared/engine-types";
import type {
  TonkCard,
  TonkDrawSource,
  TonkLogEntry,
  TonkTurnPhase,
} from "@shared/tonk-types";
import { isJoker } from "@shared/tonk-types";

/** Display constant: match ends when a tally reaches this (LLD 65 §5.2). */
export const LOSS_LINE = 150;
/** Tally at/above this gets the "near-150" warning styling (display threshold). */
export const NEAR_LINE_THRESHOLD = 120;

/** Phase chip label shown in the banner and (abbreviated) on the active seat. */
export function phaseLabel(phase: TonkTurnPhase): string {
  return phase === "discard" ? "discard phase" : "draw phase";
}

/** Short phase tag repeated next to the active seat name. */
export function phaseTag(phase: TonkTurnPhase): string {
  return phase === "discard" ? "disc." : "draw";
}

/** CSS modifier selecting the phase color token. */
export function phaseClass(phase: TonkTurnPhase): string {
  return phase === "discard" ? "tonk-phase--discard" : "tonk-phase--draw";
}

/** Turn-owner label: "Your turn" for the local player, else "<name>'s turn". */
export function turnLabel(
  currentPlayerName: string,
  isMyTurn: boolean,
): string {
  return isMyTurn ? "Your turn" : `${currentPlayerName}'s turn`;
}

/** Trick-number label; abbreviated on mobile (LLD 88 §Mobile). */
export function trickLabel(trickNumber: number, mobile = false): string {
  return mobile ? `T${trickNumber}` : `TRICK ${trickNumber}`;
}

/** Progress (0..1) of a tally toward the loss line, for the gauge bar. */
export function lossLineProgress(tally: number): number {
  return Math.min(tally / LOSS_LINE, 1);
}

/** Whether a tally is near/at the loss line (warning styling). */
export function isNearLine(tally: number): boolean {
  return tally >= NEAR_LINE_THRESHOLD;
}

/**
 * Name of who just played the live discard top, or "" when none (E2 — trick-1
 * empty pile). Index out of range falls back to "".
 */
export function justPlayedName(
  players: readonly PlayerPublicInfo[],
  lastDiscardPlayerIndex: number | null,
): string {
  if (lastDiscardPlayerIndex === null) return "";
  return players[lastDiscardPlayerIndex]?.displayName ?? "";
}

/**
 * Name of the player the drawable discard came from (the player preceding the
 * one who just played), or "" when not derivable (LLD 88 §A1). Returns "" when
 * there is no discard owner or only one player.
 */
export function drawableFromName(
  players: readonly PlayerPublicInfo[],
  lastDiscardPlayerIndex: number | null,
): string {
  if (lastDiscardPlayerIndex === null || players.length === 0) return "";
  const precedingIndex =
    (lastDiscardPlayerIndex - 1 + players.length) % players.length;
  if (precedingIndex === lastDiscardPlayerIndex) return "";
  return players[precedingIndex]?.displayName ?? "";
}

/** Compact seats (drop the card-back fan) at 6+ players (LLD 88 §Seats). */
export function isCompactRail(playerCount: number): boolean {
  return playerCount >= 6;
}

/** Rail wraps to two rows at 7+ players (LLD 88 §Seats). */
export function isWrappingRail(playerCount: number): boolean {
  return playerCount >= 7;
}

export interface SeatRow {
  readonly playerId: string;
  readonly displayName: string;
  readonly cardCount: number;
  readonly isConnected: boolean;
  readonly seatIndex: number;
  readonly tally: number;
}

/**
 * Seats rendered by the rail: every player except myPlayerIndex (or all when
 * myPlayerIndex === -1, the spectator-style contract — E11). Each carries its
 * seat index and tally for the chip.
 */
export function railSeats(
  players: readonly PlayerPublicInfo[],
  tallies: readonly number[],
  myPlayerIndex: number,
): SeatRow[] {
  return players
    .map((p, seatIndex) => ({
      playerId: p.playerId,
      displayName: p.displayName,
      cardCount: p.cardCount,
      isConnected: p.isConnected,
      seatIndex,
      tally: tallies[seatIndex] ?? 0,
    }))
    .filter((s) => s.seatIndex !== myPlayerIndex);
}

const SUIT_SYMBOLS: Record<string, string> = {
  clubs: "♣",
  diamonds: "♦",
  hearts: "♥",
  spades: "♠",
};

/** Text label for a single public card (joker → star glyph, never "Joker"). */
export function cardLabel(card: TonkCard): string {
  return isJoker(card) ? "★" : `${card.rank}${SUIT_SYMBOLS[card.suit] ?? ""}`;
}

/** "from stock" / "from discard" label for a draw entry (the source is public). */
export function drawSourceLabel(source: TonkDrawSource): string {
  return source === "stock" ? "from stock" : "from discard";
}

/**
 * The primary action text for a log entry. For draws this is ONLY the source —
 * the drawn card is hidden and never logged (LLD 88 §TonkLog / tonk-types).
 */
export function logActionText(entry: TonkLogEntry): string {
  if (entry.type === "discard") {
    const count = entry.discardCount ?? entry.discarded?.length ?? 0;
    const cards = (entry.discarded ?? []).map(cardLabel).join(" ");
    const suffix = cards ? ` (${cards})` : "";
    return `discarded ${count}${suffix}`;
  }
  if (entry.type === "draw") {
    return `drew ${drawSourceLabel(entry.drawSource ?? "stock")}`;
  }
  return "called TONK";
}

/** One-line trick-end summary (reason + per-seat values/deltas). */
export function trickResultSummary(
  entry: TonkLogEntry,
  players: readonly PlayerPublicInfo[],
): string | null {
  const r = entry.trickResult;
  if (!r) return null;
  const reason = r.reason === "tonk" ? "TONK called" : "stock ran out";
  const parts = r.handValues.map((value, seatIndex) => {
    const name = players[seatIndex]?.displayName ?? `Seat ${seatIndex + 1}`;
    const delta = r.tallyDeltas[seatIndex] ?? 0;
    return `${name}: ${value} (+${delta})`;
  });
  return `Trick ${r.trickNumber} ended — ${reason}. ${parts.join(", ")}`;
}

export interface RankedTallyRow {
  readonly seatIndex: number;
  readonly tally: number;
}

/**
 * Stable ranking for the tally panel: ascending tally (lower is better), ties
 * broken by ascending seat index (E12 — purely presentational order).
 */
export function rankedTallies(tallies: readonly number[]): RankedTallyRow[] {
  return tallies
    .map((tally, seatIndex) => ({ tally, seatIndex }))
    .sort((a, b) => a.tally - b.tally || a.seatIndex - b.seatIndex);
}
