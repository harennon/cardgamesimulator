import { describe, it, expect, vi, beforeEach } from "vitest";
import { Game } from "../../../src/backend/database/entities/Game.js";
import { GuestSessionStore } from "../../../src/backend/guest/guestSessionStore.js";
import { verifyGuestToken } from "../../../src/backend/guest/guestToken.js";

const TEST_SECRET = "test-create-session-secret";
process.env.SUPABASE_JWT_SECRET = TEST_SECRET;

const mockGetGame = vi.fn<(id: string) => Promise<Game | null>>();

vi.mock("@/database", () => ({
  gameRepo: {
    getGame: (...args: unknown[]) => mockGetGame(args[0] as string),
  },
}));

const { createSessionRouter } =
  await import("../../../src/backend/api/guest/createSession.js");

function makeGame(overrides: Partial<Game> = {}): Game {
  const game = new Game();
  game.gameId = "game-uuid-aaaa-bbbb-cccc-ddddeeeeeeee";
  game.gameType = "big2";
  game.playerIds = ["player-1"];
  game.playerDisplayNames = { "player-1": "Alice" };
  game.maxPlayers = 4;
  game.status = "CREATED";
  game.state = {};
  game.version = 1;
  Object.assign(game, overrides);
  return game;
}

function makeRequest(body: Record<string, unknown>) {
  return { body, headers: {} } as unknown as Parameters<
    ReturnType<typeof createSessionRouter>["post"]
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
    cookie() {
      return res;
    },
  };
  return { res, data };
}

// Helper: extract and call the POST handler from the router
async function callPost(
  store: GuestSessionStore,
  body: Record<string, unknown>,
  res: ReturnType<typeof makeResponse>["res"],
) {
  // createSessionRouter returns an express.Router with a POST "/" handler
  // We test the handler logic via integration with the router internals
  // by constructing a minimal fake request/response cycle.
  const req = makeRequest(body);
  const router = createSessionRouter(store, {
    getGame: mockGetGame,
    createGame: vi.fn(),
    saveGame: vi.fn(),
  });

  // Find the POST handler layer
  let routeHandler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (router as any).stack) {
    if (layer.route?.methods?.post) {
      // last handler in the stack is our async handler
      const handlers = layer.route.stack;
      routeHandler = handlers[handlers.length - 1].handle;
      break;
    }
  }

  if (!routeHandler) throw new Error("POST handler not found on router");
  await routeHandler(req, res);
}

describe("createSession — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns guestId, displayName, token, gameId on success", async () => {
    const game = makeGame();
    mockGetGame.mockResolvedValue(game);
    const store = new GuestSessionStore();
    const { res, data } = makeResponse();

    await callPost(store, { displayName: "Bob", gameId: game.gameId }, res);

    expect(data.statusCode).toBe(200);
    const body = data.body as {
      guestId: string;
      displayName: string;
      token: string;
      gameId: string;
    };
    expect(body.displayName).toBe("Bob");
    expect(body.gameId).toBe(game.gameId);
    expect(body.token).toMatch(/^guest:/);
    expect(body.guestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("the returned token is verifiable with the secret", async () => {
    const game = makeGame();
    mockGetGame.mockResolvedValue(game);
    const store = new GuestSessionStore();
    const { res, data } = makeResponse();

    await callPost(store, { displayName: "Bob", gameId: game.gameId }, res);

    const body = data.body as { token: string; guestId: string };
    const verified = verifyGuestToken(body.token, TEST_SECRET);
    expect(verified).not.toBeNull();
    expect(verified!.guestId).toBe(body.guestId);
  });

  it("stores the session in GuestSessionStore", async () => {
    const game = makeGame();
    mockGetGame.mockResolvedValue(game);
    const store = new GuestSessionStore();
    const { res, data } = makeResponse();

    await callPost(store, { displayName: "Bob", gameId: game.gameId }, res);

    const body = data.body as { guestId: string };
    expect(store.get(body.guestId)).not.toBeNull();
  });
});

describe("createSession — display name deduplication", () => {
  beforeEach(() => vi.clearAllMocks());

  it("appends '2' when display name matches an existing player", async () => {
    const game = makeGame({
      playerDisplayNames: { "player-1": "Alice" },
    });
    mockGetGame.mockResolvedValue(game);
    const store = new GuestSessionStore();
    const { res, data } = makeResponse();

    await callPost(store, { displayName: "Alice", gameId: game.gameId }, res);

    expect((data.body as { displayName: string }).displayName).toBe("Alice2");
  });

  it("increments suffix until unique", async () => {
    const game = makeGame({
      playerDisplayNames: {
        "player-1": "Alice",
        "player-2": "Alice2",
      },
    });
    mockGetGame.mockResolvedValue(game);
    const store = new GuestSessionStore();
    const { res, data } = makeResponse();

    await callPost(store, { displayName: "Alice", gameId: game.gameId }, res);

    expect((data.body as { displayName: string }).displayName).toBe("Alice3");
  });
});

describe("createSession — existingGuestId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("re-uses existingGuestId when it is a valid UUID in game.playerIds", async () => {
    const existingId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const game = makeGame({
      playerIds: ["player-1", existingId],
      playerDisplayNames: { "player-1": "Alice", [existingId]: "OldGuest" },
    });
    mockGetGame.mockResolvedValue(game);
    const store = new GuestSessionStore();
    const { res, data } = makeResponse();

    await callPost(
      store,
      { displayName: "Bob", gameId: game.gameId, existingGuestId: existingId },
      res,
    );

    expect((data.body as { guestId: string }).guestId).toBe(existingId);
  });

  it("ignores existingGuestId when it is not in game.playerIds", async () => {
    const unknownId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const game = makeGame();
    mockGetGame.mockResolvedValue(game);
    const store = new GuestSessionStore();
    const { res, data } = makeResponse();

    await callPost(
      store,
      { displayName: "Bob", gameId: game.gameId, existingGuestId: unknownId },
      res,
    );

    expect((data.body as { guestId: string }).guestId).not.toBe(unknownId);
  });

  it("ignores existingGuestId when it is not a valid UUID format", async () => {
    const game = makeGame();
    mockGetGame.mockResolvedValue(game);
    const store = new GuestSessionStore();
    const { res, data } = makeResponse();

    await callPost(
      store,
      {
        displayName: "Bob",
        gameId: game.gameId,
        existingGuestId: "not-a-uuid",
      },
      res,
    );

    expect((data.body as { guestId: string }).guestId).not.toBe("not-a-uuid");
    expect((data.body as { guestId: string }).guestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("createSession — validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws 400 for empty displayName", async () => {
    const store = new GuestSessionStore();
    const { res } = makeResponse();
    await expect(
      callPost(store, { displayName: "", gameId: "some-game" }, res),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("throws 400 for displayName longer than 20 chars", async () => {
    const store = new GuestSessionStore();
    const { res } = makeResponse();
    await expect(
      callPost(
        store,
        { displayName: "A".repeat(21), gameId: "some-game" },
        res,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("throws 400 when gameId is missing", async () => {
    const store = new GuestSessionStore();
    const { res } = makeResponse();
    await expect(
      callPost(store, { displayName: "Bob" }, res),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("throws 404 when game does not exist", async () => {
    mockGetGame.mockResolvedValue(null);
    const store = new GuestSessionStore();
    const { res } = makeResponse();
    await expect(
      callPost(store, { displayName: "Bob", gameId: "no-such-game" }, res),
    ).rejects.toMatchObject({ status: 404 });
  });
});
