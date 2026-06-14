import { test, expect } from "@playwright/test";

test.describe("Login flow", () => {
  test("successful login redirects to home and shows user name", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("/login");
    await page.fill('[data-testid="email-input"]', "e2e-player1@test.local");
    await page.fill('[data-testid="password-input"]', "testpass123");
    await page.click('[data-testid="login-button"]');

    await page.waitForURL("/");
    await expect(page.locator('[data-testid="welcome-message"]')).toBeVisible();
    await expect(page.locator('[data-testid="app-nav-user"]')).toHaveText(
      "Player1",
    );

    await context.close();
  });

  test("invalid credentials shows error message", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("/login");
    await page.fill('[data-testid="email-input"]', "wrong@test.local");
    await page.fill('[data-testid="password-input"]', "badpassword");
    await page.click('[data-testid="login-button"]');

    await expect(page.locator('[data-testid="login-error"]')).toBeVisible();
    expect(page.url()).toContain("/login");

    await context.close();
  });

  test("login with redirect query param forwards to intended page", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("/login?redirect=/create-game");
    await page.fill('[data-testid="email-input"]', "e2e-player1@test.local");
    await page.fill('[data-testid="password-input"]', "testpass123");
    await page.click('[data-testid="login-button"]');

    await page.waitForURL("/create-game");
    await expect(
      page.locator('[data-testid="game-type-select"]'),
    ).toBeVisible();

    await context.close();
  });
});

test.describe("Signup flow", () => {
  test("successful signup redirects to home", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    const uniqueEmail = `e2e-signup-${Date.now()}@test.local`;

    await page.goto("/signup");
    await page.fill('[data-testid="signup-display-name"]', "NewUser");
    await page.fill('[data-testid="signup-email"]', uniqueEmail);
    await page.fill('[data-testid="signup-password"]', "testpass123");
    await page.click('[data-testid="signup-button"]');

    await page.waitForURL("/");
    await expect(page.locator('[data-testid="welcome-message"]')).toBeVisible();

    await context.close();
  });

  test("signup with existing email shows error", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("/signup");
    await page.fill('[data-testid="signup-display-name"]', "Duplicate");
    await page.fill('[data-testid="signup-email"]', "e2e-player1@test.local");
    await page.fill('[data-testid="signup-password"]', "testpass123");
    await page.click('[data-testid="signup-button"]');

    await expect(page.locator('[data-testid="signup-error"]')).toBeVisible();
    expect(page.url()).toContain("/signup");

    await context.close();
  });
});

test.describe("Home page", () => {
  test("authenticated user sees Create Game and Join Game actions", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto("/");
    await expect(
      page.locator('[data-testid="create-game-link"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="join-game-link"]')).toBeVisible();
    await expect(page.locator('[data-testid="welcome-message"]')).toContainText(
      "Player1",
    );

    await context.close();
  });

  test("unauthenticated user sees login/signup prompt", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("/");
    await expect(
      page.locator('[data-testid="create-game-link"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('[data-testid="app-nav"] a[href="/login"]'),
    ).toBeVisible();

    await context.close();
  });
});

test.describe("Create Game flow", () => {
  test("creates a game and navigates to lobby", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto("/create-game");
    await page.selectOption('[data-testid="game-type-select"]', "big2");
    await page.click('[data-testid="submit-create-game"]');

    await page.waitForURL(/\/game\/.+/);
    await expect(page.locator('[data-testid="game-lobby"]')).toBeVisible();

    await context.close();
  });

  test("submit is disabled without game type selection", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto("/create-game");
    await expect(
      page.locator('[data-testid="submit-create-game"]'),
    ).toBeDisabled();

    await context.close();
  });

  test("unauthenticated user is redirected to login", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("/create-game");
    await page.waitForURL(/\/login/);
    expect(page.url()).toContain("redirect=/create-game");

    await context.close();
  });
});

test.describe("Join Game flow", () => {
  test("joining a non-existent game shows error", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto("/join-game");
    await page.fill(
      '[data-testid="game-code-input"]',
      "00000000-0000-0000-0000-000000000000",
    );
    await page.click('[data-testid="join-game-button"]');

    await expect(page.locator('[data-testid="join-game-error"]')).toHaveText(
      "Game not found.",
    );

    await context.close();
  });

  test("submit is disabled with empty input", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto("/join-game");
    await expect(
      page.locator('[data-testid="join-game-button"]'),
    ).toBeDisabled();

    await context.close();
  });
});

test.describe("Navigation / App shell", () => {
  test("authenticated user sees display name and logout in nav", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto("/");
    await expect(page.locator('[data-testid="app-nav-user"]')).toHaveText(
      "Player1",
    );
    await expect(page.locator('[data-testid="logout-button"]')).toBeVisible();

    await context.close();
  });

  test("logout navigates to login page", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto("/");
    await page.click('[data-testid="logout-button"]');
    await page.waitForURL("/login");

    await context.close();
  });

  test("nav is hidden on game board page", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto("/");
    await page.click('[data-testid="create-game-link"]');
    await page.selectOption('[data-testid="game-type-select"]', "big2");
    await page.click('[data-testid="submit-create-game"]');
    await page.waitForURL(/\/game\/.+/);

    await expect(page.locator('[data-testid="app-nav"]')).not.toBeVisible();

    await context.close();
  });
});
