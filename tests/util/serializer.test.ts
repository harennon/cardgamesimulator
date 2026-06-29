import { describe, it, expect } from "vitest";
import { serializeGameForPlayer } from "../../src/backend/util/serializer.js";
import { Game } from "../../src/backend/database/entities/Game.js";

function makeGame(overrides: Partial<Game> = {}): Game {
  const game = new Game();
  game.gameId = "game-1";
  game.gameType = "big2";
  game.playerIds = ["host-id", "joiner-id"];
  game.playerDisplayNames = { "host-id": "Host", "joiner-id": "Joiner" };
  game.maxPlayers = 4;
  game.status = "CREATED";
  game.state = {};
  game.turnTimerSeconds = 30;
  game.joinCode = "H7K3";
  Object.assign(game, overrides);
  return game;
}

describe("serializeGameForPlayer", () => {
  it("includes joinCode from the Game row", () => {
    const game = makeGame({ joinCode: "H7K3" });
    const result = serializeGameForPlayer(game, "host-id");
    expect(result.joinCode).toBe("H7K3");
  });

  it("includes joinCode as null when the Game row's joinCode is null", () => {
    const game = makeGame({ joinCode: null });
    const result = serializeGameForPlayer(game, "host-id");
    expect(result.joinCode).toBeNull();
  });

  it("preserves the other serialized fields alongside joinCode", () => {
    const game = makeGame();
    const result = serializeGameForPlayer(game, "host-id");
    expect(result.gameId).toBe("game-1");
    expect(result.gameType).toBe("big2");
    expect(result.maxPlayers).toBe(4);
    expect(result.status).toBe("CREATED");
    expect(result.turnTimerSeconds).toBe(30);
    expect(result.playerIds).toEqual(["host-id", "joiner-id"]);
  });

  it("includes gameConfig from the Game row", () => {
    const game = makeGame({
      gameType: "tonk",
      gameConfig: { deckRoundsTarget: 10 },
    });
    const result = serializeGameForPlayer(game, "host-id");
    expect(result.gameConfig).toEqual({ deckRoundsTarget: 10 });
  });

  it("includes gameConfig as {} for a Big2 game", () => {
    const game = makeGame({ gameConfig: {} });
    const result = serializeGameForPlayer(game, "host-id");
    expect(result.gameConfig).toEqual({});
  });
});
