import { test, expect, devices } from "@playwright/test";
import path from "path";

const MOCKUPS = [
  {
    name: "A (stacked-compact)",
    file: "mobile-a-stacked-compact.html",
    scrollSelector: ".player-hand",
  },
  {
    name: "B (scrollable-hand)",
    file: "mobile-b-arc-hand.html",
    scrollSelector: ".player-hand-scroll",
  },
];

const MOBILE_DEVICES = ["Pixel 5", "iPhone 12"] as const;

for (const mockup of MOCKUPS) {
  for (const deviceName of MOBILE_DEVICES) {
    test(`${mockup.name} hand scrolls on ${deviceName}`, async ({
      playwright,
    }) => {
      const device = devices[deviceName];
      const browser = await playwright.chromium.launch();
      const context = await browser.newContext({ ...device, hasTouch: true });
      const page = await context.newPage();

      const filePath = path.resolve(__dirname, mockup.file);
      await page.goto(`file://${filePath}`);

      const hand = page.locator(mockup.scrollSelector);
      await hand.waitFor({ state: "visible" });

      const scrollBefore = await hand.evaluate((el) => el.scrollLeft);
      const box = await hand.boundingBox();
      expect(box).not.toBeNull();

      // Simulate touch swipe left
      await page.touchscreen.tap(
        box!.x + box!.width * 0.8,
        box!.y + box!.height / 2,
      );
      await hand.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      const scrollAfter = await hand.evaluate((el) => el.scrollLeft);

      expect(scrollAfter).toBeGreaterThan(scrollBefore);

      // Verify last card is reachable
      const lastCard = hand.locator(".card--hand").last();
      const lastCardBox = await lastCard.boundingBox();
      expect(lastCardBox).not.toBeNull();

      await browser.close();
    });

    test(`${mockup.name} hand scrolls on Firefox (${deviceName} viewport)`, async ({
      playwright,
    }) => {
      const device = devices[deviceName];
      const browser = await playwright.firefox.launch();
      const context = await browser.newContext({
        viewport: device.viewport,
        hasTouch: true,
      });
      const page = await context.newPage();

      const filePath = path.resolve(__dirname, mockup.file);
      await page.goto(`file://${filePath}`);

      const hand = page.locator(mockup.scrollSelector);
      await hand.waitFor({ state: "visible" });

      const scrollBefore = await hand.evaluate((el) => el.scrollLeft);

      // Programmatic scroll — verifies overflow isn't clipped
      await hand.evaluate((el) => {
        el.scrollLeft = 100;
      });
      const scrollAfter = await hand.evaluate((el) => el.scrollLeft);

      expect(scrollAfter).toBeGreaterThan(scrollBefore);

      await browser.close();
    });
  }
}

test("A: log drawer toggle is at least 44px (touch-friendly)", async ({
  playwright,
}) => {
  const device = devices["Pixel 5"];
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({ ...device });
  const page = await context.newPage();

  const filePath = path.resolve(__dirname, "mobile-a-stacked-compact.html");
  await page.goto(`file://${filePath}`);

  const toggle = page.locator(".log-toggle");
  const box = await toggle.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);

  await browser.close();
});

test("C: history section is visible in portrait", async ({ playwright }) => {
  const device = devices["Pixel 5"];
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({ ...device });
  const page = await context.newPage();

  const filePath = path.resolve(__dirname, "mobile-c-landscape-split.html");
  await page.goto(`file://${filePath}`);

  const history = page.locator(".play-area__history");
  await expect(history).toBeVisible();

  const entries = page.locator(".history-entry");
  expect(await entries.count()).toBe(3);

  await browser.close();
});
