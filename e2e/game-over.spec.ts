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

  // Skip: guest WebSocket auth via injected cookie is unreliable in CI.
  // The guest token restoration + socket handshake requires the full browser
  // guest-entry flow to set up state correctly. Will address with guest UI polish.
  test("guest sees sign-up nudge on game over screen", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");

    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });

    // Use the real guest join UI flow (same pattern as guest-flow.spec.ts)
    // This properly creates the session cookie via the frontend's normal flow
    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();
    await guestPage.goto(`/game/${gameId}/join`);
    await guestPage.fill('[data-testid="guest-name-input"]', "GuestCarol");
    await guestPage.click('[data-testid="guest-join-button"]');
    await expect(guestPage.locator('[data-testid="game-lobby"]')).toBeVisible();

    // Read the guest ID from the game state via REST (the guest is now in playerIds)
    const stateRes = await request.get(
      `http://localhost:3000/getGameState?gameId=${gameId}`,
      { headers: { Authorization: `Bearer ${host.accessToken}` } },
    );
    const gameState = (await stateRes.json()) as {
      gameState: { playerIds: string[] };
    };
    const guestId = gameState.gameState.playerIds.find(
      (id) => id !== host.userId,
    )!;

    // Seed the game as COMPLETED
    await seedCompletedGame(request, {
      gameId,
      players: [
        { id: host.userId, displayName: "Player1" },
        { id: guestId, displayName: "GuestCarol" },
      ],
      winner: host.userId,
      scores: [
        { playerId: host.userId, score: 5 },
        { playerId: guestId, score: 0 },
      ],
    });

    // Reload the page — the guest cookie is already set by the join flow
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
