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
  ValidAction,
  PlayerPublicInfo,
} from "@shared/engine-types";
import type {
  TonkState,
  TonkAction,
  TonkCard,
  TonkLogEntry,
  TonkPublicState,
  TonkDiscardAction,
  TonkDrawAction,
} from "./tonk-types.js";
import { buildTonkDeck } from "./deck.js";
import {
  cardValue,
  clampDeckRoundsTarget,
  compareTonkCards,
  tonkCardEquals,
} from "./constants.js";
import {
  computeValidActions,
  validateDiscard,
  validateDrawSource,
} from "./valid-actions.js";
import {
  scoreTrick,
  resolveMatchEnd,
  finalScores,
  TONK_LOSS_THRESHOLD,
} from "./scoring.js";

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

    const rawTarget = Number(config.options.deckRoundsTarget);
    const deckRoundsTarget = Number.isNaN(rawTarget)
      ? 8
      : clampDeckRoundsTarget(rawTarget);

    const rawExtra = Number(config.options.extraDecks);
    const extraDecks = Number.isNaN(rawExtra) ? 0 : rawExtra;
    const numDecks = Math.ceil(players.length / 5) + extraDecks;

    // Trick-1 deck uses a deterministic sub-seed derived from the seed, exactly
    // as inter-trick rebuilds do — so replay from randomSeed alone is exact.
    const trickPrng = new SeededPRNG(
      hashSeed(prng.seed + ":trick:1").toString(),
    );
    const { hands, stock, trickDeckSize } = buildTonkDeck(
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
      trickDeckSize,
      tallies: players.map(() => 0),
      deckRoundsTarget,
      numDecks,
      tonkCallerIndex: null,
      lostPlayerIndices: [],
      trueLoserIndex: null,
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

    if (tonkAction.type === "discard") {
      return this.handleDiscard(state, tonkState, tonkAction, playerIndex);
    }
    if (tonkAction.type === "draw") {
      return this.handleDraw(state, tonkState, tonkAction, playerIndex);
    }
    if (tonkAction.type === "callTonk") {
      return this.handleCallTonk(state, tonkState, playerIndex);
    }

    return { success: false, newState: null, error: "Unknown action type." };
  }

  getPlayerView(state: InternalGameState, playerId: PlayerId): PlayerView {
    const tonkState = state.gameSpecificState as TonkState;
    const playerIndex = state.players.findIndex((p) => p.playerId === playerId);

    const players = this.publicPlayers(state, tonkState);

    const myHand = playerIndex >= 0 ? (tonkState.hands[playerIndex] ?? []) : [];

    const you = {
      playerId,
      displayName:
        playerIndex >= 0
          ? (state.players[playerIndex]?.displayName ?? playerId)
          : playerId,
      hand: [...myHand].sort(compareTonkCards),
    };

    return {
      gameId: state.gameId,
      gameType: state.gameType,
      status: state.status,
      version: state.version,
      players,
      you: you as PlayerView["you"],
      currentPlayerIndex: state.currentPlayerIndex,
      turnNumber: state.turnNumber,
      validActions: this.getValidActions(state, playerId),
      gameSpecificPublicState: this.publicState(state, tonkState),
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

    // Discard phase: discard the single highest-value card (never multiples,
    // never TONK). Deterministic tie-break via compareTonkCards.
    const hand = tonkState.hands[state.currentPlayerIndex] ?? [];
    if (hand.length === 0) return null;
    const highest = this.highestValueCard(hand);
    const discardAction: TonkDiscardAction = {
      type: "discard",
      playerId,
      cards: [highest],
    };
    return discardAction;
  }

  getSpectatorView(
    state: InternalGameState,
    spectatorCount: number,
  ): SpectatorView {
    const tonkState = state.gameSpecificState as TonkState;

    return {
      gameId: state.gameId,
      gameType: state.gameType,
      status: state.status,
      version: state.version,
      players: this.publicPlayers(state, tonkState),
      currentPlayerIndex: state.currentPlayerIndex,
      turnNumber: state.turnNumber,
      gameSpecificPublicState: this.publicState(state, tonkState),
      winner: state.winner,
      scores: state.scores,
      spectatorCount,
    };
  }

  // ---- Action handlers -----------------------------------------------------

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
        error: "Must draw to finish your turn",
      };
    }

    const hand = tonkState.hands[playerIndex] ?? [];
    const validation = validateDiscard(action.cards, hand);
    if (!validation.valid) {
      return { success: false, newState: null, error: validation.error };
    }

    // Remove each discarded card (one instance per payload card) from the hand.
    const newHand = hand.slice();
    for (const c of action.cards) {
      const idx = newHand.findIndex((h) => tonkCardEquals(h, c));
      newHand.splice(idx, 1);
    }

    const newHands = tonkState.hands.map((h, i) =>
      i === playerIndex ? newHand : h,
    );
    const newDiscardPile = [...tonkState.discardPile, ...action.cards];

    const logEntry: TonkLogEntry = {
      playerId: state.players[playerIndex]!.playerId,
      displayName: state.players[playerIndex]!.displayName,
      kind: "discard",
      cards: action.cards,
      trickNumber: tonkState.trickNumber,
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
        error: "Cannot draw before discarding",
      };
    }

    const sourceValidation = validateDrawSource(action.source, tonkState);
    if (!sourceValidation.valid) {
      return { success: false, newState: null, error: sourceValidation.error };
    }

    if (action.source === "stock" && tonkState.stock.length === 0) {
      // Stock-out: the trick ends under Case C (no draw possible).
      return this.endTrick(state, tonkState, null);
    }

    const hand = tonkState.hands[playerIndex] ?? [];
    let drawnCard: TonkCard;
    let newStock = tonkState.stock;
    let newDiscardPile = tonkState.discardPile;

    if (action.source === "stock") {
      drawnCard = tonkState.stock[tonkState.stock.length - 1] as TonkCard;
      newStock = tonkState.stock.slice(0, tonkState.stock.length - 1);
    } else {
      // Draw the exact snapshot card from the discard pile (not the live top).
      const snapshot = tonkState.drawableDiscard as TonkCard;
      drawnCard = snapshot;
      const idx = tonkState.discardPile.findIndex((c) =>
        tonkCardEquals(c, snapshot),
      );
      newDiscardPile = tonkState.discardPile.filter((_, i) => i !== idx);
    }

    const newHand = [...hand, drawnCard];
    const newHands = tonkState.hands.map((h, i) =>
      i === playerIndex ? newHand : h,
    );

    const playerCount = state.players.length;
    const nextPlayerIndex = (playerIndex + 1) % playerCount;
    const newTrickTurnCount = tonkState.trickTurnCount + 1;

    // The next player's drawable snapshot is the live discard-pile top after
    // this draw (the card the player who just finished placed), or null if
    // the pile is now empty.
    const nextDrawable =
      newDiscardPile.length > 0
        ? (newDiscardPile[newDiscardPile.length - 1] as TonkCard)
        : null;

    const logEntry: TonkLogEntry = {
      playerId: state.players[playerIndex]!.playerId,
      displayName: state.players[playerIndex]!.displayName,
      kind: "draw",
      drawSource: action.source,
      trickNumber: tonkState.trickNumber,
    };

    const newTonkState: TonkState = {
      ...tonkState,
      hands: newHands,
      stock: newStock,
      discardPile: newDiscardPile,
      drawableDiscard: nextDrawable,
      turnPhase: "discard",
      trickTurnCount: newTrickTurnCount,
      log: [...tonkState.log, logEntry],
    };

    return {
      success: true,
      newState: {
        ...state,
        version: state.version + 1,
        turnNumber: state.turnNumber + 1,
        currentPlayerIndex: nextPlayerIndex,
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
        error: "Must draw to finish your turn",
      };
    }
    if (tonkState.trickTurnCount < state.players.length) {
      return {
        success: false,
        newState: null,
        error: "TONK can only be called after every player has had a turn",
      };
    }

    return this.endTrick(state, tonkState, playerIndex);
  }

  // ---- Trick / match resolution -------------------------------------------

  private endTrick(
    state: InternalGameState,
    tonkState: TonkState,
    tonkCallerIndex: number | null,
  ): ActionResult {
    const deltas = scoreTrick(tonkState.hands, tonkCallerIndex);
    const newTallies = tonkState.tallies.map(
      (t, i) => t + (deltas[i] as number),
    );

    const caller = tonkCallerIndex;
    const resultEntry: TonkLogEntry = {
      playerId:
        caller !== null
          ? state.players[caller]!.playerId
          : state.players[state.currentPlayerIndex]!.playerId,
      displayName:
        caller !== null
          ? state.players[caller]!.displayName
          : state.players[state.currentPlayerIndex]!.displayName,
      kind: "trickResult",
      trickNumber: tonkState.trickNumber,
      deltas,
      revealedHands: tonkState.hands.map((h) => [...h]),
    };

    const callEntry: TonkLogEntry | null =
      caller !== null
        ? {
            playerId: state.players[caller]!.playerId,
            displayName: state.players[caller]!.displayName,
            kind: "callTonk",
            trickNumber: tonkState.trickNumber,
          }
        : null;

    const logWithCall = callEntry
      ? [...tonkState.log, callEntry]
      : tonkState.log;
    const newLog = [...logWithCall, resultEntry];

    const matchOver = newTallies.some((t) => t >= TONK_LOSS_THRESHOLD);

    if (matchOver) {
      return this.resolveMatch(state, tonkState, newTallies, caller, newLog);
    }

    return this.beginNextTrick(state, tonkState, newTallies, caller, newLog);
  }

  private resolveMatch(
    state: InternalGameState,
    tonkState: TonkState,
    tallies: readonly number[],
    tonkCallerIndex: number | null,
    log: readonly TonkLogEntry[],
  ): ActionResult {
    const drawPrng = new SeededPRNG(
      hashSeed(
        state.randomSeed + ":trueloser:" + tonkState.trickNumber,
      ).toString(),
    );
    const { lostPlayerIndices, trueLoserIndex, winnerIndex } = resolveMatchEnd(
      tallies,
      drawPrng,
    );

    const scores = finalScores(state.players, tallies, trueLoserIndex);

    const newTonkState: TonkState = {
      ...tonkState,
      tallies,
      tonkCallerIndex,
      lostPlayerIndices,
      trueLoserIndex,
      log,
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

  private beginNextTrick(
    state: InternalGameState,
    tonkState: TonkState,
    tallies: readonly number[],
    tonkCallerIndex: number | null,
    log: readonly TonkLogEntry[],
  ): ActionResult {
    const newTrickNumber = tonkState.trickNumber + 1;
    const playerCount = state.players.length;

    const trickPrng = new SeededPRNG(
      hashSeed(state.randomSeed + ":trick:" + newTrickNumber).toString(),
    );
    const { hands, stock, trickDeckSize } = buildTonkDeck(
      playerCount,
      tonkState.numDecks,
      tonkState.deckRoundsTarget,
      trickPrng,
    );

    // Flip one face-up start card from the stock into the discard pile.
    const faceUpCard = stock[stock.length - 1] as TonkCard;
    const remainingStock = stock.slice(0, stock.length - 1);
    const discardPile: readonly TonkCard[] = [faceUpCard];

    // Next starter = highest-tally player; ties → lowest seat index.
    let starterIndex = 0;
    for (let i = 1; i < tallies.length; i++) {
      if ((tallies[i] as number) > (tallies[starterIndex] as number)) {
        starterIndex = i;
      }
    }

    const newTonkState: TonkState = {
      ...tonkState,
      hands,
      stock: remainingStock,
      discardPile,
      drawableDiscard: faceUpCard,
      lastDiscardCount: 0,
      lastDiscardPlayerIndex: null,
      turnPhase: "discard",
      trickNumber: newTrickNumber,
      trickTurnCount: 0,
      trickDeckSize,
      tallies,
      tonkCallerIndex,
      log,
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

  // ---- View helpers --------------------------------------------------------

  private publicPlayers(
    state: InternalGameState,
    tonkState: TonkState,
  ): PlayerPublicInfo[] {
    return state.players.map((p, i) => ({
      playerId: p.playerId,
      displayName: p.displayName,
      cardCount: tonkState.hands[i]?.length ?? 0,
      isConnected: true,
    }));
  }

  private publicState(
    state: InternalGameState,
    tonkState: TonkState,
  ): TonkPublicState {
    const discardTop =
      tonkState.discardPile.length > 0
        ? (tonkState.discardPile[tonkState.discardPile.length - 1] as TonkCard)
        : null;

    return {
      discardTop,
      discardCount: tonkState.discardPile.length,
      lastDiscardCount: tonkState.lastDiscardCount,
      lastDiscardPlayerIndex: tonkState.lastDiscardPlayerIndex,
      drawableDiscard: tonkState.drawableDiscard,
      stockCount: tonkState.stock.length,
      opponentHandCounts: tonkState.hands.map((h) => h.length),
      turnPhase: tonkState.turnPhase,
      trickNumber: tonkState.trickNumber,
      trickTurnCount: tonkState.trickTurnCount,
      tonkGateOpen: tonkState.trickTurnCount >= state.players.length,
      tallies: tonkState.tallies,
      tonkCallerIndex: tonkState.tonkCallerIndex,
      trueLoserIndex: tonkState.trueLoserIndex,
      log: tonkState.log,
    };
  }

  private highestValueCard(hand: readonly TonkCard[]): TonkCard {
    const sorted = [...hand].sort(compareTonkCards);
    let best = sorted[0] as TonkCard;
    let bestValue = cardValue(best);
    for (const c of sorted) {
      const v = cardValue(c);
      if (v > bestValue) {
        best = c;
        bestValue = v;
      }
    }
    return best;
  }
}
