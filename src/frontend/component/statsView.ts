import type { GameType, GameStatsEntry, StatsWindow } from "@shared/model";

const GAME_TYPE_LABELS: Record<GameType, string> = {
  big2: "Big 2",
  tonk: "Tonk",
};

// The three time-range tabs, in render order (drives the segmented selector and
// the swipe/arrow ordering). Lifetime is first so index 0 is the default.
export interface WindowTab {
  readonly window: StatsWindow;
  readonly label: string;
}

export const WINDOW_TABS: readonly WindowTab[] = [
  { window: "lifetime", label: "Lifetime" },
  { window: "30d", label: "Last 30 days" },
  { window: "ytd", label: "Year to date" },
];

// The empty-list branch is disambiguated by the SELECTED window, not by history
// presence (LLD 116 A3): on lifetime an empty list means the user has never
// finished a game; on a window it means no games fell in range.
export function isNeverPlayed(
  window: StatsWindow,
  gamesLength: number,
): boolean {
  return window === "lifetime" && gamesLength === 0;
}

export function isEmptyWindow(
  window: StatsWindow,
  gamesLength: number,
): boolean {
  return window !== "lifetime" && gamesLength === 0;
}

// The "Tracking since" note is shown iff a non-lifetime window is selected AND
// the backend returned a non-null trackingSince (LLD 116 A4 / E1). Lifetime
// never shows it (the backend returns null there anyway).
export function showTrackingSince(
  window: StatsWindow,
  trackingSince: string | null,
): boolean {
  return window !== "lifetime" && trackingSince !== null;
}

// Locale-formatted tracking-since date for the note; null (render nothing) when
// the value is absent or unparseable (guards against "Invalid Date" — E12).
export function formatTrackingSince(
  trackingSince: string | null,
): string | null {
  if (trackingSince === null) return null;
  const parsed = new Date(trackingSince);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString();
}

// Clamp the swipe/arrow step to the tab bounds (no wrap-around — E9). Returns the
// resulting window for a +1 (next) or -1 (previous) step from the current one.
export function stepWindow(
  current: StatsWindow,
  direction: 1 | -1,
): StatsWindow {
  const index = WINDOW_TABS.findIndex((t) => t.window === current);
  const next = Math.min(Math.max(index + direction, 0), WINDOW_TABS.length - 1);
  return WINDOW_TABS[next]!.window;
}

// "big2" -> "Big 2", "tonk" -> "Tonk". Unknown -> the raw value (forward-compatible).
export function gameTypeLabel(gameType: GameType): string {
  return GAME_TYPE_LABELS[gameType] ?? gameType;
}

// Per-game-type presentational bounds — mirrors the server-authoritative engine
// config (big2 "2-4", tonk "3-8"; deckRoundsTarget [5,12] for Tonk). These are
// NOT game rules: the server validates and rejects out-of-range requests; this
// only shapes inputs and labels in the create form and lobby.
export interface GameTypeUiBounds {
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly hasDeckRoundsTarget: boolean;
}

export const GAME_TYPE_UI_BOUNDS: Record<GameType, GameTypeUiBounds> = {
  big2: { minPlayers: 2, maxPlayers: 4, hasDeckRoundsTarget: false },
  tonk: { minPlayers: 3, maxPlayers: 8, hasDeckRoundsTarget: true },
};

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
