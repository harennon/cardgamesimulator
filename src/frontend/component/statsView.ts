import type { GameType, GameStatsEntry } from "@shared/model";

const GAME_TYPE_LABELS: Record<GameType, string> = {
  big2: "Big 2",
  tonk: "Tonk",
};

// "big2" -> "Big 2", "tonk" -> "Tonk". Unknown -> the raw value (forward-compatible).
export function gameTypeLabel(gameType: GameType): string {
  return GAME_TYPE_LABELS[gameType] ?? gameType;
}

// 0..1 fraction (server-authoritative winRate) -> integer-percent string, e.g. 0.732 -> "73%".
// Do not recompute from gamesWon/gamesPlayed — display what the server sent.
export function formatWinRate(winRate: number): string {
  return `${Math.round(winRate * 100)}%`;
}

export interface StatRow {
  readonly label: string;
  readonly value: string;
}

// Display rows for a single entry, in render order.
export function statRowsFor(entry: GameStatsEntry): StatRow[] {
  return [
    { label: "Win Rate", value: formatWinRate(entry.winRate) },
    { label: "Total Games", value: String(entry.gamesPlayed) },
    { label: "Total Score", value: String(entry.totalScore) },
    { label: "Won", value: String(entry.gamesWon) },
    { label: "Lost", value: String(entry.gamesLost) },
  ];
}

// Deterministic render order for multiple entries: alphabetical by gameType.
export function sortedEntries(
  games: readonly GameStatsEntry[],
): GameStatsEntry[] {
  return [...games].sort((a, b) => a.gameType.localeCompare(b.gameType));
}
