import { describe, it, expect } from "vitest";
import { Big2Engine } from "../../../src/backend/engine/big2/big2-engine.js";
import { SeededPRNG } from "../../../src/backend/engine/prng.js";
import { detectHandType } from "../../../src/backend/engine/big2/hand-detection.js";
import { compareCards } from "../../../src/backend/engine/big2/constants.js";
import type {
  InternalGameState,
  PlayerInfo,
  Card,
} from "../../../src/shared/engine-types.js";
import type { Big2State } from "../../../src/backend/engine/big2/big2-types.js";
import type { Big2PlayCardsAction } from "../../../src/backend/engine/big2/big2-types.js";

const engine = new Big2Engine();
const config = { maxPlayers: 4, minPlayers: 2, options: {} };

function player(id: string): PlayerInfo {
  return { playerId: id, displayName: id };
}

function card(rank: Card["rank"], suit: Card["suit"]): Card {
  return { rank, suit };
}

function big2State(state: InternalGameState): Big2State {
  return state.gameSpecificState as Big2State;
}

function currentPlayerId(state: InternalGameState): string {
  return state.players[state.currentPlayerIndex]!.playerId;
}

/**
 * Build a minimal InternalGameState with directly-injected Big2State, so tests
 * can set preconditions without replaying turns.
 */
function buildState(
  ps: PlayerInfo[],
  gs: Partial<Big2State> & { hands: readonly (readonly Card[])[] },
): InternalGameState {
  const fullGs: Big2State = {
    hands: gs.hands,
    lastPlay: gs.lastPlay ?? null,
    lastPlayPlayerIndex: gs.lastPlayPlayerIndex ?? null,
    consecutivePasses: gs.consecutivePasses ?? 0,
    isFreePlay: gs.isFreePlay ?? true,
    isFirstPlayOfGame: gs.isFirstPlayOfGame ?? false,
    playHistory: gs.playHistory ?? [],
    finishedPlayerIndices: gs.finishedPlayerIndices ?? [],
    trickStartIndex: gs.trickStartIndex ?? 0,
  };
  return {
    gameId: "test",
    gameType: "big2",
    status: "IN_PROGRESS",
    version: 1,
    players: ps,
    currentPlayerIndex: 0,
    turnNumber: 1,
    gameSpecificState: fullGs,
    winner: null,
    scores: null,
    randomSeed: "test",
  };
}

function makeLastPlay(cards: Card[], playerId: string): Big2State["lastPlay"] {
  const handType = detectHandType(cards)!;
  return { cards, handType, playerId };
}

// ---------------------------------------------------------------------------
// Always-legal: for various constructed states the AI action is valid
// ---------------------------------------------------------------------------

describe("getAiMoveAction — always legal", () => {
  it("first play of game: returned action passes validateAction", () => {
    const state = engine.initialize(
      "g",
      [player("p1"), player("p2"), player("p3"), player("p4")],
      config,
      new SeededPRNG("legality-seed-1"),
    );
    const action = engine.getAiMoveAction(state);
    expect(action).not.toBeNull();
    expect(engine.validateAction(state, action!)).toBe(true);
    expect(engine.applyAction(state, action!).success).toBe(true);
  });

  it("free play state: returned action passes validateAction", () => {
    const hands: Card[][] = [
      [card("5", "clubs"), card("7", "hearts"), card("9", "spades")],
      [card("6", "clubs"), card("8", "diamonds")],
      [card("4", "diamonds"), card("K", "clubs")],
      [card("3", "spades"), card("Q", "hearts")],
    ];
    const state = buildState(
      [player("p1"), player("p2"), player("p3"), player("p4")],
      { hands, isFreePlay: true, isFirstPlayOfGame: false },
    );
    const action = engine.getAiMoveAction(state);
    expect(action).not.toBeNull();
    expect(engine.validateAction(state, action!)).toBe(true);
  });

  it("following state where AI can beat: returned action passes validateAction", () => {
    const hands: Card[][] = [
      [card("4", "clubs"), card("5", "diamonds"), card("6", "hearts")],
      [card("3", "clubs")],
      [card("7", "spades")],
      [card("8", "clubs")],
    ];
    const lastPlay = makeLastPlay([card("3", "clubs")], "p2");
    const state = buildState(
      [player("p1"), player("p2"), player("p3"), player("p4")],
      {
        hands,
        isFreePlay: false,
        isFirstPlayOfGame: false,
        lastPlay,
        lastPlayPlayerIndex: 1,
      },
    );
    const action = engine.getAiMoveAction(state);
    expect(action).not.toBeNull();
    expect(engine.validateAction(state, action!)).toBe(true);
  });

  it("following state where AI cannot beat: returns pass (legal)", () => {
    const lastPlay = makeLastPlay([card("2", "spades")], "p2");
    const hands: Card[][] = [
      [card("3", "clubs"), card("4", "diamonds")],
      [card("2", "spades")],
      [card("5", "clubs")],
      [card("6", "clubs")],
    ];
    const state = buildState(
      [player("p1"), player("p2"), player("p3"), player("p4")],
      {
        hands,
        isFreePlay: false,
        isFirstPlayOfGame: false,
        lastPlay,
        lastPlayPlayerIndex: 1,
      },
    );
    const action = engine.getAiMoveAction(state);
    expect(action).not.toBeNull();
    expect(action!.type).toBe("pass");
    expect(engine.validateAction(state, action!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Core bug fix: AI does NOT always pass when it can beat
// ---------------------------------------------------------------------------

describe("getAiMoveAction — does not always pass", () => {
  it("following state, can beat cheap single, close to out → AI plays (not passes)", () => {
    const lastPlay = makeLastPlay([card("3", "clubs")], "p2");
    // AI has 3 cards = close to out (<=5), and can beat with 4♣
    const hands: Card[][] = [
      [card("4", "clubs"), card("5", "diamonds"), card("6", "hearts")],
      [card("3", "clubs")],
      [card("7", "spades")],
      [card("8", "clubs")],
    ];
    const state = buildState(
      [player("p1"), player("p2"), player("p3"), player("p4")],
      {
        hands,
        isFreePlay: false,
        isFirstPlayOfGame: false,
        lastPlay,
        lastPlayPlayerIndex: 1,
      },
    );

    const aiAction = engine.getAiMoveAction(state);
    expect(aiAction).not.toBeNull();
    expect(aiAction!.type).toBe("playCards"); // AI plays, not passes

    // Contrast: timeout action returns pass in this follow position
    const timeoutAction = engine.getAutoTimeoutAction(state);
    expect(timeoutAction!.type).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// Sheds low cards early
// ---------------------------------------------------------------------------

describe("getAiMoveAction — sheds low cards early", () => {
  it("first play: includes the mandated lowest card", () => {
    const state = engine.initialize(
      "g",
      [player("p1"), player("p2"), player("p3"), player("p4")],
      config,
      new SeededPRNG("sheds-low-seed"),
    );
    const gs = big2State(state);
    const hand = gs.hands[state.currentPlayerIndex]!;
    const lowestCard = [...hand].sort(compareCards)[0]!;

    const action = engine.getAiMoveAction(state)! as Big2PlayCardsAction;
    expect(action.type).toBe("playCards");
    const includesLowest = action.cards.some(
      (c) => c.rank === lowestCard.rank && c.suit === lowestCard.suit,
    );
    expect(includesLowest).toBe(true);
  });

  it("first play with pair containing lowest card: sheds pair (>1 card)", () => {
    // 3♣ is the mandated lowest; 3♦ is a rank-mate → should play the pair
    const hands: Card[][] = [
      [
        card("3", "clubs"),
        card("3", "diamonds"),
        card("K", "hearts"),
        card("A", "spades"),
        card("2", "clubs"),
      ],
      [
        card("5", "clubs"),
        card("6", "diamonds"),
        card("7", "hearts"),
        card("8", "spades"),
        card("9", "clubs"),
      ],
      [
        card("4", "clubs"),
        card("4", "diamonds"),
        card("Q", "clubs"),
        card("J", "hearts"),
        card("10", "spades"),
      ],
      [
        card("5", "diamonds"),
        card("6", "clubs"),
        card("7", "spades"),
        card("8", "diamonds"),
        card("9", "hearts"),
      ],
    ];
    const state = buildState(
      [player("p1"), player("p2"), player("p3"), player("p4")],
      { hands, isFirstPlayOfGame: true, isFreePlay: true },
    );
    const action = engine.getAiMoveAction(state)! as Big2PlayCardsAction;
    expect(action.type).toBe("playCards");
    expect(action.cards.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Holds high cards
// ---------------------------------------------------------------------------

describe("getAiMoveAction — holds high cards", () => {
  it("free play with all true singletons: leads lowest card, not the 2", () => {
    // All cards are true singletons (no rank-mates), so must lead a single.
    // Policy should lead the lowest singleton and never a 2 while lower options exist.
    const hands: Card[][] = [
      [
        card("5", "clubs"),
        card("2", "hearts"),
        card("K", "spades"),
        card("A", "clubs"),
        card("7", "diamonds"),
      ],
      [card("6", "clubs"), card("8", "diamonds"), card("9", "hearts")],
      [card("4", "clubs"), card("A", "hearts"), card("10", "diamonds")],
      [card("3", "diamonds"), card("Q", "hearts"), card("J", "spades")],
    ];
    const state = buildState(
      [player("p1"), player("p2"), player("p3"), player("p4")],
      { hands, isFreePlay: true, isFirstPlayOfGame: false },
    );
    const action = engine.getAiMoveAction(state)! as Big2PlayCardsAction;
    expect(action.type).toBe("playCards");
    // Should not lead the 2 (highest single)
    const leadsTwo = action.cards.length === 1 && action.cards[0]!.rank === "2";
    expect(leadsTwo).toBe(false);
    // Should lead the 5♣ (lowest singleton)
    const leadsFive =
      action.cards.length === 1 &&
      action.cards[0]!.rank === "5" &&
      action.cards[0]!.suit === "clubs";
    expect(leadsFive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Combo preservation
// ---------------------------------------------------------------------------

describe("getAiMoveAction — combo preservation", () => {
  it("follow (single required): picks true singleton over breaking a pair to beat", () => {
    // lastPlay = single 4♣. AI must beat with a single.
    // Hand: 5♣ (true singleton) + pair of 6s.
    // Policy should use 5♣ (true singleton beater) rather than breaking the 6 pair.
    // 3 cards total = close to out, so AI plays (not conserves).
    const lastPlay = makeLastPlay([card("4", "clubs")], "p2");
    const hands: Card[][] = [
      [card("5", "clubs"), card("6", "hearts"), card("6", "spades")],
      [card("4", "clubs")],
      [card("7", "clubs")],
      [card("8", "clubs")],
    ];
    const state = buildState(
      [player("p1"), player("p2"), player("p3"), player("p4")],
      {
        hands,
        isFreePlay: false,
        isFirstPlayOfGame: false,
        lastPlay,
        lastPlayPlayerIndex: 1,
      },
    );
    const action = engine.getAiMoveAction(state)! as Big2PlayCardsAction;
    expect(action.type).toBe("playCards");
    expect(action.cards).toHaveLength(1);
    // Should play 5♣ (true singleton) not a 6 (which would break the pair)
    expect(action.cards[0]!.rank).toBe("5");
    expect(action.cards[0]!.suit).toBe("clubs");
  });
});

// ---------------------------------------------------------------------------
// Passes when it cannot beat
// ---------------------------------------------------------------------------

describe("getAiMoveAction — passes when it cannot beat", () => {
  it("returns pass when hand has no combo that beats lastPlay", () => {
    const lastPlay = makeLastPlay([card("2", "spades")], "p2");
    const hands: Card[][] = [
      [card("3", "clubs"), card("4", "diamonds"), card("5", "hearts")],
      [card("2", "spades")],
      [card("6", "clubs")],
      [card("7", "clubs")],
    ];
    const state = buildState(
      [player("p1"), player("p2"), player("p3"), player("p4")],
      {
        hands,
        isFreePlay: false,
        isFirstPlayOfGame: false,
        lastPlay,
        lastPlayPlayerIndex: 1,
      },
    );
    const action = engine.getAiMoveAction(state);
    expect(action!.type).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// Information hiding
// ---------------------------------------------------------------------------

describe("getAiMoveAction — information hiding", () => {
  it("returns same action regardless of what opponent hands contain", () => {
    const lastPlay = makeLastPlay([card("4", "clubs")], "p2");
    const aiHand: Card[] = [
      card("5", "clubs"),
      card("6", "diamonds"),
      card("7", "hearts"),
    ];

    const stateA = buildState(
      [player("p1"), player("p2"), player("p3"), player("p4")],
      {
        hands: [
          aiHand,
          [card("3", "clubs")],
          [card("3", "diamonds")],
          [card("3", "hearts")],
        ],
        isFreePlay: false,
        isFirstPlayOfGame: false,
        lastPlay,
        lastPlayPlayerIndex: 1,
      },
    );

    const stateB = buildState(
      [player("p1"), player("p2"), player("p3"), player("p4")],
      {
        hands: [
          aiHand,
          [card("2", "hearts")],
          [card("A", "spades")],
          [card("K", "clubs")],
        ],
        isFreePlay: false,
        isFirstPlayOfGame: false,
        lastPlay,
        lastPlayPlayerIndex: 1,
      },
    );

    const actionA = engine.getAiMoveAction(stateA);
    const actionB = engine.getAiMoveAction(stateB);

    expect(actionA!.type).toBe(actionB!.type);
    if (actionA!.type === "playCards" && actionB!.type === "playCards") {
      const cardsA = (actionA as Big2PlayCardsAction).cards;
      const cardsB = (actionB as Big2PlayCardsAction).cards;
      expect(cardsA).toEqual(cardsB);
    }
  });
});

// ---------------------------------------------------------------------------
// Null cases (same contract as getAutoTimeoutAction)
// ---------------------------------------------------------------------------

describe("getAiMoveAction — null cases", () => {
  it("returns null when game is COMPLETED", () => {
    const state = engine.initialize(
      "g",
      [player("p1"), player("p2")],
      config,
      new SeededPRNG("null-seed"),
    );
    const completedState: InternalGameState = {
      ...state,
      status: "COMPLETED",
      currentPlayerIndex: -1,
    };
    expect(engine.getAiMoveAction(completedState)).toBeNull();
  });

  it("returns null when currentPlayerIndex is -1", () => {
    const state = engine.initialize(
      "g",
      [player("p1"), player("p2")],
      config,
      new SeededPRNG("null-seed-2"),
    );
    const noCurrentState: InternalGameState = {
      ...state,
      currentPlayerIndex: -1,
    };
    expect(engine.getAiMoveAction(noCurrentState)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Full-game integration: Big2 with 1 human + 1 AI (seeded PRNG)
// ---------------------------------------------------------------------------

describe("getAiMoveAction — Big2 full game integration", () => {
  it("game with 1 human + 3 AI completes with all invariants satisfied and AI non-trivial", () => {
    // 4-player game: human at index 0, AI at indices 1/2/3.
    // The human also uses getAutoTimeoutAction so all seats drive to completion.
    // The human WILL lead at some point, putting AIs into follow position.
    const prng = new SeededPRNG("big2-ai-integ-seed-4p");
    const ps = [player("human"), player("ai1"), player("ai2"), player("ai3")];
    let state = engine.initialize("g", ps, config, prng);

    let totalApplied = 0;
    let aiPlayedInFollowPosition = false;
    const maxTurns = 2000;

    while (state.status === "IN_PROGRESS" && totalApplied < maxTurns) {
      const gs = big2State(state);
      const playerId = currentPlayerId(state);
      const isAiSeat = playerId !== "human";

      let action;
      if (isAiSeat) {
        action = engine.getAiMoveAction(state)!;
        if (
          !gs.isFreePlay &&
          !gs.isFirstPlayOfGame &&
          action.type === "playCards"
        ) {
          aiPlayedInFollowPosition = true;
        }
      } else {
        // Human uses timeout action (plays lowest single or passes)
        action = engine.getAutoTimeoutAction(state)!;
      }

      expect(engine.validateAction(state, action)).toBe(true);
      const result = engine.applyAction(state, action);
      expect(result.success).toBe(true);
      state = result.newState!;
      totalApplied++;
    }

    expect(state.status).toBe("COMPLETED");
    expect(state.winner).toBeDefined();
    expect(state.scores).not.toBeNull();
    // AI produced at least one play in a following position
    // (non-trivial vs all-pass timeout stream)
    expect(aiPlayedInFollowPosition).toBe(true);
  });
});
