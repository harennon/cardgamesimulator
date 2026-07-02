import { describe, it, expect, vi, beforeEach } from "vitest";
import { Game } from "../../src/backend/database/entities/Game.js";
import type { GameConfig } from "../../src/shared/model.js";

// ---------------------------------------------------------------------------
// Tests for the numAiSeats validation + addAiSeats call in CreateGameHandler.
// Uses the same mock-wiring pattern as createGame.test.ts.
// ---------------------------------------------------------------------------

function makeGame(overrides: Partial<Game> = {}): Game {
  const game = new Game();
  game.gameId = "game-1";
  game.gameType = "big2";
  game.playerIds = ["user-1"];
  game.playerDisplayNames = { "user-1": "Alice" };
  game.maxPlayers = 4;
  game.status = "CREATED";
  game.state = {};
  game.joinCode = "H7K3";
  game.version = 1;
  game.gameConfig = {};
  Object.assign(game, overrides);
  return game;
}

const mockCreateGameRepo =
  vi.fn<
    (
      gameId: string,
      gameType: string,
      creatorId: string,
      maxPlayers: number,
      creatorDisplayName: string,
      turnTimerSeconds: number | null,
      joinCode: string | null,
      gameConfig: GameConfig,
    ) => Promise<Game>
  >();

const mockAddAiSeats =
  vi.fn<(gameId: string, count: number) => Promise<Game>>();

vi.mock("@/database", () => ({
  gameRepo: {
    createGame: (
      ...args: [
        string,
        string,
        string,
        number,
        string,
        number | null,
        string | null,
        GameConfig,
      ]
    ) => mockCreateGameRepo(...args),
  },
}));

vi.mock("@/service/joinCodeService", () => ({
  generateJoinCode: () => "H7K3",
}));

process.env.SUPABASE_JWT_SECRET = "test-secret";

const { CreateGameHandler, validateNumAiSeatsOrThrow } =
  await import("../../src/backend/api/game/createGame.js");

// Stub GameService with only the addAiSeats method used by the handler.
const stubGameService = {
  addAiSeats: mockAddAiSeats,
} as unknown as import("../../src/backend/service/gameService.js").GameService;

function makeRequest(
  userId: string,
  gameType: string,
  maxPlayers: number,
  turnTimerSeconds: number,
  extra: Record<string, unknown> = {},
  isGuest = false,
) {
  return {
    userId,
    displayName: "Alice",
    isGuest,
    body: { gameType, maxPlayers, turnTimerSeconds, ...extra },
    headers: {},
  } as unknown as Parameters<InstanceType<typeof CreateGameHandler>["post"]>[0];
}

function makeResponse() {
  const data: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      data.statusCode = code;
      return res;
    },
    json(body: unknown) {
      data.body = body;
      return res;
    },
  };
  return { res, data };
}

// ---------------------------------------------------------------------------
// validateNumAiSeatsOrThrow — pure unit tests
// ---------------------------------------------------------------------------

describe("validateNumAiSeatsOrThrow", () => {
  it("returns 0 when numAiSeats is absent (undefined)", () => {
    expect(validateNumAiSeatsOrThrow(undefined, 4, true)).toBe(0);
  });

  it("returns 0 when numAiSeats is 0", () => {
    expect(validateNumAiSeatsOrThrow(0, 4, true)).toBe(0);
  });

  it("returns the value when valid (2, maxPlayers=4, registered)", () => {
    expect(validateNumAiSeatsOrThrow(2, 4, true)).toBe(2);
  });

  it("returns maxPlayers-1 when exactly at the upper bound", () => {
    expect(validateNumAiSeatsOrThrow(3, 4, true)).toBe(3);
  });

  it("throws BadRequestError when numAiSeats === maxPlayers (over-fill)", () => {
    expect(() => validateNumAiSeatsOrThrow(4, 4, true)).toThrow();
  });

  it("throws BadRequestError when numAiSeats > maxPlayers - 1", () => {
    expect(() => validateNumAiSeatsOrThrow(5, 4, true)).toThrow();
  });

  it("throws BadRequestError when numAiSeats is negative", () => {
    expect(() => validateNumAiSeatsOrThrow(-1, 4, true)).toThrow();
  });

  it("throws BadRequestError when numAiSeats is a non-integer (1.5)", () => {
    expect(() => validateNumAiSeatsOrThrow(1.5, 4, true)).toThrow();
  });

  it("throws BadRequestError when numAiSeats is a non-number string", () => {
    expect(() => validateNumAiSeatsOrThrow("2", 4, true)).toThrow();
  });

  it("throws BadRequestError when numAiSeats >= 1 from a guest (security boundary)", () => {
    expect(() => validateNumAiSeatsOrThrow(1, 4, false)).toThrow();
  });

  it("returns 0 (no throw) when numAiSeats === 0 from a guest (0 is harmless)", () => {
    expect(validateNumAiSeatsOrThrow(0, 4, false)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CreateGameHandler — addAiSeats integration
// ---------------------------------------------------------------------------

describe("CreateGameHandler — numAiSeats integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const wiredHandler = CreateGameHandler.create(stubGameService);

  it("numAiSeats absent → addAiSeats NOT called; gameConfig is {} for Big2", async () => {
    mockCreateGameRepo.mockResolvedValue(makeGame());
    mockAddAiSeats.mockResolvedValue(makeGame());
    const { res } = makeResponse();
    await wiredHandler.post(makeRequest("user-1", "big2", 4, 30), res);
    expect(mockAddAiSeats).not.toHaveBeenCalled();
    // gameConfig arg (8th) is {}
    expect(mockCreateGameRepo.mock.calls[0]![7]).toEqual({});
  });

  it("numAiSeats=0 → addAiSeats NOT called", async () => {
    mockCreateGameRepo.mockResolvedValue(makeGame());
    mockAddAiSeats.mockResolvedValue(makeGame());
    const { res } = makeResponse();
    await wiredHandler.post(
      makeRequest("user-1", "big2", 4, 30, { numAiSeats: 0 }),
      res,
    );
    expect(mockAddAiSeats).not.toHaveBeenCalled();
  });

  it("numAiSeats=2, maxPlayers=4, registered → addAiSeats called once with (gameId, 2)", async () => {
    mockCreateGameRepo.mockResolvedValue(makeGame());
    mockAddAiSeats.mockResolvedValue(makeGame());
    const { res } = makeResponse();
    await wiredHandler.post(
      makeRequest("user-1", "big2", 4, 30, { numAiSeats: 2 }),
      res,
    );
    expect(mockAddAiSeats).toHaveBeenCalledOnce();
    expect(mockAddAiSeats.mock.calls[0]).toEqual(["game-1", 2]);
  });

  it("numAiSeats = maxPlayers (over-fill) → BadRequestError, addAiSeats not called", async () => {
    const { res } = makeResponse();
    await expect(
      wiredHandler.post(
        makeRequest("user-1", "big2", 4, 30, { numAiSeats: 4 }),
        res,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockAddAiSeats).not.toHaveBeenCalled();
  });

  it("numAiSeats=-1 → BadRequestError", async () => {
    const { res } = makeResponse();
    await expect(
      wiredHandler.post(
        makeRequest("user-1", "big2", 4, 30, { numAiSeats: -1 }),
        res,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockAddAiSeats).not.toHaveBeenCalled();
  });

  it("numAiSeats=1.5 (non-integer) → BadRequestError", async () => {
    const { res } = makeResponse();
    await expect(
      wiredHandler.post(
        makeRequest("user-1", "big2", 4, 30, { numAiSeats: 1.5 }),
        res,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockAddAiSeats).not.toHaveBeenCalled();
  });

  it("numAiSeats=1 from guest → BadRequestError (security boundary)", async () => {
    const { res } = makeResponse();
    await expect(
      wiredHandler.post(
        makeRequest("guest-1", "big2", 4, 30, { numAiSeats: 1 }, true),
        res,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockAddAiSeats).not.toHaveBeenCalled();
  });

  it("Tonk create with numAiSeats absent → gameConfig has only deckRoundsTarget, addAiSeats not called", async () => {
    mockCreateGameRepo.mockResolvedValue(makeGame({ gameType: "tonk" }));
    mockAddAiSeats.mockResolvedValue(makeGame({ gameType: "tonk" }));
    const { res } = makeResponse();
    await wiredHandler.post(makeRequest("user-1", "tonk", 4, 30), res);
    expect(mockAddAiSeats).not.toHaveBeenCalled();
    expect(mockCreateGameRepo.mock.calls[0]![7]).toEqual({
      deckRoundsTarget: 8,
    });
  });
});
