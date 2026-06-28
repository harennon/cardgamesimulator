import { describe, it, expect } from "vitest";
import { Big2Engine } from "../../../src/backend/engine/big2/big2-engine.js";
import { SeededPRNG } from "../../../src/backend/engine/prng.js";
import { detectHandType } from "../../../src/backend/engine/big2/hand-detection.js";
import { beats } from "../../../src/backend/engine/big2/hand-comparison.js";
import { isValidPlay } from "../../../src/backend/engine/big2/valid-actions.js";
import { compareCards } from "../../../src/backend/engine/big2/constants.js";
import type {
  InternalGameState,
  PlayerInfo,
  Card,
} from "../../../src/shared/engine-types.js";
import type {
  Big2State,
  Big2PublicState,
} from "../../../src/backend/engine/big2/big2-types.js";

const engine = new Big2Engine();
const config = { maxPlayers: 4, minPlayers: 2, options: {} };

function player(id: string): PlayerInfo {
  return { playerId: id, displayName: id };
}

const PLAYERS4 = ["p1", "p2", "p3", "p4"].map(player);

function card(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}

function big2State(state: InternalGameState): Big2State {
  return state.gameSpecificState as Big2State;
}

function currentPlayerId(state: InternalGameState): string {
  return state.players[state.currentPlayerIndex]!.playerId;
}

function playAction(
  state: InternalGameState,
  cards: Card[],
): InternalGameState {
  const result = engine.applyAction(state, {
    type: "playCards",
    playerId: currentPlayerId(state),
    cards,
  });
  if (!result.success) throw new Error(`playCards failed: ${result.error}`);
  return result.newState!;
}

function passAction(state: InternalGameState): InternalGameState {
  const result = engine.applyAction(state, {
    type: "pass",
    playerId: currentPlayerId(state),
  });
  if (!result.success) throw new Error(`pass failed: ${result.error}`);
  return result.newState!;
}

function initGame(players = PLAYERS4, seed = "tsi-seed"): InternalGameState {
  return engine.initialize("game1", players, config, new SeededPRNG(seed));
}

function lowestClub(state: InternalGameState): Card {
  const gs = big2State(state);
  return gs.hands[state.currentPlayerIndex]!.find(
    (c) => c.rank === "3" && c.suit === "clubs",
  )!;
}

describe("trickStartIndex — initial state", () => {
  it("initialize sets trickStartIndex to 0", () => {
    const state = initGame();
    expect(big2State(state).trickStartIndex).toBe(0);
  });

  it("empty history slices to an empty current trick", () => {
    const state = initGame();
    const gs = big2State(state);
    expect(gs.playHistory.slice(gs.trickStartIndex)).toEqual([]);
  });
});

describe("trickStartIndex — plays within a trick do not move the boundary", () => {
  it("a lead play then a beating play keeps trickStartIndex at the trick start", () => {
    // Construct a controlled free-play state: p1 leads a single, p2 beats it.
    const gs: Big2State = {
      hands: [
        [card("5", "clubs"), card("9", "hearts")],
        [card("7", "spades"), card("10", "diamonds")],
        [card("Q", "clubs")],
        [card("K", "hearts")],
      ],
      lastPlay: null,
      lastPlayPlayerIndex: null,
      consecutivePasses: 0,
      isFreePlay: true,
      isFirstPlayOfGame: false,
      playHistory: [],
      finishedPlayerIndices: [],
      trickStartIndex: 0,
    };
    const state: InternalGameState = {
      gameId: "g",
      gameType: "big2",
      status: "IN_PROGRESS",
      version: 1,
      players: PLAYERS4,
      currentPlayerIndex: 0,
      turnNumber: 1,
      gameSpecificState: gs,
      winner: null,
      scores: null,
      randomSeed: "s",
    };

    let s = playAction(state, [card("5", "clubs")]); // p1 leads
    expect(big2State(s).trickStartIndex).toBe(0);
    s = playAction(s, [card("7", "spades")]); // p2 beats
    const gs2 = big2State(s);
    expect(gs2.trickStartIndex).toBe(0);
    const trick = gs2.playHistory.slice(gs2.trickStartIndex);
    expect(trick.map((e) => e.action)).toEqual(["play", "play"]);
    expect(trick[0]!.cards).toEqual([card("5", "clubs")]);
    expect(trick[1]!.cards).toEqual([card("7", "spades")]);
  });
});

describe("trickStartIndex — non-closing pass does not move the boundary", () => {
  it("a pass that does not close the trick leaves trickStartIndex unchanged and appears in the slice", () => {
    // 4 active players. p1 leads, p2 passes (1 of 3 needed to close).
    const gs: Big2State = {
      hands: [
        [card("5", "clubs"), card("9", "hearts")],
        [card("4", "spades")],
        [card("Q", "clubs")],
        [card("K", "hearts")],
      ],
      lastPlay: null,
      lastPlayPlayerIndex: null,
      consecutivePasses: 0,
      isFreePlay: true,
      isFirstPlayOfGame: false,
      playHistory: [],
      finishedPlayerIndices: [],
      trickStartIndex: 0,
    };
    const state: InternalGameState = {
      gameId: "g",
      gameType: "big2",
      status: "IN_PROGRESS",
      version: 1,
      players: PLAYERS4,
      currentPlayerIndex: 0,
      turnNumber: 1,
      gameSpecificState: gs,
      winner: null,
      scores: null,
      randomSeed: "s",
    };

    let s = playAction(state, [card("5", "clubs")]); // p1 leads (idx 0)
    s = passAction(s); // p2 passes (idx 1) — does not close (need 3 passes)
    const gs2 = big2State(s);
    expect(gs2.trickStartIndex).toBe(0);
    const trick = gs2.playHistory.slice(gs2.trickStartIndex);
    expect(trick.map((e) => e.action)).toEqual(["play", "pass"]);
  });
});

describe("trickStartIndex — trick close moves the boundary to the next index", () => {
  it("after all others pass, trickStartIndex equals playHistory.length (empty slice), then the next lead is the new trick", () => {
    let state = initGame(PLAYERS4, "trick-close");
    const lc = lowestClub(state);
    const startIdx = state.currentPlayerIndex;
    state = playAction(state, [lc]); // lead (idx 0)
    state = passAction(state); // idx 1
    state = passAction(state); // idx 2
    state = passAction(state); // idx 3 — closes trick (3 of 3 others passed)

    const gsAfterClose = big2State(state);
    // The closing pass occupies index 3; next entry will be index 4.
    expect(gsAfterClose.trickStartIndex).toBe(gsAfterClose.playHistory.length);
    expect(gsAfterClose.trickStartIndex).toBe(4);
    expect(
      gsAfterClose.playHistory.slice(gsAfterClose.trickStartIndex),
    ).toEqual([]);
    // Winner leads next
    expect(state.currentPlayerIndex).toBe(startIdx);
    expect(gsAfterClose.isFreePlay).toBe(true);

    // The new leader plays — slice now contains exactly that lead.
    const newGs = big2State(state);
    const leaderHand = newGs.hands[state.currentPlayerIndex]!;
    const leadCard = [...leaderHand].sort(compareCards)[0]!;
    state = playAction(state, [leadCard]);
    const gsAfterLead = big2State(state);
    const newTrick = gsAfterLead.playHistory.slice(gsAfterLead.trickStartIndex);
    expect(newTrick).toHaveLength(1);
    expect(newTrick[0]!.action).toBe("play");
    expect(newTrick[0]!.cards).toEqual([leadCard]);
  });
});

describe("trickStartIndex — MANDATORY interleaved fixture (pass→play mid-trick)", () => {
  it("keeps all of trick 1 in the slice mid-trick, then excludes it entirely once trick 2 leads", () => {
    // We reproduce the LLD's playHistory shape:
    //   [play, pass, play, pass, pass(closes), play(new lead)]
    // with trickStartIndex moving to 5 after the close.
    //
    // Mechanically: 3 active players (p1, p3, p4; p2 already finished) so a
    // trick closes when the 2 others pass after a play. We seed trick 1
    // already containing a mid-trick pass→play:
    //   idx 0: play(p1)  — p1 leads trick 1
    //   idx 1: pass(p3)
    //   idx 2: play(p4)  — p4 beats p1 mid-trick (the pass→play transition)
    //   idx 3: pass(p1)  — consecutivePasses = 1 (p1 cannot beat p4)
    // Next: p3 passes (idx 4) -> 2 consecutive passes -> closes; p4 (winner) leads.
    const seededHistory = [
      {
        playerId: "p1",
        displayName: "p1",
        action: "play" as const,
        cards: [card("3", "clubs")],
        handType: "single" as const,
      },
      { playerId: "p3", displayName: "p3", action: "pass" as const },
      {
        playerId: "p4",
        displayName: "p4",
        action: "play" as const,
        cards: [card("9", "spades")],
        handType: "single" as const,
      },
      { playerId: "p1", displayName: "p1", action: "pass" as const },
    ];

    const gs: Big2State = {
      hands: [
        [card("4", "diamonds")], // p1 — active, cannot beat 9♠
        [], // p2 — finished
        [card("6", "hearts")], // p3 — active, will pass
        [card("K", "spades"), card("5", "clubs")], // p4 — active, trick winner
      ],
      lastPlay: {
        cards: [card("9", "spades")],
        handType: { kind: "single", card: card("9", "spades") },
        playerId: "p4",
      },
      lastPlayPlayerIndex: 3,
      consecutivePasses: 1,
      isFreePlay: false,
      isFirstPlayOfGame: false,
      playHistory: seededHistory,
      finishedPlayerIndices: [1],
      trickStartIndex: 0,
    };

    const state: InternalGameState = {
      gameId: "interleaved",
      gameType: "big2",
      status: "IN_PROGRESS",
      version: 4,
      players: PLAYERS4,
      currentPlayerIndex: 2, // p3 to act
      turnNumber: 8,
      gameSpecificState: gs,
      winner: null,
      scores: null,
      randomSeed: "s",
    };

    // (a) Before the closing pass, the current-trick slice is ALL of trick 1.
    const trickBefore = gs.playHistory.slice(gs.trickStartIndex);
    expect(trickBefore.map((e) => e.action)).toEqual([
      "play",
      "pass",
      "play",
      "pass",
    ]);
    expect(trickBefore[0]!.playerId).toBe("p1");
    expect(trickBefore[2]!.playerId).toBe("p4"); // the mid-trick pass→play target

    // p3 passes -> consecutivePasses=2 >= activePlayerCount-1 (3-1=2) -> closes.
    const afterClose = passAction(state);
    const gsAfterClose = big2State(afterClose);

    // Closing pass appended at index 4; boundary moves to next index (5).
    expect(gsAfterClose.playHistory).toHaveLength(5);
    expect(gsAfterClose.trickStartIndex).toBe(5);
    expect(
      gsAfterClose.playHistory.slice(gsAfterClose.trickStartIndex),
    ).toEqual([]);
    // p4 (trick winner) leads next.
    expect(afterClose.currentPlayerIndex).toBe(3);
    expect(gsAfterClose.isFreePlay).toBe(true);

    // (b) p4 leads trick 2 -> slice is exactly [play(p4)], none of trick 1.
    const afterLead = playAction(afterClose, [card("5", "clubs")]);
    const gsAfterLead = big2State(afterLead);
    expect(gsAfterLead.trickStartIndex).toBe(5);
    const trick2 = gsAfterLead.playHistory.slice(gsAfterLead.trickStartIndex);
    expect(trick2).toHaveLength(1);
    expect(trick2[0]!.action).toBe("play");
    expect(trick2[0]!.playerId).toBe("p4");
    expect(trick2[0]!.cards).toEqual([card("5", "clubs")]);
    // None of trick 1's entries are in trick 2's slice.
    expect(trick2.some((e) => e.action === "pass")).toBe(false);
  });
});

describe("trickStartIndex — player finishes mid-trick", () => {
  it("a finishing play does not move the boundary; the play stays in the current slice", () => {
    // p1 leads a free play with their last card. Boundary unchanged; play
    // remains inside the current trick slice until the trick closes.
    const gs: Big2State = {
      hands: [
        [card("5", "spades")], // p1 — will empty hand
        [card("7", "spades"), card("9", "clubs")],
        [card("Q", "diamonds"), card("K", "hearts")],
        [card("A", "clubs"), card("2", "diamonds")],
      ],
      lastPlay: null,
      lastPlayPlayerIndex: null,
      consecutivePasses: 0,
      isFreePlay: true,
      isFirstPlayOfGame: false,
      playHistory: [],
      finishedPlayerIndices: [],
      trickStartIndex: 0,
    };
    const state: InternalGameState = {
      gameId: "finish-mid-trick",
      gameType: "big2",
      status: "IN_PROGRESS",
      version: 3,
      players: PLAYERS4,
      currentPlayerIndex: 0,
      turnNumber: 5,
      gameSpecificState: gs,
      winner: null,
      scores: null,
      randomSeed: "s",
    };

    const after = playAction(state, [card("5", "spades")]);
    const gsAfter = big2State(after);
    expect(gsAfter.finishedPlayerIndices).toContain(0);
    expect(gsAfter.trickStartIndex).toBe(0);
    const trick = gsAfter.playHistory.slice(gsAfter.trickStartIndex);
    expect(trick).toHaveLength(1);
    expect(trick[0]!.playerId).toBe("p1");
    expect(trick[0]!.cards).toEqual([card("5", "spades")]);
  });
});

// ---- Full-game invariant: 0 <= trickStartIndex <= playHistory.length and the
// committed prefix (slice(0, trickStartIndex)) is append-only / never rewritten.

function getCombinations<T>(arr: readonly T[], k: number): T[][] {
  if (k === 1) return arr.map((x) => [x]);
  const result: T[][] = [];
  for (let i = 0; i <= arr.length - k; i++) {
    const rest = getCombinations(arr.slice(i + 1), k - 1);
    for (const combo of rest) result.push([arr[i]!, ...combo]);
  }
  return result;
}

function findPlayableCombo(
  gs: Big2State,
  hand: readonly Card[],
  prng: SeededPRNG,
): Card[] | null {
  const { lastPlay, isFreePlay, isFirstPlayOfGame } = gs;
  const lowestCard = isFirstPlayOfGame
    ? hand.reduce((min, c) => (compareCards(c, min) < 0 ? c : min))
    : hand[0]!;
  if (isFirstPlayOfGame) {
    return [
      hand.find(
        (c) => c.rank === lowestCard.rank && c.suit === lowestCard.suit,
      )!,
    ];
  }
  if (isFreePlay || !lastPlay) {
    return [hand[Math.floor(prng.next() * hand.length)]!];
  }
  const candidates = getCombinations(hand, lastPlay.cards.length);
  for (const combo of prng.shuffle(candidates)) {
    const ht = detectHandType(combo);
    if (ht && beats(ht, lastPlay.handType)) {
      const v = isValidPlay(
        combo,
        hand,
        lastPlay,
        isFreePlay,
        isFirstPlayOfGame,
        lowestCard,
      );
      if (v.valid) return combo;
    }
  }
  return null;
}

describe("trickStartIndex — invariants across a full seeded game", () => {
  it("0 <= trickStartIndex <= playHistory.length at every step and the committed prefix is never rewritten", () => {
    let state = initGame(PLAYERS4, "invariant-full");
    const prng = new SeededPRNG("invariant-strategy");

    // The committed prefix (entries before the boundary) must never change.
    let committedPrefix: readonly { action: string }[] = [];

    for (let i = 0; i < 1000 && state.status !== "COMPLETED"; i++) {
      const gs = big2State(state);

      expect(gs.trickStartIndex).toBeGreaterThanOrEqual(0);
      expect(gs.trickStartIndex).toBeLessThanOrEqual(gs.playHistory.length);

      // The new committed prefix must extend the previous one (append-only;
      // boundary only advances, prior entries are stable).
      const newPrefix = gs.playHistory.slice(0, gs.trickStartIndex);
      expect(newPrefix.length).toBeGreaterThanOrEqual(committedPrefix.length);
      for (let j = 0; j < committedPrefix.length; j++) {
        expect(newPrefix[j]!.action).toBe(committedPrefix[j]!.action);
      }
      committedPrefix = newPrefix;

      const pid = currentPlayerId(state);
      const valid = engine.getValidActions(state, pid);
      if (valid.length === 0) break;
      const hand = gs.hands[state.currentPlayerIndex]!;
      const canPass = valid.some((a) => a.type === "pass");
      const canPlay = valid.some((a) => a.type === "playCards");

      let result;
      if (canPlay && (!canPass || prng.next() > 0.35)) {
        const combo = findPlayableCombo(gs, hand, prng);
        if (combo) {
          result = engine.applyAction(state, {
            type: "playCards",
            playerId: pid,
            cards: combo,
          });
        } else if (canPass) {
          result = engine.applyAction(state, { type: "pass", playerId: pid });
        } else break;
      } else if (canPass) {
        result = engine.applyAction(state, { type: "pass", playerId: pid });
      } else break;

      if (!result!.success) break;
      state = result!.newState!;
    }
  });
});

describe("trickStartIndex — published in views", () => {
  it("getPlayerView includes trickStartIndex matching internal Big2State", () => {
    let state = initGame(PLAYERS4, "view-player");
    state = playAction(state, [lowestClub(state)]);
    const internal = big2State(state).trickStartIndex;
    for (const p of PLAYERS4) {
      const view = engine.getPlayerView(state, p.playerId);
      const pub = view.gameSpecificPublicState as Big2PublicState;
      expect(pub.trickStartIndex).toBe(internal);
    }
  });

  it("getSpectatorView includes trickStartIndex matching internal Big2State", () => {
    let state = initGame(PLAYERS4, "view-spectator");
    state = playAction(state, [lowestClub(state)]);
    const internal = big2State(state).trickStartIndex;
    const view = engine.getSpectatorView(state, 2);
    const pub = view.gameSpecificPublicState as Big2PublicState;
    expect(pub.trickStartIndex).toBe(internal);
  });
});

describe("trickStartIndex — backward compat (Edge Case #14)", () => {
  it("coalesces a missing (undefined) trickStartIndex to 0 in the published view (no throw, full history shown)", () => {
    // Simulate a state persisted before this change: trickStartIndex absent.
    const legacyHistory = [
      {
        playerId: "p1",
        displayName: "p1",
        action: "play" as const,
        cards: [card("3", "clubs")],
        handType: "single" as const,
      },
      { playerId: "p2", displayName: "p2", action: "pass" as const },
    ];
    const legacyGs = {
      hands: [
        [card("4", "diamonds")],
        [card("5", "hearts")],
        [card("6", "clubs")],
        [card("7", "spades")],
      ],
      lastPlay: {
        cards: [card("3", "clubs")],
        handType: { kind: "single", card: card("3", "clubs") },
        playerId: "p1",
      },
      lastPlayPlayerIndex: 0,
      consecutivePasses: 1,
      isFreePlay: false,
      isFirstPlayOfGame: false,
      playHistory: legacyHistory,
      finishedPlayerIndices: [],
      // trickStartIndex intentionally omitted (legacy state)
    } as unknown as Big2State;

    const state: InternalGameState = {
      gameId: "legacy",
      gameType: "big2",
      status: "IN_PROGRESS",
      version: 3,
      players: PLAYERS4,
      currentPlayerIndex: 2,
      turnNumber: 4,
      gameSpecificState: legacyGs,
      winner: null,
      scores: null,
      randomSeed: "s",
    };

    const playerView = engine.getPlayerView(state, "p3");
    const playerPub = playerView.gameSpecificPublicState as Big2PublicState;
    expect(playerPub.trickStartIndex).toBe(0);
    expect(playerPub.playHistory.slice(playerPub.trickStartIndex)).toEqual(
      legacyHistory,
    );

    const spectatorView = engine.getSpectatorView(state, 1);
    const spectatorPub =
      spectatorView.gameSpecificPublicState as Big2PublicState;
    expect(spectatorPub.trickStartIndex).toBe(0);
  });
});
