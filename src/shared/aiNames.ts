export const AI_NAME_POOL = [
  "Ace",
  "Bishop",
  "Cortex",
  "Domino",
  "Echo",
  "Fable",
  "Gambit",
] as const;

/** Deterministic AI display name for a 0-based AI-seat ordinal. */
export function aiNameForOrdinal(ordinal: number): string {
  const len = AI_NAME_POOL.length;
  const base = AI_NAME_POOL[ordinal % len];
  const cycle = Math.floor(ordinal / len);
  return cycle === 0 ? base : `${base} ${cycle + 1}`;
}
