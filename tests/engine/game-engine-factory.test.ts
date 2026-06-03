import { describe, it, expect, beforeEach } from "vitest";
import { GameEngineFactory } from "../../src/backend/engine/game-engine-factory.js";
import type { GameEngine, GameEngineConfig } from "../../src/backend/engine/game-engine.js";
import type {
  GameType,
  InternalGameState,
  PlayerView,
  SpectatorView,
  PlayerId,
  PlayerInfo,
  GameAction,
  ActionResult,
  ValidAction,
} from "../../src/shared/engine-types.js";
import type { PRNG } from "../../src/backend/engine/prng.js";

function makeMockEngine(gameType: GameType): GameEngine {
  return {
    gameType,
    initialize(_gameId: string, _players: readonly PlayerInfo[], _config: GameEngineConfig, _prng: PRNG): InternalGameState {
      throw new Error("not implemented");
    },
    validateAction(_state: InternalGameState, _action: GameAction): boolean {
      return false;
    },
    applyAction(_state: InternalGameState, _action: GameAction): ActionResult {
      return { success: false, newState: null, error: "not implemented" };
    },
    getPlayerView(_state: InternalGameState, _playerId: PlayerId): PlayerView {
      throw new Error("not implemented");
    },
    getValidActions(_state: InternalGameState, _playerId: PlayerId): readonly ValidAction[] {
      return [];
    },
    isGameOver(_state: InternalGameState): boolean {
      return false;
    },
    getSpectatorView(_state: InternalGameState, _spectatorCount: number): SpectatorView {
      throw new Error("not implemented");
    },
  };
}

describe("GameEngineFactory", () => {
  let factory: GameEngineFactory;

  beforeEach(() => {
    factory = new GameEngineFactory();
  });

  describe("register and getEngine", () => {
    it("registers an engine and retrieves it by game type", () => {
      const engine = makeMockEngine("big2");
      factory.register(engine);
      expect(factory.getEngine("big2")).toBe(engine);
    });

    it("registers multiple engines and retrieves each correctly", () => {
      const big2 = makeMockEngine("big2");
      const tonk = makeMockEngine("tonk");
      factory.register(big2);
      factory.register(tonk);
      expect(factory.getEngine("big2")).toBe(big2);
      expect(factory.getEngine("tonk")).toBe(tonk);
    });
  });

  describe("duplicate registration", () => {
    it("throws when registering the same game type twice", () => {
      factory.register(makeMockEngine("big2"));
      expect(() => factory.register(makeMockEngine("big2"))).toThrowError(
        "Engine already registered for game type: big2",
      );
    });
  });

  describe("missing engine", () => {
    it("throws a descriptive error when getting an unregistered type", () => {
      expect(() => factory.getEngine("big2")).toThrowError(
        "No engine registered for game type: big2",
      );
    });

    it("throws for a different unregistered type", () => {
      factory.register(makeMockEngine("big2"));
      expect(() => factory.getEngine("tonk")).toThrowError(
        "No engine registered for game type: tonk",
      );
    });
  });

  describe("hasEngine", () => {
    it("returns false before registration", () => {
      expect(factory.hasEngine("big2")).toBe(false);
    });

    it("returns true after registration", () => {
      factory.register(makeMockEngine("big2"));
      expect(factory.hasEngine("big2")).toBe(true);
    });

    it("returns false for a type that was not registered", () => {
      factory.register(makeMockEngine("big2"));
      expect(factory.hasEngine("tonk")).toBe(false);
    });
  });

  describe("getRegisteredTypes", () => {
    it("returns empty array when nothing is registered", () => {
      expect(factory.getRegisteredTypes()).toEqual([]);
    });

    it("returns all registered game types", () => {
      factory.register(makeMockEngine("big2"));
      factory.register(makeMockEngine("tonk"));
      const types = factory.getRegisteredTypes();
      expect(types).toHaveLength(2);
      expect(types).toContain("big2");
      expect(types).toContain("tonk");
    });

    it("lists each type only once", () => {
      factory.register(makeMockEngine("big2"));
      const types = factory.getRegisteredTypes();
      expect(types.filter((t) => t === "big2")).toHaveLength(1);
    });
  });
});
