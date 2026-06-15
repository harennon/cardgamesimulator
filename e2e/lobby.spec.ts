import { test, expect } from "@playwright/test";
import { createGame } from "./helpers/game-helpers.js";

test.describe("Lobby UI", () => {
  test("start button is disabled with only 1 player (host alone)", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await createGame(page, { maxPlayers: 4 });

    // Host is the only player — start should be disabled
    const startButton = page.locator('[data-testid="start-game-button"]');
    await expect(startButton).toBeVisible();
    await expect(startButton).toBeDisabled();

    await context.close();
  });

  test("copy invite link button is visible and shows Copied! feedback", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    // Grant clipboard permissions so the copy action doesn't throw
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await createGame(page, { maxPlayers: 4 });

    const copyButton = page.locator('[data-testid="copy-invite-button"]');
    await expect(copyButton).toBeVisible();

    await copyButton.click();

    // After clicking, "Copied!" feedback should appear
    await expect(page.locator(".lobby__copied")).toBeVisible();
    await expect(page.locator(".lobby__copied")).toHaveText("Copied!");

    await context.close();
  });
});
