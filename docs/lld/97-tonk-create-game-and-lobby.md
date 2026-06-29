# LLD 97: Add Tonk to the Create Game Screen and Lobby

**Parent issue:** #60 · **Order:** 3 of 4 · **Effort:** medium
**Depends on:** the backend `deckRoundsTarget` contract (LLD 95 / sub-issue #1), already live on `origin/main`.
**Approved visual direction:** Direction B (segmented stepper) from the `frontend-architect` mockup on branch `lld-96-tonk-create-game-and-lobby` (`docs/mockups/tonk-create-game-and-lobby.html`). Match that mockup; do not invent a new layout.

---

## Scope

### Covers (frontend only)

1. **`CreateGameView.vue`** — add a `<option value="tonk">`; make the player-count range game-type-aware (Big 2: 2–4, Tonk: 3–8) and re-clamp the selected count when the type changes; add a Tonk-only **Deck Length** segmented stepper (`deckRoundsTarget`, integer 5–12, default 8) and send it in `CreateGameRequest`; stop sending the dead `gameOptions: {}`.
2. **`GameLobbyView.vue`** — make the lobby game-type-aware with **no Big 2-specific assumptions**: a game-type label/badge, a player-count line, a min-players-aware Start button gate (Tonk min 3, Big 2 min 2), and a layout that renders **8 players with no page scroll**.
3. **`GameView.vue`** — pass `gameType` and `minPlayers` (derived from `gameType`) into `GameLobbyView` from the already-fetched game state.
4. A small shared helper for per-game-type UI bounds (`{ minPlayers, maxPlayers }`) so both views read the same source.

### Does NOT cover

- Any client-side game-rule logic. The client only sends config and renders server-provided state (architecture-principles #1). The min/max/`deckRoundsTarget` limits are **presentational mirrors** of the server's authoritative bounds (`big2-engine.ts:36` "2-4", `tonk-engine.ts:63` "3-8", `createGame.ts` validates `deckRoundsTarget` ∈ [5,12]); the server remains the source of truth and rejects out-of-range requests.
- Backend changes. The `CreateGameRequest.deckRoundsTarget?: number`, `GameConfig`, validation, persistence (`game_config` JSONB), and `gameService` wiring already exist on `origin/main` (verified: `src/shared/model.ts:13-19`, `createGame.ts`).
- The Tonk in-game board / action panel (LLD 88 and later sub-issues #102–105).
- Socket payload changes. `gameType` is obtained from the REST `getGameState` response already fetched on mount; `LobbyStatePayload` is unchanged.

---

## Approach

### A1. Per-game-type UI bounds — single source

Add a small constant map in a shared frontend module (recommended: extend `src/frontend/component/statsView.ts` which already owns `gameTypeLabel`, or a new `src/frontend/component/createGame.ts`). It maps each `GameType` to its presentational bounds:

```
big2 -> { minPlayers: 2, maxPlayers: 4, hasDeckRoundsTarget: false }
tonk -> { minPlayers: 3, maxPlayers: 8, hasDeckRoundsTarget: true  }
```

Both `CreateGameView` (range min/max, deck control visibility) and `GameView`→`GameLobbyView` (Start gate, "up to N" label) read this map. This removes the hardcoded `gameType === 'big2' ? 4 : 10` (`CreateGameView.vue:68`) and the hardcoded `players.length >= 2` (`GameLobbyView.vue:95`).

**Rationale:** one place to change when a third game is added; mirrors the existing `GAME_TYPE_LABELS` pattern. These are UI conveniences, not rules — the comment in the mockup script ("client only renders; these limits mirror LLD 65 §9.1 / engine config — no rule logic here") is the governing principle.

### A2. Create form (Direction B)

- **Game Type** select gains `<option value="tonk">Tonk</option>` after the existing Big 2 option.
- **Players** range binds `min`/`max` to the selected type's bounds. The live value chip (`{{ maxPlayers }}`) and min/max scale labels reflect the active range (per mockup `.range-head` / `.range-scale`).
- **On game-type change**, re-clamp the selected count into the new range: `count = clamp(count, min, max)`. Implemented with a `watch(gameType)` (or `@change`). Initial default: when no type is selected the form is disabled (existing behavior); when a type is first chosen, seed the count to that type's `minPlayers` (Big 2 → 2, Tonk → 3).
- **Deck Length** control: a Tonk-only segmented stepper (Direction B). Eight buttons for values 5–12, `aria-pressed="true"` on the selected one, default 8, inside a `role="group"` labelled "Deck length in rounds". Shown only when `gameType === 'tonk'` (`v-if`). Includes the `seg-meta` row ("shorter deck / default 8 / longer deck") and help text from the mockup.
- **Submit payload** (`CreateGameRequest`): send `gameType`, `maxPlayers`, `turnTimerSeconds`, and `deckRoundsTarget` **only when** `gameType === 'tonk'` (omit otherwise — the backend defaults to 8 and only persists it for Tonk). **Remove** the `gameOptions: {}` field from the payload (it is dead — never read by the backend; verified zero backend references). The `gameOptions` property is optional-absent in the request object literal we build; the interface field stays as-is on `origin/main` and is out of scope to remove.

> `CreateGameRequest.gameOptions` is currently typed non-optional (`gameOptions: { [key: string]: string }`, `model.ts:16`). Removing it from the sent literal will not type-check unless the field is optional. **Decision:** the implementer makes `gameOptions?` optional in `model.ts` (minimal, additive, no backend impact since it is unread) so the literal can omit it. This is the smallest change that satisfies "stop sending the dead `gameOptions`". Flag for design-reviewer: if making it optional is considered out-of-scope, the fallback is to keep sending `gameOptions: {}` and only ADD `deckRoundsTarget` — the acceptance criterion "send `deckRoundsTarget`" is still met. Recommended: make it optional and omit.

### A3. Lobby (game-type-aware, 8-player no-scroll)

- `GameLobbyView` gains two props: `gameType: GameType` and `minPlayers: number` (passed from `GameView`).
- **Header:** add a game-type badge next to the title — `gameTypeLabel(gameType) · "up to " + maxPlayers`. Badge color keyed by type via `data-type` (Tonk = cyan accent, Big 2 = gold), per mockup `.lobby__type-badge`. `maxPlayers` is already a prop.
- **Count line:** `Players {count} / {maxPlayers}` (mockup `.lobby__count`), always visible.
- **Start gate:** `canStart = isHost && players.length >= minPlayers`. When disabled and below min, show the hint "{label} needs at least {minPlayers} players to start ({minPlayers - count} more)" (mockup `.lobby__hint`). Big 2 (min 2) is unaffected: at 2 players Start enables exactly as today.
- **8-player no-scroll (hard requirement):** see State Model / Edge Cases E5. The player list is a contained, internally-scrollable region with a capped max-height; the panel itself never forces the page to scroll. Seat rows keep their size; overflow scrolls **within** `.lobby__players`, not the page.

### A4. `gameType` data flow into the lobby

`GameView.vue` already fetches the full `SerializableGame` from `/api/getGameState` on mount (line 254), which includes `gameType` (`model.ts:51`). Add `const gameType = ref<GameType | null>(null)` (or default `"big2"` until loaded), set it from `game.gameType`, derive `minPlayers` from the bounds map, and pass both into `<GameLobbyView>`. No socket-payload change is needed because the lobby is only rendered in the `CREATED` display phase, which is driven by the REST-seeded state; `lobby:state` updates only `players`/`maxPlayers`/`joinCode`, none of which affect the type.

---

## Interfaces / Types

### Shared frontend bounds helper (new)

```ts
// per-game-type presentational bounds — mirrors server-authoritative engine config.
// NOT game rules: the server validates and rejects; this only shapes inputs/labels.
export interface GameTypeUiBounds {
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly hasDeckRoundsTarget: boolean;
}

export const GAME_TYPE_UI_BOUNDS: Record<GameType, GameTypeUiBounds> = {
  big2: { minPlayers: 2, maxPlayers: 4, hasDeckRoundsTarget: false },
  tonk: { minPlayers: 3, maxPlayers: 8, hasDeckRoundsTarget: true },
};
```

### `CreateGameView.vue` reactive state (additions)

```ts
const deckRoundsTarget = ref<number>(8); // Tonk only; 5..12
// bounds derived from selected gameType via GAME_TYPE_UI_BOUNDS
```

Submitted request (Tonk example):
```ts
const req: CreateGameRequest = {
  gameType: "tonk",
  maxPlayers: maxPlayers.value,
  turnTimerSeconds: turnTimerSeconds.value,
  deckRoundsTarget: deckRoundsTarget.value, // omitted for big2
};
```

### `GameLobbyView.vue` props (additions in **bold**)

```ts
defineProps<{
  gameId: string;
  players: readonly PlayerInfo[];
  maxPlayers: number;
  minPlayers: number;   // NEW — drives the Start gate (Tonk 3, Big2 2)
  gameType: GameType;   // NEW — drives the type badge/label
  isHost: boolean;
  actionPending: boolean;
  joinCode: string;
}>();
```

```ts
const canStart = computed(
  () => props.isHost && props.players.length >= props.minPlayers,
);
const playersNeeded = computed(
  () => Math.max(0, props.minPlayers - props.players.length),
);
const typeLabel = computed(() => gameTypeLabel(props.gameType));
```

No `CreateGameRequest`/`SerializableGame`/`GameConfig` changes (already on `origin/main`). The only shared-type change is making `CreateGameRequest.gameOptions` optional (A2), if that fallback path is not chosen.

---

## State Model

All state is client-side UI state; nothing new is persisted. The server remains authoritative.

| State | Where | Persisted? | Notes |
| --- | --- | --- | --- |
| `gameType` (create) | `CreateGameView` ref | No | Drives range bounds + deck control visibility + payload. |
| `maxPlayers` (selected count) | `CreateGameView` ref | Sent in request | Re-clamped on type change; server re-validates. |
| `deckRoundsTarget` | `CreateGameView` ref | Sent for Tonk only | Range 5–12, default 8; server validates (`createGame.ts`) and persists into `games.game_config` JSONB. |
| `gameType` (lobby) | `GameView` ref ← REST `getGameState` | No (already persisted server-side) | Read from `SerializableGame.gameType`; passed to lobby. Not in `lobby:state` payload. |
| `minPlayers` (lobby) | derived in `GameView` from bounds map | No | Drives Start gate. |
| `players`, `maxPlayers`, `joinCode` (lobby) | existing refs ← REST + `lobby:state` | No | Unchanged. |

**Flow:** create form POST `/api/createGame` → server validates `maxPlayers` (truthy) and `deckRoundsTarget` ∈ [5,12] and persists `game_config` → navigate to `/game/:id` → `GameView` GETs `getGameState` (gets `gameType`, `maxPlayers`) → renders `GameLobbyView` with type-aware label/gate. Live player joins arrive via `lobby:state`/`lobby:playerJoined` (existing), updating only `players`.

---

## Edge Cases

| # | Case | Handling |
| --- | --- | --- |
| E1 | Switch Tonk→Big 2 while count is 5–8 | Re-clamp count down to 4 (`clamp(count, 2, 4)`); range `max` updates to 4; deck control hides. |
| E2 | Switch Big 2→Tonk while count is 2 | Re-clamp up to Tonk min 3 (`clamp(count, 3, 8)`); range `min` updates to 3; deck control reveals at default 8. |
| E3 | `deckRoundsTarget` value carried across a Tonk→Big 2→Tonk toggle | Keep the last selected value in the ref (do not reset to 8 on hide); it is simply not sent while Big 2 is selected. Acceptable per CX; resetting is also acceptable but unnecessary. |
| E4 | Submit with no game type selected | Existing behavior: submit button disabled while `!gameType`. Unchanged. |
| E5 | **Lobby with 8 players (Tonk max)** | The page MUST NOT scroll. `.lobby__players` becomes a contained region: `max-height` capped relative to viewport (e.g. `max-height: calc(100vh - <header+chip+actions+invite reserve>)` or a fixed cap such that 8 rows + header/chip/start/invite fit), `overflow-y: auto`, with the panel still vertically centered. The panel must not exceed `100vh`; if content would exceed, only the player list scrolls internally (chip, Start, invite stay visible). Verify at 8 filled seats AND at 3 filled + 5 empty (8 total rows) — both must fit with no page scrollbar. |
| E6 | Big 2 lobby regression | With `minPlayers = 2`, Start enables at 2 players exactly as before; badge shows "Big 2 · up to 4"; 4-row list fits trivially. No Tonk assumption leaks in. |
| E7 | `gameType` not yet loaded (REST in flight) | `GameView` shows the existing "Connecting…" state until `initialized`/`restStatus` resolves, OR defaults `gameType` to `"big2"`. Recommended: keep the existing loading gate so the lobby renders only after `getGameState` returns (it already gates the lobby behind `effectiveStatus !== 'CREATED'` loading). Ensure the badge/gate never render with a stale/wrong type — derive from the REST value set before lobby render. |
| E8 | Server rejects out-of-range `maxPlayers`/`deckRoundsTarget` (tampered client) | Existing error handling in `createGame()` surfaces the `BadRequestError` message in `errorMessage`. No client-side rule enforcement beyond input shaping. |
| E9 | Unknown/forward game type | `gameTypeLabel` already falls back to the raw value; bounds map lookup should fall back safely (e.g. treat missing as `{min:2,max:8}`) — but since only `big2`/`tonk` exist, a strict `Record<GameType,...>` is sufficient. |

---

## Dependencies

| Dependency | Status | Use |
| --- | --- | --- |
| `src/shared/model.ts` — `CreateGameRequest.deckRoundsTarget?`, `GameConfig` | On `origin/main` (verified) | Field to send; no change except optional `gameOptions` (A2). |
| `src/backend/api/game/createGame.ts` — `deckRoundsTarget` validation [5,12], persists `game_config` | On `origin/main` (verified) | Server-authoritative validation + persistence. |
| `src/frontend/component/statsView.ts` — `gameTypeLabel`, `GAME_TYPE_LABELS` | Implemented | Reuse for the lobby type label; host the new bounds map here or alongside. |
| `src/backend/engine/big2/big2-engine.ts:36` ("2-4"), `tonk/tonk-engine.ts:63` ("3-8") | Implemented | Authoritative player bounds the UI mirrors. |
| `src/frontend/component/game/GameView.vue` | Implemented | Source of `gameType` (from REST `getGameState`); passes new props to lobby. |
| LLD 65 §9.1 (Tonk 3–8), §8.8/§9.9 (`deckRoundsTarget` 5–12 default 8 creator control) | Signed off | Bounds + control spec of record. |
| Approved mockup `docs/mockups/tonk-create-game-and-lobby.html` (Direction B) on `lld-96` | Approved | Visual contract. |

No backend, DB, migration, or socket-event work in this LLD.

---

## Frontend Design

Match **Direction B** (segmented stepper) from the approved mockup. Token names and class structure below mirror `docs/mockups/tonk-create-game-and-lobby.html` and existing component styles.

### Create form

- **Game Type** `<select>`: existing styling (`.form-card__input`); add Tonk option.
- **Players**: `.range-head` (label left, live `.range-value` right) + `.form-card__range` input + `.range-scale` (min/max labels). `min`/`max` bound to active bounds.
- **Deck Length (Tonk-only, `v-if`)**: `.tonk-only` block with a left cyan rule (`--tonk-cyan`). Contains:
  - `.form-card__label` "Deck Length (rounds)".
  - `.seg` group (`role="group"`, `aria-label="Deck length in rounds"`) of 8 buttons `5..12`; selected button has `aria-pressed="true"` and gold fill; others muted. Clicking sets the value and toggles `aria-pressed`. Default 8.
  - `.seg-meta` row: "shorter deck" / "default **8**" / "longer deck".
  - `.help-text`: "How many rounds the deck should last before it's recut. Discrete choice, 5–12, default 8."
- Reveal animation (`revealDown`) optional; respect `prefers-reduced-motion`.

### Lobby

- **Header** (`.lobby__header`): title + `.lobby__type-badge` showing `"{label} · up to {maxPlayers}"`. `data-type="tonk"` → cyan; `data-type="big2"` → gold.
- **Room code chip**: unchanged.
- **Count line** (`.lobby__count`): `Players {count} / {maxPlayers}`.
- **Player list** (`.lobby__players`): existing filled + `--empty` rows; mockup adds a status `dot` and a `Host` tag — these are nice-to-have polish, not acceptance-gating; the implementer may include them to match the mockup but the load-bearing requirement is the no-scroll containment.
- **Start** (`.lobby__btn--start`): disabled unless `canStart`. Below-min hint (`.lobby__hint`): "{label} needs at least {minPlayers} players to start ({playersNeeded} more)".
- **Invite**: unchanged.

### 8-player no-scroll (load-bearing — mockup did not show 8 players)

The mockup only rendered 5-row lobbies. Tonk allows 8, so the LLD specifies the containment the implementation MUST provide:

- The lobby panel stays vertically centered (existing `.lobby` flex-center) and must not exceed `100vh`.
- `.lobby__players` gets a capped height and `overflow-y: auto` so the **list** scrolls internally when rows exceed the cap; the chip, count line, Start button, hint, and invite controls remain visible without page scroll. Concretely: give `.lobby__players` a `max-height` derived so that 8 rows + the surrounding panel chrome fit within the viewport on a typical phone and desktop; on small viewports prefer scaling row padding/font down slightly (the mockup's `@media (max-width:767px)` already reduces panel padding) before allowing internal scroll.
- Acceptance: with 8 player rows (any mix of filled/empty totalling `maxPlayers`), `document.scrollingElement.scrollHeight <= clientHeight` (no page scrollbar). This is the testable assertion in Test Requirements.

---

## Test Requirements

Per testing-principles: bias to automated tests; reserve manual steps for genuine visual/layout checks. Component logic is extracted/asserted as pure functions where possible (mirrors the existing `tests/frontend/gameLobbyView.test.ts` pattern of testing the component's logic as functions).

### Unit — bounds map & clamp logic
- `GAME_TYPE_UI_BOUNDS.big2 = {min:2,max:4}` and `.tonk = {min:3,max:8}`; `hasDeckRoundsTarget` true only for Tonk.
- Clamp-on-type-switch (the medium-testability area flagged in triage):
  - Tonk(count=7) → Big 2 ⇒ count clamps to 4.
  - Tonk(count=3) → Big 2 ⇒ count clamps to 3? No — clamps to 4-max/2-min ⇒ stays within [2,4] ⇒ 3 is valid, unchanged.
  - Big 2(count=2) → Tonk ⇒ count clamps up to 3.
  - Selecting a type from unselected seeds count to that type's `minPlayers`.

### Unit — create request shaping
- Tonk submit includes `deckRoundsTarget` (the selected 5–12 value); Big 2 submit omits `deckRoundsTarget`.
- The submitted request object does not include `gameOptions` (or, if the fallback path is taken, includes only `{}` plus `deckRoundsTarget` is absent for Big 2) — assert against the chosen A2 decision.
- `deckRoundsTarget` defaults to 8 before the user touches the stepper.

### Unit — lobby Start gate (regression-critical)
- Tonk: `canStart` false at 1 and 2 players, true at ≥3 (when `isHost`).
- Big 2: `canStart` true at exactly 2 players (NO regression) and false at 1.
- Non-host: `canStart` always false regardless of count.
- `playersNeeded` = `max(0, minPlayers - count)`; hint text reflects it.
- Type badge label = `gameTypeLabel(gameType) + " · up to " + maxPlayers` for both types.

### Component / DOM — 8-player no-scroll (load-bearing)
- Mount `GameLobbyView` with `gameType="tonk"`, `maxPlayers=8`, and 8 player rows (and separately 3 filled + 5 empty). Assert the rendered lobby root does not exceed viewport height and the page does not produce a vertical scrollbar (e.g. `.lobby__players` is the only scroll container; `scrollHeight <= clientHeight` on the page root). If a full DOM-layout assertion is impractical in jsdom (no real layout), specify a **manual** check at 1280×720 and 390×844 as the fallback, plus a structural assertion that `.lobby__players` has `overflow-y: auto` and a bounded `max-height`.

### Manual (visual only — minimal)
- Create form: switching Big 2 ⇄ Tonk reveals/hides the Deck Length stepper, snaps the Players range, and re-clamps a too-high/too-low count (acceptance demo). Matches Direction B mockup.
- Lobby at 8 seats: no page scroll; chip, Start, and invite remain visible (the layout requirement above; verify in a real browser per DEVELOPMENT.md "Manual test").

### Not tested (out of scope / framework)
- Server-side `deckRoundsTarget` validation, persistence, and `gameService` wiring (covered by LLD 95 tests on `origin/main`).
- Socket event plumbing (Socket.IO library behavior; `lobby:state` unchanged).
