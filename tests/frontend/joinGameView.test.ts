import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Tests for JoinGameView input-routing logic, extracted as pure functions
// that mirror the component's joinGame() behaviour.
// ---------------------------------------------------------------------------

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_CODE_REGEX = /^[A-Z0-9]{4}$/i;

type RouteResult =
  | { type: "uuid"; gameId: string }
  | { type: "shortCode"; code: string }
  | { type: "invalid" };

/** Mirrors the input classification logic from JoinGameView.vue */
function classifyInput(raw: string): RouteResult {
  const input = raw.trim().toUpperCase();
  if (UUID_REGEX.test(input))
    return { type: "uuid", gameId: input.toLowerCase() };
  if (SHORT_CODE_REGEX.test(input)) return { type: "shortCode", code: input };
  return { type: "invalid" };
}

interface MockHttp {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
}

function makeHttp(): MockHttp {
  return {
    get: vi.fn(),
    post: vi.fn(),
  };
}

/**
 * Mirrors the full joinGame() flow from JoinGameView.vue.
 * Returns navigation target or error message.
 */
async function joinGame(
  raw: string,
  http: MockHttp,
): Promise<{ navigateTo?: string; errorMessage?: string }> {
  const classified = classifyInput(raw);

  if (classified.type === "invalid") {
    return { errorMessage: "Enter a 4-letter room code or game ID." };
  }

  let gameId: string;

  if (classified.type === "uuid") {
    gameId = classified.gameId;
  } else {
    // short code — resolve first
    try {
      const res = await http.get(`/api/games/join/${classified.code}`);
      gameId = (res as { data: { gameId: string } }).data.gameId;
    } catch (error: unknown) {
      const e = error as { response?: { status?: number } };
      if (!e.response)
        return { errorMessage: "Network error. Please try again." };
      if (e.response.status === 404) return { errorMessage: "Game not found." };
      return { errorMessage: "Something went wrong. Please try again." };
    }
  }

  try {
    const res = await http.post("/api/joinGame", { gameId });
    return {
      navigateTo: `/game/${(res as { data: { gameId: string } }).data.gameId}`,
    };
  } catch (error: unknown) {
    const e = error as { response?: { status?: number } };
    if (!e.response)
      return { errorMessage: "Network error. Please try again." };
    if (e.response.status === 404) return { errorMessage: "Game not found." };
    if (e.response.status === 409) return { errorMessage: "Game is full." };
    return { errorMessage: "Something went wrong. Please try again." };
  }
}

describe("JoinGameView — input routing", () => {
  describe("classifyInput", () => {
    it("classifies a valid UUID as uuid type", () => {
      const result = classifyInput("550e8400-e29b-41d4-a716-446655440000");
      expect(result.type).toBe("uuid");
    });

    it("normalises UUID to lowercase", () => {
      const result = classifyInput("550E8400-E29B-41D4-A716-446655440000");
      expect(result).toEqual({
        type: "uuid",
        gameId: "550e8400-e29b-41d4-a716-446655440000",
      });
    });

    it("classifies a 4-char alphanumeric string as shortCode", () => {
      const result = classifyInput("H7K3");
      expect(result).toEqual({ type: "shortCode", code: "H7K3" });
    });

    it("normalises lowercase short code to uppercase", () => {
      const result = classifyInput("h7k3");
      expect(result).toEqual({ type: "shortCode", code: "H7K3" });
    });

    it("trims whitespace before classifying", () => {
      const result = classifyInput("  H7K3  ");
      expect(result).toEqual({ type: "shortCode", code: "H7K3" });
    });

    it("classifies a 3-char string as invalid", () => {
      expect(classifyInput("H7K")).toEqual({ type: "invalid" });
    });

    it("classifies a 5-char string as invalid", () => {
      expect(classifyInput("H7K3X")).toEqual({ type: "invalid" });
    });

    it("classifies an empty string as invalid", () => {
      expect(classifyInput("")).toEqual({ type: "invalid" });
    });
  });

  describe("joinGame — UUID path (no code resolution)", () => {
    let http: MockHttp;

    beforeEach(() => {
      http = makeHttp();
    });

    it("calls joinGame directly without calling resolve endpoint", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      http.post.mockResolvedValue({ data: { gameId: uuid } });

      await joinGame(uuid, http);

      expect(http.get).not.toHaveBeenCalled();
      expect(http.post).toHaveBeenCalledWith("/api/joinGame", { gameId: uuid });
    });

    it("navigates to /game/:gameId on success", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      http.post.mockResolvedValue({ data: { gameId: uuid } });

      const result = await joinGame(uuid, http);

      expect(result.navigateTo).toBe(`/game/${uuid}`);
    });
  });

  describe("joinGame — short code path", () => {
    let http: MockHttp;

    beforeEach(() => {
      http = makeHttp();
    });

    it("calls resolve endpoint then joinGame endpoint", async () => {
      const resolvedId = "game-resolved-id";
      http.get.mockResolvedValue({ data: { gameId: resolvedId } });
      http.post.mockResolvedValue({ data: { gameId: resolvedId } });

      await joinGame("H7K3", http);

      expect(http.get).toHaveBeenCalledWith("/api/games/join/H7K3");
      expect(http.post).toHaveBeenCalledWith("/api/joinGame", {
        gameId: resolvedId,
      });
    });

    it("navigates to /game/:gameId on successful short code join", async () => {
      const resolvedId = "game-resolved-id";
      http.get.mockResolvedValue({ data: { gameId: resolvedId } });
      http.post.mockResolvedValue({ data: { gameId: resolvedId } });

      const result = await joinGame("H7K3", http);

      expect(result.navigateTo).toBe(`/game/${resolvedId}`);
    });

    it("shows 'Game not found.' when resolve returns 404", async () => {
      http.get.mockRejectedValue({ response: { status: 404 } });

      const result = await joinGame("XXXX", http);

      expect(result.errorMessage).toBe("Game not found.");
      expect(http.post).not.toHaveBeenCalled();
    });

    it("shows network error when resolve has no response", async () => {
      http.get.mockRejectedValue(new Error("Network Error"));

      const result = await joinGame("H7K3", http);

      expect(result.errorMessage).toBe("Network error. Please try again.");
    });

    it("shows generic error when resolve returns unexpected status", async () => {
      http.get.mockRejectedValue({ response: { status: 500 } });

      const result = await joinGame("H7K3", http);

      expect(result.errorMessage).toBe(
        "Something went wrong. Please try again.",
      );
    });
  });

  describe("joinGame — invalid input", () => {
    it("returns error without making any HTTP calls for invalid input", async () => {
      const http = makeHttp();

      const result = await joinGame("bad!", http);

      expect(result.errorMessage).toBe(
        "Enter a 4-letter room code or game ID.",
      );
      expect(http.get).not.toHaveBeenCalled();
      expect(http.post).not.toHaveBeenCalled();
    });
  });
});
