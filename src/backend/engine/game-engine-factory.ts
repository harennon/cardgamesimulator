import type { GameEngine } from "./game-engine.js";
import type { GameType } from "@shared/engine-types";

/**
 * Maps game type identifiers to engine instances.
 * Engines are stateless (all state in InternalGameState), so a single instance per type suffices.
 */
export class GameEngineFactory {
  private readonly engines: Map<GameType, GameEngine> = new Map();

  /** Register an engine for a game type. Called at server startup. Throws on duplicate. */
  register(engine: GameEngine): void {
    if (this.engines.has(engine.gameType)) {
      throw new Error(
        `Engine already registered for game type: ${engine.gameType}`,
      );
    }
    this.engines.set(engine.gameType, engine);
  }

  /** Get the engine for a game type. Throws if not registered. */
  getEngine(gameType: GameType): GameEngine {
    const engine = this.engines.get(gameType);
    if (!engine) {
      throw new Error(`No engine registered for game type: ${gameType}`);
    }
    return engine;
  }

  /** Check if an engine is registered for a game type. */
  hasEngine(gameType: GameType): boolean {
    return this.engines.has(gameType);
  }

  /** List all registered game types. */
  getRegisteredTypes(): GameType[] {
    return Array.from(this.engines.keys());
  }
}
