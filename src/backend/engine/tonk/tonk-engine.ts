import type { GameEngine, GameEngineConfig } from "../game-engine.js";
import type { PRNG } from "../prng.js";
import { SeededPRNG, hashSeed } from "../prng.js";
import type {
  GameAction,
  ActionResult,
  InternalGameState,
  PlayerView,
  SpectatorView,
  PlayerId,
  PlayerInfo,
  PlayerScore,
  ValidAction,
  PlayerPublicInfo,
} from "@shared/engine-types";
import type {
  TonkCard,
  TonkLogEntry,
  TonkTrickResult,
  TonkPublicState,
} from "@shared/tonk-types.js";
import type {
  TonkState,
  TonkAction,
  TonkDiscardAction,
  TonkDrawAction,
} from "./tonk-types.js";
import {
  cardValue,
  handValue,
  compareTonkCards,
  LOSE_THRESHOLD,
} from "./constants.js";
import {
  buildTrickDeck,
  deckCount,
  resolveDeckRoundsTarget,
  recoverDeckRoundsTarget,
} from "./deck.js";
import { scoreTrick, resolveMatchEnd } from "./scoring.js";
import {
  computeValidActions,
  validateDiscard,
  cardsEqual,
} from "./valid-actions.js";
import {
  isTonkGateOpen,
  nextSeat,
  computeDrawableSnapshot,
  nextStarterIndex,
} from "./turn.js";

export class TonkEngine implements GameEngine {
  readonly gameType = "tonk" as const;

  initialize(
    gameId: string,
    players: readonly PlayerInfo[],
    config: GameEngineConfig,
    prng: PRNG,
  ): InternalGameState {
    if (players.length < 3 || players.length > 8) {
      throw new Error("Tonk requires 3-8 players");
    }

    const deckRoundsTarget = resolveDeckRoundsTarget(
      config.options["deckRoundsTarget"],
    );
    const numDecks = deckCount(players.length);

    const trickPrng = new SeededPRNG(String(hashSeed(prng.seed + ":trick:1")));
    const { hands, stock, deckSize } = buildTrickDeck(
      players.length,
      numDecks,
      deckRoundsTarget,
      trickPrng,
    );

    const tonkState: TonkState = {
      hands,
      stock,
      discardPile: [],
      drawableDiscard: null,
      lastDiscardCount: 0,
      lastDiscardPlayerIndex: null,
      turnPhase: "discard",
      trickNumber: 1,
      trickTurnCount: 0,
      tallies: players.map(() => 0),
      tonkCallerIndex: null,
      lostPlayerIndices: [],
      trueLoserIndex: null,
      trickDeckSize: deckSize,
      log: [],
    };

    return {
      gameId,
      gameType: "tonk",
      status: "IN_PROGRESS",
      version: 1,
      players,
      currentPlayerIndex: 0,
      turnNumber: 1,
      gameSpecificState: tonkState,
      winner: null,
      scores: null,
      randomSeed: prng.seed,
    };
  }

  validateAction(state: InternalGameState, action: GameAction): boolean {
    return this.applyAction(state, action).success;
  }

  applyAction(state: InternalGameState, action: GameAction): ActionResult {
    if (state.status === "COMPLETED") {
      return { success: false, newState: null, error: "Game is already over." };
    }
    if (state.status !== "IN_PROGRESS") {
      return { success: false, newState: null, error: "Game has not started." };
    }

    const playerIndex = state.players.findIndex(
      (p) => p.playerId === action.playerId,
    );
    if (playerIndex !== state.currentPlayerIndex) {
      return { success: false, newState: null, error: "Not your turn." };
    }

    const tonkState = state.gameSpecificState as TonkState;
    const tonkAction = action as TonkAction;

    switch (tonkAction.type) {
      case "discard":
        return this.handleDiscard(state, tonkState, tonkAction, playerIndex);
      case "draw":
        return this.handleDraw(state, tonkState, tonkAction, playerIndex);
      case "callTonk":
        return this.handleCallTonk(state, tonkState, playerIndex);
      default:
        return {
          success: false,
          newState: null,
          error: "Unknown action type.",
        };
    }
  }

  getPlayerView(state: InternalGameState, playerId: PlayerId): PlayerView {
    const tonkState = state.gameSpecificState as TonkState;
    const playerIndex = state.players.findIndex((p) => p.playerId === playerId);

    const players: PlayerPublicInfo[] = state.players.map((p, i) => ({
      playerId: p.playerId,
      displayName: p.displayName,
      cardCount: tonkState.hands[i]?.length ?? 0,
      isConnected: true,
    }));

    const myHand = playerIndex >= 0 ? (tonkState.hands[playerIndex] ?? []) : [];

    const you = {
      playerId,
      displayName:
        playerIndex >= 0
          ? (state.players[playerIndex]?.displayName ?? playerId)
          : playerId,
      // PlayerPrivateInfo.hand is typed Card[]; Tonk hands may contain jokers.
      hand: myHand as unknown as PlayerView["you"]["hand"],
    };

    return {
      gameId: state.gameId,
      gameType: state.gameType,
      status: state.status,
      version: state.version,
      players,
      you,
      currentPlayerIndex: state.currentPlayerIndex,
      turnNumber: state.turnNumber,
      validActions: this.getValidActions(state, playerId),
      gameSpecificPublicState: this.buildPublicState(state, tonkState),
      winner: state.winner,
      scores: state.scores,
    };
  }

  getValidActions(
    state: InternalGameState,
    playerId: PlayerId,
  ): readonly ValidAction[] {
    if (state.status !== "IN_PROGRESS") return [];

    const playerIndex = state.players.findIndex((p) => p.playerId === playerId);
    if (playerIndex !== state.currentPlayerIndex) return [];

    const tonkState = state.gameSpecificState as TonkState;
    return computeValidActions(tonkState, state.players.length);
  }

  isGameOver(state: InternalGameState): boolean {
    return state.status === "COMPLETED";
  }

  getAutoTimeoutAction(state: InternalGameState): GameAction | null {
    if (state.status !== "IN_PROGRESS") return null;
    if (state.currentPlayerIndex < 0) return null;

    const playerId = state.players[state.currentPlayerIndex]!.playerId;
    const tonkState = state.gameSpecificState as TonkState;

    if (tonkState.turnPhase === "draw") {
      const drawAction: TonkDrawAction = {
        type: "draw",
        playerId,
        source: "stock",
      };
      return drawAction;
    }

    // discard phase: discard the single highest-value card (never multiples,
    // never callTonk). Deterministic tie-break via compareTonkCards.
    const hand = tonkState.hands[state.currentPlayerIndex] ?? [];
    if (hand.length === 0) return null;

    let chosen = hand[0]!;
    for (let i = 1; i < hand.length; i++) {
      const card = hand[i]!;
      const diff = cardValue(card) - cardValue(chosen);
      if (diff > 0 || (diff === 0 && compareTonkCards(card, chosen) < 0)) {
        chosen = card;
      }
    }

    const discardAction: TonkDiscardAction = {
      type: "discard",
      playerId,
      cards: [chosen],
    };
    return discardAction;
  }

  getSpectatorView(
    state: InternalGameState,
    spectatorCount: number,
  ): SpectatorView {
    const tonkState = state.gameSpecificState as TonkState;

    const players: PlayerPublicInfo[] = state.players.map((p, i) => ({
      playerId: p.playerId,
      displayName: p.displayName,
      cardCount: tonkState.hands[i]?.length ?? 0,
      isConnected: true,
    }));

    return {
      gameId: state.gameId,
      gameType: state.gameType,
      status: state.status,
      version: state.version,
      players,
      currentPlayerIndex: state.currentPlayerIndex,
      turnNumber: state.turnNumber,
      gameSpecificPublicState: this.buildPublicState(state, tonkState),
      winner: state.winner,
      scores: state.scores,
      spectatorCount,
    };
  }

  private buildPublicState(
    state: InternalGameState,
    tonkState: TonkState,
  ): TonkPublicState {
    const top = tonkState.discardPile[tonkState.discardPile.length - 1] ?? null;
    return {
      turnPhase: tonkState.turnPhase,
      trickNumber: tonkState.trickNumber,
      trickTurnCount: tonkState.trickTurnCount,
      tonkGateOpen: isTonkGateOpen(
        tonkState.trickTurnCount,
        state.players.length,
      ),
      stockCount: tonkState.stock.length,
      discardTop: top,
      discardCount: tonkState.discardPile.length,
      lastDiscardCount: tonkState.lastDiscardCount,
      lastDiscardPlayerIndex: tonkState.lastDiscardPlayerIndex,
      drawableDiscard: tonkState.drawableDiscard,
      tallies: tonkState.tallies,
      log: tonkState.log,
    };
  }

  private handleDiscard(
    state: InternalGameState,
    tonkState: TonkState,
    action: TonkDiscardAction,
    playerIndex: number,
  ): ActionResult {
    if (tonkState.turnPhase !== "discard") {
      return {
        success: false,
        newState: null,
        error: "Must draw, not discard, this phase.",
      };
    }

    const hand = tonkState.hands[playerIndex] ?? [];
    const validation = validateDiscard(action.cards, hand);
    if (!validation.valid) {
      return { success: false, newState: null, error: validation.error };
    }

    const newHand = removeCards(hand, action.cards);
    const newHands = tonkState.hands.map((h, i) =>
      i === playerIndex ? newHand : h,
    );
    const newDiscardPile = [...tonkState.discardPile, ...action.cards];

    const logEntry: TonkLogEntry = {
      playerId: state.players[playerIndex]!.playerId,
      displayName: state.players[playerIndex]!.displayName,
      type: "discard",
      discarded: action.cards,
      discardCount: action.cards.length,
    };

    const newTonkState: TonkState = {
      ...tonkState,
      hands: newHands,
      discardPile: newDiscardPile,
      lastDiscardCount: action.cards.length,
      lastDiscardPlayerIndex: playerIndex,
      turnPhase: "draw",
      log: [...tonkState.log, logEntry],
    };

    return {
      success: true,
      newState: {
        ...state,
        version: state.version + 1,
        turnNumber: state.turnNumber + 1,
        gameSpecificState: newTonkState,
      },
    };
  }

  private handleDraw(
    state: InternalGameState,
    tonkState: TonkState,
    action: TonkDrawAction,
    playerIndex: number,
  ): ActionResult {
    if (tonkState.turnPhase !== "draw") {
      return {
        success: false,
        newState: null,
        error: "Cannot draw before discarding.",
      };
    }

    if (action.source !== "stock" && action.source !== "discard") {
      return { success: false, newState: null, error: "Invalid draw source." };
    }

    if (action.source === "discard") {
      if (tonkState.drawableDiscard === null) {
        return {
          success: false,
          newState: null,
          error: "No card available to draw from the discard.",
        };
      }
      return this.drawFromDiscard(state, tonkState, playerIndex);
    }

    // source === "stock"
    if (tonkState.stock.length === 0) {
      // Stock-out: trick ends, Case C scoring.
      return this.endTrick(state, tonkState, null);
    }
    return this.drawFromStock(state, tonkState, playerIndex);
  }

  private drawFromStock(
    state: InternalGameState,
    tonkState: TonkState,
    playerIndex: number,
  ): ActionResult {
    const drawn = tonkState.stock[tonkState.stock.length - 1]!;
    const newStock = tonkState.stock.slice(0, tonkState.stock.length - 1);
    const newHand = [...(tonkState.hands[playerIndex] ?? []), drawn];
    const newHands = tonkState.hands.map((h, i) =>
      i === playerIndex ? newHand : h,
    );

    return this.completeDrawTurn(state, tonkState, playerIndex, {
      hands: newHands,
      stock: newStock,
      discardPile: tonkState.discardPile,
      drawSource: "stock",
    });
  }

  private drawFromDiscard(
    state: InternalGameState,
    tonkState: TonkState,
    playerIndex: number,
  ): ActionResult {
    const snapshot = tonkState.drawableDiscard!;
    // Remove the snapshot card (the pre-discard top) from the pile. It sits just
    // below the current player's own just-discarded cards, at index
    // (len - 1 - lastDiscardCount). lastDiscardCount reflects the current
    // player's own discard placed this turn.
    const removeAt =
      tonkState.discardPile.length - 1 - tonkState.lastDiscardCount;
    const newDiscardPile = [
      ...tonkState.discardPile.slice(0, removeAt),
      ...tonkState.discardPile.slice(removeAt + 1),
    ];
    const newHand = [...(tonkState.hands[playerIndex] ?? []), snapshot];
    const newHands = tonkState.hands.map((h, i) =>
      i === playerIndex ? newHand : h,
    );

    return this.completeDrawTurn(state, tonkState, playerIndex, {
      hands: newHands,
      stock: tonkState.stock,
      discardPile: newDiscardPile,
      drawSource: "discard",
    });
  }

  private completeDrawTurn(
    state: InternalGameState,
    tonkState: TonkState,
    playerIndex: number,
    updated: {
      hands: readonly (readonly TonkCard[])[];
      stock: readonly TonkCard[];
      discardPile: readonly TonkCard[];
      drawSource: "stock" | "discard";
    },
  ): ActionResult {
    const nextIndex = nextSeat(playerIndex, state.players.length);
    // Snapshot is the single top card of the discard pile as it stands now
    // (the card the player who just finished placed), captured before the next
    // player discards. lastDiscardCount governs how many of the top are theirs.
    const snapshot = computeDrawableSnapshot(
      updated.discardPile,
      tonkState.lastDiscardCount,
    );

    const logEntry: TonkLogEntry = {
      playerId: state.players[playerIndex]!.playerId,
      displayName: state.players[playerIndex]!.displayName,
      type: "draw",
      drawSource: updated.drawSource,
    };

    const newTonkState: TonkState = {
      ...tonkState,
      hands: updated.hands,
      stock: updated.stock,
      discardPile: updated.discardPile,
      drawableDiscard: snapshot,
      turnPhase: "discard",
      trickTurnCount: tonkState.trickTurnCount + 1,
      log: [...tonkState.log, logEntry],
    };

    return {
      success: true,
      newState: {
        ...state,
        version: state.version + 1,
        turnNumber: state.turnNumber + 1,
        currentPlayerIndex: nextIndex,
        gameSpecificState: newTonkState,
      },
    };
  }

  private handleCallTonk(
    state: InternalGameState,
    tonkState: TonkState,
    playerIndex: number,
  ): ActionResult {
    if (tonkState.turnPhase !== "discard") {
      return {
        success: false,
        newState: null,
        error: "TONK can only be called at the start of your turn.",
      };
    }
    if (!isTonkGateOpen(tonkState.trickTurnCount, state.players.length)) {
      return {
        success: false,
        newState: null,
        error: "TONK can only be called after every player has had a turn.",
      };
    }

    return this.endTrick(state, tonkState, playerIndex);
  }

  /**
   * End the current trick (TONK or stock-out), score it, then either set up the
   * next trick or resolve the match end.
   */
  private endTrick(
    state: InternalGameState,
    tonkState: TonkState,
    tonkCallerIndex: number | null,
  ): ActionResult {
    const handValues = tonkState.hands.map((h) => handValue(h));
    const tallyDeltas = scoreTrick(tonkState.hands, tonkCallerIndex);
    const newTallies = tonkState.tallies.map((t, i) => t + tallyDeltas[i]!);

    const trickResult: TonkTrickResult = {
      trickNumber: tonkState.trickNumber,
      reason: tonkCallerIndex !== null ? "tonk" : "stockout",
      tonkCallerIndex,
      revealedHands: tonkState.hands,
      handValues,
      tallyDeltas,
    };

    // A callTonk that ends the trick is logged as the trick-result entry itself
    // (its type is "callTonk"); a stock-out result is logged as a "draw" entry
    // (the trick ended on the draw that found an empty stock).
    const resultPlayerIndex = tonkCallerIndex ?? state.currentPlayerIndex;
    const resultLogEntry: TonkLogEntry = {
      playerId: state.players[resultPlayerIndex]!.playerId,
      displayName: state.players[resultPlayerIndex]!.displayName,
      type: tonkCallerIndex !== null ? "callTonk" : "draw",
      trickResult,
    };

    const newLog = [...tonkState.log, resultLogEntry];

    // Match-end check (deterministic TRUE-LOSER draw via derived sub-seed).
    const matchPrng = new SeededPRNG(
      String(
        hashSeed(state.randomSeed + ":trueloser:" + tonkState.trickNumber),
      ),
    );
    const matchEnd = resolveMatchEnd(newTallies, matchPrng);

    if (matchEnd) {
      return this.completeMatch(state, tonkState, newTallies, matchEnd, newLog);
    }

    return this.setupNextTrick(state, tonkState, newTallies, newLog);
  }

  private completeMatch(
    state: InternalGameState,
    tonkState: TonkState,
    newTallies: readonly number[],
    matchEnd: { lostPlayerIndices: readonly number[]; trueLoserIndex: number },
    newLog: readonly TonkLogEntry[],
  ): ActionResult {
    // Winner = lowest final tally (display only; ties -> lowest seat index).
    let winnerIndex = 0;
    for (let i = 1; i < newTallies.length; i++) {
      if (newTallies[i]! < newTallies[winnerIndex]!) winnerIndex = i;
    }

    const scores: PlayerScore[] = state.players.map((p, i) => ({
      playerId: p.playerId,
      score: newTallies[i]!,
      breakdown: {
        lost: newTallies[i]! >= LOSE_THRESHOLD ? 1 : 0,
        trueLoser: i === matchEnd.trueLoserIndex ? 1 : 0,
        finalTally: newTallies[i]!,
      },
    }));

    const newTonkState: TonkState = {
      ...tonkState,
      tallies: newTallies,
      lostPlayerIndices: matchEnd.lostPlayerIndices,
      trueLoserIndex: matchEnd.trueLoserIndex,
      log: newLog,
    };

    return {
      success: true,
      newState: {
        ...state,
        version: state.version + 1,
        turnNumber: state.turnNumber + 1,
        status: "COMPLETED",
        currentPlayerIndex: -1,
        winner: state.players[winnerIndex]!.playerId,
        scores,
        gameSpecificState: newTonkState,
      },
    };
  }

  private setupNextTrick(
    state: InternalGameState,
    tonkState: TonkState,
    newTallies: readonly number[],
    newLog: readonly TonkLogEntry[],
  ): ActionResult {
    const newTrickNumber = tonkState.trickNumber + 1;
    // numDecks is deterministic from player count; the match's deckRoundsTarget
    // is recovered from the first/current trick's deck size so subsequent tricks
    // reproduce the same cut without storing the target separately.
    const numDecks = deckCount(state.players.length);
    const target = recoverDeckRoundsTarget(
      state.players.length,
      numDecks,
      tonkState.trickDeckSize,
    );

    const trickPrng = new SeededPRNG(
      String(hashSeed(state.randomSeed + ":trick:" + newTrickNumber)),
    );
    const { hands, stock, deckSize } = buildTrickDeck(
      state.players.length,
      numDecks,
      target,
      trickPrng,
    );

    const starterIndex = nextStarterIndex(newTallies);

    // Trick 2+ flips one face-up start card from the stock into the discard
    // pile; it is the starter's initial drawableDiscard snapshot.
    let discardPile: readonly TonkCard[] = [];
    let drawableDiscard: TonkCard | null = null;
    let remainingStock = stock;
    let lastDiscardCount = 0;
    let lastDiscardPlayerIndex: number | null = null;
    if (stock.length > 0) {
      const flip = stock[stock.length - 1]!;
      remainingStock = stock.slice(0, stock.length - 1);
      discardPile = [flip];
      drawableDiscard = flip;
      lastDiscardCount = 1;
      lastDiscardPlayerIndex = null;
    }

    const newTonkState: TonkState = {
      ...tonkState,
      hands,
      stock: remainingStock,
      discardPile,
      drawableDiscard,
      lastDiscardCount,
      lastDiscardPlayerIndex,
      turnPhase: "discard",
      trickNumber: newTrickNumber,
      trickTurnCount: 0,
      tallies: newTallies,
      tonkCallerIndex: null,
      trickDeckSize: deckSize,
      log: newLog,
    };

    return {
      success: true,
      newState: {
        ...state,
        version: state.version + 1,
        turnNumber: state.turnNumber + 1,
        currentPlayerIndex: starterIndex,
        gameSpecificState: newTonkState,
      },
    };
  }
}

/** Remove the given cards from a hand (each one occurrence), preserving order. */
function removeCards(
  hand: readonly TonkCard[],
  cards: readonly TonkCard[],
): TonkCard[] {
  const remaining = [...hand];
  for (const card of cards) {
    const idx = remaining.findIndex((h) => cardsEqual(h, card));
    if (idx >= 0) remaining.splice(idx, 1);
  }
  return remaining;
}
