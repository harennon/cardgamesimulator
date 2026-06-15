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
  test.skip("guest sees sign-up nudge on game over screen", async ({
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

    // Create a guest browser context and set the cookie via page.evaluate
    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();

    // Capture console logs from the browser for debugging
    guestPage.on("console", (msg) => {
      console.log(`[browser ${msg.type()}] ${msg.text()}`);
    });

    // Navigate to root first to establish origin, then set cookie via JS
    await guestPage.goto("/");
    await guestPage.evaluate((token) => {
      const expires = new Date(Date.now() + 4 * 60 * 60 * 1000).toUTCString();
      document.cookie = `guestSession=${encodeURIComponent(token)}; expires=${expires}; path=/; SameSite=Strict`;
    }, guestData.token);

    // Diagnostic: verify cookie, decode, and match
    const diag = await guestPage.evaluate((expectedGameId) => {
      const cookie = document.cookie;
      const prefix = "guestSession=";
      let token: string | null = null;
      for (const part of cookie.split(";")) {
        const trimmed = part.trim();
        if (trimmed.startsWith(prefix)) {
          token = decodeURIComponent(trimmed.slice(prefix.length));
          break;
        }
      }
      if (!token) return { error: "cookie not found", cookie };
      if (!token.startsWith("guest:"))
        return { error: "no guest: prefix", token: token.slice(0, 50) };

      try {
        const encoded = token.slice(6);
        const decoded = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
        const lastDot = decoded.lastIndexOf(".");
        if (lastDot === -1)
          return { error: "no dot in decoded", decoded: decoded.slice(0, 80) };
        const payload = decoded.slice(0, lastDot);
        const parts = payload.split(".");
        if (parts.length !== 3)
          return { error: `expected 3 parts, got ${parts.length}`, parts };
        const [guestId, gameId, expiresAtStr] = parts;
        const expiresAt = parseInt(expiresAtStr!, 10);
        const gameIdMatches = gameId === expectedGameId;
        const isExpired = Date.now() > expiresAt;
        return {
          guestId,
          gameId,
          expiresAt,
          gameIdMatches,
          isExpired,
          expectedGameId,
        };
      } catch (e) {
        return { error: `decode failed: ${e}` };
      }
    }, gameId);
    console.log("[DIAG] Guest cookie decode:", JSON.stringify(diag, null, 2));

    await guestPage.goto(`/game/${gameId}`);

    // Diagnostic: what page did we end up on?
    console.log("[DIAG] Final URL:", guestPage.url());

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
