import { type Page, expect, type APIRequestContext } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

const BACKEND_URL = "http://localhost:3000";

interface StoredAuthToken {
  access_token: string;
  user: { id: string };
}

/**
 * Reads the access token and user ID from a stored Playwright auth state file.
 * Auth state files are written by global-setup.ts.
 */
export function readStoredAuth(playerFile: string): {
  accessToken: string;
  userId: string;
} {
  const filePath = path.resolve(__dirname, "..", ".auth", playerFile);
  const state = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
    origins: Array<{
      localStorage: Array<{ name: string; value: string }>;
    }>;
  };
  const localStorage = state.origins[0]?.localStorage ?? [];
  const authEntry = localStorage.find((e) => e.name.includes("auth-token"));
  if (!authEntry) {
    throw new Error(`No auth token found in ${playerFile}`);
  }
  const token = JSON.parse(authEntry.value) as StoredAuthToken;
  return { accessToken: token.access_token, userId: token.user.id };
}

/**
 * Creates a game via the backend REST API. Returns the game ID.
 * Uses the host's stored auth token — no browser interaction required.
 */
export async function createGameViaApi(
  request: APIRequestContext,
  hostAccessToken: string,
  options?: { maxPlayers?: number },
): Promise<string> {
  const res = await request.post(`${BACKEND_URL}/createGame`, {
    headers: { Authorization: `Bearer ${hostAccessToken}` },
    data: {
      gameType: "big2",
      maxPlayers: options?.maxPlayers ?? 2,
      turnTimerSeconds: 30,
    },
  });
  if (!res.ok()) {
    throw new Error(
      `createGameViaApi failed (${res.status()}): ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { gameId: string };
  return body.gameId;
}

/**
 * Joins a game via the backend REST API.
 */
export async function joinGameViaApi(
  request: APIRequestContext,
  gameId: string,
  playerAccessToken: string,
): Promise<void> {
  const res = await request.post(`${BACKEND_URL}/joinGame`, {
    headers: { Authorization: `Bearer ${playerAccessToken}` },
    data: { gameId },
  });
  if (!res.ok()) {
    throw new Error(
      `joinGameViaApi failed (${res.status()}): ${await res.text()}`,
    );
  }
}

/**
 * Logs in via the login form UI. Use when testing the login flow itself.
 * For tests that just need an authenticated session, use storageState instead.
 */
export async function loginViaUI(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto("/login");
  await page.fill('[data-testid="email-input"]', email);
  await page.fill('[data-testid="password-input"]', password);
  await page.click('[data-testid="login-button"]');
  await page.waitForURL("/");
}

/**
 * Signs up via the signup form UI.
 */
export async function signupViaUI(
  page: Page,
  displayName: string,
  email: string,
  password: string,
): Promise<void> {
  await page.goto("/signup");
  await page.fill('[data-testid="signup-display-name"]', displayName);
  await page.fill('[data-testid="signup-email"]', email);
  await page.fill('[data-testid="signup-password"]', password);
  await page.click('[data-testid="signup-button"]');
  await page.waitForURL("/");
}

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
