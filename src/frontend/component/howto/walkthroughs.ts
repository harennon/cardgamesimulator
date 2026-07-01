import type { GameType } from "@shared/engine-types";
import type { Walkthrough } from "./walkthroughTypes";
import { BIG2_WALKTHROUGH } from "./big2Walkthrough";
import { TONK_WALKTHROUGH } from "./tonkWalkthrough";

// gameType-keyed. Partial by design: a type with no content yet falls back to
// Big2 via getWalkthrough() so the FAB never renders an empty modal (LLD 111 E6).
export const WALKTHROUGHS: Partial<Record<GameType, Walkthrough>> = {
  big2: BIG2_WALKTHROUGH,
  tonk: TONK_WALKTHROUGH,
};

export function getWalkthrough(gameType: GameType): Walkthrough {
  return WALKTHROUGHS[gameType] ?? WALKTHROUGHS.big2 ?? [];
}

// Human-readable label per game type, shown in the modal header subtitle.
export const GAME_LABEL: Record<GameType, string> = {
  big2: "Big 2",
  tonk: "Tonk",
};
