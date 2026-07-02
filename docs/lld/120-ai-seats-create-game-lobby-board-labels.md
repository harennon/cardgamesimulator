# LLD 120: Create-game + lobby/board UI — add AI seats and label them distinctly from humans

Parent: #127. Order 2 of 3. Depends on LLD 118 (AI-seat foundation backend), **merged as #134**.

## Scope

This increment is a **pure consumer** of the merged #134 backend. It exposes the existing AI-seat capability to a registered host at create time and makes AI seats visually distinct from humans in the lobby and on both boards.

**Covers exactly four things:**

1. **Create-game request + one HTTP route.** Add `numAiSeats?: number` to `CreateGameRequest` (`src/shared/model.ts`) and make the `POST /api/createGame` handler seat AI players after game creation by calling the **existing** `GameService.addAiSeats(gameId, count)` (owned by #134).
2. **Surface an `isAi` flag** on `PlayerPublicInfo` and `PlayerInfo` (`src/shared/engine-types.ts`), derived **server-side** from `gameConfig.aiPlayerIds` — never trusted from the client. The view/lobby builders tag each seat.
3. **`CreateGameView.vue`** AI-opponents stepper (Variant B visual direction, locked).
4. **Badge rendering** via one shared `AiBadge.vue` atom, reused verbatim in `GameLobbyView.vue`, Big2 `OpponentRow.vue`, and Tonk `TonkSeatRail.vue`.

**Explicitly does NOT cover (owned elsewhere):**

- AI turn-driving, `shouldAutoPlay`, `autoPlayAbandoned`, `isAiSeat`, the start gate, stats/history exclusion, `addAiSeats` itself — **all owned by #134**. This LLD does not modify or re-implement any of them.
- AI naming / avatars / personality polish — **sub-issue 3 (#127 order 3)**. Names remain the backend-assigned "CPU 1", "CPU 2", …
- The turn-state gold glow / turn indicator — **not touched**. The AI badge marks *identity*; the existing gold glow marks *whose turn*. Cool blue was chosen so the two never collide.
- Any new migration or schema change.

## Approach

### A. `numAiSeats` on the create request + one route change

- Extend `CreateGameRequest` with `numAiSeats?: number` (optional; omitted/0 ⇒ ordinary human-only game).
- In `CreateGameHandler.post` (`src/backend/api/game/createGame.ts`), **after** the game row is created (with the host as the sole seat), if `numAiSeats >= 1`, call the existing `gameRepo`/`GameService.addAiSeats(gameId, numAiSeats)`. `addAiSeats` (from #134) appends the synthetic `ai:<uuid>` seats, sets `gameConfig.practice = true`, and populates `gameConfig.aiPlayerIds`. **The handler is the seam #134 documented; it does not re-implement seat creation.**
- **Server-side validation (fail-closed):** the handler validates `numAiSeats` before calling `addAiSeats`:
  - Must be an integer `>= 0`. Present-but-invalid (non-integer, negative) ⇒ `BadRequestError` (400).
  - Upper bound: `numAiSeats <= maxPlayers - 1` (one human host always seated; table can never over-fill). Exceeding ⇒ `BadRequestError`. `addAiSeats` also enforces `GAME_FULL` as the authoritative backstop, but the route pre-checks so the client gets a clean 400 rather than a partially-created game.
  - `numAiSeats === 0` or absent ⇒ skip `addAiSeats` entirely (config stays `{}` for Big2 / `{ deckRoundsTarget }` for Tonk — byte-for-byte the pre-AI behavior).
- **Registered-host only:** AI seating requires `request.userId` to be a **registered** (non-guest) user. Guests never reach `/create-game` in the UI, but the route must still reject `numAiSeats >= 1` from a guest token with `BadRequestError` (defense in depth; the practice/AI feature is a registered-host capability). Detection reuses the existing guest-token signal available in the auth middleware context (the same mechanism `isGuest` uses server-side).

**Atomicity note.** Game creation and `addAiSeats` are two writes. If `addAiSeats` fails after the game row exists, the created game is a valid human-only `CREATED` game (the host can still use it). The handler surfaces the error; it does **not** attempt rollback (the game is not corrupt, only un-AI'd). This matches the existing create-then-mutate pattern and keeps the route thin. Documented as Edge Case 8.

### B. `isAi` flag surfaced server-side (never trusted from client)

`PlayerPublicInfo` and `PlayerInfo` gain a `readonly isAi?: boolean`. It is **derived server-side** from `gameConfig.aiPlayerIds`, at the boundaries where those shapes are built for a client:

- **Board views (`PlayerPublicInfo`).** The engines' `getPlayerView`/`getSpectatorView` build `players[]` but the pure engine has no notion of AI (architecture principle 4 — the engine stays pure). Therefore `isAi` is injected in the **socket layer**, alongside the existing `injectConnectionStatus` helper in `socketHandler.ts`, which already maps over `view.players` per broadcast. Add a sibling injection (or extend that helper) that sets `isAi: aiIds.has(p.playerId)` where `aiIds` is the game's `gameConfig.aiPlayerIds` set. This keeps the engine pure and the flag authoritative (read from persisted config, not the client). The set is already cheaply available via the same read the socket layer does for `getJoinCode`; #134's `isAiSeat` memo may be reused, but a per-broadcast `Set` built from the loaded `Game.gameConfig.aiPlayerIds` is sufficient and simplest.
- **Lobby list (`PlayerInfo`).** Two producers must tag seats:
  - The socket `lobby:state` / `lobby:playerJoined` payloads (`socketHandler.ts` ~line 226): when building `PlayerInfo[]` from `game.playerIds`, set `isAi` by membership in `game.gameConfig.aiPlayerIds`.
  - The REST `getGameState` path is unchanged in shape — it returns `SerializableGame` which **already carries `gameConfig`** (including `aiPlayerIds`). The frontend derives `isAi` for the REST-seeded lobby list from `game.gameConfig.aiPlayerIds` (see Frontend Design). No new server field is required on `SerializableGame`; the socket `PlayerInfo.isAi` covers the live-update path and the REST path derives client-side from config that is *already present*.

`isAi` is optional and defaults to falsy; every existing human-vs-human payload is unchanged (no `aiPlayerIds` ⇒ every seat `isAi` falsy/absent), satisfying the "human-only flows visually unchanged" criterion.

**Why not derive `isAi` on the client by string-matching the `ai:` id prefix?** The `ai:` prefix is an #134 implementation detail; the authoritative signal is `gameConfig.aiPlayerIds`. Deriving from config (server-injected for the socket path, config-present for the REST path) avoids coupling the frontend to the id scheme.

### C. Frontend rendering — one shared `AiBadge.vue` atom

A single presentational atom `src/frontend/component/game-ui/AiBadge.vue` renders the locked Variant B identity: a squared-off steel-blue dot + the text `CPU`, using a new `--ai-accent: #7fb2ff` token. It takes no props (pure static badge) — or an optional `size` variant if the board and lobby need different scales; keep it minimal. It is imported and rendered verbatim next to the seat name in `GameLobbyView.vue`, `OpponentRow.vue`, and `TonkSeatRail.vue`, gated on the seat's `isAi`.

The stepper in `CreateGameView.vue` is a bounded numeric control (see Frontend Design), only rendered for a registered host, defaulting to 0. At 0 the create form is byte-for-byte the current form.

## Interfaces / Types

**`src/shared/model.ts` — extend `CreateGameRequest`:**

```ts
export interface CreateGameRequest {
  gameType: GameType;
  maxPlayers: number;
  gameOptions?: { [key: string]: string };
  turnTimerSeconds: 30 | 60 | 90;
  deckRoundsTarget?: number;
  numAiSeats?: number; // NEW: 0..(maxPlayers-1); omitted/0 => human-only game
}
```

`GameConfig` (with `practice`/`aiPlayerIds`) already exists from #134 — **no change**.

**`src/shared/engine-types.ts` — add `isAi` to the two public seat shapes:**

```ts
export interface PlayerInfo {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly isAi?: boolean; // NEW: true iff this seat is a server-driven AI seat
}

export interface PlayerPublicInfo {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly cardCount: number;
  readonly isConnected: boolean;
  readonly isAi?: boolean; // NEW: derived server-side from gameConfig.aiPlayerIds
}
```

**`src/backend/api/game/createGame.ts`** — internal change only:

```ts
// After createGameWithCode(...):
const numAiSeats = validateNumAiSeatsOrThrow(request.body.numAiSeats, request.body.maxPlayers, isRegisteredHost);
if (numAiSeats >= 1) {
  await gameService.addAiSeats(game.gameId, numAiSeats); // #134-owned; not re-implemented
}
```
New helper `validateNumAiSeatsOrThrow(raw, maxPlayers, isRegisteredHost)`: returns 0 for absent; throws `BadRequestError` on non-integer / negative / `> maxPlayers - 1` / (`>= 1` && guest).

**`src/backend/websocket/socketHandler.ts`** — internal change only: extend/duplicate the `injectConnectionStatus` map to also set `isAi` from the game's `aiPlayerIds` set (board path); set `isAi` when building the lobby `PlayerInfo[]` (~line 226).

**`src/frontend/component/game-ui/AiBadge.vue`** — new presentational atom, no game logic.

No socket-event or `SerializableGame` field additions (REST path reuses existing `gameConfig`).

## Frontend Design

**Approved visual direction: Variant B (LOCKED).** The mockup step is complete and approved — owner replied "Frontend decision: variant B" on issue #135. Do **not** re-run the frontend-architect mockup loop.

**Bot identity palette (new token):**
- `--ai-accent: #7fb2ff` (steel/cool blue), added to `:root` in `src/frontend/styles/game-variables.css`.
- Chosen specifically to never collide with the warm `--gold-accent (#c9a84c)` turn glow. The badge marks *identity*; gold marks *turn*. Both can be present on one seat (an AI seat whose turn it is shows the gold active border **and** the blue CPU badge) with no visual collision.

**`AiBadge.vue` (shared atom, used verbatim in all three surfaces):**
- A small inline pill: a **squared-off** (2px border-radius, not circular) dot in `--ai-accent`, followed by the text `CPU` in `--font-ui`, uppercase, letter-spaced, `--ai-accent` color, small (≈0.6rem board / ≈0.7rem lobby).
- **No robot emoji, no icon fonts.** Plain text + squared dot only.
- Non-interactive, `aria-hidden` on the dot; the `CPU` text is the accessible label (screen readers read "CPU"). Add `data-testid="ai-badge"`.

**Create-game stepper (`CreateGameView.vue`):**
- New field "AI Opponents", rendered **only for a registered host** and **only after a game type is selected** (consistent with the existing `bounds`-gated fields). It is a numeric stepper: `[ − ]  N  [ + ]`, `N` defaulting to **0**.
- Bounds: `0 .. maxPlayers - 1`. The `− ` disabled at 0; `+` disabled at `maxPlayers - 1`. When the host lowers `maxPlayers` below `numAiSeats + 1`, `numAiSeats` is re-clamped down (mirrors the existing `deckRoundsTarget`/`maxPlayers` clamp pattern). This guarantees the table can never over-fill (1 human + N AI ≤ maxPlayers).
- **At `numAiSeats === 0` the form is byte-for-byte the current form** — the CTA reads "Create Game" and no practice copy appears (acceptance criterion: human-only create flow visually unchanged).
- **When `numAiSeats >= 1`:** the primary CTA switches to **"Create Practice Game"**, and a small help line notes *practice games don't count toward stats*. Use existing `.help-text` styling.
- `data-testid`s: `ai-seats-field`, `ai-seats-value`, `ai-seats-decrement`, `ai-seats-increment`, `practice-note`. The submit button keeps `data-testid="submit-create-game"`; its label is dynamic.
- `createGame()` includes `numAiSeats: numAiSeats.value` in the request only when `> 0` (omit otherwise so human-only requests are unchanged).
- **Optional (nice-to-have, not required):** a "thinking…" line under an active AI seat on the board. Not in scope for acceptance; implementer may skip.

**Lobby (`GameLobbyView.vue`):**
- Each `.lobby__player` row renders `<AiBadge v-if="player.isAi" />` after the display name. Human rows are unchanged.
- The player-count line and empty-slot rows are unchanged.

**Big2 board (`OpponentRow.vue`):**
- Render `<AiBadge v-if="player.isAi" />` inside `.opponent__info`, next to `.opponent__name`. The `isAi` flag rides on the `PlayerPublicInfo` already passed as `players`. The existing `.opponent--active` gold border/pulse is untouched.

**Tonk board (`TonkSeatRail.vue`):**
- Render `<AiBadge v-if="seat.isAi" />` in `.tonk-seat__info` next to `.tonk-seat__name`. This requires threading `isAi` through the `railSeats()` derivation in `tonkDisplay.ts` (add `isAi` to the `SeatRow` interface, copied from `PlayerPublicInfo.isAi`). Existing tally/phase-tag/turn-indicator styling untouched.

**Reduced-motion / mobile:** the badge is static (no animation), so no `prefers-reduced-motion` handling needed. On mobile the badge sits inline with the (already ellipsized) name; keep it `flex-shrink: 0` so it is never clipped.

## State Model

- **Persisted (Supabase `games` row):** unchanged by this LLD. `addAiSeats` (already merged in #134) writes `player_ids`, `player_display_names`, and `game_config.{practice,aiPlayerIds}`. This LLD only *reads* that config to derive `isAi`.
- **In-memory (engine `InternalGameState`):** unchanged. The engine remains AI-agnostic (principle 4). `isAi` never enters engine state; it is injected at the socket serialization boundary.
- **Client (frontend):** `isAi` is a read-only display flag on `PlayerInfo`/`PlayerPublicInfo`. The lobby derives it from the socket payload (`lobby:state`/`lobby:playerJoined` now carry `isAi`) or, for the REST-seeded initial list, from `game.gameConfig.aiPlayerIds` returned by `getGameState`. `numAiSeats` is transient create-form state only; never persisted client-side.
- **Security boundary:** `isAi` is computed exclusively server-side from persisted `aiPlayerIds` (board + socket-lobby paths) or from server-returned config (REST path). A malicious client cannot mark a human seat as AI or vice-versa — the flag is not accepted on any inbound request.

## Edge Cases

1. **`numAiSeats` absent / 0.** No `addAiSeats` call; config stays `{}`/`{deckRoundsTarget}`. Create form, lobby, and boards are byte-for-byte unchanged. (Primary "human-only unchanged" acceptance case.)
2. **`numAiSeats` present but invalid** (non-integer, negative, `> maxPlayers - 1`). Route throws `BadRequestError` (400) before any `addAiSeats` call — no partial AI game created.
3. **Guest sends `numAiSeats >= 1`.** Rejected with `BadRequestError` (registered-host-only capability). Guests cannot create practice games.
4. **`maxPlayers` lowered below `numAiSeats + 1` in the form.** Stepper re-clamps `numAiSeats` down so `1 human + N AI <= maxPlayers` always holds; the request never exceeds the table.
5. **Tonk engine minimum (3 seats) with too few AI.** The route does **not** enforce the engine minimum — that is #134's start gate (`NOT_ENOUGH_PLAYERS`). E.g. 1 human + 1 AI Tonk creates fine but fails at start. The stepper does not special-case Tonk (advisory friendliness is out of scope); the host sees the existing start-gate hint. Documented, not fixed here.
6. **AI seat is the current turn player.** The board shows both the gold active border/pulse (turn) **and** the blue CPU badge (identity). Verified no visual collision (warm vs cool). The badge does not alter turn logic.
7. **Spectator view.** `getSpectatorView` players also get `isAi` injected via the same socket-layer helper, so a spectator sees CPU badges too. (Consistency; no separate handling.)
8. **`addAiSeats` fails after game row created.** The game exists as a valid human-only `CREATED` game; the route surfaces the error, no rollback (Approach A atomicity note). Not corrupt.
9. **Rematch of a practice game.** #134 strips `practice`/`aiPlayerIds` on rematch → the rematched game has no AI seats → every seat `isAi` falsy → no badges. Correct, no change needed here.
10. **Human display name collides with "CPU N".** Names are backend-assigned for AI seats; the badge (not the name) is the human/AI signal, so a human literally named "CPU 1" shows **no** badge (its id is not in `aiPlayerIds`). The flag, not the string, is authoritative.
11. **Unknown/absent `aiPlayerIds` on an otherwise-practice game** (hand-crafted data). Every seat resolves `isAi` falsy → no badges. Safe/degrades to human-only rendering.

## Dependencies

- **Must exist (merged in #134):** `GameConfig.practice`/`aiPlayerIds`; `GameService.addAiSeats(gameId, count)`; `GameService.isAiSeat`; the relaxed start gate; `shouldAutoPlay`/`autoPlayAbandoned` AI driving; stats/history exclusion. **This LLD consumes them and must not modify them.**
- **Existing infra:** `SerializableGame.gameConfig` round-trip (already returns `aiPlayerIds` via `getGameState`); `injectConnectionStatus` helper in `socketHandler.ts`; the `lobby:state`/`lobby:playerJoined` payloads carrying `PlayerInfo`.
- **Blocks:** #127 sub-issue 3 (AI naming/avatars/personality) builds on the `isAi` flag and `AiBadge` established here.
- **No new migration.**

## Test Requirements

Automated unless a check is inherently visual. Follow testing-principles: self-contained, no shared state, test the security boundary.

### Unit — create route (`createGame.ts`)
- `numAiSeats` omitted ⇒ `addAiSeats` **not** called; `gameConfig` is `{}` (Big2) / `{deckRoundsTarget}` (Tonk). (Regression: human-only create unchanged.)
- `numAiSeats = 2`, `maxPlayers = 4`, registered host ⇒ `addAiSeats(gameId, 2)` called exactly once.
- `numAiSeats = maxPlayers` (over-fill: needs 1 human) ⇒ `BadRequestError`, `addAiSeats` not called.
- `numAiSeats = -1` / `1.5` (non-integer) ⇒ `BadRequestError`.
- `numAiSeats = 1` from a **guest** token ⇒ `BadRequestError`, `addAiSeats` not called. (Security boundary.)

### Unit — `isAi` derivation (server-side)
- Socket board-view injection: given a state whose `gameConfig.aiPlayerIds` contains seat X's id, the emitted `PlayerPublicInfo` for X has `isAi === true`, and a human seat has `isAi` falsy. (Assert the flag is set from config, **not** from the `ai:` id prefix and **not** from any client input.)
- Lobby `PlayerInfo[]` builder (`lobby:state`): AI seat ids tagged `isAi: true`, human ids falsy.
- No `aiPlayerIds` (human-vs-human) ⇒ every seat `isAi` falsy. (Regression: payload shape unchanged for existing games.)

### Unit — frontend derivation + rendering
- `AiBadge.vue`: renders `CPU` text and the squared dot; no emoji; `data-testid="ai-badge"` present.
- `CreateGameView`: stepper clamps to `0..maxPlayers-1`; lowering `maxPlayers` re-clamps `numAiSeats`; CTA text is "Create Game" at 0 and "Create Practice Game" + practice note at `>=1`; request body includes `numAiSeats` only when `> 0`.
- `CreateGameView`: AI-seats field is **not rendered** for a guest / when no game type selected.
- `GameLobbyView`: a player with `isAi: true` renders exactly one `AiBadge`; a human renders none. REST-seeded lobby derives `isAi` from `gameConfig.aiPlayerIds`.
- `OpponentRow` / `TonkSeatRail`: an opponent/seat with `isAi: true` renders the badge; humans do not. Active (turn) AI seat still shows the gold active class **and** the badge (no removal of turn styling).
- `railSeats()` in `tonkDisplay.ts`: propagates `isAi` from `PlayerPublicInfo` into `SeatRow`.

### Manual (visual only — cannot be asserted in DOM)
- One-line check that the blue CPU badge and the gold turn glow are visually distinct when both present on one seat (Big2 and Tonk). Everything else is covered by DOM/unit assertions.
