# LLD 12: Supabase SDK Migration (Replace TypeORM + Add RLS)

Replace TypeORM with the Supabase JS SDK for all database operations and add Row-Level Security policies. This eliminates persistent DB connections (enabling serverless deployment on Railway), secures direct PostgREST access, and simplifies the persistence layer.

**Note:** The execution plan assigns "LLD 12" to "Rematch + Invite UX". This LLD uses the same number because it replaces the Phase 1 Supabase migration (originally LLD 1) with a more complete version. The execution plan will be updated to reflect: the original LLD 1 was an initial Supabase setup, this LLD 12 is the final migration that removes TypeORM entirely. "Rematch + Invite UX" will be renumbered to LLD 14.

---

## 1. Scope

### In scope

- Replace `PostgresDB` (TypeORM `DataSource`) with a `SupabaseDB` class using `@supabase/supabase-js`
- Design and apply RLS policies for `games`, `player_stats`, and `feedback` tables
- Supabase migration files (SQL) to create tables with RLS enabled (replaces TypeORM `synchronize: true`)
- snake_case column migration (replacing TypeORM's camelCase convention)
- Remove `typeorm` and related packages from dependencies
- Delete TypeORM entity decorators, `DataSource` configuration, and `postgres.ts`
- Preserve existing repository interfaces (`GameRepository`, `PlayerStatsRepository`, `FeedbackRepository`) unchanged
- Maintain optimistic locking semantics (version column check)
- Keep server-authoritative architecture: game state mutations only through backend game logic

### Out of scope

- **Auth changes.** The frontend continues to call Supabase Auth directly via `@supabase/supabase-js`. No auth proxy, no changes to `authService.ts` or `App.vue`. The HLD explicitly states: "the backend NEVER proxies auth requests — it only verifies incoming JWTs."
- Changing the game engine, WebSocket layer, or service layer (they consume repository interfaces which stay the same)
- Guest session system changes (stays in-memory, unchanged)
- Frontend UI changes of any kind
- Supabase Realtime subscriptions (we use Socket.IO for real-time)
- Supabase Storage (no file uploads in this app)
- Admin/dashboard UI

---

## 2. Approach

### Key technical decisions

1. **Service-role client for backend operations.** The backend uses `createClient(url, serviceRoleKey)` to bypass RLS for all game state mutations. This preserves server-authoritative architecture: the backend is trusted, RLS only restricts direct PostgREST access from untrusted clients.

2. **No auth proxy.** The HLD is explicit: "Auth happens entirely between the browser and Supabase — the Express server only verifies the JWT on incoming requests/connections." Reasons for honoring this:
   - Supabase has built-in rate limiting on auth endpoints (sufficient DDoS protection).
   - Proxying would force us to reimplement token refresh, reactive auth state (`onAuthStateChange`), and session persistence — complex and error-prone.
   - The Supabase URL + anon key are public by design (in the client bundle) — not secrets.
   - RLS handles the "privileged DB access" concern; hiding the URL adds no meaningful security.

3. **Frontend auth stays unchanged.** The frontend's `authService.ts` continues to use `@supabase/supabase-js` directly. The `supabase` client instance, `onAuthStateChange`, and `getSession()` calls remain as-is. This gives us reactive auth state, automatic token refresh, and localStorage session persistence for free.

4. **RLS policies are defensive, not load-bearing.** The backend always uses the service-role client (which bypasses RLS). RLS exists to protect against direct PostgREST abuse. If an attacker uses the anon key with PostgREST directly, RLS ensures they can only see/modify their own data.

5. **Single migration replaces TypeORM synchronize.** We create a Supabase migration that defines the exact schema (currently managed by TypeORM `synchronize: true`) and enables RLS. Going forward, schema changes use Supabase migrations.

6. **Optimistic locking via SQL `WHERE version = $n`.** TypeORM's `@VersionColumn` is replaced with an explicit `UPDATE ... WHERE version = :expected RETURNING *` pattern. If no row is returned, the version was stale (equivalent to TypeORM's `OptimisticLockVersionMismatchError`).

7. **HTTP-based, no persistent connections.** The Supabase JS SDK uses PostgREST (HTTP) under the hood. No connection pooling needed. This is ideal for Railway's serverless model where the process may cold-start.

8. **`OptimisticLockError` in `src/backend/util/errors.ts`.** Follows the existing error class pattern (`ErrorWithStatus`), placed alongside `AlreadyExistsError`, `NotFoundError`, etc.

9. **Env var validation at construction time.** `SupabaseDB.initialize()` validates that `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are present and non-empty, failing fast with a clear error message.

10. **`server.ts` call site: sync `initialize()`.** Unlike `PostgresDB.INSTANCE.initialize()` which is async (establishes TCP connections), `SupabaseDB.INSTANCE.initialize()` is synchronous (just constructs an HTTP client). The `server.ts` `start()` method changes from `await db.initialize()` to `db.initialize()` (no await needed). The `start()` method itself remains async for the `server.listen()` call.

---

## 3. Interfaces / Types

### Repository interfaces (unchanged)

The existing interfaces in `src/backend/database/database.ts` remain **exactly as-is**. This is the pluggable storage principle in action: only the implementation changes.

```typescript
// src/backend/database/database.ts — NO CHANGES
export interface GameRepository {
  createGame(gameId: string, gameType: GameType, creatorId: string, maxPlayers: number, creatorDisplayName: string, turnTimerSeconds: number | null): Promise<Game>;
  getGame(gameId: string): Promise<Game | null>;
  saveGame(game: Game): Promise<Game>;
}

export interface PlayerStatsRepository {
  getStats(userId: string): Promise<PlayerStats | null>;
  incrementStats(userId: string, delta: StatsDelta): Promise<void>;
}

export interface FeedbackRepository {
  createFeedback(feedback: Feedback): Promise<Feedback>;
  getAllFeedback(): Promise<Feedback[]>;
}
```

### Game data model (replaces TypeORM entity)

```typescript
// src/backend/database/entities/Game.ts — remove TypeORM decorators, keep as plain class
import type { GameType, GameStatus } from "@shared/engine-types";

export class Game {
  gameId: string = "";
  gameType: GameType = "big2";
  playerIds: string[] = [];
  playerDisplayNames: Record<string, string> = {};
  maxPlayers: number = 4;
  status: GameStatus = "CREATED";
  state: Record<string, unknown> = {};
  turnTimerSeconds: number | null = null;
  createdAt: Date = new Date();
  updatedAt: Date = new Date();
  version: number = 1;
}
```

### PlayerStats data model (plain class)

```typescript
// src/backend/database/entities/PlayerStats.ts
export class PlayerStats {
  userId: string = "";
  gamesPlayed: number = 0;
  gamesWon: number = 0;
  gamesLost: number = 0;
  totalScore: number = 0;
  lastPlayedAt: Date = new Date();
}
```

### Feedback data model (plain class)

```typescript
// src/backend/database/entities/Feedback.ts
import type { FeedbackCategory } from "@shared/model";

export interface FeedbackMetadata {
  route: string;
  gameId?: string;
  gameStatus?: string;
  userType: "guest" | "registered";
  browser: string;
  viewport: { width: number; height: number };
  timestamp: string;
}

export class Feedback {
  id: string = "";
  category: FeedbackCategory = "other";
  description: string = "";
  metadata: FeedbackMetadata | null = null;
  userId: string | null = null;
  createdAt: Date = new Date();
}
```

### OptimisticLockError (added to existing errors file)

```typescript
// src/backend/util/errors.ts — ADD to existing file

export class OptimisticLockError extends Error implements ErrorWithStatus {
  public readonly status: number = 409;

  constructor(gameId: string, expectedVersion: number) {
    super(`Optimistic lock failed for game ${gameId} at version ${expectedVersion}`);
    this.name = "OptimisticLockError";
    Object.setPrototypeOf(this, OptimisticLockError.prototype);
  }
}
```

### SupabaseDB implementation

```typescript
// src/backend/database/supabaseDb.ts

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { GameRepository, PlayerStatsRepository, FeedbackRepository, StatsDelta } from "@/database/database";
import { Game } from "@/database/entities/Game";
import { PlayerStats } from "@/database/entities/PlayerStats";
import { Feedback } from "@/database/entities/Feedback";
import { OptimisticLockError } from "@/util/errors";
import type { GameType } from "@shared/engine-types";

export class SupabaseDB implements GameRepository, PlayerStatsRepository, FeedbackRepository {
  public static readonly INSTANCE = new SupabaseDB();
  private client: SupabaseClient | undefined;

  private constructor() {}

  /**
   * Synchronous initialization — constructs the Supabase HTTP client.
   * Unlike TypeORM's async initialize() (which opens TCP connections),
   * this only validates env vars and creates the client object.
   */
  public initialize(): void {
    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url) {
      throw new Error("SUPABASE_URL environment variable is required");
    }
    if (!serviceRoleKey) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY environment variable is required");
    }
    this.client = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  private get db(): SupabaseClient {
    if (!this.client) throw new Error("SupabaseDB not initialized — call initialize() first");
    return this.client;
  }

  public async createGame(
    gameId: string,
    gameType: GameType,
    creatorId: string,
    maxPlayers: number,
    creatorDisplayName: string,
    turnTimerSeconds: number | null,
  ): Promise<Game> {
    const row = {
      game_id: gameId,
      game_type: gameType,
      player_ids: [creatorId],
      player_display_names: { [creatorId]: creatorDisplayName },
      max_players: maxPlayers,
      status: "CREATED",
      state: {},
      turn_timer_seconds: turnTimerSeconds,
    };
    const { data, error } = await this.db.from("games").insert(row).select().single();
    if (error) throw new Error(`createGame failed: ${error.message}`);
    return this.mapGame(data);
  }

  public async getGame(gameId: string): Promise<Game | null> {
    const { data, error } = await this.db
      .from("games")
      .select("*")
      .eq("game_id", gameId)
      .maybeSingle();
    if (error) throw new Error(`getGame failed: ${error.message}`);
    if (!data) return null;
    return this.mapGame(data);
  }

  public async saveGame(game: Game): Promise<Game> {
    const expectedVersion = game.version;
    const { data, error } = await this.db
      .from("games")
      .update({
        game_type: game.gameType,
        player_ids: game.playerIds,
        player_display_names: game.playerDisplayNames,
        max_players: game.maxPlayers,
        status: game.status,
        state: game.state,
        turn_timer_seconds: game.turnTimerSeconds,
        version: expectedVersion + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("game_id", game.gameId)
      .eq("version", expectedVersion)
      .select()
      .single();

    if (error) {
      // PostgREST returns PGRST116 when .single() matches 0 rows
      if (error.code === "PGRST116" || error.message.includes("0 rows")) {
        throw new OptimisticLockError(game.gameId, expectedVersion);
      }
      throw new Error(`saveGame failed: ${error.message}`);
    }
    return this.mapGame(data);
  }

  public async getStats(userId: string): Promise<PlayerStats | null> {
    const { data, error } = await this.db
      .from("player_stats")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(`getStats failed: ${error.message}`);
    if (!data) return null;
    return this.mapPlayerStats(data);
  }

  public async incrementStats(userId: string, delta: StatsDelta): Promise<void> {
    // Use an RPC (stored procedure) for atomic upsert
    const { error } = await this.db.rpc("increment_player_stats", {
      p_user_id: userId,
      p_games_played: delta.gamesPlayed,
      p_games_won: delta.gamesWon,
      p_games_lost: delta.gamesLost,
      p_total_score: delta.totalScore,
    });
    if (error) throw new Error(`incrementStats failed: ${error.message}`);
  }

  public async createFeedback(feedback: Feedback): Promise<Feedback> {
    const { data, error } = await this.db
      .from("feedback")
      .insert({
        category: feedback.category,
        description: feedback.description,
        metadata: feedback.metadata,
        user_id: feedback.userId,
      })
      .select()
      .single();
    if (error) throw new Error(`createFeedback failed: ${error.message}`);
    return this.mapFeedback(data);
  }

  public async getAllFeedback(): Promise<Feedback[]> {
    const { data, error } = await this.db
      .from("feedback")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(`getAllFeedback failed: ${error.message}`);
    return (data ?? []).map((row) => this.mapFeedback(row));
  }

  // --- Row mappers (snake_case DB columns -> camelCase domain objects) ---

  private mapGame(row: Record<string, unknown>): Game {
    const game = new Game();
    game.gameId = row.game_id as string;
    game.gameType = row.game_type as GameType;
    game.playerIds = row.player_ids as string[];
    game.playerDisplayNames = row.player_display_names as Record<string, string>;
    game.maxPlayers = row.max_players as number;
    game.status = row.status as Game["status"];
    game.state = row.state as Record<string, unknown>;
    game.turnTimerSeconds = row.turn_timer_seconds as number | null;
    game.createdAt = new Date(row.created_at as string);
    game.updatedAt = new Date(row.updated_at as string);
    game.version = row.version as number;
    return game;
  }

  private mapPlayerStats(row: Record<string, unknown>): PlayerStats {
    const stats = new PlayerStats();
    stats.userId = row.user_id as string;
    stats.gamesPlayed = row.games_played as number;
    stats.gamesWon = row.games_won as number;
    stats.gamesLost = row.games_lost as number;
    stats.totalScore = row.total_score as number;
    stats.lastPlayedAt = new Date(row.last_played_at as string);
    return stats;
  }

  private mapFeedback(row: Record<string, unknown>): Feedback {
    const fb = new Feedback();
    fb.id = row.id as string;
    fb.category = row.category as Feedback["category"];
    fb.description = row.description as string;
    fb.metadata = row.metadata as Feedback["metadata"];
    fb.userId = row.user_id as string | null;
    fb.createdAt = new Date(row.created_at as string);
    return fb;
  }
}
```

---

## 4. Database Schema & Migrations

### Migration: `supabase/migrations/001_create_tables.sql`

```sql
-- Create tables (previously managed by TypeORM synchronize)

CREATE TABLE IF NOT EXISTS games (
  game_id UUID PRIMARY KEY,
  game_type VARCHAR(50) NOT NULL DEFAULT 'big2',
  player_ids UUID[] NOT NULL DEFAULT '{}',
  player_display_names JSONB NOT NULL DEFAULT '{}',
  max_players INT NOT NULL DEFAULT 4,
  status VARCHAR(20) NOT NULL DEFAULT 'CREATED',
  state JSONB NOT NULL DEFAULT '{}',
  turn_timer_seconds INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS player_stats (
  user_id UUID PRIMARY KEY,
  games_played INT NOT NULL DEFAULT 0,
  games_won INT NOT NULL DEFAULT 0,
  games_lost INT NOT NULL DEFAULT 0,
  total_score INT NOT NULL DEFAULT 0,
  last_played_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category VARCHAR(20) NOT NULL,
  description VARCHAR(500) NOT NULL,
  metadata JSONB,
  user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for player lookups in games
CREATE INDEX IF NOT EXISTS idx_games_player_ids ON games USING GIN (player_ids);
CREATE INDEX IF NOT EXISTS idx_games_status ON games (status);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback (created_at DESC);
```

### Migration: `supabase/migrations/002_enable_rls.sql`

```sql
-- Enable RLS on all tables
ALTER TABLE games ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- Service role (used by backend) bypasses RLS automatically.
-- These policies only apply to requests authenticated with the anon key (direct PostgREST access).

-- === GAMES policies ===

-- Players can view games they are part of
CREATE POLICY "Users can view their own games"
  ON games FOR SELECT
  USING (auth.uid() = ANY(player_ids));

-- No direct INSERT/UPDATE/DELETE via PostgREST — all mutations go through the backend (service role)
-- This is the server-authoritative principle: clients cannot mutate game state directly.

-- === PLAYER_STATS policies ===

-- Users can only read their own stats
CREATE POLICY "Users can view their own stats"
  ON player_stats FOR SELECT
  USING (auth.uid() = user_id);

-- No direct INSERT/UPDATE/DELETE — backend handles stat recording via service role

-- === FEEDBACK policies ===

-- Users can insert their own feedback
CREATE POLICY "Users can insert feedback"
  ON feedback FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can view their own feedback (optional, for future "my submissions" feature)
CREATE POLICY "Users can view their own feedback"
  ON feedback FOR SELECT
  USING (auth.uid() = user_id);

-- No UPDATE/DELETE — feedback is immutable
```

### Migration: `supabase/migrations/003_increment_stats_rpc.sql`

```sql
-- Stored procedure for atomic stat increment (upsert)
-- Called by the backend via supabase.rpc('increment_player_stats', {...})

CREATE OR REPLACE FUNCTION increment_player_stats(
  p_user_id UUID,
  p_games_played INT,
  p_games_won INT,
  p_games_lost INT,
  p_total_score INT
) RETURNS VOID AS $$
BEGIN
  INSERT INTO player_stats (user_id, games_played, games_won, games_lost, total_score, last_played_at)
  VALUES (p_user_id, p_games_played, p_games_won, p_games_lost, p_total_score, NOW())
  ON CONFLICT (user_id) DO UPDATE SET
    games_played = player_stats.games_played + p_games_played,
    games_won = player_stats.games_won + p_games_won,
    games_lost = player_stats.games_lost + p_games_lost,
    total_score = player_stats.total_score + p_total_score,
    last_played_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- SECURITY DEFINER means this function runs with the definer's privileges (superuser),
-- bypassing RLS. This is safe because it's only callable via RPC and the backend
-- controls the inputs.

-- Restrict direct RPC calls: only the backend (service_role) should call this.
REVOKE EXECUTE ON FUNCTION increment_player_stats FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_player_stats TO service_role;
```

### Column naming convention change

TypeORM used camelCase column names (e.g., `"gameId"`, `"playerIds"`). The Supabase SDK + PostgREST works best with snake_case. This migration adopts snake_case for all columns. The `SupabaseDB` mapper methods handle the translation.

---

## 5. State Model

### What changes

| Layer | Before | After |
|-------|--------|-------|
| DB connection | TypeORM `DataSource` with persistent Postgres connections | Supabase JS SDK using HTTP (PostgREST) |
| Entity definitions | TypeORM decorators (`@Entity`, `@Column`, `@VersionColumn`) | Plain TypeScript classes (data carriers only) |
| Schema management | `synchronize: true` in dev | Supabase migrations (`supabase/migrations/`) |
| Optimistic locking | TypeORM `@VersionColumn` + `findOne(..., lock)` | Explicit `WHERE version = $n` in UPDATE |
| RLS | None | Policies on all tables |
| Barrel export | `PostgresDB.INSTANCE` | `SupabaseDB.INSTANCE` |
| DB init in `server.ts` | `await PostgresDB.INSTANCE.initialize()` (async) | `SupabaseDB.INSTANCE.initialize()` (sync) |

### What does NOT change

- Repository interfaces (`GameRepository`, `PlayerStatsRepository`, `FeedbackRepository`)
- Service layer (`GameService`, `StatsService`, `FeedbackService`)
- Game engine layer
- WebSocket layer
- Guest session system (in-memory, no DB)
- Auth middleware (still verifies Supabase JWTs the same way)
- **Frontend auth** (`authService.ts` — still uses `@supabase/supabase-js` directly)
- In-memory game cache (`GameCache`)
- The `Game`, `PlayerStats`, `Feedback` class shapes (same fields, just no decorators)

### Auth token flow (unchanged)

```
Browser                       Supabase Auth           Express Backend
  |                               |                       |
  |-- signInWithPassword -------->|                       |
  |<-- session (JWT + refresh) ---|                       |
  |                               |                       |
  |-- GET /stats (Bearer JWT) --------------------------->|
  |                               |                       |-- verify JWT (local)
  |                               |                       |-- supabase.from("player_stats").select()
  |                               |                       |   (service-role, bypasses RLS)
  |<-- { stats } -----------------------------------------|
```

The browser talks to Supabase Auth directly. The backend only verifies JWTs and uses the service-role client for DB operations.

---

## 6. Migration Strategy

### Can we do it in one shot?

**Yes.** Rationale:
- Small user base (< 10 active users during playtesting)
- The app is not publicly launched (no uptime SLA)
- No data migration needed: the new schema has the same logical shape, just snake_case columns
- We can run a data copy script if any existing data needs preserving

### Execution sequence

1. **Create Supabase migrations** (`supabase/migrations/001_*.sql`, `002_*.sql`, `003_*.sql`)
2. **Add `OptimisticLockError`** to `src/backend/util/errors.ts`
3. **Implement `SupabaseDB` class** with all repository methods
4. **Update `src/backend/database/index.ts`** barrel to export `SupabaseDB.INSTANCE` instead of `PostgresDB.INSTANCE`
5. **Update `server.ts`** — change `await PostgresDB.INSTANCE.initialize()` to `SupabaseDB.INSTANCE.initialize()` (sync call, no await), remove `reflect-metadata` import
6. **Remove TypeORM** — delete `postgres.ts`, TypeORM decorators from entities, uninstall `typeorm` and `reflect-metadata` packages
7. **Run migrations** (`supabase db push` for cloud, `supabase db reset` for local)
8. **Verify all integration tests pass**

### Data migration (if needed)

If existing data must be preserved (games in progress, player stats):

```sql
-- Run once against the Supabase DB after creating new tables:
-- Copy from old camelCase tables to new snake_case tables

INSERT INTO games (game_id, game_type, player_ids, player_display_names, max_players, status, state, turn_timer_seconds, created_at, updated_at, version)
SELECT "gameId", "gameType", "playerIds", "playerDisplayNames", "maxPlayers", status, state, "turnTimerSeconds", "createdAt", "updatedAt", version
FROM old_games;  -- rename original table first if needed
```

For the current state of the project (< 10 users, playtesting phase), it is acceptable to wipe data and start fresh.

---

## 7. File Changes

### Files to DELETE

| File | Reason |
|------|--------|
| `src/backend/database/postgres.ts` | Replaced by `supabaseDb.ts` |
| All TypeORM decorator imports in entity files | Entities become plain classes |

### Files to CREATE

| File | Purpose |
|------|---------|
| `src/backend/database/supabaseDb.ts` | New `SupabaseDB` implementation using Supabase JS SDK |
| `supabase/migrations/001_create_tables.sql` | Schema definition |
| `supabase/migrations/002_enable_rls.sql` | RLS policies |
| `supabase/migrations/003_increment_stats_rpc.sql` | Atomic stats upsert function |

### Files to MODIFY

| File | Changes |
|------|---------|
| `src/backend/database/entities/Game.ts` | Remove TypeORM imports/decorators, keep class shape |
| `src/backend/database/entities/PlayerStats.ts` | Remove TypeORM imports/decorators, keep class shape |
| `src/backend/database/entities/Feedback.ts` | Remove TypeORM imports/decorators, keep class shape |
| `src/backend/database/index.ts` | Import `SupabaseDB` instead of `PostgresDB` |
| `src/backend/server.ts` | Replace `await PostgresDB.INSTANCE.initialize()` with `SupabaseDB.INSTANCE.initialize()` (sync), remove `reflect-metadata` import |
| `src/backend/util/errors.ts` | Add `OptimisticLockError` class |
| `src/backend/api/game/joinGame.ts` | Change `e.name === "OptimisticLockVersionMismatchError"` to `e instanceof OptimisticLockError` (two catch sites) |
| `src/backend/database/database.ts` | Update `saveGame` comment from "throws OptimisticLockVersionMismatchError" to "throws OptimisticLockError" |
| `package.json` (backend) | Remove `typeorm`, `reflect-metadata`. Add `@supabase/supabase-js` to backend. |
| `tsconfig.json` (backend) | Remove `emitDecoratorMetadata` and `experimentalDecorators` if only TypeORM needed them |
| `.env.local` / `.env.example` | Add `SUPABASE_SERVICE_ROLE_KEY` for backend (if not already present) |

---

## 8. Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | Optimistic lock conflict on saveGame | `SupabaseDB.saveGame` throws `OptimisticLockError` (status 409). Callers retry once with fresh state from cache, then return 409 to client. Same behavior as before. |
| 2 | Supabase service unavailable | All DB operations throw. GameCache still serves in-memory state for active games. Persistence fails but gameplay continues. Error logged. |
| 3 | Direct PostgREST access with anon key | RLS policies restrict: users can only SELECT their own games/stats. No INSERT/UPDATE/DELETE on games or stats. Feedback INSERT requires matching `user_id`. |
| 4 | Guest users and RLS | Guests have no Supabase auth identity (no `auth.uid()`). All guest operations go through the backend service-role client which bypasses RLS. Guests cannot access PostgREST directly (they have no Supabase JWT, only guest tokens). |
| 5 | Service role key exposed | If `SUPABASE_SERVICE_ROLE_KEY` leaks, an attacker can bypass RLS. Mitigation: key is server-side only, never sent to client, never committed to git. |
| 6 | Migration applied to non-empty DB | `CREATE TABLE IF NOT EXISTS` is idempotent. For column renames (camelCase to snake_case), a one-time data migration script is provided (section 6). |
| 7 | `supabase.rpc` call for `increment_player_stats` fails | Error propagated from `SupabaseDB.incrementStats`. `StatsService` already has fire-and-forget semantics (logs error, does not crash the game flow). |
| 8 | Missing env vars at startup | `SupabaseDB.initialize()` throws immediately with a descriptive message (names which var is missing). Server fails to start — no silent fallback. |
| 9 | PostgREST returns unexpected error code | `saveGame` distinguishes `PGRST116` (zero rows matched = optimistic lock) from other errors. Unknown errors are re-thrown as generic `Error` with the Supabase error message. |

---

## 9. Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| `@supabase/supabase-js` | Add to backend | Replaces TypeORM for DB access |
| `@supabase/supabase-js` | Keep in frontend | Still used for auth (unchanged) |
| `typeorm` | Remove from backend | No longer used |
| `reflect-metadata` | Remove from backend | Only needed for TypeORM decorators |
| `jsonwebtoken` | Keep | Still used by `authMiddleware.ts` for JWT verification |
| Supabase CLI | External tool | Required for `supabase db push` (migrations) and local dev |
| Existing `authMiddleware.ts` | Keep as-is | JWT verification logic unchanged (tokens are still Supabase JWTs) |
| Existing `GameCache` | Keep as-is | In-memory cache unchanged; it calls repository interfaces |
| Existing `GameService`, `StatsService`, `FeedbackService` | Keep as-is | They depend on repository interfaces, not implementations |
| Existing `authService.ts` (frontend) | Keep as-is | Continues to use `@supabase/supabase-js` directly for auth |

---

## 10. Test Requirements

### Unit tests

| # | Test | What it verifies |
|---|------|------------------|
| 1 | `SupabaseDB.mapGame` correctly maps snake_case row to Game instance | Column name translation |
| 2 | `SupabaseDB.mapPlayerStats` correctly maps row to PlayerStats | Column name translation |
| 3 | `SupabaseDB.mapFeedback` correctly maps row to Feedback | Column name translation |
| 4 | `SupabaseDB.saveGame` throws `OptimisticLockError` when Supabase returns PGRST116 | Locking semantics |
| 5 | `SupabaseDB.initialize()` throws when `SUPABASE_URL` is missing | Env validation |
| 6 | `SupabaseDB.initialize()` throws when `SUPABASE_SERVICE_ROLE_KEY` is missing | Env validation |
| 7 | `OptimisticLockError` has status 409 and correct message format | Error class contract |

Test approach for SupabaseDB: mock the Supabase client (`from().select()` etc.) to return controlled data. Verify mappers produce correct domain objects.

### Integration tests

| # | Test | What it verifies |
|---|------|------------------|
| 1 | Create game via API, verify it persists in Supabase | Full CRUD via SDK |
| 2 | Save game with stale version, verify `OptimisticLockError` | Locking via Supabase |
| 3 | `incrementStats` creates row on first call, increments on second | Atomic upsert via RPC |
| 4 | RLS: authenticated user can only SELECT their own games via direct PostgREST | RLS policy enforcement |
| 5 | RLS: authenticated user cannot UPDATE games via direct PostgREST | RLS blocks mutation |
| 6 | RLS: authenticated user cannot read other users' stats via direct PostgREST | RLS data isolation |
| 7 | Full game flow: create game, join, play actions, verify stats recorded | End-to-end via existing auth |

Test approach: integration tests run against local Supabase (`supabase start`). For RLS tests, create a user-scoped Supabase client (with the user's JWT as auth) and verify PostgREST access is correctly restricted.

### Security tests

| # | Test | What it verifies |
|---|------|------------------|
| 1 | Anon key + PostgREST cannot INSERT into games | RLS blocks unauthenticated writes |
| 2 | Authenticated user cannot call `increment_player_stats` RPC directly | Function restricted to service_role |
| 3 | Authenticated user cannot UPDATE another user's game | RLS policy enforcement |

---

## 11. Notes

### Feedback script access

With this architecture, a CLI tool (e.g., a script that fetches feedback) works as follows:
1. The Supabase URL and anon key are public (in the frontend bundle).
2. The script signs in as an admin user using `supabase.auth.signInWithPassword(email, password)` to get a JWT.
3. The script calls `GET /api/feedback` on the backend with the JWT in the `Authorization` header.
4. The backend's `authMiddleware` verifies the JWT and the `FeedbackHandler` (admin-only GET) returns results.

No special backend routes are needed. The existing auth flow works for programmatic access.

---

## 12. Acceptance Criteria

1. `typeorm` and `reflect-metadata` are removed from `package.json` and no imports reference them
2. `@supabase/supabase-js` remains in frontend `package.json` (auth — unchanged)
3. `@supabase/supabase-js` is present in backend `package.json`
4. All three repository interfaces are implemented by `SupabaseDB` using the Supabase JS SDK
5. `SupabaseDB.initialize()` validates env vars and throws on missing values
6. `server.ts` calls `SupabaseDB.INSTANCE.initialize()` synchronously (no await)
7. RLS is enabled on `games`, `player_stats`, and `feedback` tables
8. Direct PostgREST access (with anon key) is properly restricted by RLS policies
9. Optimistic locking continues to work (stale version produces `OptimisticLockError` with status 409)
10. `OptimisticLockError` lives in `src/backend/util/errors.ts` alongside other error classes
11. All existing integration tests pass with the new implementation
12. `npm run build` succeeds with zero errors
13. `supabase db push` applies migrations without error
14. Frontend auth flow is completely unchanged (same `authService.ts`, same Supabase client)
15. Game flow (create, join, play, stats) works end-to-end
