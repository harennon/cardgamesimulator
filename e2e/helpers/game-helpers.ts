import { type Page, expect } from "@playwright/test";

/**
 * Creates a new game as the logged-in user and returns the game ID.
 */
export async function createGame(
  page: Page,
  options?: { maxPlayers?: number },
): Promise<string> {
  await page.goto("/");
  await page.click('[data-testid="create-game-link"]');
  // Select game type
  await page.selectOption('[data-testid="game-type-select"]', "big2");
  // Select player count if provided
  if (options?.maxPlayers) {
    await page.fill(
      '[data-testid="max-players-input"]',
      String(options.maxPlayers),
    );
  }
  await page.click('[data-testid="submit-create-game"]');
  // Wait for lobby to load — URL changes to /game/:id
  await page.waitForURL(/\/game\/.+/);
  const url = page.url();
  const gameId = url.split("/game/")[1]!;
  return gameId;
}

/**
 * Joins an existing game as a guest with the given display name.
 */
export async function joinAsGuest(
  page: Page,
  gameId: string,
  displayName: string,
): Promise<void> {
  await page.goto(`/game/${gameId}/join`);
  // Should see guest entry form
  await page.fill('[data-testid="guest-name-input"]', displayName);
  await page.click('[data-testid="guest-join-button"]');
  // Wait for lobby to appear
  await expect(page.locator('[data-testid="game-lobby"]')).toBeVisible();
}

/**
 * Joins an existing game as a registered (already logged-in) user.
 */
export async function joinAsRegistered(
  page: Page,
  gameId: string,
): Promise<void> {
  await page.goto(`/game/${gameId}`);
  // Registered user sees the lobby directly (auto-join)
  await expect(page.locator('[data-testid="game-lobby"]')).toBeVisible();
}

/**
 * Waits for the game board to appear (game has started).
 */
export async function waitForGameBoard(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="game-board"]')).toBeVisible({
    timeout: 10_000,
  });
}
