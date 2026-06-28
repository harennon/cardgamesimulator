import { test, expect, type Page } from "@playwright/test";

// LLD 58: Signed-in home page overflows viewport; content not vertically centered.
// These assertions cover what computed state can verify: no vertical page
// overflow on the home screen (signed in and signed out, desktop and mobile),
// and equal width of the signed-out Log In / Sign Up buttons. Visual centering
// itself is verified manually per the LLD test table.

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 375, height: 667 };

async function assertNoVerticalOverflow(page: Page): Promise<void> {
  const overflows = await page.evaluate(
    () => document.documentElement.scrollHeight > window.innerHeight,
  );
  expect(overflows).toBe(false);
}

test.describe("Home page layout (LLD 58)", () => {
  test("signed in at 1440x900: no vertical page overflow", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
      viewport: DESKTOP,
    });
    const page = await context.newPage();

    await page.goto("/");
    await expect(page.locator('[data-testid="welcome-message"]')).toBeVisible();

    await assertNoVerticalOverflow(page);

    await context.close();
  });

  test("signed in at 375x667: no vertical page overflow", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
      viewport: MOBILE,
    });
    const page = await context.newPage();

    await page.goto("/");
    await expect(page.locator('[data-testid="welcome-message"]')).toBeVisible();

    await assertNoVerticalOverflow(page);

    await context.close();
  });

  test("signed out at 1440x900: no vertical page overflow", async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: DESKTOP });
    const page = await context.newPage();

    await page.goto("/");
    await expect(page.locator('[data-testid="home-title"]')).toBeVisible();

    await assertNoVerticalOverflow(page);

    await context.close();
  });

  test("signed out at 375x667: no vertical page overflow", async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: MOBILE });
    const page = await context.newPage();

    await page.goto("/");
    await expect(page.locator('[data-testid="home-title"]')).toBeVisible();

    await assertNoVerticalOverflow(page);

    await context.close();
  });

  test("signed out: Log In and Sign Up buttons are equal width", async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: DESKTOP });
    const page = await context.newPage();

    await page.goto("/");
    const logIn = page.locator('a[href="/login"].home__btn');
    const signUp = page.locator('a[href="/signup"].home__btn');
    await expect(logIn).toBeVisible();
    await expect(signUp).toBeVisible();

    const logInBox = await logIn.boundingBox();
    const signUpBox = await signUp.boundingBox();
    expect(logInBox).not.toBeNull();
    expect(signUpBox).not.toBeNull();
    expect(Math.abs(logInBox!.width - signUpBox!.width)).toBeLessThanOrEqual(1);

    await context.close();
  });
});

test.describe("Flow screen regression (LLD 58)", () => {
  test("login at 1440x900: no horizontal overflow, form card centered", async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: DESKTOP });
    const page = await context.newPage();

    await page.goto("/login");
    const card = page.locator(".form-card");
    await expect(card).toBeVisible();

    const overflowsX = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflowsX).toBe(false);

    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    const center = box!.x + box!.width / 2;
    expect(Math.abs(center - DESKTOP.width / 2)).toBeLessThanOrEqual(2);

    await context.close();
  });

  test("signup at 1440x900: no horizontal overflow, form card centered", async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: DESKTOP });
    const page = await context.newPage();

    await page.goto("/signup");
    const card = page.locator(".form-card");
    await expect(card).toBeVisible();

    const overflowsX = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflowsX).toBe(false);

    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    const center = box!.x + box!.width / 2;
    expect(Math.abs(center - DESKTOP.width / 2)).toBeLessThanOrEqual(2);

    await context.close();
  });
});
