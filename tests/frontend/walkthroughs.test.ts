import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Card, GameType, Rank, Suit } from "@shared/engine-types";
import type { TonkCard } from "@shared/tonk-types";
import { isJoker } from "@shared/tonk-types";
import {
  WALKTHROUGHS,
  getWalkthrough,
  GAME_LABEL,
} from "@/component/howto/walkthroughs";
import { BIG2_WALKTHROUGH } from "@/component/howto/big2Walkthrough";
import { TONK_WALKTHROUGH } from "@/component/howto/tonkWalkthrough";
import type {
  WalkthroughStep,
  WalkthroughScene,
} from "@/component/howto/walkthroughTypes";
import {
  canGoBack,
  clampIndex,
  isLastStep,
  nextIndex,
  prevIndex,
  primaryAction,
} from "@/component/howto/stepNav";
import {
  clusterPlacement,
  shouldFireGameStartToast,
} from "@/component/howto/clusterPlacement";

const RANKS: readonly Rank[] = [
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
  "A",
  "2",
];
const SUITS: readonly Suit[] = ["clubs", "diamonds", "hearts", "spades"];

// A fixture is valid if it is a Tonk joker OR a standard Card (rank in Rank,
// suit in Suit). Widened for LLD 115 Option B (a cards scene may hold a joker).
function isValidFixture(c: Card | TonkCard): boolean {
  if (isJoker(c)) return true;
  return RANKS.includes(c.rank) && SUITS.includes(c.suit);
}

describe("getWalkthrough — registry lookup + fallback (E6)", () => {
  it("returns the Big2 walkthrough for 'big2' (non-empty)", () => {
    const w = getWalkthrough("big2");
    expect(w).toBe(BIG2_WALKTHROUGH);
    expect(w.length).toBeGreaterThan(0);
  });

  it("returns the Tonk walkthrough for 'tonk' (non-empty) — LLD 115", () => {
    // #123/LLD 115 registers a real Tonk entry; the fallback for tonk no longer holds.
    expect(WALKTHROUGHS.tonk).toBe(TONK_WALKTHROUGH);
    const w = getWalkthrough("tonk");
    expect(w).toBe(TONK_WALKTHROUGH);
    expect(w.length).toBeGreaterThan(0);
  });

  it("falls back to Big2 for a still-unregistered type (never empty) — E6", () => {
    // A future game type with no content still resolves to Big2, not an empty modal.
    const w = getWalkthrough("nonexistent" as GameType);
    expect(w).toBe(BIG2_WALKTHROUGH);
    expect(w.length).toBeGreaterThan(0);
  });

  it("exposes a human label for every game type", () => {
    expect(GAME_LABEL.big2).toBe("Big 2");
    expect(GAME_LABEL.tonk).toBe("Tonk");
  });
});

describe("BIG2_WALKTHROUGH — content shape & fixture validity", () => {
  it("has the expected step count (6)", () => {
    expect(BIG2_WALKTHROUGH).toHaveLength(6);
  });

  it("every step has a non-empty tag, a valid scene discriminant, and a non-empty caption", () => {
    for (const step of BIG2_WALKTHROUGH) {
      expect(step.tag.trim().length).toBeGreaterThan(0);
      expect(["cards", "callout"]).toContain(step.scene.kind);
      expect(step.caption.length).toBeGreaterThan(0);
    }
  });

  it("every caption segment is a non-empty text or strong segment", () => {
    for (const step of BIG2_WALKTHROUGH) {
      for (const seg of step.caption) {
        const value = "strong" in seg ? seg.strong : seg.text;
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });

  it("at least one caption uses a <strong> emphasis segment", () => {
    const hasStrong = BIG2_WALKTHROUGH.some((s) =>
      s.caption.some((seg) => "strong" in seg),
    );
    expect(hasStrong).toBe(true);
  });

  it("every cards scene holds only valid Cards (rank in Rank, suit in Suit) — E10", () => {
    for (const step of BIG2_WALKTHROUGH) {
      if (step.scene.kind !== "cards") continue;
      for (const c of step.scene.cards) {
        expect(isValidFixture(c)).toBe(true);
      }
    }
  });

  it("every cards scene's selectedIndices/highlightIndices are within [0, cards.length)", () => {
    for (const step of BIG2_WALKTHROUGH) {
      if (step.scene.kind !== "cards") continue;
      const n = step.scene.cards.length;
      for (const idx of [
        ...(step.scene.selectedIndices ?? []),
        ...(step.scene.highlightIndices ?? []),
      ]) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(n);
      }
    }
  });

  it("every callout scene has a non-empty icon and at least one line", () => {
    for (const step of BIG2_WALKTHROUGH) {
      if (step.scene.kind !== "callout") continue;
      expect(step.scene.icon.length).toBeGreaterThan(0);
      expect(step.scene.lines.length).toBeGreaterThan(0);
    }
  });
});

describe("TONK_WALKTHROUGH — content shape & fixture validity (LLD 115)", () => {
  it("has the expected step count (6)", () => {
    expect(TONK_WALKTHROUGH).toHaveLength(6);
  });

  it("every step has a non-empty tag, a valid scene discriminant, and a non-empty caption", () => {
    for (const step of TONK_WALKTHROUGH) {
      expect(step.tag.trim().length).toBeGreaterThan(0);
      expect(["cards", "callout"]).toContain(step.scene.kind);
      expect(step.caption.length).toBeGreaterThan(0);
    }
  });

  it("every caption segment is a non-empty text or strong segment", () => {
    for (const step of TONK_WALKTHROUGH) {
      for (const seg of step.caption) {
        const value = "strong" in seg ? seg.strong : seg.text;
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });

  it("at least one caption uses a <strong> emphasis segment", () => {
    const hasStrong = TONK_WALKTHROUGH.some((s) =>
      s.caption.some((seg) => "strong" in seg),
    );
    expect(hasStrong).toBe(true);
  });

  it("every cards scene holds only valid fixtures (Card or Tonk joker) — E10", () => {
    for (const step of TONK_WALKTHROUGH) {
      if (step.scene.kind !== "cards") continue;
      for (const c of step.scene.cards) {
        expect(isValidFixture(c)).toBe(true);
      }
    }
  });

  it("at least one step renders a joker fixture (Option B guard)", () => {
    const hasJoker = TONK_WALKTHROUGH.some(
      (s) => s.scene.kind === "cards" && s.scene.cards.some((c) => isJoker(c)),
    );
    expect(hasJoker).toBe(true);
  });

  it("every cards scene's selectedIndices/highlightIndices are within [0, cards.length)", () => {
    for (const step of TONK_WALKTHROUGH) {
      if (step.scene.kind !== "cards") continue;
      const n = step.scene.cards.length;
      for (const idx of [
        ...(step.scene.selectedIndices ?? []),
        ...(step.scene.highlightIndices ?? []),
      ]) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(n);
      }
    }
  });

  it("every callout scene has a non-empty icon and at least one line", () => {
    for (const step of TONK_WALKTHROUGH) {
      if (step.scene.kind !== "callout") continue;
      expect(step.scene.icon.length).toBeGreaterThan(0);
      expect(step.scene.lines.length).toBeGreaterThan(0);
    }
  });
});

describe("step-nav reducer (E1)", () => {
  const N = 6;

  it("clamps any index into [0, n-1]", () => {
    expect(clampIndex(-3, N)).toBe(0);
    expect(clampIndex(0, N)).toBe(0);
    expect(clampIndex(5, N)).toBe(5);
    expect(clampIndex(99, N)).toBe(5);
  });

  it("clamps to 0 for an empty walkthrough", () => {
    expect(clampIndex(0, 0)).toBe(0);
  });

  it("Back is disabled at index 0 and enabled afterwards", () => {
    expect(canGoBack(0)).toBe(false);
    expect(canGoBack(1)).toBe(true);
    expect(canGoBack(N - 1)).toBe(true);
  });

  it("Next advances but never past the last index", () => {
    expect(nextIndex(0, N)).toBe(1);
    expect(nextIndex(N - 2, N)).toBe(N - 1);
    expect(nextIndex(N - 1, N)).toBe(N - 1);
  });

  it("Back decrements but never below 0", () => {
    expect(prevIndex(N - 1, N)).toBe(N - 2);
    expect(prevIndex(1, N)).toBe(0);
    expect(prevIndex(0, N)).toBe(0);
  });

  it("isLastStep is true only on the final index", () => {
    expect(isLastStep(0, N)).toBe(false);
    expect(isLastStep(N - 2, N)).toBe(false);
    expect(isLastStep(N - 1, N)).toBe(true);
  });

  it("primary action advances except on the last step, where it closes", () => {
    expect(primaryAction(0, N)).toBe("advance");
    expect(primaryAction(N - 2, N)).toBe("advance");
    expect(primaryAction(N - 1, N)).toBe("close");
  });
});

describe("clusterPlacement — surface-aware placement (LLD 126)", () => {
  it("board path → onBoard (bug icon visible at every width)", () => {
    expect(clusterPlacement("/game/abc123")).toEqual({ onBoard: true });
  });

  it("non-board paths → !onBoard", () => {
    expect(clusterPlacement("/")).toEqual({ onBoard: false });
    expect(clusterPlacement("/create-game")).toEqual({ onBoard: false });
    expect(clusterPlacement("/stats")).toEqual({ onBoard: false });
  });

  it("a nested /game/<id>/<sub> path is NOT the board (only /game/<id> matches)", () => {
    // Mirrors App.vue showNav: the board is the sole /game/<id> route.
    expect(clusterPlacement("/game/abc/extra").onBoard).toBe(false);
  });

  it("rematch: both /game/abc and /game/xyz resolve to onBoard (E10)", () => {
    expect(clusterPlacement("/game/abc").onBoard).toBe(true);
    expect(clusterPlacement("/game/xyz").onBoard).toBe(true);
  });
});

describe("shouldFireGameStartToast — game-start toast trigger (LLD 117 §7.1)", () => {
  it("fires only on open && 'lobby' → 'in-progress'", () => {
    expect(shouldFireGameStartToast(true, "lobby", "in-progress")).toBe(true);
  });

  it("does not fire when the walkthrough is closed", () => {
    expect(shouldFireGameStartToast(false, "lobby", "in-progress")).toBe(false);
  });

  it("does not fire on the E10 rematch remount edges ('in-progress' → undefined → 'lobby')", () => {
    expect(shouldFireGameStartToast(true, "in-progress", undefined)).toBe(
      false,
    );
    expect(shouldFireGameStartToast(true, undefined, "lobby")).toBe(false);
    expect(shouldFireGameStartToast(true, "lobby", undefined)).toBe(false);
  });

  it("does not fire on 'in-progress' → 'game-over' (E16 final-play)", () => {
    expect(shouldFireGameStartToast(true, "in-progress", "game-over")).toBe(
      false,
    );
  });

  it("does not fire on undefined → 'in-progress' (no lobby was seen)", () => {
    expect(shouldFireGameStartToast(true, undefined, "in-progress")).toBe(
      false,
    );
  });
});

describe("information hiding — walkthrough modules touch no live state (decision 7)", () => {
  const FORBIDDEN = [
    "useGameState",
    "useSocket",
    "socket-events",
    "EnrichedPlayerView",
    "gameSpecificPublicState",
    "@/composables/useGameActions",
  ];

  const MODULE_FILES = [
    "src/frontend/component/howto/walkthroughs.ts",
    "src/frontend/component/howto/walkthroughTypes.ts",
    "src/frontend/component/howto/big2Walkthrough.ts",
    "src/frontend/component/howto/tonkWalkthrough.ts",
    "src/frontend/component/howto/stepNav.ts",
    "src/frontend/component/howto/clusterPlacement.ts",
    "src/frontend/component/howto/WalkthroughScene.vue",
    "src/frontend/component/howto/WalkthroughModal.vue",
  ];

  for (const rel of MODULE_FILES) {
    it(`${rel} imports nothing from a live-state source`, () => {
      const source = readFileSync(resolve(__dirname, "../../", rel), "utf-8");
      for (const needle of FORBIDDEN) {
        expect(source).not.toContain(needle);
      }
    });
  }
});

// Compile-time sanity that the exported types are what the shell consumes; this
// keeps the union exhaustive check honest if a future scene kind is added.
describe("walkthrough types", () => {
  it("a WalkthroughStep's scene is one of the two known kinds", () => {
    const kinds = new Set<WalkthroughScene["kind"]>(["cards", "callout"]);
    const step: WalkthroughStep = BIG2_WALKTHROUGH[0];
    expect(kinds.has(step.scene.kind)).toBe(true);
  });
});
