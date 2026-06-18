# LLD 28: Mobile Invite Code

## Scope

**Covers:**
- Backend: generate a short 4-character alphanumeric join code on game creation
- Backend: `join_code` column on `games` table with unique partial index
- Backend: `GET /api/games/join/:code` endpoint to resolve code to gameId
- Frontend: display the join code prominently in `GameLobbyView.vue` (Casino Chip design)
- Frontend: accept 4-char codes in `JoinGameView.vue` input field
- Code lifecycle: lives as long as the game row exists

**Does NOT cover:**
- Changes to the existing invite link flow (preserved as-is)
- QR code generation
- Deep link / universal link handling
- Spectator join via code (future: late joiners become spectators)

## Approach

### Code Generation

Generate a 4-character code from a reduced alphabet (A-Z, 2-9) excluding ambiguous characters: `0, O, 1, I, L`. This yields a 30-character alphabet with 30^4 = 810,000 combinations — more than sufficient for the expected concurrent game count (< 100).

Use `crypto.randomBytes()` with rejection sampling to eliminate modulo bias, mapping each byte to the alphabet. Retry on collision (unique constraint violation). Collisions are astronomically unlikely given the ratio of active games to code space.

Codes are case-insensitive: stored uppercase, input normalized to uppercase before lookup.

### Storage

A `join_code TEXT` column on the existing `games` table with a unique partial index (`WHERE join_code IS NOT NULL`). No separate table needed — the code's lifecycle is identical to the game's.

### Lifecycle

- **Created:** atomically with the game row in `createGame`. If the code collides (unique constraint), retry up to 5 times with a new code. If all 5 fail, the request returns 500 (game is not created).
- **Deleted:** when the game row is deleted. No cleanup job needed.

### Frontend

The code is returned in the `CreateGameResponse` and included in the `LobbyStatePayload` so all lobby members see it. The Casino Chip design renders it as a large, monospace, gold-bordered element that is visually dominant on mobile.

## Interfaces / Types

### Shared Types (`src/shared/model.ts`)

```typescript
export interface CreateGameResponse {
  gameId: string;
  gameType: GameType;
  joinCode: string; // 4-char alphanumeric code
}

export interface ResolveJoinCodeResponse {
  gameId: string;
}
```

### Socket Events (`src/shared/socket-events.ts`)

```typescript
export interface LobbyStatePayload {
  players: PlayerInfo[];
  maxPlayers: number;
  joinCode: string; // 4-char invite code
}
```

### Backend: Game Entity (`src/backend/database/entities/Game.ts`)

```typescript
export class Game {
  // ... existing fields ...
  joinCode: string | null = null;
}
```

### Backend: GameRepository (`src/backend/database/database.ts`)

```typescript
export interface GameRepository {
  createGame(
    gameId: string,
    gameType: GameType,
    creatorId: string,
    maxPlayers: number,
    creatorDisplayName: string,
    turnTimerSeconds: number | null,
    joinCode: string | null,
  ): Promise<Game>;
  getGame(gameId: string): Promise<Game | null>;
  getGameByJoinCode(code: string): Promise<Game | null>;
  saveGame(game: Game): Promise<Game>;
}
```

### Backend: Code Generator (`src/backend/service/joinCodeService.ts`)

```typescript
// Pure function — no class, no state, no DB dependency
export function generateJoinCode(): string;
```

### Backend: REST Endpoint (`src/backend/api/game/resolveJoinCode.ts`)

```typescript
// GET /api/games/join/:code
// No auth required (guests need to resolve codes before they have a session)
// Queries games table directly via gameRepo.getGameByJoinCode
// Response: 200 { gameId: string } or 404
```

### Database Schema (`supabase/migrations/001_create_tables.sql`)

```sql
-- join_code column on games table
CREATE TABLE IF NOT EXISTS games (
  -- ... existing columns ...
  join_code TEXT,
  -- ...
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_games_join_code ON games (join_code)
  WHERE join_code IS NOT NULL;
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
    → generateJoinCode() for code
    → gameRepo.createGame(..., joinCode) — retries on collision
    → return { gameId, gameType, joinCode }

Lobby Join (existing WebSocket flow):
  lobby:state event includes joinCode from game.joinCode
    → socketHandler reads game object directly (no separate lookup)

Code Resolution (REST endpoint):
  GET /api/games/join/:code
    → gameRepo.getGameByJoinCode(code.toUpperCase())
    → 200 { gameId } or 404
```

## Edge Cases

1. **Code collision on generate:** Retry up to 5 times with new random bytes. If all 5 fail (effectively impossible), return 500 to the client. The game is not created.

2. **Code entered in wrong case:** Normalize to uppercase before lookup. The input field uses `text-transform: uppercase` for visual consistency.

3. **Code for a completed game:** The code still resolves to the gameId. The downstream `joinGame` endpoint handles the "game already completed" rejection. Future: could reject at resolution time.

4. **Code for a full game:** Resolution returns the gameId; the existing joinGame endpoint handles the "game full" error (409). No special handling needed at the code layer.

5. **User enters a UUID in the code field:** Detect by length (36 chars with hyphens) — route directly to joinGame without code resolution. Existing behavior preserved.

6. **Multiple games by same host:** Each game gets its own code. No conflict — codes are keyed by the unique index on the column.

7. **Clipboard API unavailable (some mobile browsers):** Fall back to selecting the text for manual copy. Show a different message: "Long-press to copy."

## Dependencies

- **Existing `CreateGameHandler`** (`src/backend/api/game/createGame.ts`) — modified to generate and pass join code.
- **Existing `GameLobbyView.vue`** — modified to add the Casino Chip display.
- **Existing `JoinGameView.vue`** — modified to handle 4-char code resolution.
- **Existing `LobbyStatePayload`** (`src/shared/socket-events.ts`) — extended with `joinCode`.
- **Socket handler** (`src/backend/websocket/socketHandler.ts`) — reads `game.joinCode` when emitting `lobby:state`.

No upstream LLD dependencies. This is a standalone feature.

## Test Requirements

### Unit Tests

- **Code generation (`generateJoinCode`):**
  - Generated code is exactly 4 characters
  - Generated code contains only characters from the reduced alphabet
  - Code is uppercase
  - Generates different codes across calls (not deterministic)

- **Code resolution (`resolveJoinCode` endpoint):**
  - Valid code returns 200 with gameId
  - Unknown code returns 404
  - Input is normalized to uppercase before lookup

- **CreateGameHandler:**
  - Creates game with joinCode in response
  - Passes joinCode to gameRepo.createGame

### Integration Tests

- **Full flow:** Create game → response includes joinCode → GET /api/games/join/:code returns gameId → joinGame with that gameId succeeds

### Frontend Tests (Component)

- **GameLobbyView:** renders joinCode in casino chip element when prop is provided
- **GameLobbyView:** tapping the chip copies code to clipboard
- **JoinGameView:** submitting a 4-char code calls the resolve endpoint then joins
- **JoinGameView:** submitting a UUID bypasses code resolution (direct join)
- **JoinGameView:** invalid code shows "Game not found" error
