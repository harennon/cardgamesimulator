import type { Big2HistoryEntry, HandTypeKind } from "@shared/big2-types";

export interface GameOverStat {
  readonly label: string;
  readonly value: number | string;
}

const HAND_TYPE_RANK: Record<HandTypeKind, number> = {
  single: 1,
  pair: 2,
  straight: 3,
  fullHouse: 4,
  fourOfAKind: 5,
  straightFlush: 6,
};

const HAND_TYPE_DISPLAY: Record<HandTypeKind, string> = {
  single: "Single",
  pair: "Pair",
  straight: "Straight",
  fullHouse: "Full House",
  fourOfAKind: "Four of a Kind",
  straightFlush: "Straight Flush",
};

export function getBestHand(
  plays: readonly { handType?: HandTypeKind }[],
): string {
  let best: HandTypeKind | null = null;
  let bestRank = 0;

  for (const play of plays) {
    if (play.handType && HAND_TYPE_RANK[play.handType] > bestRank) {
      bestRank = HAND_TYPE_RANK[play.handType];
      best = play.handType;
    }
  }

  return best ? HAND_TYPE_DISPLAY[best] : "--";
}

export function countTricksWon(
  playHistory: readonly Big2HistoryEntry[],
  currentPlayerId: string,
): number {
  let tricks = 0;
  const playerCount = new Set(playHistory.map((e) => e.playerId)).size;
  if (playerCount < 2) return 0;

  for (let i = 0; i < playHistory.length; i++) {
    const entry = playHistory[i];
    if (entry.playerId !== currentPlayerId || entry.action !== "play") continue;

    let consecutivePasses = 0;
    for (let j = i + 1; j < playHistory.length; j++) {
      if (playHistory[j].action === "pass") {
        consecutivePasses++;
      } else {
        break;
      }
    }

    if (consecutivePasses >= playerCount - 1) {
      tricks++;
    }
  }

  return tricks;
}

export function deriveBig2Stats(
  playHistory: readonly Big2HistoryEntry[],
  currentPlayerId: string,
): GameOverStat[] {
  const myPlays = playHistory.filter(
    (e) => e.playerId === currentPlayerId && e.action === "play",
  );
  const myPasses = playHistory.filter(
    (e) => e.playerId === currentPlayerId && e.action === "pass",
  );

  const tricksWon = countTricksWon(playHistory, currentPlayerId);
  const bestHand = getBestHand(myPlays);

  return [
    { label: "Plays Made", value: myPlays.length },
    { label: "Passes", value: myPasses.length },
    { label: "Tricks Won", value: tricksWon },
    { label: "Best Hand", value: bestHand },
  ];
}

export const PLACEMENT_BADGES = ["gold", "silver", "bronze", "grey"] as const;
export type BadgeType = (typeof PLACEMENT_BADGES)[number];

export function getBadgeForPosition(
  index: number,
  totalPlayers: number,
): BadgeType | null {
  if (index >= totalPlayers) return null;
  if (index < PLACEMENT_BADGES.length) return PLACEMENT_BADGES[index];
  return "grey";
}

export function getBadgeClass(badge: BadgeType): string {
  return `game-over__badge--${badge}`;
}
