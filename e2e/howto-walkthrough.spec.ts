import { test, expect, type Page, type BrowserContext } from "@playwright/test";
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

/** True iff two DOMRect-like boxes do not overlap (share no interior area). */
function boxesDisjoint(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

/**
 * Seed a 2-player Big2 game to IN_PROGRESS with the host (player1) on turn and a
 * playable first hand, then land the host on the live board. Mirrors the LLD 111
 * board-persistence seed but keeps the host's turn so Play/Pass render.
 */
async function seedBig2Board(
  browser: Parameters<Parameters<typeof test>[1]>[0]["browser"],
  request: Parameters<Parameters<typeof test>[1]>[0]["request"],
  viewport?: { width: number; height: number },
): Promise<{ context: BrowserContext; page: Page }> {
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
      randomSeed: "howto-board-offset-seed",
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
    ...(viewport ? { viewport } : {}),
  });
  const page = await context.newPage();
  await page.goto(`/game/${gameId}`);
  await expect(page.locator('[data-testid="game-board"]')).toBeVisible({
    timeout: 10_000,
  });
  return { context, page };
}

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

test.describe("How-to-play walkthrough — FAB hardening (LLD 117)", () => {
  test("board (Big2, desktop): the (?) FAB does not overlap the Play/Pass action row", async ({
    browser,
    request,
  }) => {
    const { context, page } = await seedBig2Board(browser, request);

    // Action row (Play/Pass) is present on the host's turn.
    const actionPanel = page.locator(".action-panel");
    await expect(actionPanel).toBeVisible();

    const fab = page.locator('[data-testid="howto-fab"]');
    await expect(fab).toBeVisible();

    const fabBox = await fab.boundingBox();
    const panelBox = await actionPanel.boundingBox();
    expect(boxesDisjoint(fabBox!, panelBox!)).toBe(true);

    await context.close();
  });

  test("board (Big2, desktop): opening the walkthrough leaves the action row visible; the FAB is lifted off it", async ({
    browser,
    request,
  }) => {
    const { context, page } = await seedBig2Board(browser, request);

    await page.click('[data-testid="howto-fab"]');
    await expect(page.locator('[data-testid="howto-modal"]')).toBeVisible();

    await context.close();
  });

  test("board (Tonk, desktop): the (?) FAB does not overlap the Tonk action panel", async ({
    browser,
    request,
  }) => {
    // Reuse the Tonk-board seeding via a minimal inline flow.
    const auths = ["player1.json", "player2.json", "player3.json"].map((f) => ({
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
        randomSeed: "howto-tonk-offset-seed",
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

    const actionPanel = page.locator('[data-testid="tonk-action-panel"]');
    await expect(actionPanel).toBeVisible();
    const fab = page.locator('[data-testid="howto-fab"]');
    await expect(fab).toBeVisible();

    const fabBox = await fab.boundingBox();
    const panelBox = await actionPanel.boundingBox();
    expect(boxesDisjoint(fabBox!, panelBox!)).toBe(true);

    await context.close();
  });

  test("mobile board: both (?) FAB and bug icon are visible, lifted above action row (LLD 126)", async ({
    browser,
    request,
  }) => {
    const { context, page } = await seedBig2Board(browser, request, {
      width: 375,
      height: 667,
    });

    // Both FABs visible on the mobile board (LLD 126 Option B restores the bug icon).
    const fab = page.locator('[data-testid="howto-fab"]');
    const bugButton = page.locator('[data-testid="feedback-trigger"]');
    await expect(fab).toBeVisible();
    await expect(bugButton).toBeVisible();

    // Both FABs are lifted above the action row — E1 guardrail.
    const fabBox = await fab.boundingBox();
    const bugBox = await bugButton.boundingBox();
    const panelBox = await page.locator(".action-panel").boundingBox();
    expect(boxesDisjoint(fabBox!, panelBox!)).toBe(true);
    expect(boxesDisjoint(bugBox!, panelBox!)).toBe(true);

    // Neither FAB obscures the player's own cards — E2 guardrail.
    const cardBoxes = await page
      .locator(".player-hand__card")
      .evaluateAll((els) =>
        els
          .map((el) => el.getBoundingClientRect())
          .map((r) => ({
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
          })),
      );
    for (const card of cardBoxes) {
      expect(boxesDisjoint(fabBox!, card)).toBe(true);
      expect(boxesDisjoint(bugBox!, card)).toBe(true);
    }

    await context.close();
  });

  test("mobile board: tapping the bug icon opens the feedback modal (LLD 126 E6)", async ({
    browser,
    request,
  }) => {
    const { context, page } = await seedBig2Board(browser, request, {
      width: 375,
      height: 667,
    });

    await page.click('[data-testid="feedback-trigger"]');
    await expect(page.locator('[data-testid="feedback-modal"]')).toBeVisible();

    await context.close();
  });

  test("non-board surfaces show both the (?) FAB and the bug icon (resting corner)", async ({
    browser,
  }) => {
    const { context, page } = await openHome(browser);
    await expect(page.locator('[data-testid="howto-fab"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="feedback-trigger"]'),
    ).toBeVisible();
    await context.close();
  });

  test("non-board surfaces keep both buttons at mobile width", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
      viewport: { width: 375, height: 667 },
    });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator('[data-testid="howto-fab"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="feedback-trigger"]'),
    ).toBeVisible();
    await context.close();
  });

  test("open/close on the board preserves board state and interactivity (E6)", async ({
    browser,
    request,
  }) => {
    const { context, page } = await seedBig2Board(browser, request);

    // Player's own hand is present before opening.
    const hand = page.locator(".player-hand");
    await expect(hand).toBeVisible();

    await page.click('[data-testid="howto-fab"]');
    await expect(page.locator('[data-testid="howto-modal"]')).toBeVisible();
    await page.click('[data-testid="howto-close"]');
    await expect(page.locator('[data-testid="howto-modal"]')).not.toBeVisible();

    // Board is intact and interactive after close: the hand is still there and
    // a card can be selected (interactive) on the host's turn.
    await expect(hand).toBeVisible();
    await expect(page.locator(".action-panel")).toBeVisible();
    await page.locator(".player-hand__card").first().click();

    await context.close();
  });

  test("open/close in the lobby preserves lobby state (E5)", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");
    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);

    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();
    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="game-lobby"]')).toBeVisible();

    const codeBefore = await page
      .locator('[data-testid="join-code-chip"]')
      .textContent();
    const countBefore = await page
      .locator('[data-testid="lobby-count"]')
      .textContent();

    await page.click('[data-testid="howto-fab"]');
    await expect(page.locator('[data-testid="howto-modal"]')).toBeVisible();
    await page.click('[data-testid="howto-close"]');
    await expect(page.locator('[data-testid="howto-modal"]')).not.toBeVisible();

    // Lobby untouched: room code, count, and Start button are still there.
    await expect(page.locator('[data-testid="join-code-chip"]')).toHaveText(
      codeBefore ?? "",
    );
    await expect(page.locator('[data-testid="lobby-count"]')).toHaveText(
      countBefore ?? "",
    );
    await expect(
      page.locator('[data-testid="start-game-button"]'),
    ).toBeVisible();

    await context.close();
  });

  test("game-starts-while-open: toast appears, modal stays open, board is underneath (E4)", async ({
    browser,
    request,
  }) => {
    // Two real contexts: the host starts the game while the OTHER player is
    // reading the walkthrough. The observing player's full-viewport modal scrim
    // must not block the host's Start (each has their own page), and the phase
    // edge lands on the observer's still-open modal — the E4 scenario.
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");
    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);

    const hostContext = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const hostPage = await hostContext.newPage();
    await hostPage.goto(`/game/${gameId}`);
    await expect(hostPage.locator('[data-testid="game-lobby"]')).toBeVisible();

    const observerContext = await browser.newContext({
      storageState: "e2e/.auth/player2.json",
    });
    const observerPage = await observerContext.newPage();
    await observerPage.goto(`/game/${gameId}`);
    await expect(
      observerPage.locator('[data-testid="game-lobby"]'),
    ).toBeVisible();

    // Observer opens the walkthrough in the lobby.
    await observerPage.click('[data-testid="howto-fab"]');
    await expect(
      observerPage.locator('[data-testid="howto-modal"]'),
    ).toBeVisible();

    // Host starts the game (their own page — not behind the observer's scrim).
    await hostPage.click('[data-testid="start-game-button"]');
    await expect(hostPage.locator('[data-testid="game-board"]')).toBeVisible();

    // (a) the non-blocking toast appears on the observer's screen.
    await expect(
      observerPage.locator('[data-testid="howto-gamestart-toast"]'),
    ).toBeVisible();
    // (b) the observer's modal is not auto-closed (user not trapped).
    await expect(
      observerPage.locator('[data-testid="howto-modal"]'),
    ).toBeVisible();
    // (c) the board rendered underneath the observer's still-open modal.
    await expect(
      observerPage.locator('[data-testid="game-board"]'),
    ).toBeVisible();

    // (d) after closing the modal, the observer's board is fully interactive.
    await observerPage.click('[data-testid="howto-close"]');
    await expect(
      observerPage.locator('[data-testid="howto-modal"]'),
    ).not.toBeVisible();
    await expect(
      observerPage.locator('[data-testid="game-board"]'),
    ).toBeVisible();
    await expect(observerPage.locator(".player-hand")).toBeVisible();

    await observerContext.close();
    await hostContext.close();
  });
});
