import { test, expect } from "@playwright/test";
import { readStoredAuth, createGameViaApi } from "./helpers/game-helpers.js";

// LLD 97: Tonk on the Create Game screen and lobby.

test.describe("Create Game — Tonk option (LLD 97)", () => {
  test("selecting Tonk reveals the Deck Length stepper and snaps the player range to 3-8", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto("/create-game");

    // Deck Length is hidden before any type is selected.
    await expect(page.locator('[data-testid="deck-length-field"]')).toHaveCount(
      0,
    );

    await page.selectOption('[data-testid="game-type-select"]', "tonk");

    // Tonk-only deck-length stepper appears, default 8 is selected.
    const deck = page.locator('[data-testid="deck-length-field"]');
    await expect(deck).toBeVisible();
    await expect(
      page.locator('[data-testid="deck-length-option-8"]'),
    ).toHaveAttribute("aria-pressed", "true");

    // Range snaps to Tonk's 3-8 and seeds to the min (3).
    const range = page.locator('[data-testid="max-players-input"]');
    await expect(range).toHaveAttribute("min", "3");
    await expect(range).toHaveAttribute("max", "8");
    await expect(page.locator('[data-testid="max-players-value"]')).toHaveText(
      "3",
    );

    await context.close();
  });

  test("switching Tonk -> Big 2 hides the stepper and re-clamps a high count down to 4", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto("/create-game");
    await page.selectOption('[data-testid="game-type-select"]', "tonk");

    // Push the Tonk count up to 7.
    const range = page.locator('[data-testid="max-players-input"]');
    await range.fill("7");
    await expect(page.locator('[data-testid="max-players-value"]')).toHaveText(
      "7",
    );

    // Switch to Big 2: deck control disappears, count re-clamps to the 2-4 max.
    await page.selectOption('[data-testid="game-type-select"]', "big2");
    await expect(page.locator('[data-testid="deck-length-field"]')).toHaveCount(
      0,
    );
    await expect(range).toHaveAttribute("min", "2");
    await expect(range).toHaveAttribute("max", "4");
    await expect(page.locator('[data-testid="max-players-value"]')).toHaveText(
      "4",
    );

    await context.close();
  });

  test("creating a Tonk game navigates to a lobby with a Tonk badge and min-3 Start gate", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto("/create-game");
    await page.selectOption('[data-testid="game-type-select"]', "tonk");
    await page.click('[data-testid="submit-create-game"]');

    await page.waitForURL(/\/game\/.+/);
    await expect(page.locator('[data-testid="game-lobby"]')).toBeVisible();

    // Tonk badge + count line.
    await expect(
      page.locator('[data-testid="lobby-type-badge"]'),
    ).toContainText("Tonk");
    await expect(page.locator('[data-testid="lobby-count"]')).toContainText(
      "1",
    );

    // Host alone (1 player) is below the Tonk minimum of 3 — Start disabled.
    await expect(
      page.locator('[data-testid="start-game-button"]'),
    ).toBeDisabled();
    await expect(
      page.locator('[data-testid="lobby-start-hint"]'),
    ).toContainText("Tonk needs at least 3 players to start");

    await context.close();
  });
});

test.describe("Tonk lobby — 8-player no-scroll (LLD 97 E5)", () => {
  for (const viewport of [
    { name: "desktop", width: 1280, height: 720 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    test(`8-seat Tonk lobby does not scroll the page on ${viewport.name}`, async ({
      browser,
      request,
    }) => {
      const host = readStoredAuth("player1.json");
      const gameId = await createGameViaApi(request, host.accessToken, {
        gameType: "tonk",
        maxPlayers: 8,
      });

      const context = await browser.newContext({
        storageState: "e2e/.auth/player1.json",
        viewport: { width: viewport.width, height: viewport.height },
      });
      const page = await context.newPage();

      await page.goto(`/game/${gameId}`);
      await expect(page.locator('[data-testid="game-lobby"]')).toBeVisible({
        timeout: 10_000,
      });

      // 8 total seat rows (1 filled host + 7 empty) render.
      await expect(page.locator(".lobby__player")).toHaveCount(8);

      // Load-bearing assertion: the page itself never gains a vertical scrollbar.
      const hasPageScroll = await page.evaluate(
        () => document.scrollingElement!.scrollHeight > window.innerHeight,
      );
      expect(hasPageScroll).toBe(false);

      // The chip, count, Start, and invite controls all stay on-screen.
      await expect(
        page.locator('[data-testid="join-code-chip"]'),
      ).toBeVisible();
      await expect(page.locator('[data-testid="lobby-count"]')).toBeVisible();
      await expect(
        page.locator('[data-testid="start-game-button"]'),
      ).toBeVisible();
      await expect(
        page.locator('[data-testid="copy-invite-button"]'),
      ).toBeVisible();

      await context.close();
    });
  }
});

test.describe("Tonk join-by-code (LLD 100 S3)", () => {
  test("a second player enters the lobby join code and lands in the Tonk lobby", async ({
    browser,
  }) => {
    // Host creates a Tonk game through the real UI and reads the join code chip.
    const hostContext = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const hostPage = await hostContext.newPage();
    await hostPage.goto("/create-game");
    await hostPage.selectOption('[data-testid="game-type-select"]', "tonk");
    await hostPage.click('[data-testid="submit-create-game"]');
    await hostPage.waitForURL(/\/game\/.+/);
    await expect(hostPage.locator('[data-testid="game-lobby"]')).toBeVisible();

    const codeChip = hostPage.locator('[data-testid="join-code-chip"]');
    await expect(codeChip).toBeVisible();
    // The code arrives via lobby:state / REST; wait for the 4-char value to fill.
    await expect(codeChip).toHaveText(/^[A-Z0-9]{4}$/, { timeout: 10_000 });
    const joinCode = (await codeChip.innerText()).trim();

    // A second player resolves the code on the Join Game screen and joins the
    // SAME Tonk lobby — the Tonk badge proves the resolved game is the Tonk game.
    const guestContext = await browser.newContext({
      storageState: "e2e/.auth/player2.json",
    });
    const joinerPage = await guestContext.newPage();
    await joinerPage.goto("/join-game");
    await joinerPage.fill('[data-testid="game-code-input"]', joinCode);
    await joinerPage.click('[data-testid="join-game-button"]');

    await joinerPage.waitForURL(/\/game\/.+/);
    await expect(joinerPage.locator('[data-testid="game-lobby"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      joinerPage.locator('[data-testid="lobby-type-badge"]'),
    ).toContainText("Tonk");

    await guestContext.close();
    await hostContext.close();
  });
});
