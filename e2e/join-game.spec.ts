import { test, expect } from "@playwright/test";
import {
  readStoredAuth,
  createGameViaApi,
  joinGameViaApi,
} from "./helpers/game-helpers.js";

test.describe("Join Game — error states", () => {
  test("joining a full game shows an error message", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");
    const player3 = readStoredAuth("player3.json");

    // Create a 2-player game and fill it
    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);

    // Third player tries to join via UI
    const context = await browser.newContext({
      storageState: "e2e/.auth/player3.json",
    });
    const page = await context.newPage();

    await page.goto("/join-game");
    await page.fill('[data-testid="game-code-input"]', gameId);
    await page.click('[data-testid="join-game-button"]');

    // Frontend should render the error returned by the backend (409)
    await expect(page.locator('[data-testid="join-game-error"]')).toBeVisible({
      timeout: 8_000,
    });

    // Stays on the join-game page (no redirect to lobby)
    expect(page.url()).toContain("/join-game");

    await context.close();
  });
});
