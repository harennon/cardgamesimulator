# LLD 5: Guest Access

Enable unauthenticated users to join and play games via invite link. After this LLD, a user can click an invite link, enter a display name, and join a game with zero signup. Guests are first-class players during gameplay — indistinguishable from registered users. The only differences are post-game persistence and inability to create games.

---

## 1. Scope

### In scope

- Guest identity model (server-generated session token, display name, no Supabase account)
- Guest session storage (in-memory Map on server, cookie-based persistence on client)
- Dual-path auth: accept guest tokens alongside Supabase JWTs in both REST and WebSocket middleware
- Guest entry screen (display name prompt when unauthenticated user lands on `/game/:gameId`)
- REST endpoint for guest session creation (`POST /guest/session`)
- Guest limitations enforcement (cannot create games, no persistent stats)
- Guest-to-registered conversion flow (link guest game results to new account)
- Guest session cleanup (expiry after game completes + inactivity timeout)

### Out of scope

- Frontend game UI components (LLD 6)
- Turn timer and auto-pass (LLD 7)
- Spectating UX for guests arriving at in-progress games (LLD 8 — though guests can spectate, the full spectator UX is designed there)
- Persistent guest sessions across multiple games (guests are per-game)
- Guest rate limiting or abuse prevention (defer until needed)

---

## 2. Approach

### Key decisions

1. **Guest token format: HMAC-signed opaque tokens (not JWTs).**

   Guest tokens are `base64url(guestId + "." + gameId + "." + expiresAt + "." + hmac)`. The server signs them using the same `SUPABASE_JWT_SECRET` (as HMAC key). This avoids the overhead of full JWT libraries while providing tamper-proof verification. The token encodes: which guest, for which game, and when it expires. The server verifies by recomputing the HMAC.

   *Rationale:* JWTs are overkill for short-lived, server-verified tokens. The server already has the session in memory — the token just proves "I am guest X for game Y." Using HMAC-SHA256 with the existing secret avoids introducing new dependencies or secrets.

   *Alternative considered:* Random UUIDs stored server-side (lookup on every request). Rejected because it requires a Map lookup for validation with no cryptographic proof the client is who they claim. An attacker could guess/brute-force guest IDs. HMAC gives self-verifying tokens that are still validated against the in-memory session for existence.

   **Guest ID format:** Plain UUIDs (e.g., `"a1b2c3d4-e5f6-..."`), NOT prefixed with `"guest_"`. The existing `Game.playerIds` column is typed as PostgreSQL `uuid[]`, which only accepts valid UUID values. Using a prefix would break the database constraint. Guest vs registered is determined by the `isGuest` flag on the request/socket (set during auth) and by querying the `GuestSessionStore`, not by inspecting the ID format.

2. **Dual-path auth middleware (single middleware, two code paths).**

   The auth middleware checks the token prefix: tokens starting with `guest:` are guest tokens, everything else is treated as a Supabase JWT. Both paths produce the same output: `userId` and `displayName` on the request/socket. This means all downstream code (GameService, socket handlers, engine) sees no difference between guest and registered users.

   *Rationale:* A single middleware with two code paths is simpler than two separate middlewares or a middleware chain. The downstream code never needs to know whether it is dealing with a guest.

3. **Guest session storage: in-memory Map with TTL.**

   Guest sessions are stored in a `Map<guestId, GuestSession>` on the server. No database table. Sessions are created on `POST /guest/session` and cleaned up after the associated game completes + a grace period (30 minutes), or after 4 hours of inactivity (covering the case where a game is never started).

   *Rationale:* Guests are ephemeral by design. Adding a database table for guest sessions adds complexity (migrations, queries, cleanup jobs) for data that is intentionally discarded. The in-memory approach aligns with Architecture Principle 5 (In-Memory Cache) and Principle 10 (Deploy Cheap). If the server restarts, guest sessions are lost — this is acceptable because guests losing their session on server restart is equivalent to the "guest closes browser" edge case (seat opens up or auto-pass).

   *Tradeoff:* If we ever need horizontal scaling (multiple servers), guest sessions would need shared state (Redis). Per Principle 6, we defer this until it is needed.

4. **Client-side persistence: httpOnly cookie containing the guest token.**

   When the guest session is created, the server sets an `httpOnly`, `SameSite=Strict` cookie named `guest_token`. The frontend reads its existence (not its value) via a non-httpOnly companion cookie `guest_session=1` to know it is in guest mode. On page refresh, the browser automatically sends the cookie, allowing the backend to re-identify the guest.

   *Alternative considered:* localStorage. Rejected because localStorage tokens can be stolen via XSS. httpOnly cookies are automatically sent and cannot be read by JavaScript, providing better security for a session that grants game access.

   *Frontend WebSocket auth:* Socket.IO does not automatically send cookies in the handshake auth payload. The frontend must extract the guest token from the cookie and pass it as `auth.token`.

   *Approach:* Use a regular cookie (`guest_token`, `SameSite=Strict`, `Secure` in production, `Path=/`) that the frontend JavaScript can read directly. The threat model for guest tokens is lower than for Supabase JWTs — a guest token grants access to a single game for a few hours. The simplicity of the frontend reading the token directly (for Socket.IO auth and session restoration) outweighs the marginal security benefit of httpOnly for a short-lived, game-scoped token.

   On page refresh, the frontend reads the token from the cookie, decodes the payload client-side (without HMAC verification — the server will verify on use), and restores the guest state. No `GET /guest/session` endpoint is needed — the cookie IS the session proof, and the server validates it on every authenticated request.

5. **Guest-to-registered conversion: claim endpoint.**

   After a guest plays a game, if they sign up, the frontend calls `POST /guest/claim` with the guest token and the new Supabase JWT. The server validates both, and if the guest participated in a completed game, it updates the `Game.playerIds` and `Game.playerDisplayNames` to replace the guest ID with the new Supabase user ID. Future stat calculations (LLD 7) will then include this game in the registered user's history.

   *Rationale:* The conversion is a one-time operation after signup. It does not need to be real-time or handle concurrent claims. The simplest approach is a dedicated endpoint that does the ID swap.

6. **Invite link routing: frontend route guard with guest fork.**

   The `/game/:gameId` route currently has `meta: { requiresAuth: true }`. This LLD changes it to `meta: { requiresAuth: false }` and adds logic in the route guard: if unauthenticated and no guest session, redirect to `/game/:gameId/join` (guest entry screen). If authenticated (Supabase or guest), proceed normally.

7. **Display name uniqueness: per-game check at join time.**

   When a guest picks a display name, the `POST /guest/session` endpoint checks whether any player already in that game has the same display name. If so, it appends a number (e.g., "Alice" -> "Alice2"). This is a best-effort UX improvement, not a hard constraint — the game engine only cares about PlayerId uniqueness, which is guaranteed by UUID generation.

---

## 3. Interfaces / Types

### 3.1 Guest Session Types

```typescript
// src/backend/guest/types.ts

import type { PlayerId } from "@shared/engine-types";

/** Server-side guest session record */
export interface GuestSession {
  readonly guestId: PlayerId; // Plain UUID (compatible with Game.playerIds uuid[] column)
  readonly displayName: string;
  readonly gameId: string; // The game this session is scoped to
  readonly createdAt: number; // Unix timestamp (ms)
  readonly expiresAt: number; // Unix timestamp (ms)
}

/** Request body for POST /guest/session */
export interface CreateGuestSessionRequest {
  displayName: string;
  gameId: string;
}

/** Response body for POST /guest/session */
export interface CreateGuestSessionResponse {
  guestId: string;
  displayName: string; // May differ from request if deduplication applied
  token: string; // Guest token for auth (prefix: "guest:")
  gameId: string;
}

/**
 * Request body for POST /guest/claim.
 *
 * Authorization model:
 * - The `Authorization: Bearer <supabase-jwt>` header authenticates the newly-registered
 *   user. The authMiddleware sets req.userId to their new Supabase user ID.
 * - The `guestToken` in the body identifies which guest session to claim.
 * - The handler (not middleware) reads the body token and performs the ID swap:
 *   replaces guestId with req.userId in Game.playerIds and Game.playerDisplayNames.
 */
export interface ClaimGuestSessionRequest {
  guestToken: string; // The guest token identifying the guest session to claim
}

/** Response body for POST /guest/claim */
export interface ClaimGuestSessionResponse {
  success: boolean;
  gamesLinked: number; // Number of games retroactively linked to the new account
}

```

### 3.2 Guest Session Store

```typescript
// src/backend/guest/guestSessionStore.ts

import type { GuestSession } from "./types";
import type { PlayerId } from "@shared/engine-types";

/**
 * In-memory store for active guest sessions.
 * Sessions are scoped to a single game and auto-expire.
 */
export class GuestSessionStore {
  private readonly sessions: Map<PlayerId, GuestSession> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  /** Create and store a new guest session. Returns the session. */
  create(displayName: string, gameId: string, ttlMs: number): GuestSession;

  /** Get a session by guestId. Returns null if not found or expired. */
  get(guestId: PlayerId): GuestSession | null;

  /** Delete a session (e.g., after conversion or game cleanup). */
  delete(guestId: PlayerId): void;

  /** Get all active guest sessions for a specific game. */
  getByGame(gameId: string): GuestSession[];

  /** Start periodic cleanup of expired sessions (call once at server start). */
  startCleanupLoop(intervalMs?: number): void;

  /** Stop the cleanup loop (for graceful shutdown). */
  stopCleanupLoop(): void;
}
```

### 3.3 Guest Token Utility

```typescript
// src/backend/guest/guestToken.ts

import type { PlayerId } from "@shared/engine-types";

/**
 * Create a guest token: "guest:" + base64url(guestId.gameId.expiresAt.hmac)
 * The "guest:" prefix allows the auth middleware to quickly identify guest tokens.
 */
export function createGuestToken(
  guestId: PlayerId,
  gameId: string,
  expiresAt: number,
  secret: string,
): string;

/**
 * Verify and decode a guest token. Returns null if invalid or expired.
 */
export function verifyGuestToken(
  token: string,
  secret: string,
): { guestId: PlayerId; gameId: string; expiresAt: number } | null;
```

### 3.4 Updated Auth Middleware (Dual-Path)

```typescript
// src/backend/middleware/authMiddleware.ts (modified)

import jwt from "jsonwebtoken";
import { Request, Response, Next } from "@/util/types";
import { UnauthorizedError } from "@/util/errors";
import { verifyGuestToken } from "@/guest/guestToken";
import type { GuestSessionStore } from "@/guest/guestSessionStore";

const jwtSecret = process.env.SUPABASE_JWT_SECRET;
if (!jwtSecret) {
  throw new Error("SUPABASE_JWT_SECRET is required");
}

export interface SupabaseJWTPayload {
  sub: string;
  email: string;
  role: string;
  aud: string;
  iat: number;
  exp: number;
  user_metadata: { display_name?: string };
}

/**
 * Creates the dual-path auth middleware.
 * Takes GuestSessionStore as a parameter (dependency injection for testability).
 *
 * - Tokens prefixed with "guest:" are verified as guest tokens
 * - All other tokens are verified as Supabase JWTs
 *
 * Both paths set req.userId and req.displayName.
 * Adds req.isGuest (boolean) for route-level permission checks.
 */
export function createAuthMiddleware(
  guestSessionStore: GuestSessionStore,
): (req: Request, _res: Response, next: Next) => void;

/**
 * Middleware that only allows registered users (rejects guests).
 * Used on routes like POST /createGame. Throws AccessDeniedError if req.isGuest is true.
 */
export function registeredOnlyMiddleware(
  req: Request,
  _res: Response,
  next: Next,
): void;
```

### 3.5 Updated Socket Auth Middleware

```typescript
// src/backend/websocket/socketAuth.ts (modified)

import jwt from "jsonwebtoken";
import type { TypedSocket } from "./socketServer";
import type { SupabaseJWTPayload } from "@/middleware/authMiddleware";
import { verifyGuestToken } from "@/guest/guestToken";
import type { GuestSessionStore } from "@/guest/guestSessionStore";

const jwtSecret = process.env.SUPABASE_JWT_SECRET;
if (!jwtSecret) {
  throw new Error("SUPABASE_JWT_SECRET is required");
}

/**
 * Creates the dual-path socket auth middleware.
 * Takes GuestSessionStore as a parameter (dependency injection for testability).
 *
 * - Tokens prefixed with "guest:" are verified as guest tokens
 * - All other tokens are verified as Supabase JWTs
 *
 * Both paths set socket.data.userId and socket.data.displayName.
 * Adds socket.data.isGuest (boolean).
 */
export function createSocketAuthMiddleware(
  guestSessionStore: GuestSessionStore,
): (socket: TypedSocket, next: (err?: Error) => void) => void;
```

### 3.6 Updated SocketData

```typescript
// src/backend/websocket/types.ts (modified)

import type { PlayerId } from "@shared/engine-types";

/** Attached to socket.data after successful auth middleware */
export interface SocketData {
  userId: PlayerId;
  displayName: string;
  isGuest: boolean; // true for guest sessions, false for Supabase-authenticated users
}

/** Shape of the auth payload sent in the Socket.IO handshake */
export interface SocketAuthPayload {
  token: string; // Supabase access_token (JWT) OR guest token (prefixed "guest:")
}
```

### 3.7 Updated Request Type

```typescript
// src/backend/util/types.ts (additions)

// Add to the existing Request interface augmentation:
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      displayName?: string;
      isGuest?: boolean; // true for guest sessions
    }
  }
}
```

### 3.8 Frontend Guest Service

```typescript
// src/frontend/service/guestService.ts

import type { CreateGuestSessionResponse } from "@shared/guest-types"; // Shared subset of types

export interface GuestState {
  guestId: string;
  displayName: string;
  token: string;
  gameId: string;
}

/** Create a guest session for a specific game. Stores token in cookie. */
export async function createGuestSession(
  displayName: string,
  gameId: string,
): Promise<GuestState>;

/** Restore guest session from cookie (on page refresh). Decodes token client-side. Returns null if no cookie or expired. */
export function restoreGuestSession(): GuestState | null;

/** Get the current guest token (for Socket.IO auth). Returns null if not a guest. */
export function getGuestToken(): string | null;

/** Clear the guest session (on logout or session expiry). */
export function clearGuestSession(): void;

/** Claim the guest session for a newly registered account. */
export async function claimGuestSession(
  guestToken: string,
): Promise<{ gamesLinked: number }>;
```

### 3.9 Frontend Socket Composable Update

```typescript
// src/frontend/composables/useSocket.ts (modified connect function)

async function connect(): Promise<void> {
  if (socket.value) return;

  // Try Supabase token first, fall back to guest token
  const token = (await getAccessToken()) ?? getGuestToken();
  if (!token) {
    error.value = "Not authenticated";
    return;
  }

  const s = io(import.meta.env.VITE_API_BASE_URL || "", {
    auth: { token },
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  // ... rest unchanged
}
```

---

## 4. State Model

### Guest Session Lifecycle

```
Guest clicks invite link (/game/:gameId)
  │
  ▼
Router guard: no session (no Supabase, no guest cookie)
  │
  ▼
Redirect to /game/:gameId/join (Guest Entry Screen)
  │
  ▼
Guest enters display name, clicks "Join Game"
  │
  ▼
Frontend: POST /guest/session { displayName, gameId }
  │
  ▼
Server: GuestSessionStore.create(displayName, gameId, ttl)
  │── Generates guestId: crypto.randomUUID() (plain UUID — fits Game.playerIds uuid[] column)
  │── Generates token: "guest:" + HMAC-signed payload
  │── Stores session in memory Map
  │── Returns { guestId, displayName, token, gameId }
  │
  ▼
Frontend: stores token in cookie + Vue reactive state
  │
  ▼
Frontend: POST /joinGame { gameId } with Authorization: Bearer guest:...
  │
  ▼
Server: authMiddleware detects "guest:" prefix
  │── verifyGuestToken(token, secret) → { guestId, gameId }
  │── guestSessionStore.get(guestId) → validates session exists
  │── sets req.userId = guestId, req.displayName, req.isGuest = true
  │
  ▼
JoinGameHandler: adds guestId to game.playerIds (same as registered user)
  │
  ▼
Frontend: connect WebSocket with auth: { token: "guest:..." }
  │
  ▼
Server: socketAuthMiddleware (same dual-path logic)
  │── socket.data.userId = guestId
  │── socket.data.displayName = displayName
  │── socket.data.isGuest = true
  │
  ▼
Normal gameplay (indistinguishable from registered user)
```

### Session Expiry and Cleanup

```
Game completes (status → COMPLETED)
  │
  ▼
GuestSessionStore: sessions for this game get 30-minute grace period
  │── Grace period allows guest-to-registered conversion
  │
  ▼
After 30 minutes: sessions deleted from Map, cookies become invalid

OR

No game activity for 4 hours
  │
  ▼
GuestSessionStore cleanup loop: deletes expired sessions
```

### State Ownership

| State                       | Location                        | Lifetime                                         |
| --------------------------- | ------------------------------- | ------------------------------------------------ |
| Guest session               | GuestSessionStore (in-memory)   | Until game completes + 30min, or 4h inactivity   |
| Guest token                 | Client cookie + Vue state       | Until browser closes or cookie expires            |
| Guest in game.playerIds     | Database (Game entity)          | Permanent (or until claimed by registered user)  |
| Guest in ConnectionManager  | In-memory                       | Per-connection lifetime (same as registered)     |
| Guest-to-registered mapping | None (direct ID swap on claim)  | Claim is a one-time DB update                    |

### Page Refresh Flow

```
Guest refreshes page (browser still has guest_token cookie)
  │
  ▼
Router guard: no Supabase session, but cookie exists
  │
  ▼
Frontend: reads guest_token from cookie (regular cookie, JS-readable)
  │── Decodes base64url payload to extract guestId, gameId, expiresAt
  │── Checks expiresAt > now (client-side only; server will re-verify HMAC on use)
  │── If expired → clears cookie, redirects to /game/:gameId/join
  │── If valid → restores GuestState in Vue reactive state
  │
  ▼
Proceeds to /game/:gameId as authenticated guest (no network call needed)
  │
  ▼
WebSocket connects with existing guest token → server validates HMAC + session store → game continues
```

---

## 5. Edge Cases

| Edge case | Handling |
|-----------|----------|
| Guest refreshes page | Cookie preserves guest token. Frontend reads cookie, restores session, reconnects WebSocket. Server validates token against GuestSessionStore. |
| Guest closes browser permanently | Cookie persists, but if they never return, the session expires after 4 hours. The seat in-game is handled by disconnect logic (LLD 8 auto-pass). No guest-specific logic needed — same as registered player disconnect. |
| Guest token expires during gameplay | Token expiry is set to 4 hours. For turn-based games this is more than enough. If it does expire, WebSocket reconnection will fail. The guest must create a new session (they lose their seat). This is acceptable per CX doc: "Guest closes browser → gone permanently." |
| Display name collision within a game | `POST /guest/session` checks existing players in game. If "Alice" exists, tries "Alice2", "Alice3", etc. Returns the adjusted name. Frontend displays the actual name used. |
| Guest tries to create a game | `POST /createGame` uses `registeredOnlyMiddleware` which checks `req.isGuest` and returns 403. Frontend hides the "Create Game" button for guests, but server enforces it. |
| Guest token tampered with | HMAC verification fails in `verifyGuestToken`. Auth middleware returns 401. |
| Guest token valid but session evicted from memory (server restart) | `verifyGuestToken` passes (HMAC valid), but `guestSessionStore.get()` returns null. Auth middleware returns 401. The guest must re-enter their display name. The cookie is cleared. |
| Guest tries to join a game they are not scoped to | Guest token encodes `gameId`. If they try to join a different game, the auth middleware can optionally reject (or we allow it and let the normal joinGame flow handle it). Decision: allow — the guest token proves identity, and joinGame's validation handles "game full" etc. The gameId in the token is for cleanup scoping only. |
| Multiple guests with same browser | Each `POST /guest/session` overwrites the cookie. A browser can only be one guest at a time. If they want to be a guest in two games simultaneously, they need two browser profiles. This is acceptable for the MVP. |
| Guest signs up after game (conversion) | Frontend calls `POST /guest/claim` with guest token in body + Supabase JWT in Authorization header. Server validates both, swaps `guestId` for new `userId` in all relevant `Game.playerIds` and `Game.playerDisplayNames` entries. |
| Guest signs up but game was already cleaned up | `POST /guest/claim` checks if the guest has any game records. If the session is expired and no games found, returns `{ success: true, gamesLinked: 0 }`. Not an error — the conversion still creates the account. |
| Server restart while guests are playing | All guest sessions lost from memory. Active WebSocket connections drop (clients auto-reconnect). On reconnect, guest token HMAC is valid but session is gone. Guest gets 401, must re-create session. If game is IN_PROGRESS, the guest's ID is still in `game.playerIds` — a new guest session with the same guestId would need to be re-created. Solution: `POST /guest/session` accepts optional `existingGuestId` param; if the ID is a valid UUID present in the game's `playerIds`, the server re-creates the session for that ID instead of generating a new one. The frontend knows its old guestId because it can decode it from the cookie token (base64url payload includes guestId). |
| Race condition: two requests with same guest token simultaneously | Guest tokens identify a single guest. Both requests resolve to the same `userId`. No conflict — same as registered user making concurrent requests. |

---

## 6. Dependencies

| Dependency | Status | Notes |
|-----------|--------|-------|
| LLD 1: Supabase Migration | Implemented | JWT verification logic, `SUPABASE_JWT_SECRET` env var |
| LLD 3: WebSocket Layer | Implemented | `socketAuthMiddleware`, `SocketData`, `ConnectionManager`, `useSocket.ts` composable |
| LLD 4: Big2 Engine | Implemented | Game engine uses `PlayerId` (string) — already compatible with guest IDs |
| `src/backend/middleware/authMiddleware.ts` | Exists | Must be modified for dual-path auth |
| `src/backend/websocket/socketAuth.ts` | Exists | Must be modified for dual-path auth |
| `src/backend/websocket/types.ts` | Exists | Must add `isGuest` to `SocketData` |
| `src/backend/api/game/joinGame.ts` | Exists | No changes needed — already accepts any userId string |
| `src/backend/api/game/createGame.ts` | Exists | Must add `registeredOnlyMiddleware` |
| `src/frontend/routes.ts` | Exists | Must add guest entry route, modify `/game/:gameId` auth requirement |
| `src/frontend/composables/useSocket.ts` | Exists | Must support guest token as auth alternative |
| `src/frontend/service/authService.ts` | Exists | No changes — guest service is separate |
| `crypto` (Node.js built-in) | Available | Used for HMAC-SHA256 and UUID generation |

---

## 7. File Changes

### Files to CREATE

| File | Purpose |
|------|---------|
| `src/backend/guest/types.ts` | Guest session types (GuestSession, request/response interfaces) |
| `src/backend/guest/guestSessionStore.ts` | In-memory session store with TTL and cleanup |
| `src/backend/guest/guestToken.ts` | Token creation and HMAC verification |
| `src/backend/api/guest/createSession.ts` | `POST /guest/session` handler |
| `src/backend/api/guest/claimSession.ts` | `POST /guest/claim` handler (guest-to-registered conversion) |
| `src/frontend/service/guestService.ts` | Frontend guest session management (create, restore, clear) |
| `src/frontend/component/GuestEntryView.vue` | Guest entry screen (display name input, join button) |
| `src/shared/guest-types.ts` | Shared request/response types for guest endpoints |

### Files to MODIFY

| File | Changes |
|------|---------|
| `src/backend/middleware/authMiddleware.ts` | Add dual-path logic: detect `guest:` prefix, verify guest token, add `isGuest` to request. Add `registeredOnlyMiddleware` export. |
| `src/backend/websocket/socketAuth.ts` | Add dual-path logic: detect `guest:` prefix, verify guest token, set `socket.data.isGuest`. |
| `src/backend/websocket/types.ts` | Add `isGuest: boolean` to `SocketData` interface. |
| `src/backend/server.ts` | Register guest API routes (`/guest/session`, `/guest/claim`). Instantiate `GuestSessionStore` and pass to middleware/handlers. Start cleanup loop. |
| `src/backend/api/game/createGame.ts` | Change middleware from `authMiddleware` to `[authMiddleware, registeredOnlyMiddleware]`. |
| `src/frontend/routes.ts` | Add `/game/:gameId/join` route for `GuestEntryView`. Change `/game/:gameId` from `requiresAuth: true` to custom guard logic (allow guest sessions). |
| `src/frontend/composables/useSocket.ts` | Modify `connect()` to try guest token when Supabase token is unavailable. |

### Files to DELETE

None.

---

## 8. Implementation Steps

Execute in this sequence. Each step produces a buildable project.

### Step 1: Create guest token utility

Create `src/backend/guest/guestToken.ts` with `createGuestToken` and `verifyGuestToken` functions using Node.js `crypto.createHmac`. Create corresponding unit tests.

The token format: `"guest:" + base64url(guestId + "." + gameId + "." + expiresAt + "." + hmacSignature)`

### Step 2: Create GuestSessionStore

Create `src/backend/guest/guestSessionStore.ts`. Implement the in-memory Map with:
- `create()`: generates `crypto.randomUUID()` (plain UUID, no prefix), stores with TTL
- `get()`: returns session if exists and not expired, null otherwise
- `delete()`: removes session
- `getByGame()`: returns all sessions for a game
- `startCleanupLoop()` / `stopCleanupLoop()`: periodic removal of expired sessions

Export the class only (not a singleton). Instantiate in `server.ts` and pass to middleware/handlers via dependency injection. This enables testing with a fresh store per test.

### Step 3: Create shared guest types

Create `src/shared/guest-types.ts` with `CreateGuestSessionRequest`, `CreateGuestSessionResponse`, `ClaimGuestSessionRequest`, `ClaimGuestSessionResponse`.

Create `src/backend/guest/types.ts` with `GuestSession` interface.

### Step 4: Modify auth middleware (dual-path)

Modify `src/backend/middleware/authMiddleware.ts`:
- Export `createAuthMiddleware(guestSessionStore)` factory function (returns the middleware)
- Extract token from header (existing logic)
- If token starts with `"guest:"`: call `verifyGuestToken`, then `guestSessionStore.get()`. Set `req.userId`, `req.displayName`, `req.isGuest = true`
- Else: existing Supabase JWT verification, set `req.isGuest = false`
- Export `registeredOnlyMiddleware` that checks `req.isGuest === true` and throws `AccessDeniedError` (existing error class in `src/backend/util/errors.ts`)

### Step 5: Modify socket auth middleware (dual-path)

Modify `src/backend/websocket/socketAuth.ts`: export `createSocketAuthMiddleware(guestSessionStore)` factory function with same dual-path logic.
Modify `src/backend/websocket/types.ts` to add `isGuest: boolean` to `SocketData`.

### Step 6: Create guest API endpoints

Create:
- `POST /guest/session` — validates gameId exists (returns 404 if not found), validates display name (non-empty, max 20 chars), deduplicates name within game, creates session, sets `guest_token` cookie, returns token in response body
- `POST /guest/claim` — requires Supabase JWT in `Authorization` header (sets `req.userId` to the new registered user ID via `authMiddleware`) + guest token in request body (read by handler, not middleware). Handler verifies the guest token, finds games containing the guest ID, and swaps the guest ID for `req.userId` in `Game.playerIds` and `Game.playerDisplayNames`

### Step 7: Register guest routes in server.ts

Modify `src/backend/server.ts`:
- Instantiate `GuestSessionStore`, start cleanup loop
- Create auth middleware via `createAuthMiddleware(guestSessionStore)`
- Create socket auth middleware via `createSocketAuthMiddleware(guestSessionStore)`
- Import and register guest API routes:
  - `POST /guest/session` — no auth middleware (it creates auth). Pass `guestSessionStore` and `gameRepo` to handler.
  - `POST /guest/claim` — uses `authMiddleware` (validates Supabase JWT in header; rejects guest tokens since only a registered user can claim)
- Add `registeredOnlyMiddleware` to `POST /createGame`

### Step 8: Create frontend guest service

Create `src/frontend/service/guestService.ts`:
- `createGuestSession()`: calls `POST /guest/session`, stores token in cookie + Vue reactive state
- `restoreGuestSession()`: reads `guest_token` cookie directly, decodes payload client-side (guestId, gameId, expiresAt), checks not expired, restores Vue state. No network call needed — server validates the token on first authenticated request.
- `getGuestToken()`: returns token from Vue reactive state (for WebSocket auth)
- `clearGuestSession()`: removes cookie, clears reactive state
- `claimGuestSession()`: calls `POST /guest/claim` with guest token in body (Supabase JWT sent via Authorization header automatically by Axios interceptor)

### Step 9: Create GuestEntryView component

Create `src/frontend/component/GuestEntryView.vue`:
- Display name input (required, max 20 chars)
- "Join Game" button (calls `createGuestSession`, then `POST /joinGame`, then navigates to `/game/:gameId`)
- "Sign up instead" link (navigates to `/signup?redirect=/game/:gameId`)
- Error display (game not found, game full, etc.)

### Step 10: Update frontend routing

Modify `src/frontend/routes.ts`:
- Add route: `{ path: "/game/:gameId/join", component: GuestEntryView, meta: { requiresAuth: false }, props: true }`
- Change `/game/:gameId` to `meta: { requiresAuth: false }`
- Update route guard: if navigating to `/game/:gameId` without auth (no Supabase session, no guest token), redirect to `/game/:gameId/join`
- If navigating to `/game/:gameId` with valid guest token, allow through

### Step 11: Update useSocket composable

Modify `src/frontend/composables/useSocket.ts`:
- In `connect()`, try `getAccessToken()` first. If null, try `getGuestToken()`. If both null, set error.

### Step 12: Verify build and manual test

- `npm run build` — zero TypeScript errors
- Manual test flow: start server, navigate to `/game/:gameId/join`, enter name, join game, verify WebSocket connects, verify game state received

---

## 9. Testing Strategy

### Unit Tests

| Test | What it verifies |
|------|-----------------|
| `createGuestToken` produces valid format | Token starts with "guest:", base64url-decodable |
| `verifyGuestToken` returns payload for valid token | guestId, gameId, expiresAt correctly extracted |
| `verifyGuestToken` returns null for tampered token | Modified payload fails HMAC check |
| `verifyGuestToken` returns null for expired token | expiresAt in the past → null |
| `verifyGuestToken` returns null for wrong secret | Different key → null |
| `GuestSessionStore.create` returns session with correct fields | guestId is valid UUID, displayName, gameId, timestamps set |
| `GuestSessionStore.get` returns session for valid guestId | Happy path |
| `GuestSessionStore.get` returns null for expired session | TTL exceeded → null |
| `GuestSessionStore.get` returns null for unknown guestId | Not in Map → null |
| `GuestSessionStore.getByGame` returns correct sessions | Filters by gameId |
| `GuestSessionStore.delete` removes session | Subsequent get returns null |
| `GuestSessionStore` cleanup loop removes expired sessions | After interval fires, expired sessions gone |
| Dual-path authMiddleware accepts valid Supabase JWT | Same behavior as before (regression) |
| Dual-path authMiddleware accepts valid guest token | Sets req.userId, req.displayName, req.isGuest=true |
| Dual-path authMiddleware rejects invalid guest token | Returns 401 |
| Dual-path authMiddleware rejects guest token for evicted session | HMAC valid but store has no record → 401 |
| `registeredOnlyMiddleware` allows registered user | req.isGuest=false → next() |
| `registeredOnlyMiddleware` rejects guest | req.isGuest=true → 403 |
| Display name deduplication | "Alice" when "Alice" exists → "Alice2" |
| Display name validation | Empty string → error, >20 chars → error |

### Integration Tests

| Test | What it verifies |
|------|-----------------|
| Full guest join flow: create session → join game → WebSocket connect → receive state | End-to-end happy path |
| Guest plays a game action successfully | Guest submits action via WebSocket, game state updates for all players |
| Guest and registered user in same game | Both receive state updates, no differentiation in gameplay |
| Guest token rejected on createGame endpoint | Returns 403 |
| Guest page refresh flow: create session → disconnect WebSocket → reconnect with same token | Session survives, state restored |
| Guest-to-registered conversion: play game → sign up → claim → verify game linked | Game.playerIds updated |
| Guest session expired: old token rejected | Returns 401 after TTL |
| Multiple guests in same game with same display name | Names deduplicated |
| Server restart simulation: clear GuestSessionStore → guest token rejected | Returns 401 |

### Security Tests

| Test | What it verifies |
|------|-----------------|
| Guest token with forged HMAC rejected | Tampered payload → 401 |
| Guest token for non-existent game | `POST /guest/session` validates game exists before creating session. Returns 404 if game not found. Prevents memory waste from sessions targeting non-existent games. |
| Guest cannot spoof action as another player | WebSocket handler overrides playerId from socket.data (existing behavior, verify with guest) |
| Guest token scoped: cannot be reused after session deletion | After `delete()`, token verification passes HMAC but fails store lookup |

---

## 10. Acceptance Criteria

Implementation is complete when:

1. `npm run build` succeeds with zero TypeScript errors.
2. An unauthenticated user visiting `/game/:gameId` is redirected to `/game/:gameId/join` (guest entry screen).
3. The guest entry screen accepts a display name and creates a guest session via `POST /guest/session`.
4. A guest can join an existing game via `POST /joinGame` using their guest token.
5. A guest can connect via WebSocket using their guest token and receive `game:state` events.
6. During gameplay, a guest player is indistinguishable from a registered player (same `PlayerView` structure, same action flow).
7. A guest cannot create a game (403 on `POST /createGame`).
8. Page refresh preserves the guest session (cookie-based) — guest can reconnect and continue playing.
9. After a game completes, a guest can sign up and claim their game via `POST /guest/claim`, linking the game to their new account.
10. Display names are deduplicated within a game (no two players have the same display name).
11. Guest sessions expire after 4 hours of inactivity or 30 minutes after game completion.
12. Existing registered-user flows are unaffected (all previous tests still pass).
13. All new tests pass via `npm test`.
