import type { GameEngine, GameEngineConfig } from "../game-engine.js";
import type { PRNG } from "../prng.js";
import type {
  Card,
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
  Big2State,
  Big2Action,
  Big2PlayCardsAction,
  Big2PublicState,
} from "./big2-types.js";
import { buildDeck } from "./deck.js";
import { isValidPlay, computeValidActions } from "./valid-actions.js";
import { computeScores } from "./scoring.js";
import { compareCards } from "./constants.js";

export class Big2Engine implements GameEngine {
  readonly gameType = "big2" as const;

  initialize(
    gameId: string,
    players: readonly PlayerInfo[],
    _config: GameEngineConfig,
    prng: PRNG,
  ): InternalGameState {
    if (players.length < 2 || players.length > 4) {
      throw new Error("Big2 requires 2-4 players");
    }

    const { hands, lowestCard } = buildDeck(players.length, prng);

    const startingPlayerIndex = hands.findIndex((hand) =>
      hand.some(
        (c) => c.rank === lowestCard.rank && c.suit === lowestCard.suit,
      ),
    );

    const big2State: Big2State = {
      hands,
      lastPlay: null,
      lastPlayPlayerIndex: null,
      consecutivePasses: 0,
      isFreePlay: true,
      isFirstPlayOfGame: true,
      playHistory: [],
      finishedPlayerIndices: [],
      trickStartIndex: 0,
    };

    return {
      gameId,
      gameType: "big2",
      status: "IN_PROGRESS",
      version: 1,
      players,
      currentPlayerIndex: startingPlayerIndex,
      turnNumber: 1,
      gameSpecificState: big2State,
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

    const big2State = state.gameSpecificState as Big2State;
    const big2Action = action as Big2Action;

    if (big2Action.type === "playCards") {
      return this.handlePlayCards(state, big2State, big2Action, playerIndex);
    }

    if (big2Action.type === "pass") {
      return this.handlePass(state, big2State, playerIndex);
    }

    return { success: false, newState: null, error: "Unknown action type." };
  }

  getPlayerView(state: InternalGameState, playerId: PlayerId): PlayerView {
    const big2State = state.gameSpecificState as Big2State;
    const playerIndex = state.players.findIndex((p) => p.playerId === playerId);

    const players: PlayerPublicInfo[] = state.players.map((p, i) => ({
      playerId: p.playerId,
      displayName: p.displayName,
      cardCount: big2State.hands[i]?.length ?? 0,
      isConnected: true,
    }));

    const myHand = playerIndex >= 0 ? (big2State.hands[playerIndex] ?? []) : [];

    const you = {
      playerId,
      displayName:
        playerIndex >= 0
          ? (state.players[playerIndex]?.displayName ?? playerId)
          : playerId,
      hand: [...myHand].sort(compareCards),
    };

    const publicState: Big2PublicState = {
      lastPlay: big2State.lastPlay,
      consecutivePasses: big2State.consecutivePasses,
      isFreePlay: big2State.isFreePlay,
      isFirstPlayOfGame: big2State.isFirstPlayOfGame,
      playHistory: big2State.playHistory,
      finishedPlayerIndices: big2State.finishedPlayerIndices,
      trickStartIndex: big2State.trickStartIndex ?? 0,
    };

    const validActions = this.getValidActions(state, playerId);

    return {
      gameId: state.gameId,
      gameType: state.gameType,
      status: state.status,
      version: state.version,
      players,
      you,
      currentPlayerIndex: state.currentPlayerIndex,
      turnNumber: state.turnNumber,
      validActions,
      gameSpecificPublicState: publicState,
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

    const big2State = state.gameSpecificState as Big2State;

    if (big2State.finishedPlayerIndices.includes(playerIndex)) return [];

    const hand = big2State.hands[playerIndex] ?? [];
    return computeValidActions(big2State, hand);
  }

  isGameOver(state: InternalGameState): boolean {
    return state.status === "COMPLETED";
  }

  getAutoTimeoutAction(state: InternalGameState): GameAction | null {
    if (state.status !== "IN_PROGRESS") return null;
    if (state.currentPlayerIndex < 0) return null;

    const playerId = state.players[state.currentPlayerIndex]!.playerId;
    const big2State = state.gameSpecificState as Big2State;

    if (!big2State.isFirstPlayOfGame && !big2State.isFreePlay) {
      return { type: "pass", playerId };
    }

    const hand = big2State.hands[state.currentPlayerIndex] ?? [];
    const sorted = [...hand].sort(compareCards);
    const lowestCard = sorted[0];
    if (!lowestCard) return null;

    const playAction: Big2PlayCardsAction = {
      type: "playCards",
      playerId,
      cards: [lowestCard],
    };
    return playAction;
  }

  getSpectatorView(
    state: InternalGameState,
    spectatorCount: number,
  ): SpectatorView {
    const big2State = state.gameSpecificState as Big2State;

    const players: PlayerPublicInfo[] = state.players.map((p, i) => ({
      playerId: p.playerId,
      displayName: p.displayName,
      cardCount: big2State.hands[i]?.length ?? 0,
      isConnected: true,
    }));

    const publicState: Big2PublicState = {
      lastPlay: big2State.lastPlay,
      consecutivePasses: big2State.consecutivePasses,
      isFreePlay: big2State.isFreePlay,
      isFirstPlayOfGame: big2State.isFirstPlayOfGame,
      playHistory: big2State.playHistory,
      finishedPlayerIndices: big2State.finishedPlayerIndices,
      trickStartIndex: big2State.trickStartIndex ?? 0,
    };

    return {
      gameId: state.gameId,
      gameType: state.gameType,
      status: state.status,
      version: state.version,
      players,
      currentPlayerIndex: state.currentPlayerIndex,
      turnNumber: state.turnNumber,
      gameSpecificPublicState: publicState,
      winner: state.winner,
      scores: state.scores,
      spectatorCount,
    };
  }

  private handlePlayCards(
    state: InternalGameState,
    big2State: Big2State,
    action: Big2PlayCardsAction,
    playerIndex: number,
  ): ActionResult {
    const hand = big2State.hands[playerIndex] ?? [];
    const lowestCard = this.getLowestCard(big2State, state.players.length);

    const validation = isValidPlay(
      action.cards,
      hand,
      big2State.lastPlay,
      big2State.isFreePlay,
      big2State.isFirstPlayOfGame,
      lowestCard,
    );

    if (!validation.valid) {
      return { success: false, newState: null, error: validation.error };
    }

    const newHand = hand.filter(
      (c) =>
        !action.cards.some((ac) => ac.rank === c.rank && ac.suit === c.suit),
    );

    const newHands = big2State.hands.map((h, i) =>
      i === playerIndex ? newHand : h,
    );

    const play = {
      cards: action.cards,
      handType: validation.handType!,
      playerId: state.players[playerIndex]!.playerId,
    };

    const historyEntry = {
      playerId: state.players[playerIndex]!.playerId,
      displayName: state.players[playerIndex]!.displayName,
      action: "play" as const,
      cards: action.cards,
      handType: validation.handType!.kind,
    };

    const newPlayHistory = [...big2State.playHistory, historyEntry];

    if (newHand.length === 0) {
      const newFinished = [...big2State.finishedPlayerIndices, playerIndex];
      const activePlayers = state.players.filter(
        (_, i) => !newFinished.includes(i),
      );

      if (activePlayers.length <= 1) {
        const lastPlayerIndex = state.players.findIndex(
          (_, i) => !newFinished.includes(i),
        );
        const finalFinished =
          lastPlayerIndex >= 0
            ? [...newFinished, lastPlayerIndex]
            : newFinished;

        const scores = computeScores(state.players, finalFinished);
        const newBig2State: Big2State = {
          ...big2State,
          hands: newHands,
          lastPlay: play,
          lastPlayPlayerIndex: playerIndex,
          consecutivePasses: 0,
          isFreePlay: false,
          isFirstPlayOfGame: false,
          playHistory: newPlayHistory,
          finishedPlayerIndices: finalFinished,
        };
        return {
          success: true,
          newState: {
            ...state,
            version: state.version + 1,
            turnNumber: state.turnNumber + 1,
            status: "COMPLETED",
            currentPlayerIndex: -1,
            winner: state.players[finalFinished[0]]!.playerId,
            scores,
            gameSpecificState: newBig2State,
          },
        };
      }

      // Game continues — player finished but others remain
      const nextPlayerIndex = this.getNextActivePlayerIndex(
        playerIndex,
        state.players.length,
        newFinished,
      );

      const newBig2State: Big2State = {
        hands: newHands,
        lastPlay: play,
        lastPlayPlayerIndex: playerIndex,
        consecutivePasses: 0,
        isFreePlay: false,
        isFirstPlayOfGame: false,
        playHistory: newPlayHistory,
        finishedPlayerIndices: newFinished,
        trickStartIndex: big2State.trickStartIndex,
      };

      return {
        success: true,
        newState: {
          ...state,
          version: state.version + 1,
          turnNumber: state.turnNumber + 1,
          currentPlayerIndex: nextPlayerIndex,
          gameSpecificState: newBig2State,
        },
      };
    }

    // Player did not finish — normal advance
    const nextPlayerIndex = this.getNextActivePlayerIndex(
      playerIndex,
      state.players.length,
      big2State.finishedPlayerIndices,
    );

    const newBig2State: Big2State = {
      hands: newHands,
      lastPlay: play,
      lastPlayPlayerIndex: playerIndex,
      consecutivePasses: 0,
      isFreePlay: false,
      isFirstPlayOfGame: false,
      playHistory: newPlayHistory,
      finishedPlayerIndices: big2State.finishedPlayerIndices,
      trickStartIndex: big2State.trickStartIndex,
    };

    return {
      success: true,
      newState: {
        ...state,
        version: state.version + 1,
        turnNumber: state.turnNumber + 1,
        currentPlayerIndex: nextPlayerIndex,
        gameSpecificState: newBig2State,
      },
    };
  }

  private handlePass(
    state: InternalGameState,
    big2State: Big2State,
    playerIndex: number,
  ): ActionResult {
    if (big2State.isFirstPlayOfGame) {
      return {
        success: false,
        newState: null,
        error: "Cannot pass on the first play.",
      };
    }

    if (big2State.isFreePlay) {
      return {
        success: false,
        newState: null,
        error: "Cannot pass when leading a trick.",
      };
    }

    const historyEntry = {
      playerId: state.players[playerIndex]!.playerId,
      displayName: state.players[playerIndex]!.displayName,
      action: "pass" as const,
    };

    const newConsecutivePasses = big2State.consecutivePasses + 1;
    const activePlayerCount =
      state.players.length - big2State.finishedPlayerIndices.length;

    if (newConsecutivePasses >= activePlayerCount - 1) {
      // All other active players have passed — trick winner leads next
      const trickWinnerIndex = big2State.lastPlayPlayerIndex!;
      const trickWinnerIsActive =
        !big2State.finishedPlayerIndices.includes(trickWinnerIndex);

      let nextLeader: number;
      if (trickWinnerIsActive) {
        nextLeader = trickWinnerIndex;
      } else {
        nextLeader = this.getNextActivePlayerIndex(
          trickWinnerIndex,
          state.players.length,
          big2State.finishedPlayerIndices,
        );
      }

      const newBig2State: Big2State = {
        ...big2State,
        consecutivePasses: 0,
        isFreePlay: true,
        lastPlay: null,
        lastPlayPlayerIndex: null,
        playHistory: [...big2State.playHistory, historyEntry],
        trickStartIndex: big2State.playHistory.length + 1,
      };

      return {
        success: true,
        newState: {
          ...state,
          version: state.version + 1,
          turnNumber: state.turnNumber + 1,
          currentPlayerIndex: nextLeader,
          gameSpecificState: newBig2State,
        },
      };
    }

    // Normal pass — advance to next active player
    const nextPlayerIndex = this.getNextActivePlayerIndex(
      playerIndex,
      state.players.length,
      big2State.finishedPlayerIndices,
    );

    const newBig2State: Big2State = {
      ...big2State,
      consecutivePasses: newConsecutivePasses,
      playHistory: [...big2State.playHistory, historyEntry],
    };

    return {
      success: true,
      newState: {
        ...state,
        version: state.version + 1,
        turnNumber: state.turnNumber + 1,
        currentPlayerIndex: nextPlayerIndex,
        gameSpecificState: newBig2State,
      },
    };
  }

  private getNextActivePlayerIndex(
    currentIndex: number,
    playerCount: number,
    finishedPlayerIndices: readonly number[],
  ): number {
    let next = (currentIndex + 1) % playerCount;
    for (let i = 0; i < playerCount; i++) {
      if (!finishedPlayerIndices.includes(next)) return next;
      next = (next + 1) % playerCount;
    }
    return -1;
  }

  private getLowestCard(big2State: Big2State, playerCount: number): Card {
    const allCards = big2State.hands.flat();
    if (playerCount === 3) {
      // 3♦ is lowest in 3P (3♣ was removed)
      const threeOfDiamonds = allCards.find(
        (c) => c.rank === "3" && c.suit === "diamonds",
      );
      if (threeOfDiamonds) return threeOfDiamonds;
    }
    // For 4P: 3♣. For 2P or fallback: lowest dealt card.
    return allCards.reduce((lowest, card) =>
      compareCards(card, lowest) < 0 ? card : lowest,
    );
  }
}
