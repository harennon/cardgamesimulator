import { test, expect } from "@playwright/test";
import {
  readStoredAuth,
  createGameViaApi,
  joinGameViaApi,
} from "./helpers/game-helpers.js";
import { seedCompletedGame } from "./helpers/seed-helpers.js";

test.describe("Rematch button on game over screen", () => {
  test("host sees an active Rematch button; non-host sees the passive indicator", async ({
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

    // Host view: active, enabled Rematch button.
    const hostContext = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const hostPage = await hostContext.newPage();
    await hostPage.goto(`/game/${gameId}`);
    await expect(hostPage.locator('[data-testid="game-over"]')).toBeVisible({
      timeout: 10_000,
    });
    const rematchBtn = hostPage.locator('[data-testid="rematch-button"]');
    await expect(rematchBtn).toBeVisible();
    await expect(rematchBtn).toBeEnabled();
    await expect(
      hostPage.locator('[data-testid="rematch-waiting"]'),
    ).toHaveCount(0);

    // Non-host view: passive "Host can start a rematch" indicator, no button.
    const p2Context = await browser.newContext({
      storageState: "e2e/.auth/player2.json",
    });
    const p2Page = await p2Context.newPage();
    await p2Page.goto(`/game/${gameId}`);
    await expect(p2Page.locator('[data-testid="game-over"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      p2Page.locator('[data-testid="rematch-waiting"]'),
    ).toBeVisible();
    await expect(p2Page.locator('[data-testid="rematch-button"]')).toHaveCount(
      0,
    );

    await hostContext.close();
    await p2Context.close();
  });

  test("host click starts a rematch and both players navigate into the new game", async ({
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

    const hostContext = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const hostPage = await hostContext.newPage();
    const p2Context = await browser.newContext({
      storageState: "e2e/.auth/player2.json",
    });
    const p2Page = await p2Context.newPage();

    await hostPage.goto(`/game/${gameId}`);
    await p2Page.goto(`/game/${gameId}`);
    await expect(hostPage.locator('[data-testid="game-over"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(p2Page.locator('[data-testid="game-over"]')).toBeVisible({
      timeout: 10_000,
    });

    // Host clicks rematch — both clients should navigate to the new game route.
    await hostPage.locator('[data-testid="rematch-button"]').click();

    await hostPage.waitForURL(
      (url) =>
        url.pathname.startsWith("/game/") && url.pathname !== `/game/${gameId}`,
      { timeout: 10_000 },
    );
    await p2Page.waitForURL(
      (url) =>
        url.pathname.startsWith("/game/") && url.pathname !== `/game/${gameId}`,
      { timeout: 10_000 },
    );

    const hostNewUrl = new URL(hostPage.url());
    const p2NewUrl = new URL(p2Page.url());
    expect(hostNewUrl.pathname).toBe(p2NewUrl.pathname);

    // Both land in the dealt round (game board), not a lobby.
    await expect(hostPage.locator(".game-view__board-container")).toBeVisible({
      timeout: 10_000,
    });
    await expect(p2Page.locator(".game-view__board-container")).toBeVisible({
      timeout: 10_000,
    });

    await hostContext.close();
    await p2Context.close();
  });
});
