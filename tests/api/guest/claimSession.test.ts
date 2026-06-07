import { describe, it, expect, vi, beforeEach } from "vitest";
import { Game } from "../../../src/backend/database/entities/Game.js";
import { createGuestToken } from "../../../src/backend/guest/guestToken.js";

const TEST_SECRET = "test-claim-session-secret";
process.env.SUPABASE_JWT_SECRET = TEST_SECRET;

const mockGetGame = vi.fn<(id: string) => Promise<Game | null>>();
const mockSaveGame = vi.fn<(game: Game) => Promise<Game>>();

const GUEST_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const GAME_ID = "ffffffff-1111-2222-3333-444444444444";
const NEW_USER_ID = "user-registered-uuid-123456789012";

function makeGame(overrides: Partial<Game> = {}): Game {
  const game = new Game();
  game.gameId = GAME_ID;
  game.gameType = "big2";
  game.playerIds = [GUEST_ID, "player-2"];
  game.playerDisplayNames = { [GUEST_ID]: "GuestBob", "player-2": "Alice" };
  game.maxPlayers = 4;
  game.status = "COMPLETED";
  game.state = {};
  game.version = 1;
  Object.assign(game, overrides);
  return game;
}

function makeRequest(userId: string, body: Record<string, unknown>) {
  return { userId, body, headers: {} } as unknown as Parameters<
    ReturnType<
      (typeof import("../../../src/backend/api/guest/claimSession.js"))["createClaimRouter"]
    >["post"]
  >[0];
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

const { createClaimRouter } =
  await import("../../../src/backend/api/guest/claimSession.js");

async function callPost(
  userId: string,
  body: Record<string, unknown>,
  res: ReturnType<typeof makeResponse>["res"],
) {
  const req = makeRequest(userId, body);
  const router = createClaimRouter({
    getGame: mockGetGame,
    createGame: vi.fn(),
    saveGame: (...args: unknown[]) => mockSaveGame(args[0] as Game),
  });

  let routeHandler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (router as any).stack) {
    if (layer.route?.methods?.post) {
      const handlers = layer.route.stack;
      routeHandler = handlers[handlers.length - 1].handle;
      break;
    }
  }

  if (!routeHandler) throw new Error("POST handler not found on router");
  await routeHandler(req, res);
}

function validGuestToken(
  guestId = GUEST_ID,
  gameId = GAME_ID,
  expiryOffset = 3_600_000,
): string {
  return createGuestToken(
    guestId,
    gameId,
    Date.now() + expiryOffset,
    TEST_SECRET,
  );
}

describe("claimSession — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveGame.mockImplementation(async (game) => game);
  });

  it("swaps guestId for newUserId in playerIds and saves the game", async () => {
    const game = makeGame();
    mockGetGame.mockResolvedValue(game);
    const { res, data } = makeResponse();

    await callPost(NEW_USER_ID, { guestToken: validGuestToken() }, res);

    expect(data.statusCode).toBe(200);
    expect((data.body as { gamesLinked: number }).gamesLinked).toBe(1);
    expect(mockSaveGame).toHaveBeenCalledOnce();
    const saved = mockSaveGame.mock.calls[0]![0];
    expect(saved.playerIds).toContain(NEW_USER_ID);
    expect(saved.playerIds).not.toContain(GUEST_ID);
  });

  it("moves the guest display name to the new userId key", async () => {
    const game = makeGame();
    mockGetGame.mockResolvedValue(game);
    const { res } = makeResponse();

    await callPost(NEW_USER_ID, { guestToken: validGuestToken() }, res);

    const saved = mockSaveGame.mock.calls[0]![0];
    expect(saved.playerDisplayNames[NEW_USER_ID]).toBe("GuestBob");
    expect(saved.playerDisplayNames[GUEST_ID]).toBeUndefined();
  });
});

describe("claimSession — no-op cases", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns gamesLinked=0 for an expired guest token (no error)", async () => {
    const { res, data } = makeResponse();
    const expiredToken = createGuestToken(
      GUEST_ID,
      GAME_ID,
      Date.now() - 1000,
      TEST_SECRET,
    );

    await callPost(NEW_USER_ID, { guestToken: expiredToken }, res);

    expect(data.statusCode).toBe(200);
    expect((data.body as { gamesLinked: number }).gamesLinked).toBe(0);
    expect(mockSaveGame).not.toHaveBeenCalled();
  });

  it("returns gamesLinked=0 when game is not found", async () => {
    mockGetGame.mockResolvedValue(null);
    const { res, data } = makeResponse();

    await callPost(NEW_USER_ID, { guestToken: validGuestToken() }, res);

    expect(data.statusCode).toBe(200);
    expect((data.body as { gamesLinked: number }).gamesLinked).toBe(0);
    expect(mockSaveGame).not.toHaveBeenCalled();
  });

  it("returns gamesLinked=0 when guestId is not in game.playerIds", async () => {
    const game = makeGame({ playerIds: ["other-player"] });
    mockGetGame.mockResolvedValue(game);
    const { res, data } = makeResponse();

    await callPost(NEW_USER_ID, { guestToken: validGuestToken() }, res);

    expect(data.statusCode).toBe(200);
    expect((data.body as { gamesLinked: number }).gamesLinked).toBe(0);
  });
});

describe("claimSession — validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws 400 when guestToken is missing from body", async () => {
    const { res } = makeResponse();
    await expect(callPost(NEW_USER_ID, {}, res)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("throws 400 when guestToken is not a string", async () => {
    const { res } = makeResponse();
    await expect(
      callPost(NEW_USER_ID, { guestToken: 12345 }, res),
    ).rejects.toMatchObject({ status: 400 });
  });
});
