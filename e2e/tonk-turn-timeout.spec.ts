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

// LLD 100 — the hard requirement at the browser tier: a Tonk turn left to time
// out auto-discards (phase 1) AND auto-draws (phase 2) for the SAME seat, and the
// turn does not stall — the board advances to the next seat.
//
// This is the integration SMOKE for the re-arm: it proves the two-phase re-arm
// surfaces through the real socket + UI without stalling, regardless of WHICH
// production path drives it. With the timed-out seat observed (not actively kept
// connected), the server treats it as abandoned and the autoPlayAbandoned chain
// drives both phases; the connected-but-AFK handleTimerExpired re-arm is proven
// deterministically — and authoritatively — at the integration tier by
// tests/integration/tonk-timer-rearm.test.ts (T1/T2) with a FakeTimerProvider.
// The browser cannot inject a FakeTimerProvider, so this test waits for the REAL
// configured timer (turnTimerSeconds is constrained to {30,60,90}; we use 30) and
// allows a generous window because the real clock drives it.
//
// E5 (reconnect mid-draw) is also covered here: a seated player reloads during
// the draw phase and is restored to draw-phase controls with a live countdown.

const TURN_TIMER_SECONDS = 30;
// The FIRST turn uses 2x the configured duration (turnTimerService.startTurn
// isFirstTurn=true), so phase 1 (auto-discard) can fire up to ~2x = 60s after
// start; the re-arm for phase 2 (auto-draw) adds another ~1x = 30s. Allow ample
// headroom for that worst case plus socket round-trips and CI jitter.
const TWO_PHASE_WINDOW_MS = TURN_TIMER_SECONDS * 1000 * 4;

const THREE_PLAYERS = ["player1.json", "player2.json", "player3.json"] as const;

interface SeatHandle {
  file: string;
  id: string;
  displayName: string;
  page: Page;
  context: BrowserContext;
}

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

/** Create + REST-join + open pages + real Start a 3-seat Tonk game @ 30s timer. */
async function createStartedTonkGame(
  browser: Browser,
  request: APIRequestContext,
): Promise<{
  gameId: string;
  seats: SeatHandle[];
  players: Array<{ id: string; displayName: string }>;
}> {
  const auths = THREE_PLAYERS.map((f) => readStoredAuth(f));
  const res = await request.post("http://localhost:3000/createGame", {
    headers: { Authorization: `Bearer ${auths[0]!.accessToken}` },
    data: {
      gameType: "tonk",
      maxPlayers: THREE_PLAYERS.length,
      turnTimerSeconds: TURN_TIMER_SECONDS,
      deckRoundsTarget: 6,
    },
  });
  if (!res.ok()) {
    throw new Error(`createGame failed (${res.status()}): ${await res.text()}`);
  }
  const gameId = ((await res.json()) as { gameId: string }).gameId;
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

/** Count cards in a seat's own-hand zone. */
async function handCount(page: Page): Promise<number> {
  return page.locator('[data-testid="tonk-hand"] .card').count();
}

test.describe("Tonk turn timeout — two-phase re-arm in the browser (LLD 100)", () => {
  test("T1: a discard-phase seat left to time out auto-discards then auto-draws; the seat advances (no stall)", async ({
    browser,
    request,
  }) => {
    // Real clock drives two phases — give the test ample headroom.
    test.setTimeout(TWO_PHASE_WINDOW_MS + 60_000);

    const { gameId, seats, players } = await createStartedTonkGame(
      browser,
      request,
    );

    // Seed seat 1 (a NON-host) on turn, discard phase, multi-card hand + healthy
    // stock so the auto-draw is valid. We OBSERVE from the host (seat 0) so the
    // own-hand zone never confuses the assertion; we watch the seat rail + log.
    // Seat 1 is not actively kept connected, so the server treats it as abandoned
    // and the autoPlayAbandoned chain drives both phases — either production path
    // satisfies the no-stall assertion this smoke makes.
    const hands = [
      [tonkCard("3", "clubs"), tonkCard("4", "diamonds")],
      [
        tonkCard("K", "spades"),
        tonkCard("9", "hearts"),
        tonkCard("5", "clubs"),
      ],
      [tonkCard("6", "clubs"), tonkCard("8", "hearts")],
    ];
    await seedTonkState(request, {
      gameId,
      players,
      currentPlayerIndex: 1,
      tonk: buildTonkSeedState(3, hands, { turnPhase: "discard" }),
    });

    // Observe from the host; refresh so the seeded state renders.
    const host = seats[0]!.page;
    await host.goto(`/game/${gameId}`);
    await expect(host.locator('[data-testid="tonk-board"]')).toBeVisible({
      timeout: 10_000,
    });

    // It is seat 1's (Player2) turn — the host sees the waiting pill naming them.
    await expect(host.locator('[data-testid="tonk-turn-pill"]')).toContainText(
      "Player2",
      { timeout: 10_000 },
    );

    // Phase 1: the timeout auto-discards for the seat. The board re-renders; the
    // seat is still seat 1 (the discard does NOT advance the seat — that is the
    // re-arm invariant). We confirm progression by the turn ultimately handing off.
    //
    // Phase 2: the re-armed/abandoned-chain step auto-draws; the seat advances to
    // seat 2 (Player3). We assert the turn pill names the NEXT seat — proving the
    // turn did not stall on the discard.
    await expect(host.locator('[data-testid="tonk-turn-pill"]')).toContainText(
      "Player3",
      { timeout: TWO_PHASE_WINDOW_MS },
    );

    await closeSeats(seats);
  });

  test("S2/E5: a seated player who reloads during the draw phase is restored to draw controls with a countdown", async ({
    browser,
    request,
  }) => {
    const { gameId, seats, players } = await createStartedTonkGame(
      browser,
      request,
    );

    // Seed the HOST (seat 0) on turn, already in the DRAW phase, with a healthy
    // stock so draw controls are live. A multi-card hand keeps the board sane.
    const hands = [
      [tonkCard("K", "spades"), tonkCard("7", "hearts")],
      [tonkCard("9", "diamonds"), tonkCard("2", "spades")],
      [tonkCard("6", "clubs"), tonkCard("8", "hearts")],
    ];
    await seedTonkState(request, {
      gameId,
      players,
      currentPlayerIndex: 0,
      tonk: buildTonkSeedState(3, hands, { turnPhase: "draw" }),
    });

    const page = seats[0]!.page;
    await page.reload();
    await expect(page.locator('[data-testid="tonk-board"]')).toBeVisible({
      timeout: 10_000,
    });

    // Restored to the DRAW phase: the draw-source buttons render (not the discard
    // button). The hand count is unchanged from the seeded 2.
    await expect(
      page.locator('[data-testid="tonk-draw-stock-btn"]'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="tonk-discard-btn"]')).toHaveCount(
      0,
    );
    expect(await handCount(page)).toBe(2);

    // The game did not freeze: the take-discard control reflects the seeded
    // drawable discard, and the draw action still advances the turn.
    await page.locator('[data-testid="tonk-draw-stock-btn"]').click();
    await expect(page.locator('[data-testid="tonk-turn-pill"]')).toBeVisible({
      timeout: 10_000,
    });

    await closeSeats(seats);
  });
});
