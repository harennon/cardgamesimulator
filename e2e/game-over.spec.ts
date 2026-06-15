import { test, expect } from "@playwright/test";
import {
  readStoredAuth,
  createGameViaApi,
  joinGameViaApi,
} from "./helpers/game-helpers.js";
import { seedCompletedGame } from "./helpers/seed-helpers.js";

test.describe("Game over screen", () => {
  test("renders with scores table and winner name", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");

    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);

    await seedCompletedGame(request, {
      gameId,
      players: [
        { id: host.userId, displayName: "Player1" },
        { id: player2.userId, displayName: "Player2" },
      ],
      winner: host.userId,
      scores: [
        { playerId: host.userId, score: 5 },
        { playerId: player2.userId, score: 0 },
      ],
    });

    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="game-over"]')).toBeVisible({
      timeout: 10_000,
    });

    await expect(page.locator(".game-over__winner")).toContainText("Player1");

    // Score table should show 1st and 2nd place
    const rows = page.locator(".game-over__scores tbody tr");
    await expect(rows).toHaveCount(2);

    // Back to Home button is present and clickable
    const homeBtn = page.locator(".game-over__btn--home");
    await expect(homeBtn).toBeVisible();
    await homeBtn.click();
    await page.waitForURL("/");

    await context.close();
  });

  test("guest sees sign-up nudge on game over screen", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");

    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });

    // Create a guest session via REST API to get the guestId and token
    const guestRes = await request.post("http://localhost:3000/guest/session", {
      data: { gameId, displayName: "GuestCarol" },
    });
    const guestData = (await guestRes.json()) as {
      guestId: string;
      token: string;
    };

    // Join the game as the guest via REST
    await joinGameViaApi(request, gameId, guestData.token);

    await seedCompletedGame(request, {
      gameId,
      players: [
        { id: host.userId, displayName: "Player1" },
        { id: guestData.guestId, displayName: "GuestCarol" },
      ],
      winner: host.userId,
      scores: [
        { playerId: host.userId, score: 5 },
        { playerId: guestData.guestId, score: 0 },
      ],
    });

    // Create a guest browser context with the guest token stored in cookie
    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();
    // Set the guest cookie so the frontend recognizes this as a guest session
    await guestContext.addCookies([
      {
        name: "guestSession",
        value: encodeURIComponent(guestData.token),
        domain: "localhost",
        path: "/",
      },
    ]);

    await guestPage.goto(`/game/${gameId}`);
    await expect(guestPage.locator('[data-testid="game-over"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(guestPage.locator(".game-over__guest-nudge")).toBeVisible();
    await expect(guestPage.locator(".game-over__guest-nudge")).toContainText(
      "Sign up",
    );

    await guestContext.close();
  });

  test("registered user does NOT see sign-up nudge on game over screen", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");

    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);

    await seedCompletedGame(request, {
      gameId,
      players: [
        { id: host.userId, displayName: "Player1" },
        { id: player2.userId, displayName: "Player2" },
      ],
      winner: host.userId,
      scores: [
        { playerId: host.userId, score: 5 },
        { playerId: player2.userId, score: 0 },
      ],
    });

    const context = await browser.newContext({
      storageState: "e2e/.auth/player2.json",
    });
    const page = await context.newPage();

    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="game-over"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator(".game-over__guest-nudge")).not.toBeVisible();

    await context.close();
  });
});
