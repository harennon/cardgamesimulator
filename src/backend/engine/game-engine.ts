import type {
  GameType,
  GameAction,
  ActionResult,
  InternalGameState,
  PlayerView,
  SpectatorView,
  PlayerId,
  PlayerInfo,
  ValidAction,
} from "@shared/engine-types";
import type { PRNG } from "./prng.js";

export interface GameEngineConfig {
  readonly maxPlayers: number;
  readonly minPlayers: number;
  readonly options: Record<string, unknown>;
}

export interface GameEngine {
  /** The game type this engine handles. */
  readonly gameType: GameType;

  /**
   * Create a new game's initial state.
   *
   * Contract:
   * - Returns state with status "IN_PROGRESS"
   * - Deck is shuffled using the provided PRNG
   * - Cards are dealt to all players
   * - currentPlayerIndex is set to the correct starting player
   * - version is 1
   * - Throws if players.length < minPlayers or > maxPlayers
   */
  initialize(
    gameId: string,
    players: readonly PlayerInfo[],
    config: GameEngineConfig,
    prng: PRNG,
  ): InternalGameState;

  /**
   * Check whether an action is valid given the current state.
   * Does NOT modify state. Pure predicate.
   *
   * Contract:
   * - Returns true if applyAction would succeed with this action
   * - Returns false otherwise
   * - Consistent with getValidActions
   */
  validateAction(state: InternalGameState, action: GameAction): boolean;

  /**
   * Apply a validated action to produce new state.
   *
   * Contract:
   * - If invalid: returns { success: false, newState: null, error: "reason" }
   * - If valid: returns { success: true, newState: <new state>, error: undefined }
   * - newState.version === state.version + 1
   * - Original state is NEVER mutated
   * - Deterministic: same (state, action) always produces same result
   * - If win condition met: newState.status === "COMPLETED" and newState.winner is set
   *
   * Mid-game randomness must use a pre-shuffled deck stored in gameSpecificState.
   * applyAction takes no PRNG — it must be deterministic.
   */
  applyAction(state: InternalGameState, action: GameAction): ActionResult;

  /**
   * Derive the filtered view for a specific player.
   *
   * Contract:
   * - Output physically excludes all hidden information
   * - validActions populated only if it is this player's turn AND status is "IN_PROGRESS"
   * - validActions is empty array otherwise (never undefined/null)
   * - Pure derivation — must not modify state
   */
  getPlayerView(state: InternalGameState, playerId: PlayerId): PlayerView;

  /**
   * Get the list of valid actions for a specific player given current state.
   *
   * Contract:
   * - Returns empty array if not this player's turn
   * - Returns empty array if game status is not "IN_PROGRESS"
   * - Returns action TYPES (e.g., "playCards", "pass"), not every possible combination
   */
  getValidActions(
    state: InternalGameState,
    playerId: PlayerId,
  ): readonly ValidAction[];

  /**
   * Check if the game has ended.
   *
   * Contract:
   * - Returns true if and only if state.status === "COMPLETED"
   * - Pure derivation, no side effects
   */
  isGameOver(state: InternalGameState): boolean;

  /**
   * Derive the spectator view from current state.
   *
   * Contract:
   * - Contains no player hands
   * - Contains no hidden game state
   * - Shows card counts, last play, turn order, game status
   */
  getSpectatorView(
    state: InternalGameState,
    spectatorCount: number,
  ): SpectatorView;
}
