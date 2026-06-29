import { test, expect } from "@playwright/test";
import {
  readStoredAuth,
  createGameViaApi,
  joinGameViaApi,
} from "./helpers/game-helpers.js";
import { seedGameState } from "./helpers/seed-helpers.js";

// 13 distinct cards for a full Big2 starting hand
const FULL_HAND = [
  { suit: "clubs", rank: "3" },
  { suit: "diamonds", rank: "4" },
  { suit: "hearts", rank: "5" },
  { suit: "spades", rank: "6" },
  { suit: "clubs", rank: "7" },
  { suit: "diamonds", rank: "8" },
  { suit: "hearts", rank: "9" },
  { suit: "spades", rank: "10" },
  { suit: "clubs", rank: "J" },
  { suit: "diamonds", rank: "Q" },
  { suit: "hearts", rank: "K" },
  { suit: "spades", rank: "A" },
  { suit: "clubs", rank: "2" },
] as const;

const OPPONENT_HAND = [
  { suit: "diamonds", rank: "3" },
  { suit: "hearts", rank: "4" },
  { suit: "spades", rank: "5" },
  { suit: "clubs", rank: "6" },
  { suit: "diamonds", rank: "7" },
  { suit: "hearts", rank: "8" },
  { suit: "spades", rank: "9" },
  { suit: "clubs", rank: "10" },
  { suit: "diamonds", rank: "J" },
  { suit: "hearts", rank: "Q" },
  { suit: "spades", rank: "K" },
  { suit: "clubs", rank: "A" },
  { suit: "diamonds", rank: "2" },
] as const;

/**
 * Seeds a 2-player Big2 game into IN_PROGRESS with full hands.
 * Player1 goes first (has 3 of clubs, first play of game).
 */
async function seedInProgressGame(
  request: Parameters<typeof seedGameState>[0],
  gameId: string,
  host: { userId: string },
  player2: { userId: string },
): Promise<void> {
  await seedGameState(request, {
    gameId,
    state: {
      status: "IN_PROGRESS",
      gameType: "big2",
      version: 1,
      turnNumber: 1,
      randomSeed: "test-mobile-seed",
      currentPlayerIndex: 0,
      winner: null,
      scores: null,
      players: [
        { playerId: host.userId, displayName: "Player1" },
        { playerId: player2.userId, displayName: "Player2" },
      ],
      gameSpecificState: {
        hands: [FULL_HAND, OPPONENT_HAND],
        lastPlay: null,
        lastPlayPlayerIndex: null,
        consecutivePasses: 0,
        isFreePlay: false,
        isFirstPlayOfGame: true,
        playHistory: [],
        finishedPlayerIndices: [],
      },
    },
    dbFields: {
      status: "IN_PROGRESS",
      playerIds: [host.userId, player2.userId],
      playerDisplayNames: {
        [host.userId]: "Player1",
        [player2.userId]: "Player2",
      },
    },
  });
}

test.describe("Mobile layout (LLD 11)", () => {
  test("mobile viewport: game-board--mobile class is present at 375x667", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");

    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);
    await seedInProgressGame(request, gameId, host, player2);

    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="game-board"]')).toBeVisible({
      timeout: 10_000,
    });

    await page.setViewportSize({ width: 375, height: 667 });

    const board = page.locator('[data-testid="game-board"]');
    await expect(board).toHaveClass(/game-board--mobile/);

    await context.close();
  });

  test("mobile viewport: game-board__log is display:none", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");

    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);
    await seedInProgressGame(request, gameId, host, player2);

    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="game-board"]')).toBeVisible({
      timeout: 10_000,
    });

    await page.setViewportSize({ width: 375, height: 667 });

    const logPanel = page.locator(".game-board__log");
    await expect(logPanel).toHaveCSS("display", "none");

    await context.close();
  });

  test("mobile viewport: log toggle button is visible", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");

    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);
    await seedInProgressGame(request, gameId, host, player2);

    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="game-board"]')).toBeVisible({
      timeout: 10_000,
    });

    await page.setViewportSize({ width: 375, height: 667 });

    await expect(page.locator(".log-toggle")).toBeVisible();

    await context.close();
  });

  test("mobile viewport: clicking log toggle opens the drawer", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");

    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);
    await seedInProgressGame(request, gameId, host, player2);

    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="game-board"]')).toBeVisible({
      timeout: 10_000,
    });

    await page.setViewportSize({ width: 375, height: 667 });

    const toggle = page.locator(".log-toggle");
    await expect(toggle).toBeVisible();
    await toggle.click();

    await expect(page.locator(".log-drawer")).toHaveClass(/log-drawer--open/);

    await context.close();
  });

  test("mobile viewport: pressing Escape closes the drawer", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");

    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);
    await seedInProgressGame(request, gameId, host, player2);

    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="game-board"]')).toBeVisible({
      timeout: 10_000,
    });

    await page.setViewportSize({ width: 375, height: 667 });

    // Open the drawer
    await page.locator(".log-toggle").click();
    await expect(page.locator(".log-drawer")).toHaveClass(/log-drawer--open/);

    // Close it with Escape
    await page.keyboard.press("Escape");
    await expect(page.locator(".log-drawer")).not.toHaveClass(
      /log-drawer--open/,
    );

    await context.close();
  });

  test("mobile viewport: hand is horizontally scrollable with 13 cards", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");

    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);
    await seedInProgressGame(request, gameId, host, player2);

    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="game-board"]')).toBeVisible({
      timeout: 10_000,
    });

    await page.setViewportSize({ width: 375, height: 667 });

    const isScrollable = await page.locator(".player-hand").evaluate((el) => {
      return el.scrollWidth > el.clientWidth;
    });
    expect(isScrollable).toBe(true);

    await context.close();
  });

  test("mobile viewport: /join-game does not overflow vertically (LLD 60)", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();

    await page.goto("/join-game");
    await expect(page.locator('[data-testid="game-code-input"]')).toBeVisible({
      timeout: 10_000,
    });

    // The short join form must fit the visible viewport with no vertical scroll.
    const hasOverflow = await page.evaluate(
      () => document.scrollingElement!.scrollHeight > window.innerHeight,
    );
    expect(hasOverflow).toBe(false);

    await context.close();
  });

  test("desktop viewport: game-board--mobile class is NOT present at 1024x768", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");

    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);
    await seedInProgressGame(request, gameId, host, player2);

    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="game-board"]')).toBeVisible({
      timeout: 10_000,
    });

    await page.setViewportSize({ width: 1024, height: 768 });

    const board = page.locator('[data-testid="game-board"]');
    await expect(board).not.toHaveClass(/game-board--mobile/);

    await context.close();
  });
});
