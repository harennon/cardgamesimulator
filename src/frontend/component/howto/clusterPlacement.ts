// Pure placement + game-start-toast logic for the persistent help cluster,
// extracted so it is unit testable in the node vitest env (project pattern:
// stepNav.ts). HelpCluster.vue holds the reactive inputs (route path, viewport
// media query, feedback-phase enum) and delegates these decisions here.
//
// This module is held to LLD 111 decision 7 by the walkthrough source-scan test:
// it imports nothing from a live-state source. Its only inputs are the route
// path string and the coarse feedback-phase enum.

import type { FeedbackGamePhase } from "@/composables/useFeedbackContext";

// The live board is the only route shaped /game/<id> (mirrors App.vue showNav).
const BOARD_PATH = /^\/game\/[^/]+$/;

export interface ClusterPlacement {
  // Over a live board (Big2 GameBoard / Tonk TonkBoard) — apply the board offset.
  onBoard: boolean;
  // collapseBug removed (LLD 126): the bug icon shows on the board at every width.
}

export function clusterPlacement(path: string): ClusterPlacement {
  return { onBoard: BOARD_PATH.test(path) };
}

// The game-start toast fires only when the game starts WHILE the walkthrough is
// open — i.e. the lobby->board edge on the existing feedback-phase enum
// ("lobby" -> "in-progress"). Any other transition (open or closed) is a no-op,
// so the E10 rematch remount ordering ("in-progress" -> undefined -> "lobby")
// never spuriously fires it.
export function shouldFireGameStartToast(
  walkthroughOpen: boolean,
  prevPhase: FeedbackGamePhase | undefined,
  nextPhase: FeedbackGamePhase | undefined,
): boolean {
  return (
    walkthroughOpen && prevPhase === "lobby" && nextPhase === "in-progress"
  );
}
