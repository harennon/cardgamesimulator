import { test, expect } from "@playwright/test";
import {
  readStoredAuth,
  createGameWithCodeViaApi,
} from "./helpers/game-helpers.js";

test.describe("Join Game via short join code", () => {
  test("player can join a game by entering the 4-char join code", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");

    // Host creates a game — get both gameId and joinCode
    const { gameId, joinCode } = await createGameWithCodeViaApi(
      request,
      host.accessToken,
      { maxPlayers: 4 },
    );
    expect(joinCode).toHaveLength(4);

    // Player 2 opens Join Game page and enters the short code
    const context = await browser.newContext({
      storageState: "e2e/.auth/player2.json",
    });
    const page = await context.newPage();

    await page.goto("/join-game");
    await page.fill('[data-testid="game-code-input"]', joinCode);

    // Intercept network to observe the resolve call
    const resolveRequest = page.waitForRequest((req) =>
      req.url().includes("/api/games/join/"),
    );

    await page.click('[data-testid="join-game-button"]');

    // Verify the resolve endpoint was called with the join code
    const req = await resolveRequest;
    expect(req.url()).toContain(`/api/games/join/${joinCode.toUpperCase()}`);

    // Should navigate to the game lobby (URL contains the UUID gameId)
    await page.waitForURL(/\/game\/[0-9a-f-]{36}/, { timeout: 10_000 });
    expect(page.url()).toContain(`/game/${gameId}`);

    // Should see the lobby
    await expect(page.locator('[data-testid="game-lobby"]')).toBeVisible({
      timeout: 8_000,
    });

    await context.close();
  });

  test("guest can join a game by navigating to /game/:code/join", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");

    // Host creates a game
    const { gameId, joinCode } = await createGameWithCodeViaApi(
      request,
      host.accessToken,
      { maxPlayers: 4 },
    );

    // Guest (no auth) navigates directly to /game/<joinCode>/join
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(`/game/${joinCode}/join`);

    // Route guard should resolve the code and redirect to /game/<uuid>/join
    // Guest then sees the GuestEntryView
    await page.waitForURL(/\/game\/[0-9a-f-]{36}\/join/, { timeout: 10_000 });
    expect(page.url()).toContain(`/game/${gameId}/join`);

    // Should see the guest entry form
    await expect(page.locator('[data-testid="guest-entry"]')).toBeVisible({
      timeout: 8_000,
    });

    // Enter a name and join
    await page.fill('[data-testid="guest-name-input"]', "TestGuest");
    await page.click('[data-testid="guest-join-button"]');

    // Should navigate to the game lobby
    await page.waitForURL(/\/game\/[0-9a-f-]{36}$/, { timeout: 10_000 });
    await expect(page.locator('[data-testid="game-lobby"]')).toBeVisible({
      timeout: 8_000,
    });

    await context.close();
  });

  test("entering an invalid code shows 'Game not found'", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player2.json",
    });
    const page = await context.newPage();

    await page.goto("/join-game");
    await page.fill('[data-testid="game-code-input"]', "ZZZZ");
    await page.click('[data-testid="join-game-button"]');

    await expect(page.locator('[data-testid="join-game-error"]')).toHaveText(
      "Game not found.",
      { timeout: 8_000 },
    );

    // Stays on join-game page
    expect(page.url()).toContain("/join-game");

    await context.close();
  });
});
