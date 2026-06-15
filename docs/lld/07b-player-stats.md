# LLD 7b: Player Stats

Persistent player statistics recorded when games complete. Tracks games played, games won, total score, and exposes a computed win rate via a REST endpoint. Guest players are excluded from stat recording.

---

## 1. Scope

### In scope

- `StatsService` — orchestrates stat recording on game completion
- `PlayerStatsRepository.incrementStats` — atomic upsert using SQL `ON CONFLICT DO UPDATE SET col = col + $n`
- `GET /stats` endpoint — returns the authenticated user's stats with computed `winRate`
- Integration point: stats recorded when `GameService.applyAction` transitions a game to `COMPLETED`
- Guest player filtering via `GuestSessionStore.get(playerId)` check
- Unit tests for StatsService logic (guest filtering, score extraction)
- Integration tests for the repository upsert and the REST endpoint

### Out of scope

- Guest-to-registered stat conversion (Phase 5 — execution plan lists this under LLD 5 Guest Access)
- Frontend stats display (Phase 5 polish)
- Game history list or detailed per-game records
- Leaderboards or other-player stat lookup
- Stats for games that are abandoned (only COMPLETED games count)

---

## 2. Approach

### Key technical decisions

1. **Atomic increment via SQL upsert, not read-modify-write.** The current `PostgresDB.upsertStats` does a full `save()` which is a read-modify-write pattern vulnerable to races (two games completing simultaneously for the same player). Replace with a raw SQL `INSERT ... ON CONFLICT DO UPDATE SET col = col + $n` for the stat recording path. The existing `getStats` read path remains unchanged.

2. **Stats recorded inside `GameService.applyAction` when status transitions to COMPLETED.** This ensures stats are recorded exactly once regardless of whether the game ended via player action or timer auto-play (from LLD 7a). The `GameService` already detects the COMPLETED transition. Adding a `statsService.recordGameCompletion(state)` call at this point covers both paths.

3. **Guest identification via `GuestSessionStore`.** The user requirement mentions "guest_ ID prefix" but the actual codebase uses regular UUIDs for guest players (see `src/backend/guest/guestSessionStore.ts`). The reliable way to identify guests is to check `guestSessionStore.get(playerId) !== null`. The `StatsService` takes a `GuestSessionStore` dependency for this check. If the session has expired (game ran very long), the fallback is safe: attempting to upsert a UUID that doesn't correspond to a real Supabase user is harmless (the `player_stats` table has no FK constraint to auth.users), and the row will simply be orphaned. However, to avoid even this, we also check if the `PlayerStats` row already exists — a guest who has never played before will have no row and the session check catches them. In practice, guest sessions last 4 hours which covers all realistic game durations.

4. **`StatsService` is a thin orchestration layer.** It extracts scores from `InternalGameState`, filters out guests, and calls `incrementStats` for each registered player. No complex business logic — just mapping + filtering + delegation.

5. **`GET /stats` requires authentication but allows guests (returns empty stats).** A guest calling this endpoint receives a zeroed-out stats response. This is simpler than blocking guests and lets the frontend render the stats page uniformly.

6. **`winRate` is computed on read, not stored.** Storing derived data invites inconsistency. The computation is trivial: `gamesPlayed > 0 ? gamesWon / gamesPlayed : 0`.

---

## 3. Interfaces / Types

### PlayerStatsRepository change

Replace the existing `upsertStats` with an atomic `incrementStats`:

```typescript
// Updated src/backend/database/database.ts

export interface PlayerStatsRepository {
  getStats(userId: string): Promise<PlayerStats | null>;
  /**
   * Atomically increment stats for a player. Creates the row if it doesn't exist.
   * Uses SQL ON CONFLICT DO UPDATE to avoid read-modify-write races.
   */
  incrementStats(
    userId: string,
    delta: StatsDelta,
  ): Promise<void>;
}

export interface StatsDelta {
  gamesPlayed: number;  // always 1
  gamesWon: number;     // 1 or 0
  gamesLost: number;    // 1 or 0
  totalScore: number;   // placement score from the game
}
```

### PostgresDB.incrementStats implementation

```typescript
// Updated src/backend/database/postgres.ts

public async incrementStats(userId: string, delta: StatsDelta): Promise<void> {
  await this.dataSource!.query(
    `INSERT INTO player_stats ("userId", "gamesPlayed", "gamesWon", "gamesLost", "totalScore", "lastPlayedAt")
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT ("userId") DO UPDATE SET
       "gamesPlayed" = player_stats."gamesPlayed" + $2,
       "gamesWon" = player_stats."gamesWon" + $3,
       "gamesLost" = player_stats."gamesLost" + $4,
       "totalScore" = player_stats."totalScore" + $5,
       "lastPlayedAt" = NOW()`,
    [userId, delta.gamesPlayed, delta.gamesWon, delta.gamesLost, delta.totalScore],
  );
}
```

Note: The existing `upsertStats(stats: PlayerStats)` method is removed since `incrementStats` replaces its functionality with a safer atomic pattern. The `getStats` method remains unchanged.

### StatsService

```typescript
// src/backend/service/statsService.ts

import type { InternalGameState, PlayerScore } from "@shared/engine-types";
import type { PlayerStatsRepository, StatsDelta } from "@/database/database";
import type { GuestSessionStore } from "@/guest/guestSessionStore";

export class StatsService {
  constructor(
    private readonly statsRepo: PlayerStatsRepository,
    private readonly guestSessionStore: GuestSessionStore,
  ) {}

  /**
   * Record stats for all registered (non-guest) players in a completed game.
   * Called once when game status transitions to COMPLETED.
   *
   * Silently skips guest players. Errors on individual player upserts are
   * logged but do not block other players' stat recording.
   */
  async recordGameCompletion(state: InternalGameState): Promise<void> {
    if (state.status !== "COMPLETED") return;
    if (!state.scores || state.scores.length === 0) return;

    const winnerId = state.winner;

    for (const playerScore of state.scores) {
      if (this.isGuest(playerScore.playerId)) continue;

      const delta: StatsDelta = {
        gamesPlayed: 1,
        gamesWon: playerScore.playerId === winnerId ? 1 : 0,
        gamesLost: playerScore.playerId !== winnerId ? 1 : 0,
        totalScore: playerScore.score,
      };

      try {
        await this.statsRepo.incrementStats(playerScore.playerId, delta);
      } catch (err: unknown) {
        console.error(
          `Failed to record stats for player ${playerScore.playerId}:`,
          err,
        );
      }
    }
  }

  /**
   * Check if a playerId belongs to a guest session.
   */
  private isGuest(playerId: string): boolean {
    return this.guestSessionStore.get(playerId) !== null;
  }
}
```

### GET /stats response type

```typescript
// Addition to src/shared/model.ts

export interface GetStatsResponse {
  userId: string;
  gamesPlayed: number;
  gamesWon: number;
  gamesLost: number;
  totalScore: number;
  winRate: number;        // computed: gamesWon / gamesPlayed (0 if no games)
  lastPlayedAt: string | null;  // ISO 8601 timestamp, null if never played
}
```

### GetStatsHandler

```typescript
// src/backend/api/stats/getStats.ts

import { type Request, type Response } from "@/util/types";
import { Handler } from "@/api/handler";
import type { GetStatsResponse } from "@shared/model";
import { statsRepo } from "@/database";

export class GetStatsHandler extends Handler {
  public static INSTANCE: GetStatsHandler = new GetStatsHandler();
  private constructor() {
    super();
  }

  public override async get(
    request: Request,
    response: Response<GetStatsResponse>,
  ) {
    const userId = request.userId!;
    const stats = await statsRepo.getStats(userId);

    const result: GetStatsResponse = {
      userId,
      gamesPlayed: stats?.gamesPlayed ?? 0,
      gamesWon: stats?.gamesWon ?? 0,
      gamesLost: stats?.gamesLost ?? 0,
      totalScore: stats?.totalScore ?? 0,
      winRate:
        stats && stats.gamesPlayed > 0
          ? stats.gamesWon / stats.gamesPlayed
          : 0,
      lastPlayedAt: stats?.lastPlayedAt?.toISOString() ?? null,
    };

    response.status(200).json(result);
  }
}
```

---

## 4. State Model

### Persistence

`PlayerStats` entity (already exists in `src/backend/database/entities/PlayerStats.ts`):

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| userId | uuid (PK) | — | References Supabase auth.users.id (no FK) |
| gamesPlayed | int | 0 | Incremented by 1 per game |
| gamesWon | int | 0 | Incremented by 1 when player is the winner |
| gamesLost | int | 0 | Incremented by 1 when player is not the winner |
| totalScore | int | 0 | Incremented by placement score |
| lastPlayedAt | timestamptz | auto | Updated on each game completion |

The entity already exists and does not need modification.

### Data flow

```
Game completes (player action or timer auto-play):
  GameService.applyAction(...)
    → engine.applyAction returns newState with status "COMPLETED"
    → statsService.recordGameCompletion(newState)
      → for each player in state.scores:
        → if guestSessionStore.get(playerId) !== null → skip
        → statsRepo.incrementStats(playerId, delta)
    → persist game to DB (existing flow)
    → return newState to caller (socketHandler broadcasts)

GET /stats request:
  authMiddleware verifies JWT or guest token
    → GetStatsHandler.get
      → statsRepo.getStats(userId)
      → compute winRate
      → return GetStatsResponse
```

### In-memory vs persisted

- Stats are persisted only (no caching). Read frequency is low (dashboard loads, not game hot-path). The single DB query per stats read is acceptable.
- The `GuestSessionStore` is in-memory (already exists).

---

## 5. Integration Point: Game Completion

The `GameService` currently detects game completion in `applyAction`:

```typescript
// Existing code in src/backend/service/gameService.ts (lines 118-119):
if (result.newState.status === "COMPLETED") {
  game.status = "COMPLETED";
}
```

Add the `StatsService` call at this point:

```typescript
// Modified applyAction in GameService:
if (result.newState.status === "COMPLETED") {
  game.status = "COMPLETED";
  // Fire-and-forget: don't block game state persistence on stats
  this.statsService.recordGameCompletion(result.newState).catch(
    (err: unknown) => console.error("Stats recording failed:", err),
  );
}
```

The `GameService` constructor gains a `statsService` parameter:

```typescript
export class GameService {
  constructor(
    private readonly cache: GameCache,
    private readonly engineFactory: GameEngineFactory,
    private readonly gameRepo: GameRepository,
    private readonly statsService: StatsService,
  ) {}
```

This is fire-and-forget: stats recording failure must not prevent game state from being persisted or broadcast to players. The `await` is intentionally omitted so the game flow continues immediately. The `catch` logs the error.

### Why not in the socket handler?

The execution plan requires stats to be recorded on the COMPLETED transition regardless of trigger (player action, timer expiry). Both paths converge in `GameService.applyAction`. Hooking stats here means a single integration point rather than duplicating in `handleGameAction` and `handleTimerExpired`.

---

## 6. Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | Two games for the same player complete simultaneously | `incrementStats` uses `ON CONFLICT DO UPDATE SET col = col + $n` — fully atomic, no race condition. |
| 2 | Guest player in a completed game | `StatsService.isGuest` checks `GuestSessionStore` and skips the player. No row is created. |
| 3 | Guest session expired before game completes (4h+ game) | `GuestSessionStore.get` returns null (session expired). The player is treated as registered. This is acceptable: their UUID doesn't correspond to a real Supabase user, so an orphaned `player_stats` row is created. It's harmless and cleaned up if/when guest-to-registered conversion is implemented. |
| 4 | Player has never played before (no stats row) | `incrementStats` creates the row via `INSERT ... ON CONFLICT`. `getStats` returns null, endpoint responds with zeroed stats. |
| 5 | Stats recording fails for one player | Error is logged, other players' stats are still recorded (loop continues). Game state is unaffected. |
| 6 | Game ends with no scores (should not happen) | `recordGameCompletion` returns early if `state.scores` is null or empty. |
| 7 | Guest calls GET /stats | Returns zeroed stats (`getStats` returns null for their UUID since no row exists). No error thrown. |
| 8 | `applyAction` called but game was already COMPLETED (duplicate trigger) | The engine rejects actions on COMPLETED games, so `applyAction` never produces a second COMPLETED transition. Stats are recorded exactly once. |
| 9 | Server restart between game completion and stats write | Stats are fire-and-forget. If the server crashes after persisting the game but before stats are written, stats for that game are lost. Acceptable for v1 — stats are informational, not transactional. |

---

## 7. Wiring

### server.ts changes

```typescript
// In the Server constructor, after creating gameCache and before registerSocketHandlers:

import { StatsService } from "@/service/statsService";
import { statsRepo } from "@/database";

// ...inside constructor():
const statsService = new StatsService(statsRepo, this.guestSessionStore);
const gameService = new GameService(gameCache, engineFactory, gameRepo, statsService);
```

### Route registration

```typescript
// In server.ts, add to the authenticated routes:
import { GetStatsHandler } from "@/api/stats/getStats";

// After the existing authenticated route map:
new Map<string, Handler>([
  ["/stats", GetStatsHandler.INSTANCE],
]).forEach((handler: Handler, path: string) => {
  this.app.use(path, authMiddleware, handler.router);
});
```

The `/stats` endpoint uses `authMiddleware` (allows both registered and guest tokens) but NOT `registeredOnlyMiddleware`. Guests get zeroed stats rather than a 403.

---

## 8. File Organization

```
New files:
  src/backend/service/statsService.ts        — StatsService class
  src/backend/api/stats/getStats.ts          — GET /stats handler
  tests/service/statsService.test.ts         — Unit tests for StatsService
  tests/integration/player-stats.test.ts     — Integration tests

Modified files:
  src/backend/database/database.ts           — Replace upsertStats with incrementStats + StatsDelta interface
  src/backend/database/postgres.ts           — Implement incrementStats with raw SQL upsert
  src/backend/database/index.ts              — (no change needed, statsRepo already exported)
  src/backend/service/gameService.ts         — Add statsService dependency, call recordGameCompletion
  src/backend/server.ts                      — Instantiate StatsService, pass to GameService, register /stats route
  src/shared/model.ts                        — Add GetStatsResponse interface
```

---

## 9. Test Requirements

### Unit tests: StatsService (`tests/service/statsService.test.ts`)

| # | Test | What it verifies |
|---|------|------------------|
| 1 | Records stats for all players in a completed game | `incrementStats` called once per player with correct deltas |
| 2 | Winner gets `gamesWon: 1, gamesLost: 0` | Delta for the winning player has correct win/loss values |
| 3 | Non-winners get `gamesWon: 0, gamesLost: 1` | Delta for losing players has correct win/loss values |
| 4 | Guest players are skipped | `incrementStats` not called for players found in GuestSessionStore |
| 5 | Returns early if game is not COMPLETED | No calls to `incrementStats` when state.status !== "COMPLETED" |
| 6 | Returns early if scores array is empty or null | No calls to `incrementStats` |
| 7 | Individual player failure does not block others | If `incrementStats` throws for player A, player B's stats are still recorded |
| 8 | Correct totalScore extracted from PlayerScore | Delta.totalScore matches the score from state.scores for each player |

Test approach: mock `PlayerStatsRepository` and `GuestSessionStore`. Construct `InternalGameState` objects directly with known scores. Verify correct calls to `incrementStats`.

### Integration tests: Player stats (`tests/integration/player-stats.test.ts`)

| # | Test | What it verifies |
|---|------|------------------|
| 1 | `GET /stats` returns zeroed stats for new user | Authenticated user with no games gets `{ gamesPlayed: 0, winRate: 0, ... }` |
| 2 | `GET /stats` returns 401 without auth token | Unauthenticated request rejected |
| 3 | Stats are recorded after game completion via WebSocket | Play a full game to completion, then GET /stats shows gamesPlayed: 1 |
| 4 | Winner's stats show gamesWon: 1 | After game completion, winner's GET /stats shows correct win count |
| 5 | Loser's stats show gamesLost: 1 | After game completion, non-winner's GET /stats shows correct loss count |
| 6 | Guest player has no stats row after game completion | Guest plays and finishes game, GET /stats returns zeroed response |
| 7 | `incrementStats` is atomic (concurrent upserts) | Two concurrent incrementStats calls for same userId both succeed, final values are sum of both |
| 8 | `winRate` is correctly computed | After 3 games (1 win, 2 losses), winRate is approximately 0.333 |

### Integration test infrastructure notes

- Tests 3-6 require playing a full game to completion via WebSocket (reuse the existing `websocket-game.test.ts` pattern).
- Test 7 can be a direct repository-level test using the test database.
- The existing `tests/integration/helpers/testServer.ts` must be updated to pass a `StatsService` instance to `GameService` (or the test server factory must be updated to construct one).

---

## 10. Dependencies

- **LLD 4 (Big2 Engine)** — game must complete and produce scores
- **LLD 7a (Turn Timer)** — timer auto-play can trigger game completion; stats must be recorded in that path too (covered by hooking into `GameService.applyAction`)
- **Existing code:** `src/backend/database/entities/PlayerStats.ts`, `src/backend/database/database.ts`, `src/backend/database/postgres.ts`, `src/backend/service/gameService.ts`, `src/backend/server.ts`, `src/backend/guest/guestSessionStore.ts`
