import { test, expect } from "@playwright/test";
import {
  readStoredAuth,
  createGameViaApi,
  joinGameViaApi,
} from "./helpers/game-helpers.js";
import { seedGameState } from "./helpers/seed-helpers.js";

// 13 distinct cards for a full Big2 starting hand
const FULL_HAND = [
  { suit: "clubs", rank: "3" },
  { suit: "diamonds", rank: "4" },
  { suit: "hearts", rank: "5" },
  { suit: "spades", rank: "6" },
  { suit: "clubs", rank: "7" },
  { suit: "diamonds", rank: "8" },
  { suit: "hearts", rank: "9" },
  { suit: "spades", rank: "10" },
  { suit: "clubs", rank: "J" },
  { suit: "diamonds", rank: "Q" },
  { suit: "hearts", rank: "K" },
  { suit: "spades", rank: "A" },
  { suit: "clubs", rank: "2" },
] as const;

const OPPONENT_HAND = [
  { suit: "diamonds", rank: "3" },
  { suit: "hearts", rank: "4" },
  { suit: "spades", rank: "5" },
  { suit: "clubs", rank: "6" },
  { suit: "diamonds", rank: "7" },
  { suit: "hearts", rank: "8" },
  { suit: "spades", rank: "9" },
  { suit: "clubs", rank: "10" },
  { suit: "diamonds", rank: "J" },
  { suit: "hearts", rank: "Q" },
  { suit: "spades", rank: "K" },
  { suit: "clubs", rank: "A" },
  { suit: "diamonds", rank: "2" },
] as const;

/**
 * Optional overrides merged into the seeded Big2 gameSpecificState so a test can
 * seed a non-empty current trick (LLD 108). Defaults preserve the original
 * empty-trick behaviour so existing callers are unaffected.
 */
interface GameStateOverrides {
  lastPlay?: unknown;
  lastPlayPlayerIndex?: number | null;
  playHistory?: unknown[];
  isFirstPlayOfGame?: boolean;
  isFreePlay?: boolean;
}

/**
 * Seeds a 2-player Big2 game into IN_PROGRESS with full hands.
 * Player1 goes first (has 3 of clubs, first play of game).
 *
 * With no overrides this produces an empty current trick (no played row / pile).
 * Pass overrides to seed a lastPlay + matching playHistory so the played row and
 * trick pile render (trickStartIndex defaults to 0, so the seeded playHistory is
 * the current trick).
 */
async function seedInProgressGame(
  request: Parameters<typeof seedGameState>[0],
  gameId: string,
  host: { userId: string },
  player2: { userId: string },
  overrides: GameStateOverrides = {},
): Promise<void> {
  await seedGameState(request, {
    gameId,
    state: {
      status: "IN_PROGRESS",
      gameType: "big2",
      version: 1,
      turnNumber: 1,
      randomSeed: "test-mobile-seed",
      currentPlayerIndex: 0,
      winner: null,
      scores: null,
      players: [
        { playerId: host.userId, displayName: "Player1" },
        { playerId: player2.userId, displayName: "Player2" },
      ],
      gameSpecificState: {
        hands: [FULL_HAND, OPPONENT_HAND],
        lastPlay: overrides.lastPlay ?? null,
        lastPlayPlayerIndex: overrides.lastPlayPlayerIndex ?? null,
        consecutivePasses: 0,
        isFreePlay: overrides.isFreePlay ?? false,
        isFirstPlayOfGame: overrides.isFirstPlayOfGame ?? true,
        playHistory: overrides.playHistory ?? [],
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
      // createGameViaApi requests turnTimerSeconds:30, but this seed never arms a
      // timer. On player join the timer-recovery branch (socketHandler.ts) would
      // see a non-null timer with no deadline/active timer, treat the seeded turn
      // as expired, and auto-pass — ending the 2-player trick, nulling lastPlay,
      // and rendering "New Trick" so .play-area__card-row never appears. Disable
      // the timer for these deterministic seeds so the seeded play stays on-table.
      turnTimerSeconds: null,
    },
  });
}

type Suit = "clubs" | "diamonds" | "hearts" | "spades";
type Rank = string;
const c = (rank: Rank, suit: Suit) => ({ rank, suit });

// A 5-card full house (three 5s + two 6s) as the seeded lastPlay + playHistory.
const FULL_HOUSE_CARDS = [
  c("5", "clubs"),
  c("5", "diamonds"),
  c("5", "hearts"),
  c("6", "clubs"),
  c("6", "diamonds"),
];

function playEntry(
  playerId: string,
  displayName: string,
  cards: ReturnType<typeof c>[],
  handType: string,
) {
  return { playerId, displayName, action: "play", cards, handType };
}

/** Overrides seeding a single 5-card full-house play by Player2 (current trick). */
function fullHouseOverride(player2Id: string): GameStateOverrides {
  return {
    lastPlay: {
      cards: FULL_HOUSE_CARDS,
      handType: {
        kind: "fullHouse",
        tripleRank: "5",
        highCard: c("6", "diamonds"),
      },
      playerId: player2Id,
    },
    lastPlayPlayerIndex: 1,
    playHistory: [
      playEntry("__p2__", "Player2", FULL_HOUSE_CARDS, "fullHouse"),
    ],
    isFirstPlayOfGame: false,
  };
}

/** Overrides seeding a single-card play by Player2 (current trick). */
function singleOverride(player2Id: string): GameStateOverrides {
  const cards = [c("K", "spades")];
  return {
    lastPlay: {
      cards,
      handType: { kind: "single", card: cards[0] },
      playerId: player2Id,
    },
    lastPlayPlayerIndex: 1,
    playHistory: [playEntry("__p2__", "Player2", cards, "single")],
    isFirstPlayOfGame: false,
  };
}

/** Overrides seeding a two-card pair play by Player2 (current trick). */
function pairOverride(player2Id: string): GameStateOverrides {
  const cards = [c("Q", "spades"), c("Q", "hearts")];
  return {
    lastPlay: {
      cards,
      handType: { kind: "pair", rank: "Q", highCard: cards[0] },
      playerId: player2Id,
    },
    lastPlayPlayerIndex: 1,
    playHistory: [playEntry("__p2__", "Player2", cards, "pair")],
    isFirstPlayOfGame: false,
  };
}

/**
 * Overrides seeding a deep current trick (4 alternating plays) so the collapsed
 * pile depth exceeds MAX_LAYERS-worthy stacking on desktop while the badge shows
 * the true count. lastPlay is the most recent play.
 */
function deepTrickOverride(player2Id: string): GameStateOverrides {
  const p1 = [
    c("3", "clubs"),
    c("3", "diamonds"),
    c("3", "hearts"),
    c("4", "clubs"),
    c("4", "diamonds"),
  ];
  const p2 = [
    c("7", "clubs"),
    c("7", "diamonds"),
    c("7", "hearts"),
    c("8", "clubs"),
    c("8", "diamonds"),
  ];
  const p3 = [
    c("9", "clubs"),
    c("9", "diamonds"),
    c("9", "hearts"),
    c("10", "clubs"),
    c("10", "diamonds"),
  ];
  const p4 = FULL_HOUSE_CARDS.map((card) => ({ ...card }));
  return {
    lastPlay: {
      cards: p4,
      handType: {
        kind: "fullHouse",
        tripleRank: "5",
        highCard: c("6", "diamonds"),
      },
      playerId: player2Id,
    },
    lastPlayPlayerIndex: 1,
    playHistory: [
      playEntry("__p1__", "Player1", p1, "fullHouse"),
      playEntry("__p2__", "Player2", p2, "fullHouse"),
      playEntry("__p1__", "Player1", p3, "fullHouse"),
      playEntry("__p2__", "Player2", p4, "fullHouse"),
    ],
    isFirstPlayOfGame: false,
  };
}

test.describe("Mobile layout (LLD 11)", () => {
  test("mobile viewport: game-board--mobile class is present at 375x667", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");

    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);
    await seedInProgressGame(request, gameId, host, player2);

    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="game-board"]')).toBeVisible({
      timeout: 10_000,
    });

    await page.setViewportSize({ width: 375, height: 667 });

    const board = page.locator('[data-testid="game-board"]');
    await expect(board).toHaveClass(/game-board--mobile/);

    await context.close();
  });

  test("mobile viewport: game-board__log is display:none", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");

    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);
    await seedInProgressGame(request, gameId, host, player2);

    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="game-board"]')).toBeVisible({
      timeout: 10_000,
    });

    await page.setViewportSize({ width: 375, height: 667 });

    const logPanel = page.locator(".game-board__log");
    await expect(logPanel).toHaveCSS("display", "none");

    await context.close();
  });

  test("mobile viewport: log toggle button is visible", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");

    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);
    await seedInProgressGame(request, gameId, host, player2);

    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="game-board"]')).toBeVisible({
      timeout: 10_000,
    });

    await page.setViewportSize({ width: 375, height: 667 });

    await expect(page.locator(".log-toggle")).toBeVisible();

    await context.close();
  });

  test("mobile viewport: clicking log toggle opens the drawer", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");

    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);
    await seedInProgressGame(request, gameId, host, player2);

    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="game-board"]')).toBeVisible({
      timeout: 10_000,
    });

    await page.setViewportSize({ width: 375, height: 667 });

    const toggle = page.locator(".log-toggle");
    await expect(toggle).toBeVisible();
    await toggle.click();

    await expect(page.locator(".log-drawer")).toHaveClass(/log-drawer--open/);

    await context.close();
  });

  test("mobile viewport: pressing Escape closes the drawer", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");

    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);
    await seedInProgressGame(request, gameId, host, player2);

    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="game-board"]')).toBeVisible({
      timeout: 10_000,
    });

    await page.setViewportSize({ width: 375, height: 667 });

    // Open the drawer
    await page.locator(".log-toggle").click();
    await expect(page.locator(".log-drawer")).toHaveClass(/log-drawer--open/);

    // Close it with Escape
    await page.keyboard.press("Escape");
    await expect(page.locator(".log-drawer")).not.toHaveClass(
      /log-drawer--open/,
    );

    await context.close();
  });

  test("mobile viewport: hand is horizontally scrollable with 13 cards", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");

    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);
    await seedInProgressGame(request, gameId, host, player2);

    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="game-board"]')).toBeVisible({
      timeout: 10_000,
    });

    await page.setViewportSize({ width: 375, height: 667 });

    const isScrollable = await page.locator(".player-hand").evaluate((el) => {
      return el.scrollWidth > el.clientWidth;
    });
    expect(isScrollable).toBe(true);

    await context.close();
  });

  test("mobile viewport: /join-game does not overflow vertically (LLD 60)", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();

    await page.goto("/join-game");
    await expect(page.locator('[data-testid="game-code-input"]')).toBeVisible({
      timeout: 10_000,
    });

    // The short join form must fit the visible viewport with no vertical scroll.
    const hasOverflow = await page.evaluate(
      () => document.scrollingElement!.scrollHeight > window.innerHeight,
    );
    expect(hasOverflow).toBe(false);

    await context.close();
  });

  test("desktop viewport: game-board--mobile class is NOT present at 1024x768", async ({
    browser,
    request,
  }) => {
    const host = readStoredAuth("player1.json");
    const player2 = readStoredAuth("player2.json");

    const gameId = await createGameViaApi(request, host.accessToken, {
      maxPlayers: 2,
    });
    await joinGameViaApi(request, gameId, player2.accessToken);
    await seedInProgressGame(request, gameId, host, player2);

    const context = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const page = await context.newPage();

    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="game-board"]')).toBeVisible({
      timeout: 10_000,
    });

    await page.setViewportSize({ width: 1024, height: 768 });

    const board = page.locator('[data-testid="game-board"]');
    await expect(board).not.toHaveClass(/game-board--mobile/);

    await context.close();
  });
});

const MOBILE_WIDTHS: ReadonlyArray<{ width: number; height: number }> = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
];

/** Open a seeded game as Player1 at the given viewport and wait for the board. */
async function openSeededBoard(
  browser: Parameters<Parameters<typeof test>[1]>[0]["browser"],
  request: Parameters<typeof seedGameState>[0],
  overrides: GameStateOverrides,
  viewport: { width: number; height: number },
) {
  const host = readStoredAuth("player1.json");
  const player2 = readStoredAuth("player2.json");

  const gameId = await createGameViaApi(request, host.accessToken, {
    maxPlayers: 2,
  });
  await joinGameViaApi(request, gameId, player2.accessToken);
  await seedInProgressGame(request, gameId, host, player2, overrides);

  const context = await browser.newContext({
    storageState: "e2e/.auth/player1.json",
    viewport,
  });
  const page = await context.newPage();
  await page.goto(`/game/${gameId}`);
  await expect(page.locator('[data-testid="game-board"]')).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator(".play-area__card-row")).toBeVisible();
  return { context, page, player2Id: player2.userId };
}

test.describe("Big2 mobile played row & trick pile (LLD 108)", () => {
  for (const vp of MOBILE_WIDTHS) {
    test(`${vp.width}px: 5-card full house is not clipped and centered`, async ({
      browser,
      request,
    }) => {
      const player2 = readStoredAuth("player2.json");
      const { context, page } = await openSeededBoard(
        browser,
        request,
        fullHouseOverride(player2.userId),
        vp,
      );

      const cards = page.locator(".play-area__card-row .card");
      await expect(cards).toHaveCount(5);

      // No card crosses either viewport edge.
      const rects = await cards.evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right };
        }),
      );
      const innerWidth = await page.evaluate(() => window.innerWidth);
      for (const r of rects) {
        expect(r.left).toBeGreaterThanOrEqual(0);
        expect(r.right).toBeLessThanOrEqual(innerWidth + 0.5);
      }

      // Row is horizontally centered within .play-area__center.
      const centering = await page.evaluate(() => {
        const center = document.querySelector(".play-area__center");
        const row = document.querySelector(".play-area__card-row");
        if (!center || !row) return null;
        const cr = center.getBoundingClientRect();
        const rr = row.getBoundingClientRect();
        return {
          leftMargin: rr.left - cr.left,
          rightMargin: cr.right - rr.right,
        };
      });
      expect(centering).not.toBeNull();
      expect(
        Math.abs(centering!.leftMargin - centering!.rightMargin),
      ).toBeLessThanOrEqual(2);

      await context.close();
    });

    test(`${vp.width}px: trick pile does not overlap any played card`, async ({
      browser,
      request,
    }) => {
      const player2 = readStoredAuth("player2.json");
      const { context, page } = await openSeededBoard(
        browser,
        request,
        fullHouseOverride(player2.userId),
        vp,
      );

      const pileRect = await page
        .locator(".play-area__trick-pile")
        .evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        });
      const cardRects = await page
        .locator(".play-area__card-row .card")
        .evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return {
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
            };
          }),
        );

      for (const cr of cardRects) {
        const overlaps =
          pileRect.left < cr.right &&
          pileRect.right > cr.left &&
          pileRect.top < cr.bottom &&
          pileRect.bottom > cr.top;
        expect(overlaps).toBe(false);
      }

      await context.close();
    });

    test(`${vp.width}px: single-card and pair plays render centered and un-clipped`, async ({
      browser,
      request,
    }) => {
      const player2 = readStoredAuth("player2.json");

      for (const override of [
        singleOverride(player2.userId),
        pairOverride(player2.userId),
      ]) {
        const { context, page } = await openSeededBoard(
          browser,
          request,
          override,
          vp,
        );

        const cards = page.locator(".play-area__card-row .card");
        const rects = await cards.evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right };
          }),
        );
        const innerWidth = await page.evaluate(() => window.innerWidth);
        for (const r of rects) {
          expect(r.left).toBeGreaterThanOrEqual(0);
          expect(r.right).toBeLessThanOrEqual(innerWidth + 0.5);
        }
        await context.close();
      }
    });

    test(`${vp.width}px: collapsed pile is a single static layer regardless of depth`, async ({
      browser,
      request,
    }) => {
      const player2 = readStoredAuth("player2.json");
      const { context, page } = await openSeededBoard(
        browser,
        request,
        deepTrickOverride(player2.userId),
        vp,
      );

      // Mobile static branch: exactly one layer element even for a deep trick.
      await expect(
        page.locator(".play-area__trick-pile .trick-pile__layer"),
      ).toHaveCount(1);
      // Badge still shows the true play count (4).
      await expect(page.locator('[data-testid="trick-pile-badge"]')).toHaveText(
        "4",
      );

      await context.close();
    });
  }

  test("pile position is play-invariant between a single and a 5-card play (320px)", async ({
    browser,
    request,
  }) => {
    const player2 = readStoredAuth("player2.json");
    const vp = { width: 320, height: 568 };

    const single = await openSeededBoard(
      browser,
      request,
      singleOverride(player2.userId),
      vp,
    );
    const singlePile = await single.page
      .locator(".play-area__trick-pile")
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, bottom: r.bottom };
      });
    await single.context.close();

    const full = await openSeededBoard(
      browser,
      request,
      fullHouseOverride(player2.userId),
      vp,
    );
    const fullPile = await full.page
      .locator(".play-area__trick-pile")
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, bottom: r.bottom };
      });
    await full.context.close();

    // The pile does not move when the play widens.
    expect(Math.abs(fullPile.left - singlePile.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(fullPile.bottom - singlePile.bottom)).toBeLessThanOrEqual(
      1,
    );
  });

  test("desktop (1024px): collapsed pile keeps its layered stack and offset; row is not width-capped", async ({
    browser,
    request,
  }) => {
    const player2 = readStoredAuth("player2.json");
    const { context, page } = await openSeededBoard(
      browser,
      request,
      deepTrickOverride(player2.userId),
      { width: 1024, height: 768 },
    );

    await expect(page.locator('[data-testid="game-board"]')).not.toHaveClass(
      /game-board--mobile/,
    );

    // Desktop layered stack: more than one layer element (up to MAX_LAYERS=4).
    const layerCount = await page
      .locator(".play-area__trick-pile .trick-pile__layer")
      .count();
    expect(layerCount).toBeGreaterThan(1);

    // Desktop keeps its mid-left offset (left is negative relative to center box).
    const offsetOk = await page.evaluate(() => {
      const center = document.querySelector(".play-area__center");
      const pile = document.querySelector(".play-area__trick-pile");
      if (!center || !pile) return null;
      const cr = center.getBoundingClientRect();
      const pr = pile.getBoundingClientRect();
      return pr.left < cr.left;
    });
    expect(offsetOk).toBe(true);

    // The mobile width cap did not leak: the row has no max-width constraint.
    const rowMaxWidth = await page.evaluate(() => {
      const row = document.querySelector(".play-area__card-row");
      if (!row) return null;
      return getComputedStyle(row).maxWidth;
    });
    expect(rowMaxWidth).toBe("none");

    await context.close();
  });
});
