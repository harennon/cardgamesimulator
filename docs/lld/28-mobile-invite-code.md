# LLD 28: Mobile Invite Code

## Scope

**Covers:**
- Backend: generate a short 4-character alphanumeric join code on game creation
- Backend: `join_codes` table in Supabase with code-to-game mapping
- Backend: `GET /api/games/join/:code` endpoint to resolve code to gameId
- Frontend: display the join code prominently in `GameLobbyView.vue` (Casino Chip design)
- Frontend: accept 4-char codes in `JoinGameView.vue` input field
- Code lifecycle: creation on game create, deletion on game completion or 24h inactivity

**Does NOT cover:**
- Changes to the existing invite link flow (preserved as-is)
- QR code generation
- Deep link / universal link handling
- Changes to the WebSocket layer or game engine

## Approach

### Code Generation

Generate a 4-character code from a reduced alphabet (A-Z, 2-9) excluding ambiguous characters: `0, O, 1, I, L`. This yields a 30-character alphabet with 30^4 = 810,000 combinations — more than sufficient for the expected concurrent game count (< 100).

Use `crypto.randomBytes(4)` and map each byte modulo 30 to the alphabet. Retry on collision (check DB uniqueness). Collisions are astronomically unlikely given the ratio of active games to code space.

Codes are case-insensitive: stored uppercase, input normalized to uppercase before lookup.

### Storage

A new `join_codes` table rather than a column on `games` — keeps the games table unchanged and allows indexing the code as a primary key for O(1) lookups.

### Lifecycle

- **Created:** atomically when `createGame` is called, in the same DB transaction conceptually (two sequential inserts — if code insert fails, game creation fails).
- **Deleted:** (a) when game status transitions to COMPLETED, or (b) by a periodic cleanup of codes whose associated game has been inactive > 24h. Cleanup runs on a `setInterval` in the server process (no external cron needed).

### Frontend

The code is returned in the `CreateGameResponse` and included in the `LobbyStatePayload` so all lobby members see it. The Casino Chip design renders it as a large, monospace, gold-bordered element that is visually dominant on mobile.

## Interfaces / Types

### Shared Types (`src/shared/model.ts`)

```typescript
// Extend CreateGameResponse
export interface CreateGameResponse {
  gameId: string;
  gameType: GameType;
  joinCode: string; // NEW: 4-char alphanumeric code
}

// New response type for code resolution
export interface ResolveJoinCodeResponse {
  gameId: string;
}
```

### Socket Events (`src/shared/socket-events.ts`)

```typescript
// Extend LobbyStatePayload
export interface LobbyStatePayload {
  players: PlayerInfo[];
  maxPlayers: number;
  joinCode: string; // NEW
}
```

### Backend: Join Code Repository (`src/backend/database/database.ts`)

```typescript
export interface JoinCodeRepository {
  createJoinCode(code: string, gameId: string): Promise<void>;
  getGameIdByCode(code: string): Promise<string | null>;
  deleteByGameId(gameId: string): Promise<void>;
  deleteExpired(maxAgeMs: number): Promise<number>; // returns count deleted
}
```

### Backend: Code Generator (`src/backend/service/joinCodeService.ts`)

```typescript
export class JoinCodeService {
  // Reduced alphabet: A-Z minus O/I/L, digits 2-9
  private static readonly ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  constructor(private readonly joinCodeRepo: JoinCodeRepository) {}

  /** Generate a unique 4-char code. Retries up to 5 times on collision. */
  async generateCode(gameId: string): Promise<string>;

  /** Resolve a code to a gameId. Returns null if not found. */
  async resolveCode(code: string): Promise<string | null>;

  /** Delete code for a completed/expired game. */
  async deleteForGame(gameId: string): Promise<void>;

  /** Cleanup codes older than maxAgeMs. Called periodically. */
  async cleanupExpired(maxAgeMs: number): Promise<number>;
}
```

### Backend: REST Endpoint (`src/backend/api/game/resolveJoinCode.ts`)

```typescript
// GET /api/games/join/:code
// No auth required (guests need to resolve codes before they have a session)
// Response: 200 { gameId: string } or 404 { error: "CODE_NOT_FOUND" }
```

### Database Migration (`supabase/migrations/004_join_codes.sql`)

```sql
CREATE TABLE IF NOT EXISTS join_codes (
  code TEXT PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_join_codes_game_id ON join_codes (game_id);

-- Allow service_role full access, anon/authenticated can SELECT (resolve codes)
GRANT ALL ON join_codes TO service_role;
GRANT SELECT ON join_codes TO authenticated;
GRANT SELECT ON join_codes TO anon;
```

## Frontend Design

### Casino Chip in GameLobbyView

The join code is displayed between the title and the player list as a "casino chip" element:

- **Container:** circular/rounded-square element with a 3px solid gold border (`var(--gold-accent)`)
- **Text:** 4 characters in monospace font, `2rem` size, letter-spacing `0.3em`, color `var(--gold-accent)`
- **Label:** small text above: "ROOM CODE" in `0.7rem` uppercase muted text
- **Tap behavior:** tapping the chip copies the code to clipboard (same feedback as existing "Copy Invite Link" — shows "Copied!" toast)
- **Position:** centered, above the player list, below the title — the most prominent element on mobile
- **Responsive:** on desktop the chip is positioned inline; on mobile (< 480px) it takes the same centered layout but slightly smaller (`1.6rem`)

```
+----------------------------------+
|         Game Lobby               |
|                                  |
|          ROOM CODE               |
|        +----------+              |
|        |  H 7 K 3 |  <-- gold   |
|        +----------+              |
|                                  |
|  Players (2/4):                  |
|    * Alice (host)                |
|    * Bob                         |
|    o Waiting...                  |
|    o Waiting...                  |
|                                  |
|  [    Start Game    ]            |
|  [ Copy Invite Link ]           |
+----------------------------------+
```

### Props Change

`GameLobbyView.vue` receives a new prop:
```typescript
joinCode: string; // 4-char code to display
```

### JoinGameView Enhancement

The existing `JoinGameView.vue` input already accepts a "Game Code" — the only change is:

1. Detect if input is exactly 4 characters matching `[A-Z0-9]` (case-insensitive) → call `GET /api/games/join/:code` to resolve to a gameId, then proceed with existing join flow
2. If input looks like a UUID (36 chars with dashes) → use directly as gameId (existing behavior)
3. Input placeholder updated to: "Enter 4-letter room code"
4. Auto-uppercase the input via CSS `text-transform: uppercase` and normalize on submit

## State Model

```
Game Creation:
  createGame handler
    → crypto.randomUUID() for gameId
    → joinCodeService.generateCode(gameId)
    → gameRepo.createGame(...)
    → return { gameId, gameType, joinCode }

Lobby Join (existing WebSocket flow):
  lobby:state event now includes joinCode field
    → socketHandler reads join_codes table (or caches in-memory alongside game)

Code Resolution (new REST endpoint):
  GET /api/games/join/:code
    → joinCodeService.resolveCode(code.toUpperCase())
    → 200 { gameId } or 404

Game Completion:
  gameService.applyAction (when status → COMPLETED)
    → joinCodeService.deleteForGame(gameId) (fire-and-forget)

Periodic Cleanup:
  setInterval in server.ts (every 1 hour)
    → joinCodeService.cleanupExpired(24 * 60 * 60 * 1000)
```

### In-Memory Considerations

The join code is lightweight metadata (4 chars + gameId). It can be cached in a `Map<string, string>` (code → gameId) in `JoinCodeService` for fast resolution without DB round-trips. Cache is populated on create and invalidated on delete. For a single-server deployment this is sufficient. The DB remains the source of truth for recovery after restart.

## Edge Cases

1. **Code collision on generate:** Retry up to 5 times with new random bytes. If all 5 fail (effectively impossible), throw an error that propagates as a 500 to the client. The game is not created.

2. **Code entered in wrong case:** Normalize to uppercase before lookup. The input field uses `text-transform: uppercase` for visual consistency.

3. **Code for a completed game:** The code is deleted on game completion. Lookup returns 404. The user sees "Game not found."

4. **Code for a full game:** Resolution returns the gameId; the existing joinGame endpoint handles the "game full" error (409). No special handling needed at the code layer.

5. **User enters a UUID in the code field:** Detect by length (36 chars with hyphens) — route directly to joinGame without code resolution. Existing behavior preserved.

6. **Server restart:** In-memory code cache is lost. On next lookup, the service falls through to the DB. On next game creation, a new code is generated normally. Existing codes survive in the DB.

7. **Multiple games by same host:** Each game gets its own code. No conflict — codes are keyed by code value, not by host.

8. **24h cleanup races:** If a game is still in CREATED status but inactive > 24h, the cleanup deletes the code. If the host then tries to share the code, it will 404. The game itself remains accessible via direct link/UUID. This is acceptable — a 24h-idle lobby is effectively abandoned.

9. **Clipboard API unavailable (some mobile browsers):** Fall back to selecting the text for manual copy. Show a different message: "Long-press to copy."

## Dependencies

- **Supabase migrations infrastructure** — must be able to run new migration (already established with 001-003).
- **Existing `CreateGameHandler`** (`src/backend/api/game/createGame.ts`) — will be modified to call `JoinCodeService`.
- **Existing `GameLobbyView.vue`** — will be modified to add the Casino Chip display.
- **Existing `JoinGameView.vue`** — will be modified to handle 4-char code resolution.
- **Existing `LobbyStatePayload`** (`src/shared/socket-events.ts`) — will be extended with `joinCode`.
- **Socket handler** (`src/backend/websocket/socketHandler.ts`) — must include `joinCode` when emitting `lobby:state`.

No upstream LLD dependencies. This is a standalone feature.

## Test Requirements

### Unit Tests

- **Code generation:**
  - Generated code is exactly 4 characters
  - Generated code contains only characters from the reduced alphabet
  - Code is uppercase
  - On simulated collision (mock repo returning duplicate error), retries and succeeds
  - After 5 collisions, throws error

- **Code resolution:**
  - Valid code returns gameId
  - Unknown code returns null
  - Input is normalized to uppercase before lookup

- **Cleanup:**
  - Codes older than threshold are deleted
  - Codes newer than threshold are preserved

### Integration Tests

- **Full flow:** Create game → response includes joinCode → GET /api/games/join/:code returns gameId → joinGame with that gameId succeeds
- **Expired code:** Create game → advance time past 24h → cleanup runs → code resolves to 404
- **Completed game:** Create game → start → complete → code resolves to 404

### Frontend Tests (Component)

- **GameLobbyView:** renders joinCode in casino chip element when prop is provided
- **GameLobbyView:** tapping the chip copies code to clipboard
- **JoinGameView:** submitting a 4-char code calls the resolve endpoint then joins
- **JoinGameView:** submitting a UUID bypasses code resolution (direct join)
- **JoinGameView:** invalid code shows "Game not found" error
