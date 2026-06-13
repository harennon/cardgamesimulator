import { test, expect } from "@playwright/test";

test.describe("Smoke test", () => {
  test("home page loads for authenticated user", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    await expect(
      page.locator('[data-testid="create-game-link"]'),
    ).toBeVisible();
    await context.close();
  });

  test("guest entry screen renders for unauthenticated user visiting game URL", async ({
    page,
  }) => {
    // Navigate to a game join URL without auth — should show guest entry form
    await page.goto("/game/nonexistent-id/join");
    // Assert the guest entry component rendered with its heading
    await expect(page.locator('[data-testid="guest-entry"]')).toBeVisible();
    await expect(page.locator("h2")).toHaveText("Join as Guest");
  });
});
