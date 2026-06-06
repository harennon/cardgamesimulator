# LLD 1: Supabase Migration

Replace custom authentication and standalone PostgreSQL with Supabase (auth + managed Postgres). After this migration, the frontend talks directly to Supabase for sign-up/sign-in, and the Express backend verifies Supabase-issued JWTs on incoming requests.

---

## 1. Overview

Delete the entire custom auth system (nonce flow, argon2 hashing, custom JWT signing, crypto utilities) and replace it with:

- Frontend: Supabase JS SDK for `signUp`, `signInWithPassword`, `getSession`, `signOut`
- Backend: Middleware that verifies Supabase-issued JWTs (RS256, using Supabase's JWKS)
- Database: TypeORM connecting to Supabase's Postgres instance (same wire protocol, different host)

---

## 2. Scope

### In scope

- Delete all custom auth code (files listed in section 4)
- Integrate `@supabase/supabase-js` in the frontend for auth operations
- New backend JWT verification middleware using `@supabase/supabase-js` server-side or `jsonwebtoken` with Supabase's JWT secret
- Redesign the `Game` entity for the post-migration schema (UUID PK, JSONB state, version column, timestamps)
- Add `PlayerStats` entity
- Redesign the `Database` interface to remove auth methods and add game/stats repository methods
- Local development setup with `supabase init` and `supabase start`
- Environment configuration for local and production
- Update `docker-compose.yml` to remove standalone Postgres (Supabase local stack provides it)
- Remove packages: `argon2`, `crypto-js`, `@types/crypto-js`

### Out of scope

- Socket.IO integration (LLD 3)
- Game engine interface (LLD 2)
- Guest access flow (LLD 5 — depends on this LLD's auth model)
- Socket.IO as SSE replacement (LLD 3). Note: the SSE files (`event.ts`, `subscribers.ts`, frontend `sse.ts`) are deleted in this LLD because they depend on the removed auth code and would not compile. LLD 3's scope description of "remove old SSE" is pre-fulfilled here.
- Frontend UI components (login/signup form redesign is in scope; game UI is not)

---

## 3. Design

### 3.1 Auth Flow (Post-Migration)

```
Browser                      Supabase                    Express Server
  │                             │                             │
  │── signUp/signIn ───────────►│                             │
  │◄── JWT (access_token) ──────│                             │
  │                             │                             │
  │── REST request + Bearer JWT ──────────────────────────────►│
  │                             │                             │── verify JWT
  │                             │                             │── extract user_id
  │◄── response ──────────────────────────────────────────────│
```

Key decisions:

- The frontend manages the full auth lifecycle (sign-up, sign-in, token refresh, sign-out) using `@supabase/supabase-js`
- The backend NEVER proxies auth requests — it only verifies incoming JWTs
- Supabase JWTs are signed with the project's JWT secret (HS256 for local, configurable for cloud)
- The backend verifies using the `SUPABASE_JWT_SECRET` directly (simpler than JWKS for a monolith)
- **Display names** are stored in Supabase `user_metadata` (set at signup via `options.data`). The JWT includes `user_metadata.display_name`, so the backend extracts it without an extra DB query. No separate `profiles` table needed. Fallback: email address if display name is not set.

### 3.2 Backend JWT Verification Middleware

```typescript
// src/backend/middleware/authMiddleware.ts

import jwt from "jsonwebtoken";
import { Request, Response, Next } from "@/util/types";
import { UnauthorizedError } from "@/util/errors";

// Fail fast at module load (server startup) — not on first request.
const jwtSecret = process.env.SUPABASE_JWT_SECRET;
if (!jwtSecret) {
  throw new Error("SUPABASE_JWT_SECRET is required");
}

export interface SupabaseJWTPayload {
  sub: string; // user UUID (from auth.users)
  email: string;
  role: string; // 'authenticated' or 'anon'
  aud: string; // 'authenticated'
  iat: number;
  exp: number;
  user_metadata: {
    display_name?: string;
  };
}

export function authMiddleware(req: Request, _res: Response, next: Next): void {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : undefined;

  if (!token) {
    throw new UnauthorizedError();
  }

  try {
    const decoded = jwt.verify(token, jwtSecret, {
      algorithms: ["HS256"],
    }) as SupabaseJWTPayload;

    if (decoded.role !== "authenticated") {
      throw new UnauthorizedError();
    }

    req.userId = decoded.sub;
    req.displayName = decoded.user_metadata?.display_name ?? decoded.email;
    next();
  } catch {
    throw new UnauthorizedError();
  }
}
```

Changes to `Request` type:

```typescript
// src/backend/util/types.ts
export type Request<ReqBody = any> = ExpressRequest<any, any, ReqBody> & {
  userId?: string; // Supabase user UUID (from JWT sub claim)
  displayName?: string; // from JWT user_metadata.display_name, falls back to email
};
```

### 3.3 Frontend Auth Service

```typescript
// src/frontend/service/authService.ts

import { createClient, SupabaseClient, Session } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient = createClient(
  supabaseUrl,
  supabaseAnonKey,
);

export async function signUp(
  email: string,
  password: string,
  displayName: string,
): Promise<Session> {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName } },
  });
  if (error) throw error;
  if (!data.session)
    throw new Error("Sign-up succeeded but no session returned");
  return data.session;
}

export async function signIn(
  email: string,
  password: string,
): Promise<Session> {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  if (!data.session)
    throw new Error("Sign-in succeeded but no session returned");
  return data.session;
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
```

The frontend must attach the access token to every REST request to Express:

```typescript
// src/frontend/main.ts (axios interceptor)
import axios from "axios";
import { getAccessToken } from "@/service/authService";

export const axiosInstance = axios.create({ baseURL: "/api" });

axiosInstance.interceptors.request.use(async (config) => {
  const token = await getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});
```

### 3.4 Database Schema

#### `games` table (TypeORM entity)

```typescript
// src/backend/database/entities/Game.ts

import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
} from "typeorm";

export type GameType = "big2" | "tonk";
export type GameStatus = "CREATED" | "IN_PROGRESS" | "COMPLETED";

@Entity("games")
export class Game {
  @PrimaryColumn({ type: "uuid" })
  gameId: string = "";

  @Column({ type: "varchar", length: 50 })
  gameType: GameType = "big2";

  @Column({ type: "uuid", array: true, default: "{}" })
  playerIds: string[] = [];

  @Column({ type: "int" })
  maxPlayers: number = 4;

  @Column({ type: "varchar", length: 20 })
  status: GameStatus = "CREATED";

  @Column({ type: "jsonb", default: "{}" })
  state: Record<string, unknown> = {};

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date = new Date();

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date = new Date();

  @VersionColumn()
  version: number = 1;
}
```

Schema notes:

- `playerIds` uses a UUID array (not a join table) since max players is 4 and we always load all players for a game. This is simpler and avoids unnecessary joins.
- `state` is JSONB for flexibility — game engine defines the shape, DB treats it as opaque.
- `version` column provides optimistic locking (TypeORM's `@VersionColumn` auto-increments and throws on stale writes).
- Removed `PAUSED` status — not needed per the HLD (games are CREATED, IN_PROGRESS, or COMPLETED).

#### `player_stats` table (TypeORM entity)

```typescript
// src/backend/database/entities/PlayerStats.ts

import { Entity, PrimaryColumn, Column, UpdateDateColumn } from "typeorm";

@Entity("player_stats")
export class PlayerStats {
  @PrimaryColumn({ type: "uuid" })
  userId: string = ""; // References Supabase auth.users.id (no FK — different schema)

  @Column({ type: "int", default: 0 })
  gamesPlayed: number = 0;

  @Column({ type: "int", default: 0 })
  gamesWon: number = 0;

  @Column({ type: "int", default: 0 })
  gamesLost: number = 0;

  @Column({ type: "int", default: 0 })
  totalScore: number = 0;

  @UpdateDateColumn({ type: "timestamptz" })
  lastPlayedAt: Date = new Date();
}
```

Schema notes:

- No foreign key to `auth.users` — Supabase auth lives in a separate Postgres schema (`auth`). TypeORM manages the `public` schema. The application enforces referential integrity.
- `userId` is the Supabase `auth.users.id` UUID.
- Stats are updated atomically on game completion (LLD 7 handles the trigger logic; this LLD defines the table).

#### SQL Migration (for reference — TypeORM `synchronize: true` handles this in dev)

```sql
CREATE TABLE games (
  "gameId" UUID PRIMARY KEY,
  "gameType" VARCHAR(50) NOT NULL,
  "playerIds" UUID[] NOT NULL DEFAULT '{}',
  "maxPlayers" INT NOT NULL DEFAULT 4,
  status VARCHAR(20) NOT NULL DEFAULT 'CREATED',
  state JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INT NOT NULL DEFAULT 1
);

CREATE TABLE player_stats (
  "userId" UUID PRIMARY KEY,
  "gamesPlayed" INT NOT NULL DEFAULT 0,
  "gamesWon" INT NOT NULL DEFAULT 0,
  "gamesLost" INT NOT NULL DEFAULT 0,
  "totalScore" INT NOT NULL DEFAULT 0,
  "lastPlayedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 3.5 Database Interface (Redesigned)

```typescript
// src/backend/database/database.ts

import { Game } from "@/database/entities/Game";
import { PlayerStats } from "@/database/entities/PlayerStats";
import { GameType } from "@/database/entities/Game";

export interface GameRepository {
  createGame(
    gameId: string,
    gameType: GameType,
    creatorId: string,
    maxPlayers: number,
  ): Promise<Game>;
  getGame(gameId: string): Promise<Game | null>;
  saveGame(game: Game): Promise<Game>; // throws OptimisticLockVersionMismatchError on version conflict
}
// Note: `createGame` takes gameId as a parameter (caller generates UUID via `crypto.randomUUID()`).
// This allows the REST handler to generate the ID and use it for in-memory cache registration (LLD 2) in the same call.

export interface PlayerStatsRepository {
  getStats(userId: string): Promise<PlayerStats | null>;
  upsertStats(stats: PlayerStats): Promise<PlayerStats>;
}
```

**Injection pattern:** Handlers import the interfaces from `database.ts` and obtain instances via module-level exports:

```typescript
// src/backend/database/index.ts (barrel — the only import path for consumers)

import { PostgresDB } from "./postgres";
import { GameRepository, PlayerStatsRepository } from "./database";

export type { GameRepository, PlayerStatsRepository };
export const gameRepo: GameRepository = PostgresDB.INSTANCE;
export const statsRepo: PlayerStatsRepository = PostgresDB.INSTANCE;
```

Handlers import `gameRepo` / `statsRepo` from `@/database` — never `PostgresDB` directly. This means swapping to an in-memory implementation for tests (or a different DB) requires changing only `index.ts`.

The concrete implementation continues to use TypeORM with the `PostgresDB` class, but auth methods (`saveNonce`, `getAndRemoveNonce`, `createAccount`, `getAccount`, `getAccountById`, `getAccountsByIds`) are deleted entirely.

### 3.6 Database Connection (Post-Migration)

```typescript
// src/backend/database/postgres.ts

import { DataSource } from "typeorm";
import { Game } from "@/database/entities/Game";
import { PlayerStats } from "@/database/entities/PlayerStats";

export class PostgresDB implements GameRepository, PlayerStatsRepository {
  public static readonly INSTANCE = new PostgresDB();
  private dataSource: DataSource | undefined;

  public async initialize(): Promise<void> {
    if (this.dataSource) throw new Error("Database already initialized");

    this.dataSource = await new DataSource({
      type: "postgres",
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT || "54322"),
      username: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "postgres",
      database: process.env.DB_NAME || "postgres",
      entities: [Game, PlayerStats],
      synchronize: process.env.NODE_ENV !== "production",
      logging: process.env.NODE_ENV !== "production" ? "all" : ["error"],
    }).initialize();
  }

  // ... repository method implementations
}
```

Connection notes:

- Supabase local exposes Postgres on port `54322` (not `5432`).
- In production, `DB_HOST` points to the Supabase project's Postgres connection string.
- `synchronize: true` only in development. Production uses migrations.
- Subscribers for nonce expiration (`ExpireOldNonceLookupSubscriber`) and SSE game broadcast (`GameSubscriber`) are removed. The SSE game broadcast is temporary — it will be replaced by Socket.IO in LLD 3. For the interim, the game endpoints will not broadcast via SSE (this is acceptable since the lobby/game flow doesn't function end-to-end yet anyway).

### 3.7 Shared Model Cleanup

Remove from `src/shared/model.ts`:

- `GetNonceRequest`, `GetNonceResponse`
- `CreateAccountRequest`, `CreateAccountResponse`
- `GetAuthTokenRequest`, `GetAuthTokenResponse`
- `BatchGetUsernameRequest`, `BatchGetUsernameResponse`
- `Account`, `AccountFailure`, `AccountPayload`

Keep and update:

- `GameType`, `GameStatus` (remove `PAUSED`)
- `CreateGameRequest`, `CreateGameResponse`
- `JoinGameRequest`, `JoinGameResponse`
- `GetGameStateRequest`, `GetGameStateResponse`
- `SerializableGame`, `SerializableGameState`

Updates:

- `GetGameStateRequest`: `accountId` → `userId`
- `SerializableGame.accountIds` → `playerIds`
- `CreateGameRequest.numPlayers` → `maxPlayers` (for consistency with the Game entity)
- All `accountId` references in request/response types → `userId`

---

## 4. File Changes

### Files to DELETE

| File                                       | Reason                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `src/backend/api/auth/getNonce.ts`         | Nonce flow eliminated                                                                     |
| `src/backend/api/auth/createAccount.ts`    | Supabase handles account creation                                                         |
| `src/backend/api/auth/getAuthToken.ts`     | Supabase handles sign-in                                                                  |
| `src/backend/api/auth/batchGetUsername.ts` | No longer needed — user info comes from Supabase                                          |
| `src/backend/service/authNService.ts`      | Custom JWT signing/verification eliminated                                                |
| `src/backend/middleware/authNHandler.ts`   | Replaced by new `authMiddleware.ts`                                                       |
| `src/shared/crypto.ts`                     | AES encrypt/decrypt only used by nonce auth flow                                          |
| `src/frontend/service/authNService.ts`     | Replaced by new `authService.ts`                                                          |
| `src/frontend/util/cookie.ts`              | JWT cookie management no longer needed (Supabase SDK manages tokens)                      |
| `src/frontend/util/sse.ts`                 | SSE utility (will be replaced by Socket.IO in LLD 3; safe to remove now)                  |
| `src/backend/api/event.ts`                 | SSE handler (replaced by Socket.IO in LLD 3; remove now since it depends on deleted auth) |
| `src/backend/database/subscribers.ts`      | Both subscribers reference deleted entities/systems                                       |

### Files to CREATE

| File                                           | Purpose                                                      |
| ---------------------------------------------- | ------------------------------------------------------------ |
| `src/backend/middleware/authMiddleware.ts`     | Supabase JWT verification middleware                         |
| `src/frontend/service/authService.ts`          | Supabase SDK wrapper for auth operations                     |
| `src/backend/database/entities/Game.ts`        | Redesigned Game entity                                       |
| `src/backend/database/entities/PlayerStats.ts` | New PlayerStats entity                                       |
| `supabase/config.toml`                         | Supabase local project config (generated by `supabase init`) |
| `supabase/seed.sql`                            | Seed data for local development                              |
| `.env.local`                                   | Local development env vars                                   |
| `.env.example`                                 | Template with all required vars documented                   |

### Files to MODIFY

| File                                   | Changes                                                                                                                                                                                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/backend/server.ts`                | Remove auth route registrations (`/auth/*`), remove `/event` SSE route, remove `/authNedEcho` (test route — no longer needed), replace `authNHandler` with new `authMiddleware` on game routes, remove `cookieParser` middleware, remove deleted imports              |
| `src/backend/database/postgres.ts`     | Remove auth methods, update entity list, update connection config                                                                                                                                                                                                     |
| `src/backend/database/database.ts`     | Replace interface with `GameRepository` + `PlayerStatsRepository`                                                                                                                                                                                                     |
| `src/backend/database/entities.ts`     | Delete file contents (entities moved to individual files in `entities/` dir)                                                                                                                                                                                          |
| `src/backend/util/types.ts`            | Rename `accountId` to `userId` on Request type                                                                                                                                                                                                                        |
| `src/backend/api/game/createGame.ts`   | Use `req.userId` instead of `req.accountId`                                                                                                                                                                                                                           |
| `src/backend/api/game/joinGame.ts`     | Use `req.userId` instead of `req.accountId`                                                                                                                                                                                                                           |
| `src/backend/api/game/getGameState.ts` | Use `req.userId` instead of `req.accountId`                                                                                                                                                                                                                           |
| `src/shared/model.ts`                  | Remove auth-related interfaces, update game interfaces                                                                                                                                                                                                                |
| `src/frontend/main.ts`                 | Replace axios auth setup with Supabase interceptor                                                                                                                                                                                                                    |
| `package.json`                         | Add `@supabase/supabase-js`. Remove `argon2`, `crypto-js`, `@types/crypto-js`. Keep `jsonwebtoken`, `@types/jsonwebtoken` (backend JWT verification), `uuid` (game ID generation), `cookie-parser` (remove — no longer needed since new auth uses Bearer tokens only) |
| `docker-compose.yml`                   | Remove standalone `database` service (Supabase local stack replaces it)                                                                                                                                                                                               |
| `.gitignore`                           | Add `supabase/.temp/`, `.env.local`                                                                                                                                                                                                                                   |

---

## 5. Environment & Configuration

### `.env.local` (local development)

```env
# Supabase (local — values from `supabase status`)
SUPABASE_URL=http://localhost:54321
SUPABASE_ANON_KEY=<from supabase status>
SUPABASE_SERVICE_ROLE_KEY=<from supabase status>
SUPABASE_JWT_SECRET=<from supabase status>

# Database (Supabase local Postgres)
DB_HOST=localhost
DB_PORT=54322
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=postgres

# Express
BACKEND_PORT=3000
NODE_ENV=development

# Frontend (Vite — must be prefixed with VITE_)
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=<from supabase status>
VITE_API_BASE_URL=http://localhost:3000
```

### `.env.production` (cloud deployment)

```env
# Supabase (cloud project)
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<from Supabase dashboard>
SUPABASE_SERVICE_ROLE_KEY=<from Supabase dashboard>
SUPABASE_JWT_SECRET=<from Supabase dashboard → Settings → API → JWT Secret>

# Database (Supabase cloud Postgres)
DB_HOST=db.<project-ref>.supabase.co
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=<from Supabase dashboard>
DB_NAME=postgres

# Express
BACKEND_PORT=3000
NODE_ENV=production

# Frontend (baked into build)
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<from Supabase dashboard>
VITE_API_BASE_URL=<production server URL>
```

### Key differences between local and production

| Concern      | Local                             | Production                             |
| ------------ | --------------------------------- | -------------------------------------- |
| Supabase URL | `http://localhost:54321`          | `https://<ref>.supabase.co`            |
| DB port      | `54322`                           | `5432`                                 |
| JWT secret   | Deterministic (from local config) | Random (from dashboard)                |
| TypeORM sync | `synchronize: true`               | `synchronize: false` (migrations only) |
| Logging      | `'all'`                           | `['error']`                            |

---

## 6. Local Development Setup

### One-time setup

```bash
# 1. Install Supabase CLI (if not installed)
npm install -g supabase

# 2. Initialize Supabase in project root
supabase init

# 3. Start Supabase local stack (runs Postgres, Auth, Studio in Docker)
supabase start

# 4. Copy output values into .env.local
#    - API URL:    http://localhost:54321
#    - anon key:   eyJ...
#    - service_role key: eyJ...
#    - JWT secret: super-secret-jwt-token-...
#    - DB URL:     postgresql://postgres:postgres@localhost:54322/postgres

# 5. Install npm dependencies
npm install

# 6. Run Express server (reads .env.local)
npm run dev
```

### `supabase/config.toml` customizations

```toml
[api]
port = 54321

[db]
port = 54322

[auth]
site_url = "http://localhost:5173"
additional_redirect_urls = ["http://localhost:3000"]

[auth.email]
enable_signup = true
enable_confirmations = false  # Skip email confirmation for local dev
```

### Seed script (`supabase/seed.sql`)

```sql
-- Create a test user in auth.users for local development
-- (Supabase local auth allows this via the dashboard at localhost:54323)
-- No manual seed needed for auth — use Supabase Studio or the SDK.

-- Seed player_stats for a known test user (optional)
-- INSERT INTO player_stats ("userId", "gamesPlayed", "gamesWon", "gamesLost", "totalScore")
-- VALUES ('00000000-0000-0000-0000-000000000001', 5, 3, 2, 42);
```

### Docker Compose changes

The standalone `database` service is removed. Supabase local stack (started via `supabase start`) provides Postgres. The `docker-compose.yml` retains only the Express backend and nginx frontend for deployment, with DB connection pointing to the Supabase-managed Postgres.

For local development, `supabase start` + `npm run dev` is the preferred workflow (not Docker Compose). Docker Compose is used for production-like testing only.

Updated `docker-compose.yml`:

```yaml
services:
  frontend:
    image: nginx-frontend
    build:
      context: .
      dockerfile: ./src/frontend/Dockerfile
    depends_on:
      - backend
    ports:
      - "80:80"
    networks:
      - app

  backend:
    image: express-backend
    env_file:
      - .env.local
    build:
      context: .
      dockerfile: ./src/backend/Dockerfile
    ports:
      - "3000:3000"
    networks:
      - app
    # Note: backend connects to Supabase Postgres via DB_HOST env var
    # For local: host.docker.internal or the Supabase container network

networks:
  app:
```

---

## 7. Migration Steps (Implementation Order)

Execute in this sequence. Each step should result in a buildable (if not fully functional) project.

### Step 1: Install dependencies and init Supabase

- `npm install @supabase/supabase-js`
- `npm uninstall argon2 crypto-js @types/crypto-js`
- `supabase init` in project root
- Configure `supabase/config.toml` (disable email confirmation for local)
- Create `.env.local` and `.env.example`
- Update `.gitignore`

### Step 2: Create new database entities

- Create `src/backend/database/entities/` directory
- Create `Game.ts` with redesigned schema (UUID, JSONB, version, timestamps)
- Create `PlayerStats.ts`
- Delete old `src/backend/database/entities.ts`

### Step 3: Rewrite database layer

- Rewrite `src/backend/database/database.ts` with `GameRepository` + `PlayerStatsRepository` interfaces
- Rewrite `src/backend/database/postgres.ts`: remove all auth methods, update entity list, update connection config
- Delete `src/backend/database/subscribers.ts`

### Step 4: Create new auth middleware

- Create `src/backend/middleware/authMiddleware.ts` (Supabase JWT verification)
- Delete `src/backend/middleware/authNHandler.ts`
- Update `src/backend/util/types.ts` (rename `accountId` to `userId`)

### Step 5: Delete backend auth code

- Delete `src/backend/api/auth/` directory (all 4 files)
- Delete `src/backend/service/authNService.ts`

### Step 6: Update server routing

- Update `src/backend/server.ts`: remove auth routes, import new `authMiddleware`, remove SSE/event route, remove deleted imports
- Update game handlers (`createGame.ts`, `joinGame.ts`, `getGameState.ts`) to use `req.userId`

### Step 7: Update shared models

- Clean `src/shared/model.ts`: remove auth interfaces, update game interfaces (`accountIds` to `playerIds`)
- Delete `src/shared/crypto.ts`

### Step 8: Create frontend auth service

- Create `src/frontend/service/authService.ts` (Supabase SDK wrapper)
- Delete `src/frontend/service/authNService.ts`
- Delete `src/frontend/util/cookie.ts`
- Delete `src/frontend/util/sse.ts`
- Update `src/frontend/main.ts` with axios interceptor for Supabase tokens

### Step 9: Update package.json and docker-compose

- Verify `package.json` dependency changes
- Update `docker-compose.yml` (remove `database` service)

### Step 10: Verify build

- Run `npm run build` — ensure zero TypeScript errors
- Run `supabase start` + `npm run start:backend` — verify Express connects to Supabase Postgres
- Test sign-up/sign-in via Supabase Studio (localhost:54323) and verify JWT verification works

---

## 8. Testing Strategy

### Unit tests

| What                                    | How                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| Auth middleware rejects missing token   | Call `authMiddleware` with no Authorization header, assert `UnauthorizedError` thrown |
| Auth middleware rejects invalid token   | Call with malformed/expired JWT, assert `UnauthorizedError`                           |
| Auth middleware rejects anon role       | Call with valid JWT but `role: 'anon'`, assert `UnauthorizedError`                    |
| Auth middleware extracts userId         | Call with valid JWT, assert `req.userId` equals JWT `sub` claim                       |
| Auth middleware rejects wrong algorithm | Sign JWT with RS256, verify middleware (expecting HS256) rejects it                   |

Test approach: construct JWTs manually using the known local Supabase JWT secret. No network calls needed.

### Integration tests

| What                               | How                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Database: create and retrieve game | Initialize TypeORM against local Supabase Postgres, create a game, retrieve by ID, assert fields match                |
| Database: optimistic locking       | Load a game, modify in two parallel transactions, assert one throws on version conflict                               |
| Database: upsert player stats      | Create stats, update them, verify idempotent upsert behavior                                                          |
| Full auth flow                     | Use Supabase JS SDK to sign up a user, extract token, send request to Express with Bearer header, verify 200 response |

Integration tests require `supabase start` running. Use a `beforeAll` / `afterAll` that verifies connectivity.

### What NOT to test

- Supabase SDK itself (library responsibility)
- That TypeORM generates correct SQL (ORM responsibility)
- Frontend Supabase auth calls (SDK handles these; test at integration level if needed)

---

## 9. Acceptance Criteria

The migration is complete when:

1. `npm run build` succeeds with zero errors and no references to deleted files
2. `supabase start` provides a running local Postgres + Auth instance
3. A user can sign up via the Supabase SDK (tested via Supabase Studio or a simple script)
4. A signed-up user's JWT is accepted by the Express `authMiddleware` and `req.userId` is populated
5. An invalid/missing JWT is rejected with 401
6. The `games` table exists with the correct schema (UUID PK, JSONB state, version column, timestamps)
7. The `player_stats` table exists with the correct schema
8. Creating and retrieving a game via the REST API works end-to-end (authenticated)
9. None of the deleted files exist in the codebase
10. No references to `argon2`, `crypto-js`, nonce, or the old `AuthNService` exist in source code
11. Environment variables are documented in `.env.example`
12. The old standalone `database` Docker service is removed from `docker-compose.yml`

---

## 10. Edge Cases

| Edge case                                          | Handling                                                                                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase JWT expired                               | Middleware returns 401. Frontend's Supabase SDK auto-refreshes tokens before expiry — if it fails, redirect to login.                                                                    |
| `SUPABASE_JWT_SECRET` not set                      | Server fails to start with clear error message at initialization (fail fast, not on first request).                                                                                      |
| Supabase local not running                         | TypeORM connection fails on `initialize()`. Server logs error and exits.                                                                                                                 |
| User deleted in Supabase but JWT still valid       | JWT verification succeeds (stateless). Game logic continues. On next token refresh, Supabase rejects — user is effectively signed out. Acceptable for turn-based games (short sessions). |
| Version conflict on game save (optimistic locking) | TypeORM throws `OptimisticLockVersionMismatchError`. Caller retries with fresh state. Game handlers must handle this (retry once, then 409 to client).                                   |
| Production DB with `synchronize: true`             | Prevented by `NODE_ENV` check. Only `synchronize: false` in production.                                                                                                                  |
| Multiple browser tabs                              | Supabase SDK shares session via `localStorage`. All tabs use the same token. No special handling needed.                                                                                 |

---

## 11. Dependencies

| Dependency              | Status            | Notes                                                               |
| ----------------------- | ----------------- | ------------------------------------------------------------------- |
| Supabase CLI            | External tool     | Must be installed globally (`npm install -g supabase`)              |
| Docker                  | Existing          | Required for `supabase start` (local stack runs in Docker)          |
| `@supabase/supabase-js` | npm package       | Add to `dependencies`                                               |
| `jsonwebtoken`          | Already installed | Keep — used by backend middleware for JWT verification              |
| TypeORM                 | Already installed | Continues to manage the public schema                               |
| LLD 3 (WebSocket)       | Future            | Will add Socket.IO auth that reuses the same JWT verification logic |
| LLD 5 (Guest Access)    | Future            | Will extend `authMiddleware` to also accept guest tokens            |
