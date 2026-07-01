import { test, expect, type Page, type Route } from "@playwright/test";
import type { GameStatsEntry, GetStatsResponse } from "../src/shared/model.js";

// LLD 116: Stats time-range UI selector (frontend for the LLD 101 backend).
// These specs drive the real signed-in stats page but intercept GET /api/stats
// so each window renders a deterministic response — the seed API cannot create
// dated game_history rows, and we want to assert exactly which query string the
// UI emits per window and how it renders each windowed result. This is API
// mocking, not auth cookie injection (auth still uses the real storageState).

const AUTH = "e2e/.auth/player1.json";

function entry(
  gameType: GameStatsEntry["gameType"],
  won: number,
): GameStatsEntry {
  return {
    gameType,
    gamesPlayed: 4,
    gamesWon: won,
    gamesLost: 4 - won,
    totalScore: 30,
    winRate: won / 4,
    lastPlayedAt: "2026-06-01T00:00:00.000Z",
  };
}

// Route the stats endpoint. `bodyFor` maps the requested window ("lifetime" when
// no ?window= is present) to the response body to return, and every request URL
// is recorded so a test can assert the exact query string the UI emitted.
async function stubStats(
  page: Page,
  bodyFor: (window: string) => GetStatsResponse,
  urls: string[],
): Promise<void> {
  await page.route("**/api/stats**", async (route: Route) => {
    const url = new URL(route.request().url());
    urls.push(url.pathname + url.search);
    const window = url.searchParams.get("window") ?? "lifetime";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(bodyFor(window)),
    });
  });
}

test.describe("Stats time-range selector (LLD 116)", () => {
  test("lifetime default: no-query request, caption unchanged, no tracking-since note", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: AUTH });
    const page = await context.newPage();
    const urls: string[] = [];
    await stubStats(
      page,
      (w) => ({
        userId: "u",
        window: w as GetStatsResponse["window"],
        trackingSince: null,
        games: [entry("big2", 3)],
      }),
      urls,
    );

    await page.goto("/stats");
    await expect(page.locator('[data-testid="stats-list"]')).toBeVisible();

    // No-regression: caption text unchanged, no ?window= on the lifetime fetch.
    await expect(page.locator(".stats-card__caption")).toHaveText(
      "Lifetime totals across all your games.",
    );
    expect(urls[0]).toBe("/api/stats");
    await expect(
      page.locator('[data-testid="stats-tracking-since"]'),
    ).toHaveCount(0);

    // Selector is present with the three labelled tabs.
    await expect(
      page.locator('[data-testid="stats-window-lifetime"]'),
    ).toHaveText("Lifetime");
    await expect(page.locator('[data-testid="stats-window-30d"]')).toHaveText(
      "Last 30 days",
    );
    await expect(page.locator('[data-testid="stats-window-ytd"]')).toHaveText(
      "Year to date",
    );

    await context.close();
  });

  test("selecting 30d/ytd re-fetches with ?window= and slides the thumb", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: AUTH });
    const page = await context.newPage();
    const urls: string[] = [];
    await stubStats(
      page,
      (w) => ({
        userId: "u",
        window: w as GetStatsResponse["window"],
        trackingSince: w === "lifetime" ? null : "2026-01-01T00:00:00.000Z",
        games: [entry("big2", 2)],
      }),
      urls,
    );

    await page.goto("/stats");
    await expect(page.locator('[data-testid="stats-list"]')).toBeVisible();

    const thumb = page.locator(".stats-tabs__thumb");
    // Required refinement 1: the thumb is inset (has left/right track spacing),
    // so its left edge sits inside the track, not flush at x=0 of the track.
    const trackBox = await page
      .locator('[data-testid="stats-window-tabs"]')
      .boundingBox();
    const lifetimeThumbBox = await thumb.boundingBox();
    expect(trackBox).not.toBeNull();
    expect(lifetimeThumbBox).not.toBeNull();
    expect(lifetimeThumbBox!.x).toBeGreaterThan(trackBox!.x);
    // At lifetime the thumb is not translated.
    await expect(thumb).toHaveAttribute("style", /translateX\(0%\)/);

    await page.locator('[data-testid="stats-window-30d"]').click();
    await expect(
      page.locator('[data-testid="stats-tracking-since"]'),
    ).toBeVisible();
    expect(urls.some((u) => u === "/api/stats?window=30d")).toBe(true);
    // Thumb slid to the middle segment (translateX 100%).
    await expect(thumb).toHaveAttribute("style", /translateX\(100%\)/);

    await page.locator('[data-testid="stats-window-ytd"]').click();
    expect(urls.some((u) => u === "/api/stats?window=ytd")).toBe(true);
    // Thumb slid to the last segment (translateX 200%).
    await expect(thumb).toHaveAttribute("style", /translateX\(200%\)/);

    await context.close();
  });

  test("empty-window state is distinct from never-played (no Create CTA)", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: AUTH });
    const page = await context.newPage();
    const urls: string[] = [];
    await stubStats(
      page,
      (w) => ({
        userId: "u",
        window: w as GetStatsResponse["window"],
        trackingSince: w === "lifetime" ? null : "2026-01-01T00:00:00.000Z",
        // Lifetime has games; the windows are empty.
        games: w === "lifetime" ? [entry("big2", 2)] : [],
      }),
      urls,
    );

    await page.goto("/stats");
    await expect(page.locator('[data-testid="stats-list"]')).toBeVisible();

    await page.locator('[data-testid="stats-window-30d"]').click();
    await expect(
      page.locator('[data-testid="stats-empty-window"]'),
    ).toBeVisible();
    // The distinct empty-window state must NOT offer the Create-a-Game CTA.
    await expect(page.locator('[data-testid="stats-create-link"]')).toHaveCount(
      0,
    );
    // Tracking-since still shows on the window.
    await expect(
      page.locator('[data-testid="stats-tracking-since"]'),
    ).toBeVisible();

    await context.close();
  });

  test("keyboard: arrow keys move selection and re-fetch", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: AUTH });
    const page = await context.newPage();
    const urls: string[] = [];
    await stubStats(
      page,
      (w) => ({
        userId: "u",
        window: w as GetStatsResponse["window"],
        trackingSince: null,
        games: [entry("big2", 1)],
      }),
      urls,
    );

    await page.goto("/stats");
    await expect(page.locator('[data-testid="stats-list"]')).toBeVisible();

    await page.locator('[data-testid="stats-window-lifetime"]').focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.locator('[data-testid="stats-window-30d"]'),
    ).toHaveAttribute("aria-selected", "true");
    expect(urls.some((u) => u === "/api/stats?window=30d")).toBe(true);

    // Clamp: ArrowLeft twice from 30d lands on lifetime and stays there.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(
      page.locator('[data-testid="stats-window-lifetime"]'),
    ).toHaveAttribute("aria-selected", "true");

    await context.close();
  });

  test("guest: selector is not rendered (route guard redirects to login)", async ({
    browser,
  }) => {
    // No storageState -> the requiresAuth guard (LLD 90) redirects a signed-out
    // deep link to /login; the stats window tabs never render for a guest.
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("/stats");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('[data-testid="stats-window-tabs"]')).toHaveCount(
      0,
    );

    await context.close();
  });
});
