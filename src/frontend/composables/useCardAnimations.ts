// Pure helpers for card animation decision logic.
// The CSS motion itself is not tested here — these helpers drive when/whether
// the animation classes are applied (LLD 152).

/**
 * Returns true when transitioning from an empty/short hand to a full deal.
 *
 * A "fresh deal" is detected by the empty-or-missing → full-hand transition:
 *   - 0 → N (N > 0): round-start deal. ✓
 *   - N → M where M < N: a play/discard shrunk the hand. ✗
 *   - N → N+1: a Tonk draw (grew by one). ✗
 *   - N → N: no change (e.g. unrelated re-render). ✗
 *
 * Tonk start-of-round: the hand goes to 0 (or the board is freshly mounted)
 * before the new hand arrives, producing 0→N which re-arms deal-in for that
 * round. If Tonk ever delivers a full→full swap without an intermediate empty,
 * callers must gate on a round signal instead (not needed in practice — the
 * server clears the hand to [] at round-start before dealing new cards).
 */
export function isFreshDeal(prevLen: number, nextLen: number): boolean {
  if (nextLen === 0) return false;
  // Only fire when prev was zero (or before first deal) and we now have cards.
  return prevLen === 0;
}

/**
 * Returns a stable identity string for the "current Big2 play" so the played
 * row can re-key only on a genuinely new play (not on unrelated re-renders).
 *
 * Returns "" when lastPlay is null (free trick / no current play).
 */
export function playKey(
  lastPlay: {
    playerId: string;
    cards: readonly { rank: string; suit: string }[];
  } | null,
): string {
  if (!lastPlay) return "";
  const cardStr = lastPlay.cards.map((c) => `${c.rank}${c.suit}`).join(",");
  return `${lastPlay.playerId}:${cardStr}`;
}

/**
 * Returns a stable identity string for the "current Tonk discard top" so the
 * discard slot can re-key only on a genuinely new discard.
 *
 * The discardCount increments on every new discard (even if the same rank/suit
 * card lands on top again), so it is the authoritative "new discard" signal.
 * Returns "" when discardTop is null (empty discard pile).
 */
export function discardKey(
  discardTop: { rank?: string; suit?: string; id?: string | number } | null,
  discardCount: number,
): string {
  if (!discardTop) return "";
  const card =
    discardTop.id ?? `${discardTop.rank ?? ""}${discardTop.suit ?? ""}`;
  return `${discardCount}:${card}`;
}
