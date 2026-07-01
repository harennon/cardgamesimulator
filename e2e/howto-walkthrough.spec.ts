import { test, expect, type Page } from "@playwright/test";
import {
  readStoredAuth,
  createGameViaApi,
  joinGameViaApi,
} from "./helpers/game-helpers.js";
import {
  seedGameState,
  buildTonkSeedState,
  tonkCard,
} from "./helpers/seed-helpers.js";

const BIG2_STEP_COUNT = 6;
const TONK_STEP_COUNT = 6;

async function openHome(
  browser: Parameters<Parameters<typeof test>[1]>[0]["browser"],
) {
  const context = await browser.newContext({
    storageState: "e2e/.auth/player1.json",
  });
  const page = await context.newPage();
  await page.goto("/");
  return { context, page };
}

/** Advance from step 1 to the last step, asserting the indicator each time. */
async function walkToLastStep(page: Page): Promise<void> {
  for (let step = 1; step <= BIG2_STEP_COUNT; step++) {
    await expect(
      page.locator('[data-testid="howto-step-indicator"]'),
    ).toContainText(`Step ${step} of ${BIG2_STEP_COUNT}`);
    if (step < BIG2_STEP_COUNT) {
      await page.click('[data-testid="howto-next"]');
    }
  }
}

test.describe("How-to-play walkthrough (LLD 111)", () => {
  test("(?) FAB is visible on the home screen", async ({ browser }) => {
    const { context, page } = await openHome(browser);
    await expect(page.locator('[data-testid="howto-fab"]')).toBeVisible();
    await context.close();
  });

  test("tapping the FAB opens the modal at step 1 with Back disabled", async ({
    browser,
  }) => {
    const { context, page } = await openHome(browser);

    await page.click('[data-testid="howto-fab"]');
    await expect(page.locator('[data-testid="howto-modal"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="howto-step-indicator"]'),
    ).toContainText(`Step 1 of ${BIG2_STEP_COUNT}`);
    await expect(page.locator('[data-testid="howto-back"]')).toBeDisabled();

    await context.close();
  });

  test("Next advances through all steps; the dot indicator has one dot per step", async ({
    browser,
  }) => {
    const { context, page } = await openHome(browser);

    await page.click('[data-testid="howto-fab"]');
    await expect(page.locator('[data-testid="howto-dots"] i')).toHaveCount(
      BIG2_STEP_COUNT,
    );

    await walkToLastStep(page);

    // On the last step the primary button dismisses the modal ("Got it").
    await expect(page.locator('[data-testid="howto-next"]')).toContainText(
      "Got it",
    );
    await page.click('[data-testid="howto-next"]');
    await expect(page.locator('[data-testid="howto-modal"]')).not.toBeVisible();

    await context.close();
  });

  test("card scenes render real GameCard .card elements (Option 1 wiring)", async ({
    browser,
  }) => {
    const { context, page } = await openHome(browser);

    await page.click('[data-testid="howto-fab"]');
    // Step 1 is a `cards` scene (3♣ 7♠ 10♥ K♦ 2♠).
    await expect(
      page.locator('[data-testid="howto-scene"] .card').first(),
    ).toBeVisible();
    await expect(page.locator('[data-testid="howto-scene"] .card')).toHaveCount(
      5,
    );

    await context.close();
  });

  test("close via X dismisses the modal (E3/E4)", async ({ browser }) => {
    const { context, page } = await openHome(browser);
    await page.click('[data-testid="howto-fab"]');
    await expect(page.locator('[data-testid="howto-modal"]')).toBeVisible();
    await page.click('[data-testid="howto-close"]');
    await expect(page.locator('[data-testid="howto-modal"]')).not.toBeVisible();
    await context.close();
  });

  test("close via scrim click dismisses the modal (E4)", async ({
    browser,
  }) => {
    const { context, page } = await openHome(browser);
    await page.click('[data-testid="howto-fab"]');
    await expect(page.locator('[data-testid="howto-modal"]')).toBeVisible();
    // Click the scrim at a corner well outside the centered panel.
    await page.locator(".wt-scrim").click({ position: { x: 5, y: 5 } });
    await expect(page.locator('[data-testid="howto-modal"]')).not.toBeVisible();
    await context.close();
  });

  test("close via Esc dismisses the modal (E3)", async ({ browser }) => {
    const { context, page } = await openHome(browser);
    await page.click('[data-testid="howto-fab"]');
    await expect(page.locator('[data-testid="howto-modal"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="howto-modal"]')).not.toBeVisible();
    await context.close();
  });

  test("mobile viewport: FAB, bug icon, and nav buttons meet the ~44px target (E9)", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
      viewport: { width: 375, height: 667 },
    });
    const page = await context.newPage();
    await page.goto("/");

    const fab = page.locator('[data-testid="howto-fab"]');
    const bug = page.locator('[data-testid="feedback-trigger"]');
    await expect(fab).toBeVisible();
    await expect(bug).toBeVisible();

    // FAB is 46px, bug icon 40px — both comfortably tappable.
    const fabBox = await fab.boundingBox();
    const bugBox = await bug.boundingBox();
    expect(fabBox!.width).toBeGreaterThanOrEqual(40);
    expect(bugBox!.width).toBeGreaterThanOrEqual(38);

    await page.click('[data-testid="howto-fab"]');
    await expect(page.locator('[data-testid="howto-modal"]')).toBeVisible();

    // Nav buttons are ≥44px tall.
    for (const testid of ["howto-back", "howto-next"]) {
      const box = await page.locator(`[data-testid="${testid}"]`).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    await context.close();
  });
});

test.describe("How-to-play walkthrough — persistence on the game board (LLD 111)", () => {
  test("(?) FAB is visible on an in-progress game board", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");

    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);
    await seedGameState(request, {
      gameId,
      state: {
        status: "IN_PROGRESS",
        gameType: "big2",
        version: 1,
        turnNumber: 1,
        randomSeed: "howto-fab-seed",
        currentPlayerIndex: 0,
        winner: null,
        scores: null,
        players: [
          { playerId: host.userId, displayName: "Player1" },
          { playerId: player2.userId, displayName: "Player2" },
        ],
        gameSpecificState: {
          hands: [
            [
              { suit: "clubs", rank: "3" },
              { suit: "diamonds", rank: "4" },
            ],
            [
              { suit: "hearts", rank: "5" },
              { suit: "spades", rank: "6" },
            ],
          ],
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
        turnTimerSeconds: null,
      },
    });

    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();
    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="game-board"]')).toBeVisible({
      timeout: 10_000,
    });

    // The cluster persists onto the live board.
    await expect(page.locator('[data-testid="howto-fab"]')).toBeVisible();
    await page.click('[data-testid="howto-fab"]');
    await expect(page.locator('[data-testid="howto-modal"]')).toBeVisible();
    // Header subtitle reflects the current game's type.
    await expect(page.locator('[data-testid="howto-modal"]')).toContainText(
      "Big 2",
    );

    await context.close();
  });
});

test.describe("How-to-play walkthrough — Tonk resolution (LLD 115)", () => {
  // Land the host on a Tonk board deterministically: create a 3-player Tonk game
  // via REST, join the other seats via REST, seed a full in-progress Tonk state
  // (all required top-level fields incl. players, so getPlayerView/spectator view
  // never dereference undefined), then open the host page. The board sets the
  // current game type to "tonk", so the (?) FAB resolves TONK_WALKTHROUGH with no
  // FAB change (LLD 115 §2.4). We do NOT inject cookies/state into the browser.
  async function openTonkBoard(
    browser: Parameters<Parameters<typeof test>[1]>[0]["browser"],
    request: Parameters<Parameters<typeof test>[1]>[0]["request"],
  ): Promise<{
    context: Awaited<ReturnType<typeof browser.newContext>>;
    page: Page;
  }> {
    const auths = ["player1.json", "player2.json", "player3.json"].map((f) => ({
      file: f,
      ...readStoredAuth(f),
    }));

    const gameId = await createGameViaApi(request, auths[0]!.accessToken, {
      gameType: "tonk",
      maxPlayers: 3,
      deckRoundsTarget: 6,
    });
    for (let i = 1; i < auths.length; i++) {
      await joinGameViaApi(request, gameId, auths[i]!.accessToken);
    }

    const players = auths.map((a, i) => ({
      playerId: a.userId,
      displayName: `Player${i + 1}`,
    }));
    await seedGameState(request, {
      gameId,
      state: {
        status: "IN_PROGRESS",
        gameType: "tonk",
        version: 1,
        turnNumber: 1,
        randomSeed: "howto-tonk-seed",
        currentPlayerIndex: 0,
        winner: null,
        scores: null,
        players,
        gameSpecificState: buildTonkSeedState(3, [
          [
            tonkCard("K", "spades"),
            tonkCard("4", "clubs"),
            tonkCard("7", "hearts"),
          ],
          [tonkCard("9", "diamonds"), tonkCard("2", "spades")],
          [tonkCard("6", "clubs"), tonkCard("8", "hearts")],
        ]),
      },
      dbFields: {
        status: "IN_PROGRESS",
        playerIds: players.map((p) => p.playerId),
        playerDisplayNames: Object.fromEntries(
          players.map((p) => [p.playerId, p.displayName]),
        ),
        turnTimerSeconds: null,
      },
    });

    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();
    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="tonk-board"]')).toBeVisible({
      timeout: 10_000,
    });
    return { context, page };
  }

  test("FAB opens the Tonk walkthrough (subtitle 'Tonk', 6 steps) with a real joker on the Jokers step", async ({
    browser,
    request,
  }) => {
    const { context, page } = await openTonkBoard(browser, request);

    await expect(page.locator('[data-testid="howto-fab"]')).toBeVisible();
    await page.click('[data-testid="howto-fab"]');
    await expect(page.locator('[data-testid="howto-modal"]')).toBeVisible();

    // Header subtitle is the Tonk label; step 1 of 6.
    await expect(page.locator('[data-testid="howto-modal"]')).toContainText(
      "Tonk",
    );
    await expect(
      page.locator('[data-testid="howto-step-indicator"]'),
    ).toContainText(`Step 1 of ${TONK_STEP_COUNT}`);

    // Step 4 is the Jokers step: advance to it and assert a real joker GameCard
    // renders inside the scene (Option B wiring — a live component, not caption).
    for (let step = 1; step < 4; step++) {
      await page.click('[data-testid="howto-next"]');
    }
    await expect(
      page.locator('[data-testid="howto-step-indicator"]'),
    ).toContainText(`Step 4 of ${TONK_STEP_COUNT}`);
    await expect(
      page.locator('[data-testid="howto-scene"] [data-testid="joker-card"]'),
    ).toBeVisible();

    await context.close();
  });

  test("Next advances through all 6 Tonk steps; the last step closes the modal", async ({
    browser,
    request,
  }) => {
    const { context, page } = await openTonkBoard(browser, request);

    await page.click('[data-testid="howto-fab"]');
    await expect(page.locator('[data-testid="howto-dots"] i')).toHaveCount(
      TONK_STEP_COUNT,
    );

    for (let step = 1; step <= TONK_STEP_COUNT; step++) {
      await expect(
        page.locator('[data-testid="howto-step-indicator"]'),
      ).toContainText(`Step ${step} of ${TONK_STEP_COUNT}`);
      if (step < TONK_STEP_COUNT) {
        await page.click('[data-testid="howto-next"]');
      }
    }

    await expect(page.locator('[data-testid="howto-next"]')).toContainText(
      "Got it",
    );
    await page.click('[data-testid="howto-next"]');
    await expect(page.locator('[data-testid="howto-modal"]')).not.toBeVisible();

    await context.close();
  });

  test("mobile viewport (360px): the Tonk modal, nav, and joker card are usable", async ({
    browser,
    request,
  }) => {
    const { context, page } = await openTonkBoard(browser, request);
    await page.setViewportSize({ width: 360, height: 640 });

    await page.click('[data-testid="howto-fab"]');
    await expect(page.locator('[data-testid="howto-modal"]')).toBeVisible();

    // Nav buttons remain ≥44px tall on mobile.
    for (const testid of ["howto-back", "howto-next"]) {
      const box = await page.locator(`[data-testid="${testid}"]`).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    // The joker card is visible at 360px on the Jokers step.
    for (let step = 1; step < 4; step++) {
      await page.click('[data-testid="howto-next"]');
    }
    await expect(
      page.locator('[data-testid="howto-scene"] [data-testid="joker-card"]'),
    ).toBeVisible();

    await context.close();
  });
});
