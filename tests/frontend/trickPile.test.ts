import { describe, it, expect } from "vitest";
import { ref, computed, watch, nextTick } from "vue";
import type { Big2HistoryEntry } from "../../src/shared/big2-types.js";
import type { Card } from "../../src/shared/engine-types.js";

// These tests exercise the TrickPile.vue derivation and interaction logic in
// isolation (node environment, no DOM mount), mirroring the existing
// gameBoardMobile.test.ts pattern. The computed/watch definitions below are an
// exact transcription of the component's <script setup> logic.

const MAX_LAYERS = 4;

function card(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}

function play(
  playerId: string,
  cards: Card[],
  handType: Big2HistoryEntry["handType"] = "single",
): Big2HistoryEntry {
  return { playerId, displayName: playerId, action: "play", cards, handType };
}

function pass(playerId: string): Big2HistoryEntry {
  return { playerId, displayName: playerId, action: "pass" };
}

/** Reproduce the component's reactive derivation against ref inputs. */
function makeTrickPileLogic(
  playHistory: ReturnType<typeof ref<readonly Big2HistoryEntry[]>>,
  trickStartIndex: ReturnType<typeof ref<number>>,
) {
  const currentTrick = computed<readonly Big2HistoryEntry[]>(() =>
    (playHistory.value ?? []).slice(trickStartIndex.value),
  );
  const playEntries = computed<Big2HistoryEntry[]>(() =>
    currentTrick.value.filter((e) => e.action === "play"),
  );
  const badgeCount = computed<number>(() => playEntries.value.length);
  const latestPlay = computed<Big2HistoryEntry | undefined>(
    () => playEntries.value[playEntries.value.length - 1],
  );
  const stackLayers = computed<Big2HistoryEntry[]>(() => {
    const plays = playEntries.value;
    return plays.slice(Math.max(0, plays.length - MAX_LAYERS));
  });

  const expanded = ref(false);
  const toggle = () => {
    expanded.value = !expanded.value;
  };
  const collapse = () => {
    expanded.value = false;
  };

  watch(
    () => currentTrick.value.length,
    (len) => {
      if (len === 0) collapse();
    },
  );

  return {
    currentTrick,
    playEntries,
    badgeCount,
    latestPlay,
    stackLayers,
    expanded,
    toggle,
    collapse,
  };
}

describe("TrickPile — currentTrick derivation", () => {
  it("empty history with trickStartIndex 0 → empty current trick, pile/badge hidden", () => {
    const playHistory = ref<readonly Big2HistoryEntry[]>([]);
    const trickStartIndex = ref(0);
    const t = makeTrickPileLogic(playHistory, trickStartIndex);
    expect(t.currentTrick.value).toEqual([]);
    expect(t.badgeCount.value).toBe(0);
    // pile is rendered only when currentTrick.length > 0
    expect(t.currentTrick.value.length > 0).toBe(false);
  });

  it("fresh trick (trickStartIndex === playHistory.length) → empty current trick, pile hidden", () => {
    const hist = [play("p1", [card("3", "clubs")]), pass("p2"), pass("p3")];
    const playHistory = ref<readonly Big2HistoryEntry[]>(hist);
    const trickStartIndex = ref(hist.length); // boundary at end → empty slice
    const t = makeTrickPileLogic(playHistory, trickStartIndex);
    expect(t.currentTrick.value).toEqual([]);
    expect(t.currentTrick.value.length > 0).toBe(false);
  });

  it("single play → currentTrick length 1, badgeCount 1, top of pile is that play", () => {
    const hist = [play("p1", [card("3", "clubs")])];
    const t = makeTrickPileLogic(
      ref<readonly Big2HistoryEntry[]>(hist),
      ref(0),
    );
    expect(t.currentTrick.value).toHaveLength(1);
    expect(t.badgeCount.value).toBe(1);
    const top = t.stackLayers.value[t.stackLayers.value.length - 1]!;
    expect(top.playerId).toBe("p1");
  });

  it("multiple plays → ordered oldest→newest; collapsed top = most recent (last) play", () => {
    const hist = [
      play("p1", [card("3", "clubs")]),
      play("p2", [card("5", "hearts")]),
      play("p3", [card("9", "spades")]),
    ];
    const t = makeTrickPileLogic(
      ref<readonly Big2HistoryEntry[]>(hist),
      ref(0),
    );
    expect(t.currentTrick.value.map((e) => e.playerId)).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
    const top = t.stackLayers.value[t.stackLayers.value.length - 1]!;
    expect(top.playerId).toBe("p3"); // most recent on top
  });

  it("interleaved passes within the trick → passes excluded from stack but present in currentTrick; badge = play count", () => {
    const hist = [
      play("p1", [card("3", "clubs")]),
      pass("p2"),
      play("p3", [card("9", "spades")]),
      pass("p4"),
    ];
    const t = makeTrickPileLogic(
      ref<readonly Big2HistoryEntry[]>(hist),
      ref(0),
    );
    // Passes appear in the (expanded) currentTrick in order...
    expect(t.currentTrick.value.map((e) => e.action)).toEqual([
      "play",
      "pass",
      "play",
      "pass",
    ]);
    // ...but the collapsed card stack contains only plays.
    expect(t.stackLayers.value.every((e) => e.action === "play")).toBe(true);
    expect(t.badgeCount.value).toBe(2);
  });

  it("stack caps visible layers at MAX_LAYERS, keeping the most recent on top", () => {
    const hist = [
      play("p1", [card("3", "clubs")]),
      play("p2", [card("4", "clubs")]),
      play("p3", [card("5", "clubs")]),
      play("p4", [card("6", "clubs")]),
      play("p1", [card("7", "clubs")]),
      play("p2", [card("8", "clubs")]),
    ];
    const t = makeTrickPileLogic(
      ref<readonly Big2HistoryEntry[]>(hist),
      ref(0),
    );
    expect(t.badgeCount.value).toBe(6); // badge counts all plays
    expect(t.stackLayers.value).toHaveLength(MAX_LAYERS); // visible layers capped
    const top = t.stackLayers.value[t.stackLayers.value.length - 1]!;
    expect(top.cards![0]).toEqual(card("8", "clubs")); // most recent on top
  });

  it("interleaved fixture fed as (playHistory, trickStartIndex) → slice contains current trick only, excludes prior trick", () => {
    // playHistory has trick 1 then a new lead; boundary at 5 (per engine).
    const playHistory: readonly Big2HistoryEntry[] = [
      play("p1", [card("3", "clubs")]), // 0 — trick 1
      pass("p2"), // 1
      play("p3", [card("9", "spades")]), // 2
      pass("p4"), // 3
      pass("p1"), // 4 — closing pass
      play("p3", [card("5", "clubs")]), // 5 — trick 2 lead
    ];
    const t = makeTrickPileLogic(
      ref<readonly Big2HistoryEntry[]>(playHistory),
      ref(5),
    );
    expect(t.currentTrick.value).toEqual(playHistory.slice(5));
    expect(t.currentTrick.value).toHaveLength(1);
    expect(t.currentTrick.value[0]!.playerId).toBe("p3");
    // None of trick 1's entries leak in.
    expect(t.currentTrick.value.some((e) => e.action === "pass")).toBe(false);
  });
});

describe("TrickPile — latestPlay derivation (mobile static layer)", () => {
  it("single play → latestPlay is that play", () => {
    const hist = [play("p1", [card("3", "clubs")])];
    const t = makeTrickPileLogic(
      ref<readonly Big2HistoryEntry[]>(hist),
      ref(0),
    );
    expect(t.latestPlay.value?.playerId).toBe("p1");
    expect(t.latestPlay.value).toBe(
      t.playEntries.value[t.playEntries.value.length - 1],
    );
  });

  it("three plays → latestPlay is the last (most recent) play", () => {
    const hist = [
      play("p1", [card("3", "clubs")]),
      play("p2", [card("5", "hearts")]),
      play("p3", [card("9", "spades")]),
    ];
    const t = makeTrickPileLogic(
      ref<readonly Big2HistoryEntry[]>(hist),
      ref(0),
    );
    expect(t.latestPlay.value?.playerId).toBe("p3");
    expect(t.latestPlay.value?.cards![0]).toEqual(card("9", "spades"));
  });

  it("six plays → latestPlay is the sixth play (unaffected by MAX_LAYERS cap)", () => {
    const hist = [
      play("p1", [card("3", "clubs")]),
      play("p2", [card("4", "clubs")]),
      play("p3", [card("5", "clubs")]),
      play("p4", [card("6", "clubs")]),
      play("p1", [card("7", "clubs")]),
      play("p2", [card("8", "clubs")]),
    ];
    const t = makeTrickPileLogic(
      ref<readonly Big2HistoryEntry[]>(hist),
      ref(0),
    );
    expect(t.latestPlay.value?.playerId).toBe("p2");
    expect(t.latestPlay.value?.cards![0]).toEqual(card("8", "clubs"));
  });

  it("current trick with only passes → latestPlay is undefined (guards the v-if)", () => {
    const hist = [pass("p1"), pass("p2")];
    const t = makeTrickPileLogic(
      ref<readonly Big2HistoryEntry[]>(hist),
      ref(0),
    );
    expect(t.playEntries.value).toHaveLength(0);
    expect(t.latestPlay.value).toBeUndefined();
  });
});

describe("TrickPile — expand/collapse interaction", () => {
  it("toggle flips expanded state", () => {
    const t = makeTrickPileLogic(
      ref<readonly Big2HistoryEntry[]>([play("p1", [card("3", "clubs")])]),
      ref(0),
    );
    expect(t.expanded.value).toBe(false);
    t.toggle();
    expect(t.expanded.value).toBe(true);
    t.toggle();
    expect(t.expanded.value).toBe(false);
  });

  it("collapse closes the overlay", () => {
    const t = makeTrickPileLogic(
      ref<readonly Big2HistoryEntry[]>([play("p1", [card("3", "clubs")])]),
      ref(0),
    );
    t.toggle();
    expect(t.expanded.value).toBe(true);
    t.collapse();
    expect(t.expanded.value).toBe(false);
  });

  it("force-collapses when the trick resets (currentTrick becomes empty) while expanded", async () => {
    const playHistory = ref<readonly Big2HistoryEntry[]>([
      play("p1", [card("3", "clubs")]),
      pass("p2"),
      pass("p3"),
      pass("p4"),
    ]);
    const trickStartIndex = ref(0);
    const t = makeTrickPileLogic(playHistory, trickStartIndex);
    t.toggle();
    expect(t.expanded.value).toBe(true);

    // Trick closes: engine moves the boundary to playHistory.length → empty slice.
    trickStartIndex.value = playHistory.value!.length;
    await nextTick();
    expect(t.currentTrick.value).toEqual([]);
    expect(t.expanded.value).toBe(false);
  });
});
