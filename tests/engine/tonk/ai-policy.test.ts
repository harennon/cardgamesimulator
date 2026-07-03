import { describe, it, expect } from "vitest";
import { TonkEngine } from "../../../src/backend/engine/tonk/tonk-engine.js";
import { SeededPRNG } from "../../../src/backend/engine/prng.js";
import { buildTonkState, c, j, players } from "./helpers.js";
import { TONK_CALL_THRESHOLD } from "../../../src/backend/engine/tonk/ai-policy.js";
import type {
  TonkDiscardAction,
  TonkDrawAction,
  TonkCallTonkAction,
} from "../../../src/backend/engine/tonk/tonk-types.js";
import type { InternalGameState } from "../../../src/shared/engine-types.js";

const engine = new TonkEngine();
const config = { maxPlayers: 8, minPlayers: 3, options: {} };

// ---------------------------------------------------------------------------
// Always legal
// ---------------------------------------------------------------------------

describe("getAiMoveAction — Tonk always legal", () => {
  it("discard phase (gate closed): returned action is legal", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [c("3", "clubs"), c("K", "hearts"), c("5", "spades")],
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 0,
      },
    });
    const action = engine.getAiMoveAction(state)!;
    expect(action).not.toBeNull();
    expect(engine.validateAction(state, action)).toBe(true);
    expect(engine.applyAction(state, action).success).toBe(true);
  });

  it("discard phase (gate open, low hand): callTonk is legal", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [c("3", "clubs"), c("4", "diamonds")], // handValue = 7 <= threshold
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 5, // gate open (>= 3 players)
      },
    });
    const action = engine.getAiMoveAction(state)!;
    expect(engine.validateAction(state, action)).toBe(true);
    expect(engine.applyAction(state, action).success).toBe(true);
  });

  it("draw phase (stock available): returned action is legal", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [c("5", "clubs"), c("K", "hearts")],
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        turnPhase: "draw",
      },
    });
    const action = engine.getAiMoveAction(state)!;
    expect(engine.validateAction(state, action)).toBe(true);
    expect(engine.applyAction(state, action).success).toBe(true);
  });

  it("draw phase (stock empty): returned action is legal (triggers stock-out)", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("3", "clubs")], [c("9", "hearts")], [c("K", "spades")]],
        stock: [],
        discardPile: [c("4", "clubs")],
        turnPhase: "draw",
        trickTurnCount: 3,
      },
    });
    const action = engine.getAiMoveAction(state)!;
    expect(action.type).toBe("draw");
    expect((action as TonkDrawAction).source).toBe("stock");
    expect(engine.applyAction(state, action).success).toBe(true);
  });

  it("draw phase (drawable present): returned action is legal", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [c("K", "hearts"), c("Q", "spades")],
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        discardPile: [c("3", "clubs")],
        drawableDiscard: c("3", "clubs"),
        lastDiscardCount: 1,
        turnPhase: "draw",
      },
    });
    const action = engine.getAiMoveAction(state)!;
    expect(engine.validateAction(state, action)).toBe(true);
    expect(engine.applyAction(state, action).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Discard to minimize value
// ---------------------------------------------------------------------------

describe("getAiMoveAction — discards to minimize hand value", () => {
  it("discards the highest-value single card", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [c("3", "clubs"), c("K", "hearts"), c("5", "spades")],
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
      },
    });
    const action = engine.getAiMoveAction(state) as TonkDiscardAction;
    expect(action.type).toBe("discard");
    expect(action.cards).toHaveLength(1);
    expect(action.cards[0]).toEqual(c("K", "hearts")); // K = 10 pts, highest
  });

  it("discards full pair of Kings (20 pts) over single lower card", () => {
    // Pair of Kings (20 pts) vs single 9 (9 pts) vs single 4 (4 pts)
    // Should discard both Kings to maximize point reduction
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [
            c("K", "hearts"),
            c("K", "spades"),
            c("9", "clubs"),
            c("4", "diamonds"),
          ],
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
      },
    });
    const action = engine.getAiMoveAction(state) as TonkDiscardAction;
    expect(action.type).toBe("discard");
    // Should discard both Kings (total 20 pts > single 9 = 9 pts)
    expect(action.cards).toHaveLength(2);
    expect(action.cards.every((c) => c.rank === "K")).toBe(true);
  });

  it("tie-break deterministic via compareTonkCards", () => {
    // Two singles of same value (J clubs = 10, Q spades = 10) — same point value
    // compareTonkCards determines order: J (rank index lower) sorts before Q
    // So among equal-score groups, prefer the one whose lowest card sorts first
    const make = () =>
      buildTonkState({
        playerCount: 3,
        currentPlayerIndex: 0,
        tonk: {
          hands: [
            [c("J", "clubs"), c("Q", "spades"), c("5", "diamonds")],
            [c("6", "clubs")],
            [c("7", "clubs")],
          ],
          stock: [c("8", "clubs")],
          turnPhase: "discard",
        },
      });
    const a = engine.getAiMoveAction(make()) as TonkDiscardAction;
    const b = engine.getAiMoveAction(make()) as TonkDiscardAction;
    // Both calls must return the same card (deterministic)
    expect(a.cards[0]).toEqual(b.cards[0]);
  });

  it("never discards jokers when non-joker cards exist", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [j(0), c("4", "clubs"), c("5", "diamonds")],
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
      },
    });
    const action = engine.getAiMoveAction(state) as TonkDiscardAction;
    expect(action.type).toBe("discard");
    // Should not discard the joker
    const discardedJoker = action.cards.some(
      (c) => "joker" in c && c.joker === true,
    );
    expect(discardedJoker).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TONK calling
// ---------------------------------------------------------------------------

describe("getAiMoveAction — TONK calling", () => {
  it("calls TONK when gate open and hand value at threshold", () => {
    // hand value = TONK_CALL_THRESHOLD exactly
    // Need cards that sum to exactly TONK_CALL_THRESHOLD
    // 3+4+3 = 10 = TONK_CALL_THRESHOLD (3♣=3, 4♦=4, 3♠=3)
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [c("3", "clubs"), c("4", "diamonds"), c("3", "spades")], // 3+4+3=10
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 5, // gate open
      },
    });
    const action = engine.getAiMoveAction(state)!;
    expect(action.type).toBe("callTonk");
  });

  it("calls TONK when gate open and hand value below threshold", () => {
    // hand = 3♣ + 4♦ = 7 < threshold
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [c("3", "clubs"), c("4", "diamonds")], // 3+4=7
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 5,
      },
    });
    const action = engine.getAiMoveAction(state)!;
    expect(action.type).toBe("callTonk");
  });

  it("does NOT call TONK when gate open but hand value above threshold", () => {
    // hand value = 11 > TONK_CALL_THRESHOLD (10)
    // 3+4+4 = 11
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [c("3", "clubs"), c("4", "diamonds"), c("4", "hearts")], // 3+4+4=11
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 5,
      },
    });
    const action = engine.getAiMoveAction(state)!;
    expect(action.type).toBe("discard"); // discards instead
  });

  it("does NOT call TONK when gate closed even if hand is low", () => {
    // hand value = 3, but trickTurnCount = 0 → gate closed
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [c("3", "clubs")], // value=3, very low
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 0, // gate closed
      },
    });
    const action = engine.getAiMoveAction(state)!;
    expect(action.type).toBe("discard"); // cannot callTonk
  });

  it("TONK_CALL_THRESHOLD is 10", () => {
    expect(TONK_CALL_THRESHOLD).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Draw phase decisions
// ---------------------------------------------------------------------------

describe("getAiMoveAction — draw phase decisions", () => {
  it("draws from discard when drawable card is cheaper than cheapest held card", () => {
    // Hand has K(10), Q(10); drawable = 3(3) < 10 → draw discard
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [c("K", "hearts"), c("Q", "spades")],
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        discardPile: [c("3", "clubs")],
        drawableDiscard: c("3", "clubs"),
        lastDiscardCount: 1,
        turnPhase: "draw",
      },
    });
    const action = engine.getAiMoveAction(state) as TonkDrawAction;
    expect(action.type).toBe("draw");
    expect(action.source).toBe("discard");
  });

  it("draws from stock when drawable card is same value as cheapest held card", () => {
    // Hand has 3(3); drawable = 3(3) — same value, not strictly cheaper → stock
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [c("3", "clubs"), c("K", "hearts")],
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        discardPile: [c("3", "diamonds")],
        drawableDiscard: c("3", "diamonds"),
        lastDiscardCount: 1,
        turnPhase: "draw",
      },
    });
    const action = engine.getAiMoveAction(state) as TonkDrawAction;
    expect(action.type).toBe("draw");
    expect(action.source).toBe("stock");
  });

  it("draws from stock when drawable card is more expensive than cheapest held", () => {
    // Hand has 3(3), K(10); drawable = 5(5) > 3 → stock
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [c("3", "clubs"), c("K", "hearts")],
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        discardPile: [c("5", "diamonds")],
        drawableDiscard: c("5", "diamonds"),
        lastDiscardCount: 1,
        turnPhase: "draw",
      },
    });
    const action = engine.getAiMoveAction(state) as TonkDrawAction;
    expect(action.source).toBe("stock");
  });

  it("draws from stock when no drawable discard (null)", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          [c("K", "hearts"), c("Q", "spades")],
          [c("6", "clubs")],
          [c("7", "clubs")],
        ],
        stock: [c("8", "clubs")],
        drawableDiscard: null,
        turnPhase: "draw",
      },
    });
    const action = engine.getAiMoveAction(state) as TonkDrawAction;
    expect(action.source).toBe("stock");
  });

  it("joker in hand: drawable card (>=1) is never strictly cheaper than joker (0) → stock", () => {
    // Joker has value 0; any real card has value >= 1
    // So drawable is never strictly cheaper than joker → draw stock (keep joker)
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[j(0), c("K", "hearts")], [c("6", "clubs")], [c("7", "clubs")]],
        stock: [c("8", "clubs")],
        discardPile: [c("3", "clubs")],
        drawableDiscard: c("3", "clubs"),
        lastDiscardCount: 1,
        turnPhase: "draw",
      },
    });
    const action = engine.getAiMoveAction(state) as TonkDrawAction;
    expect(action.source).toBe("stock"); // keeps joker, draws stock
  });

  it("stock-out (stockCount=0): returns draw:stock which ends the trick", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [[c("3", "clubs")], [c("9", "hearts")], [c("K", "spades")]],
        stock: [],
        discardPile: [c("4", "clubs")],
        turnPhase: "draw",
        trickTurnCount: 3,
      },
    });
    const action = engine.getAiMoveAction(state) as TonkDrawAction;
    expect(action.source).toBe("stock");
    const result = engine.applyAction(state, action);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Information hiding
// ---------------------------------------------------------------------------

describe("getAiMoveAction — Tonk information hiding", () => {
  it("returns same action regardless of opponent hands", () => {
    // Both states have identical AI hand (seat 0) and public state
    const aiHand = [c("K", "hearts"), c("Q", "spades"), c("7", "clubs")];

    const stateA = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          aiHand,
          [c("3", "clubs")], // opponents with low cards
          [c("4", "diamonds")],
        ],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 0,
      },
    });

    const stateB = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: 0,
      tonk: {
        hands: [
          aiHand,
          [c("2", "spades")], // opponents with high cards
          [c("A", "hearts")],
        ],
        stock: [c("8", "clubs")],
        turnPhase: "discard",
        trickTurnCount: 0,
      },
    });

    const actionA = engine.getAiMoveAction(stateA) as TonkDiscardAction;
    const actionB = engine.getAiMoveAction(stateB) as TonkDiscardAction;

    expect(actionA.type).toBe(actionB.type);
    expect(actionA.cards).toEqual(actionB.cards);
  });
});

// ---------------------------------------------------------------------------
// Null cases
// ---------------------------------------------------------------------------

describe("getAiMoveAction — Tonk null cases", () => {
  it("returns null when game is COMPLETED", () => {
    const state = buildTonkState({
      playerCount: 3,
      status: "COMPLETED",
      currentPlayerIndex: -1,
      tonk: { hands: [[], [], []], stock: [] },
    });
    expect(engine.getAiMoveAction(state)).toBeNull();
  });

  it("returns null when currentPlayerIndex < 0", () => {
    const state = buildTonkState({
      playerCount: 3,
      currentPlayerIndex: -1,
      tonk: {
        hands: [[c("5", "clubs")], [c("6", "clubs")], [c("7", "clubs")]],
        stock: [c("8", "clubs")],
      },
    });
    expect(engine.getAiMoveAction(state)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Full-game integration: Tonk with 1 human + 2 AI
// ---------------------------------------------------------------------------

describe("getAiMoveAction — Tonk full game integration", () => {
  it("3-player game (1 human + 2 AI) completes with all invariants satisfied and AI non-trivial", () => {
    const prng = new SeededPRNG("tonk-ai-integ-seed");
    let state = engine.initialize(
      "g",
      [
        { playerId: "human", displayName: "Human" },
        { playerId: "ai1", displayName: "AI1" },
        { playerId: "ai2", displayName: "AI2" },
      ],
      config,
      prng,
    );

    let totalApplied = 0;
    let aiCalledTonkOrDrawedDiscard = false;
    const maxTurns = 5000;

    while (state.status === "IN_PROGRESS" && totalApplied < maxTurns) {
      const playerId = state.players[state.currentPlayerIndex]!.playerId;
      const isAiSeat = playerId === "ai1" || playerId === "ai2";

      let action;
      if (isAiSeat) {
        action = engine.getAiMoveAction(state)!;
        if (action.type === "callTonk") {
          aiCalledTonkOrDrawedDiscard = true;
        }
        if (
          action.type === "draw" &&
          (action as TonkDrawAction).source === "discard"
        ) {
          aiCalledTonkOrDrawedDiscard = true;
        }
      } else {
        // Human: use timeout action (deterministic fallback)
        action = engine.getAutoTimeoutAction(state)!;
      }

      // Invariant: action is always legal
      expect(engine.validateAction(state, action)).toBe(true);

      const result = engine.applyAction(state, action);
      expect(result.success).toBe(true);
      state = result.newState!;
      totalApplied++;
    }

    expect(state.status).toBe("COMPLETED");
    expect(state.winner).toBeDefined();
    expect(state.scores).not.toBeNull();
    // AI exercised the policy distinctly from the timeout stream
    expect(aiCalledTonkOrDrawedDiscard).toBe(true);
  });
});
