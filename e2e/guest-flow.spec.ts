import { test, expect } from "@playwright/test";
import { createGame, joinAsGuest } from "./helpers/game-helpers.js";

test.describe("Guest flow", () => {
  test("guest joins via invite link, enters name, and reaches lobby", async ({
    browser,
  }) => {
    const hostContext = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const hostPage = await hostContext.newPage();
    const gameId = await createGame(hostPage, { maxPlayers: 4 });

    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();
    await guestPage.goto(`/game/${gameId}/join`);

    await guestPage.fill('[data-testid="guest-name-input"]', "GuestAlice");
    await guestPage.click('[data-testid="guest-join-button"]');

    await expect(guestPage.locator('[data-testid="game-lobby"]')).toBeVisible();

    await guestContext.close();
    await hostContext.close();
  });

  test("host sees guest appear in lobby player list", async ({ browser }) => {
    const hostContext = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const hostPage = await hostContext.newPage();
    const gameId = await createGame(hostPage, { maxPlayers: 4 });

    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();
    await joinAsGuest(guestPage, gameId, "GuestBob");

    await expect(hostPage.locator('[data-testid="game-lobby"]')).toContainText(
      "GuestBob",
    );

    await guestContext.close();
    await hostContext.close();
  });

  test("guest can play cards after game starts", async ({ browser }) => {
    const hostContext = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const hostPage = await hostContext.newPage();
    const gameId = await createGame(hostPage, { maxPlayers: 2 });

    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();
    await joinAsGuest(guestPage, gameId, "GuestPlayer");

    await hostPage.click('[data-testid="start-game-button"]');

    await expect(hostPage.locator('[data-testid="game-board"]')).toBeVisible();
    await expect(guestPage.locator('[data-testid="game-board"]')).toBeVisible();

    await guestContext.close();
    await hostContext.close();
  });

  test("guest navigating directly to /game/:id is redirected to guest entry", async ({
    browser,
  }) => {
    const hostContext = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const hostPage = await hostContext.newPage();
    const gameId = await createGame(hostPage, { maxPlayers: 4 });

    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();
    await guestPage.goto(`/game/${gameId}`);

    await expect(guestPage).toHaveURL(new RegExp(`/game/${gameId}/join`));
    await expect(
      guestPage.locator('[data-testid="guest-entry"]'),
    ).toBeVisible();

    await guestContext.close();
    await hostContext.close();
  });

  test("guest with expired/invalid cookie is shown guest entry again", async ({
    browser,
  }) => {
    const hostContext = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const hostPage = await hostContext.newPage();
    const gameId = await createGame(hostPage, { maxPlayers: 4 });

    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();
    await guestPage.goto(`/game/${gameId}`);

    await expect(
      guestPage.locator('[data-testid="guest-entry"]'),
    ).toBeVisible();

    await guestContext.close();
    await hostContext.close();
  });
});
