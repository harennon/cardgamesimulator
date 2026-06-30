import {
  test,
  expect,
  type Page,
  type Browser,
  type BrowserContext,
  type APIRequestContext,
} from "@playwright/test";
import { readStoredAuth, joinGameViaApi } from "./helpers/game-helpers.js";
import {
  buildTonkSeedState,
  seedTonkState,
  tonkCard,
} from "./helpers/seed-helpers.js";

// LLD 100: play a full Tonk game start-to-finish in the browser.
//
// F1  create via the real Create Game UI (3 players, chosen deckRoundsTarget),
//     have two more players join, start -> land on a Tonk board.
// F2  drive a real turn through the rendered TonkActionPanel: discard -> draw,
//     phase stepper advances, hand count returns, board updates for the actor.
// F3  seed a near-threshold tally then complete the match by a browser-driven
//     callTonk -> game-over screen renders with winner + final tallies.
// F4  the completing player's Tonk stats reflect the match (retry-tolerant; a
//     known fire-and-forget write race means we assert presence/count, not exact
//     numbers — see the "flaky player-stats" project memory).
//
// Determinism comes from POST /test/seed-state (direct state manipulation over a
// 150-point replay, testing-principles §4) — the same harness the integration
// suite (tests/integration/tonk-timer-rearm.test.ts) uses, lifted to the browser.

const DECK_ROUNDS_TARGET = 6;

const THREE_PLAYERS = ["player1.json", "player2.json", "player3.json"] as const;

interface SeatHandle {
  file: string;
  id: string;
  displayName: string;
  page: Page;
  context: BrowserContext;
}

/**
 * Open a fresh browser context + game page for each stored-auth player file and
 * wait for the lobby. Each page opens a real socket, so the host page receives
 * lobby:playerJoined for every joiner (REST joinGame alone does not broadcast).
 */
async function openSeats(
  browser: Browser,
  gameId: string,
  files: readonly string[],
): Promise<SeatHandle[]> {
  const seats: SeatHandle[] = [];
  for (const file of files) {
    const auth = readStoredAuth(file);
    const context = await browser.newContext({
      storageState: `e2e/.auth/${file}`,
    });
    const page = await context.newPage();
    await page.goto(`/game/${gameId}`);
    await expect(page.locator('[data-testid="game-lobby"]')).toBeVisible({
      timeout: 10_000,
    });
    seats.push({
      file,
      id: auth.userId,
      displayName: file.replace(".json", "").replace("player", "Player"),
      page,
      context,
    });
  }
  return seats;
}

async function closeSeats(seats: SeatHandle[]): Promise<void> {
  for (const seat of seats) await seat.context.close();
}

/** Create a Tonk game via REST as the first player. Returns the gameId. */
async function createTonkGame(
  request: APIRequestContext,
  hostAccessToken: string,
  maxPlayers: number,
): Promise<string> {
  const res = await request.post("http://localhost:3000/createGame", {
    headers: { Authorization: `Bearer ${hostAccessToken}` },
    data: {
      gameType: "tonk",
      maxPlayers,
      turnTimerSeconds: 30,
      deckRoundsTarget: DECK_ROUNDS_TARGET,
    },
  });
  if (!res.ok()) {
    throw new Error(`createGame failed (${res.status()}): ${await res.text()}`);
  }
  return ((await res.json()) as { gameId: string }).gameId;
}

/**
 * Full setup for the seed-driven cases: create via REST, REST-join the rest, open
 * every seat's page (live sockets so the host lobby fills and Start enables), then
 * the host clicks the real Start button and all seats land on the Tonk board.
 */
async function createStartedTonkGame(
  browser: Browser,
  request: APIRequestContext,
): Promise<{
  gameId: string;
  seats: SeatHandle[];
  players: Array<{ id: string; displayName: string }>;
}> {
  const auths = THREE_PLAYERS.map((f) => readStoredAuth(f));
  const gameId = await createTonkGame(
    request,
    auths[0]!.accessToken,
    THREE_PLAYERS.length,
  );
  for (let i = 1; i < auths.length; i++) {
    await joinGameViaApi(request, gameId, auths[i]!.accessToken);
  }

  const seats = await openSeats(browser, gameId, THREE_PLAYERS);
  const hostPage = seats[0]!.page;
  await expect(hostPage.locator('[data-testid="lobby-count"]')).toContainText(
    "3",
  );
  const startBtn = hostPage.locator('[data-testid="start-game-button"]');
  await expect(startBtn).toBeEnabled({ timeout: 10_000 });
  await startBtn.click();
  for (const seat of seats) {
    await expect(seat.page.locator('[data-testid="tonk-board"]')).toBeVisible({
      timeout: 10_000,
    });
  }

  const players = seats.map((s) => ({ id: s.id, displayName: s.displayName }));
  return { gameId, seats, players };
}

test.describe("Tonk full game (LLD 100)", () => {
  test("F1: create Tonk via UI with a chosen deck length, 2 more join, start lands on a board", async ({
    browser,
    request,
  }) => {
    const player2 = readStoredAuth("player2.json");
    const player3 = readStoredAuth("player3.json");

    // Create through the real Create Game screen with a chosen deck length.
    const hostContext = await browser.newContext({
      storageState: "e2e/.auth/player1.json",
    });
    const hostPage = await hostContext.newPage();
    await hostPage.goto("/create-game");
    await hostPage.selectOption('[data-testid="game-type-select"]', "tonk");
    await hostPage.click(
      `[data-testid="deck-length-option-${DECK_ROUNDS_TARGET}"]`,
    );
    await expect(
      hostPage.locator(
        `[data-testid="deck-length-option-${DECK_ROUNDS_TARGET}"]`,
      ),
    ).toHaveAttribute("aria-pressed", "true");
    await hostPage.click('[data-testid="submit-create-game"]');

    await hostPage.waitForURL(/\/game\/.+/);
    const gameId = hostPage.url().split("/game/")[1]!;
    await expect(hostPage.locator('[data-testid="game-lobby"]')).toBeVisible();

    // Two more players join via REST and then open their pages, so the host's
    // lobby fills (lobby:playerJoined) and Start enables.
    await joinGameViaApi(request, gameId, player2.accessToken);
    await joinGameViaApi(request, gameId, player3.accessToken);
    const joiners = await openSeats(browser, gameId, [
      "player2.json",
      "player3.json",
    ]);

    await expect(hostPage.locator('[data-testid="lobby-count"]')).toContainText(
      "3",
    );
    const startBtn = hostPage.locator('[data-testid="start-game-button"]');
    await expect(startBtn).toBeEnabled({ timeout: 10_000 });
    await startBtn.click();

    // The host lands on the Tonk board; the deal happened (own hand renders) and
    // a seat is current (either the stepper for our turn or the waiting pill).
    await expect(hostPage.locator('[data-testid="tonk-board"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(hostPage.locator('[data-testid="tonk-hand"]')).toBeVisible();
    await expect(
      hostPage.locator(
        '[data-testid="tonk-phase-stepper"], [data-testid="tonk-turn-pill"]',
      ),
    ).toHaveCount(1);

    await closeSeats(joiners);
    await hostContext.close();
  });

  test("F2: drive a real turn (discard -> draw) through the UI; stepper advances and hand count returns", async ({
    browser,
    request,
  }) => {
    const { gameId, seats, players } = await createStartedTonkGame(
      browser,
      request,
    );

    // Seed a known discard-phase precondition with the HOST (seat 0) on turn.
    const hands = [
      [
        tonkCard("K", "spades"),
        tonkCard("4", "clubs"),
        tonkCard("7", "hearts"),
      ],
      [tonkCard("9", "diamonds"), tonkCard("2", "spades")],
      [tonkCard("6", "clubs"), tonkCard("8", "hearts")],
    ];
    await seedTonkState(request, {
      gameId,
      players,
      currentPlayerIndex: 0,
      tonk: buildTonkSeedState(3, hands),
    });

    // Re-open the host page so it pulls the seeded state fresh on join.
    const hostSeat = seats[0]!;
    await hostSeat.page.goto(`/game/${gameId}`);
    const page = hostSeat.page;
    await expect(page.locator('[data-testid="tonk-board"]')).toBeVisible({
      timeout: 10_000,
    });

    // It is our turn, discard phase: stepper visible, hand has 3 cards.
    await expect(
      page.locator('[data-testid="tonk-phase-stepper"]'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="tonk-hand"] .card')).toHaveCount(
      3,
    );

    // Select the first card and discard.
    await page.locator('[data-testid="tonk-hand"] .card').first().click();
    const discardBtn = page.locator('[data-testid="tonk-discard-btn"]');
    await expect(discardBtn).toBeEnabled();
    await discardBtn.click();

    // Phase advances to draw: draw-source buttons appear, hand is now 2.
    const drawStockBtn = page.locator('[data-testid="tonk-draw-stock-btn"]');
    await expect(drawStockBtn).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="tonk-hand"] .card')).toHaveCount(
      2,
    );

    // Draw from stock: hand returns to the prior size and the turn hands off.
    await drawStockBtn.click();
    await expect(page.locator('[data-testid="tonk-hand"] .card')).toHaveCount(
      3,
    );
    await expect(page.locator('[data-testid="tonk-turn-pill"]')).toBeVisible({
      timeout: 10_000,
    });

    await closeSeats(seats);
  });

  test("F3: a near-threshold tally completed by a browser callTonk renders the game-over screen", async ({
    browser,
    request,
  }) => {
    const { gameId, seats, players } = await createStartedTonkGame(
      browser,
      request,
    );

    // Seat 0 (host) holds a single Ace (value 1) and is strictly lowest, so a
    // callTonk lands Case A: every OTHER player adds their hand value. Seat 1's
    // tally 145 + a 6-value card = 151 >= LOSE_THRESHOLD (150) -> COMPLETED.
    // The TONK gate is open (trickTurnCount >= playerCount) so callTonk is valid.
    const hands = [
      [tonkCard("A", "clubs")],
      [tonkCard("6", "hearts")],
      [tonkCard("3", "diamonds")],
    ];
    await seedTonkState(request, {
      gameId,
      players,
      currentPlayerIndex: 0,
      tonk: buildTonkSeedState(3, hands, {
        tallies: [10, 145, 20],
        trickTurnCount: 3,
        turnPhase: "discard",
      }),
    });

    const hostSeat = seats[0]!;
    await hostSeat.page.goto(`/game/${gameId}`);
    const page = hostSeat.page;
    await expect(page.locator('[data-testid="tonk-board"]')).toBeVisible({
      timeout: 10_000,
    });

    const callTonkBtn = page.locator('[data-testid="tonk-call-tonk-btn"]');
    await expect(callTonkBtn).toBeEnabled({ timeout: 10_000 });
    await callTonkBtn.click();

    // Game-over screen renders with a winner and a final scores table (3 rows).
    await expect(page.locator('[data-testid="game-over"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator(".game-over__winner")).not.toBeEmpty();
    await expect(page.locator(".game-over__scores tbody tr")).toHaveCount(3);

    await closeSeats(seats);
  });

  test("F4: after a completed Tonk match the host's stats show a Tonk entry", async ({
    browser,
    request,
  }) => {
    const { gameId, seats, players } = await createStartedTonkGame(
      browser,
      request,
    );
    const hands = [
      [tonkCard("A", "clubs")],
      [tonkCard("6", "hearts")],
      [tonkCard("3", "diamonds")],
    ];
    await seedTonkState(request, {
      gameId,
      players,
      currentPlayerIndex: 0,
      tonk: buildTonkSeedState(3, hands, {
        tallies: [10, 145, 20],
        trickTurnCount: 3,
        turnPhase: "discard",
      }),
    });

    const hostSeat = seats[0]!;
    await hostSeat.page.goto(`/game/${gameId}`);
    const page = hostSeat.page;
    await expect(page.locator('[data-testid="tonk-board"]')).toBeVisible({
      timeout: 10_000,
    });
    await page.locator('[data-testid="tonk-call-tonk-btn"]').click();
    await expect(page.locator('[data-testid="game-over"]')).toBeVisible({
      timeout: 10_000,
    });

    // Stats are written fire-and-forget on completion (LLD 66). The stats page
    // must show a Tonk entry. Retry-tolerant via auto-retrying expect; reload
    // once if the write has not landed yet.
    await page.goto("/stats");
    const tonkEntry = page
      .locator('[data-testid="stats-entry"]')
      .filter({ hasText: "Tonk" });
    await expect(async () => {
      await page.reload();
      await expect(tonkEntry).toHaveCount(1, { timeout: 5_000 });
    }).toPass({ timeout: 20_000 });

    await closeSeats(seats);
  });
});
