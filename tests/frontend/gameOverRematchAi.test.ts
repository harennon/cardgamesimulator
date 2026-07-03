/**
 * LLD 140 — GameOverView rematch enable-state and lineup row logic.
 *
 * Tests the canRematch / humanCount / aiCount computed logic extracted from
 * GameOverView.vue as pure functions (no DOM mounting, mirrors project pattern).
 */
import { describe, it, expect } from "vitest";
import { computed, ref } from "vue";
import type { PlayerPublicInfo } from "../../src/shared/engine-types.js";

// ---------------------------------------------------------------------------
// Pure logic extracted from GameOverView.vue script setup
// ---------------------------------------------------------------------------

function makePlayer(id: string, isAi: boolean): PlayerPublicInfo {
  return {
    playerId: id,
    displayName: isAi ? "CPU" : id,
    cardCount: 0,
    isConnected: true,
    isAi,
  };
}

/**
 * Replicates the canRematch / humanCount / aiCount / showLineup computed values
 * from GameOverView.vue in isolation so we can assert them without mounting.
 */
function makeRematchState(opts: {
  isHost: boolean;
  players: PlayerPublicInfo[];
  engineMin: number;
}) {
  const isHost = ref(opts.isHost);
  const players = ref(opts.players);
  const engineMin = ref(opts.engineMin);

  const humanCount = computed(
    () => players.value.filter((p) => !p.isAi).length,
  );
  const aiCount = computed(() => players.value.filter((p) => p.isAi).length);

  const canRematch = computed(
    () =>
      isHost.value &&
      humanCount.value >= 1 &&
      players.value.length >= engineMin.value,
  );

  // Lineup row: rendered for host when canRematch && aiCount >= 1
  const showLineup = computed(
    () => isHost.value && canRematch.value && aiCount.value >= 1,
  );

  // Too-few hint: shown when host && !canRematch
  const showTooFew = computed(() => isHost.value && !canRematch.value);

  return { humanCount, aiCount, canRematch, showLineup, showTooFew };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GameOverView — rematch enable state (LLD 140)", () => {
  // Enable state — CPU game (1 human + 2 CPUs, Big2 engineMin=2)
  it("CPU game: isHost, 1 human + 2 CPUs, engineMin=2 → canRematch=true, showTooFew=false", () => {
    const { canRematch, showTooFew } = makeRematchState({
      isHost: true,
      players: [
        makePlayer("user-1", false),
        makePlayer("ai-1", true),
        makePlayer("ai-2", true),
      ],
      engineMin: 2,
    });

    expect(canRematch.value).toBe(true);
    expect(showTooFew.value).toBe(false);
  });

  // Enable state — Big2 human-only regression (2 humans)
  it("regression: 2 humans, engineMin=2 → canRematch=true", () => {
    const { canRematch, showTooFew } = makeRematchState({
      isHost: true,
      players: [makePlayer("user-1", false), makePlayer("user-2", false)],
      engineMin: 2,
    });

    expect(canRematch.value).toBe(true);
    expect(showTooFew.value).toBe(false);
  });

  // Enable state — Big2 human-only regression (1 human)
  it("regression: 1 human, engineMin=2 → canRematch=false, showTooFew=true", () => {
    const { canRematch, showTooFew } = makeRematchState({
      isHost: true,
      players: [makePlayer("user-1", false)],
      engineMin: 2,
    });

    expect(canRematch.value).toBe(false);
    expect(showTooFew.value).toBe(true);
  });

  // Enable state — Tonk: 1 human + 1 CPU (total 2 < min 3) → disabled
  it("Tonk: 1 human + 1 CPU (total 2 < engineMin 3) → canRematch=false", () => {
    const { canRematch, showTooFew } = makeRematchState({
      isHost: true,
      players: [makePlayer("user-1", false), makePlayer("ai-1", true)],
      engineMin: 3,
    });

    expect(canRematch.value).toBe(false);
    expect(showTooFew.value).toBe(true);
  });

  // Enable state — Tonk: 1 human + 2 CPUs (total 3 = min 3) → enabled
  it("Tonk: 1 human + 2 CPUs (total 3 = engineMin 3) → canRematch=true", () => {
    const { canRematch, showTooFew } = makeRematchState({
      isHost: true,
      players: [
        makePlayer("user-1", false),
        makePlayer("ai-1", true),
        makePlayer("ai-2", true),
      ],
      engineMin: 3,
    });

    expect(canRematch.value).toBe(true);
    expect(showTooFew.value).toBe(false);
  });

  // Non-host: canRematch always false
  it("non-host: canRematch=false regardless of player count", () => {
    const { canRematch, showTooFew } = makeRematchState({
      isHost: false,
      players: [
        makePlayer("user-1", false),
        makePlayer("ai-1", true),
        makePlayer("ai-2", true),
      ],
      engineMin: 2,
    });

    expect(canRematch.value).toBe(false);
    expect(showTooFew.value).toBe(false); // only shown for host
  });
});

describe("GameOverView — humanCount / aiCount (LLD 140)", () => {
  it("counts humans and AIs correctly from a mixed roster", () => {
    const { humanCount, aiCount } = makeRematchState({
      isHost: true,
      players: [
        makePlayer("user-1", false),
        makePlayer("ai-1", true),
        makePlayer("ai-2", true),
      ],
      engineMin: 2,
    });

    expect(humanCount.value).toBe(1);
    expect(aiCount.value).toBe(2);
  });

  it("all-human roster: aiCount=0", () => {
    const { humanCount, aiCount } = makeRematchState({
      isHost: true,
      players: [makePlayer("user-1", false), makePlayer("user-2", false)],
      engineMin: 2,
    });

    expect(humanCount.value).toBe(2);
    expect(aiCount.value).toBe(0);
  });
});

describe("GameOverView — lineup row visibility (LLD 140)", () => {
  // Lineup row shown for host with CPUs and canRematch
  it("showLineup=true when host, canRematch, and aiCount >= 1", () => {
    const { showLineup } = makeRematchState({
      isHost: true,
      players: [makePlayer("user-1", false), makePlayer("ai-1", true)],
      engineMin: 2,
    });

    expect(showLineup.value).toBe(true);
  });

  // Lineup row absent for human-only roster
  it("showLineup=false for human-only roster", () => {
    const { showLineup } = makeRematchState({
      isHost: true,
      players: [makePlayer("user-1", false), makePlayer("user-2", false)],
      engineMin: 2,
    });

    expect(showLineup.value).toBe(false);
  });

  // Lineup row absent when canRematch is false (not enough seats)
  it("showLineup=false when canRematch=false even with CPUs", () => {
    const { showLineup } = makeRematchState({
      isHost: true,
      players: [makePlayer("user-1", false), makePlayer("ai-1", true)],
      engineMin: 3, // Tonk, total 2 < 3
    });

    expect(showLineup.value).toBe(false);
  });

  // Lineup row absent for non-host
  it("showLineup=false for non-host even with CPUs and valid count", () => {
    const { showLineup } = makeRematchState({
      isHost: false,
      players: [makePlayer("user-1", false), makePlayer("ai-1", true)],
      engineMin: 2,
    });

    expect(showLineup.value).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GameView engineMin prop derivation (LLD 140 §B)
// ---------------------------------------------------------------------------

describe("GameView — engineMin prop derivation", () => {
  /**
   * Mirrors the :engine-min="gameState.gameType === 'tonk' ? 3 : 2" inline
   * ternary in GameView.vue.
   */
  function deriveEngineMin(gameType: string): number {
    return gameType === "tonk" ? 3 : 2;
  }

  it("big2 → engineMin=2", () => {
    expect(deriveEngineMin("big2")).toBe(2);
  });

  it("tonk → engineMin=3", () => {
    expect(deriveEngineMin("tonk")).toBe(3);
  });

  it("unknown game type falls back to 2", () => {
    expect(deriveEngineMin("unknown")).toBe(2);
  });
});
