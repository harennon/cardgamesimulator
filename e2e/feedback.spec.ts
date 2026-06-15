import { test, expect } from "@playwright/test";

test.describe("Feedback widget", () => {
  test("floating button is visible on home page", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto("/");
    await expect(
      page.locator('[data-testid="feedback-trigger"]'),
    ).toBeVisible();

    await context.close();
  });

  test("clicking trigger opens modal, cancel closes it", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto("/");
    await page.click('[data-testid="feedback-trigger"]');
    await expect(page.locator('[data-testid="feedback-modal"]')).toBeVisible();

    // Trigger button should be hidden when modal is open
    await expect(
      page.locator('[data-testid="feedback-trigger"]'),
    ).not.toBeVisible();

    // Cancel closes the modal
    await page.click(".feedback-widget__btn--cancel");
    await expect(
      page.locator('[data-testid="feedback-modal"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('[data-testid="feedback-trigger"]'),
    ).toBeVisible();

    await context.close();
  });

  test("submit button disabled when description is empty", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto("/");
    await page.click('[data-testid="feedback-trigger"]');

    await expect(
      page.locator('[data-testid="feedback-submit"]'),
    ).toBeDisabled();

    await page.fill('[data-testid="feedback-description"]', "Some feedback");
    await expect(page.locator('[data-testid="feedback-submit"]')).toBeEnabled();

    await context.close();
  });

  test("submitting feedback shows toast and closes modal", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto("/");
    await page.click('[data-testid="feedback-trigger"]');

    await page.selectOption('[data-testid="feedback-category"]', "bug");
    await page.fill(
      '[data-testid="feedback-description"]',
      "The cards overlap on small screens",
    );
    await page.click('[data-testid="feedback-submit"]');

    // Toast appears
    await expect(page.locator('[data-testid="feedback-toast"]')).toBeVisible();
    await expect(page.locator('[data-testid="feedback-toast"]')).toContainText(
      "Thanks",
    );

    // Modal closes
    await expect(
      page.locator('[data-testid="feedback-modal"]'),
    ).not.toBeVisible();

    await context.close();
  });
});
