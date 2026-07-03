# LLD 128: Polish — AI opponent naming and avatars (optional / deferrable)

Parent: #127. Order 3 of 3. Depends on LLD 118 (backend AI foundation, **merged #137**) and LLD 120 (create-game + lobby/board AI labels, **merged #138**).

## Scope

Aesthetic-only polish on top of the merged AI-seat feature. Three parts:

1. **Backend naming.** Replace the `CPU ${n}` `displayName` assignment in `GameService.addAiSeats` with a curated, deterministic, ordinal-assigned name pool (Ace, Bishop, Cortex, Domino, Echo, Fable, Gambit).
2. **Frontend avatar.** Add a shared inline-SVG geometric bot glyph in a ringed disc (**Direction B**, the approved mockup direction) as the bot visual identity, rendered on all four bot surfaces: create-game preview, lobby, Big2 `OpponentRow`, Tonk `TonkSeatRail`.
3. **Create-game convenience.** Add an optional "Fill remaining seats" shortcut (sets `numAiSeats = maxPlayers - 1` in one tap) plus a live table preview of the assigned bot names.

**Explicitly does NOT cover / must not change (locked by #137/#138):**

- Game logic, turn-driving (`shouldAutoPlay`/`autoPlayAbandoned`), the start gate, stats/history exclusion — untouched.
- The server-side `isAi` derivation, the `injectBoardAi`/`buildLobbyPlayers` helpers, `SerializableGame`, `PlayerInfo`/`PlayerPublicInfo` shapes — **no type or socket-field change** (see Approach A on why the name pool needs none).
- The LLD 120 blue `CPU` badge (`AiBadge.vue`) and the gold turn glow — both remain; the avatar sits *on top of* that identity system, it does not replace the badge.
- Any migration or schema change; any change to `numAiSeats` request handling or validation (LLD 120).

This increment may be dropped without leaving #127 incomplete.

## Approach

### A. Backend name pool (`GameService.addAiSeats`)

The only backend change is the per-seat `displayName` string. In `addAiSeats` (`src/backend/service/gameService.ts`, currently line 259) replace:

```ts
const displayName = `CPU ${existingAiCount + i + 1}`;
```

with an ordinal lookup into a module-level constant pool:

```ts
const AI_NAME_POOL = ["Ace", "Bishop", "Cortex", "Domino", "Echo", "Fable", "Gambit"] as const;
// ordinal = existingAiCount + i (0-based); stable per seat, matches existing numbering.
const displayName = aiNameForOrdinal(existingAiCount + i);
```

`aiNameForOrdinal(ordinal)` is a pure exported helper:
- `ordinal < pool.length` ⇒ `pool[ordinal]`.
- `ordinal >= pool.length` ⇒ cycle with a numeric suffix so names stay unique and stable: `` `${pool[ordinal % pool.length]} ${Math.floor(ordinal / pool.length) + 1}` `` (e.g. ordinal 7 → "Ace 2"). The pool of 7 already covers the largest table (Tonk, 8 seats ⇒ ≤ 7 bots), so the cycle path is a defensive fallback, not a normal case.

**Why no new type and no new socket field.** Identity keys off the server-side `isAi` flag from LLD 120 (derived from `gameConfig.aiPlayerIds`), never off the display string. The name pool is *just a different string* written to the same `playerDisplayNames` map that already flows through every view. Collisions with human names are therefore safe (LLD 120 Edge Case 10 stands: a human literally named "Ace" still shows no badge/avatar because its id is not in `aiPlayerIds`). Determinism (principle: server-authoritative, reproducible) holds because assignment is a pure function of the seat ordinal — no randomness, no `Math.random`.

**Rematch interaction (unchanged).** `createRematch` already strips `practice`/`aiPlayerIds`; a rematched game has no AI seats, so the pool is irrelevant there. No change.

### B. Frontend bot avatar — Direction B (shared glyph atom)

Add one presentational atom, `src/frontend/component/game-ui/AiAvatar.vue`, rendering the approved Direction B glyph: a single **shared** inline-SVG procedural bot "face" (rounded-rect head, two eye dots, a top antenna dot) centered in a dark disc ringed in `--ai-accent`. The glyph is identical for every bot — individuality comes from the *name*, not the glyph; the glyph marks a consistent "bot species".

- **Asset-free.** Inline SVG + CSS only. No robot emoji, no icon font (respects the LLD 120 constraint).
- **Props:** an optional `size?: "sm" | "md"` (default `md`). `sm` (≈26px) is used on the dense board/lobby rows; `md` (≈34px) on the create-game preview chips. Keep it minimal — no other props.
- **Non-interactive:** `aria-hidden="true"` on the whole avatar (the adjacent `CPU` badge text is the accessible label; the avatar is decorative). `data-testid="ai-avatar"`.
- **Layout safety:** `flex-shrink: 0` so it never clips when the name ellipsizes on a mobile row.
- **Tokens:** uses existing `--ai-accent`. The glyph disc fill/ring use the mockup's cool-blue values. **Two new tokens** are added to `:root` in `src/frontend/styles/game-variables.css` (present in the approved mockup but not yet in the real stylesheet): `--ai-accent-line: rgba(127, 178, 255, 0.5)` (ring/border) and `--ai-accent-dim: rgba(127, 178, 255, 0.16)` (soft fill/halo). No other token changes.

The avatar is rendered next to the seat name on every surface, gated on the **existing** `isAi` flag (already threaded by LLD 120):

- **Lobby** (`GameLobbyView.vue`): `<AiAvatar size="sm" v-if="player.isAi" />` before the name in `.lobby__player`.
- **Big2** (`OpponentRow.vue`): `<AiAvatar size="sm" v-if="player.isAi" />` inside `.opponent__info` beside `.opponent__name` (next to the existing `<AiBadge>`).
- **Tonk** (`TonkSeatRail.vue`): `<AiAvatar size="sm" v-if="seat.isAi" />` in `.tonk-seat__info` beside `.tonk-seat__name`. `SeatRow.isAi` is **already** propagated by `railSeats()` (LLD 120) — no `tonkDisplay.ts` change needed.
- **Create-game preview** (`CreateGameView.vue`, part C): `<AiAvatar />` (md) in each preview chip.

The existing `<AiBadge>` stays on all three game surfaces — avatar + badge appear together. The gold turn glow (`.opponent--active` / `.tonk-seat--active` border + pulse) is untouched.

**Turn-signal / identity separation (hard constraint).** Warm gold (`--gold-accent #c9a84c`, turn) and cool blue (`--ai-accent #7fb2ff`, identity) occupy separate hue lanes and separate roles (turn = border+pulse; identity = avatar+badge). An active bot seat shows both simultaneously with no collision (Edge Case 1). This must be visually verified (Test Requirements → Manual).

### C. Create-game convenience (`CreateGameView.vue`)

Additive to the existing stepper (LLD 120); the stepper stays. No new request field — the button and preview are pure client-side conveniences over the existing `numAiSeats` ref.

- **"Fill remaining seats" button.** Rendered in the AI-seats field (only when `showAiSeats` is true, i.e. registered host + a game type chosen). One tap sets `numAiSeats = maxAiSeats` (`= maxPlayers - 1`). Disabled when already at `maxAiSeats`. `data-testid="ai-seats-fill"`.
- **Live table preview.** When `numAiSeats >= 1`, render a list of the bot names that will be seated: `aiNameForOrdinal(0 .. numAiSeats-1)` — the same pure helper as the backend, imported from `@shared` (see Interfaces). Each row is a chip with the `<AiAvatar />` glyph + the name. `data-testid="ai-seats-preview"`, each chip `data-testid="ai-seats-preview-chip"`.
- **At `numAiSeats === 0`:** no preview renders; the Fill button is present but the form is otherwise byte-for-byte the LLD-120 form (CTA "Create Game", no practice note). This is the human-only regression case.
- The `createGame()` request body is unchanged — `numAiSeats` is still included only when `> 0`.

**Name-pool sharing.** So the create-game preview matches the names the backend actually assigns, `aiNameForOrdinal` and `AI_NAME_POOL` live in `src/shared/` (imported by both `gameService.ts` and `CreateGameView.vue`), consistent with the shared-code convention (`@shared/*`). This is the single new shared module; it contains no game logic, only the deterministic naming function.

## Interfaces / Types

**`src/shared/aiNames.ts`** — new pure module (no game logic):

```ts
export const AI_NAME_POOL = [
  "Ace", "Bishop", "Cortex", "Domino", "Echo", "Fable", "Gambit",
] as const;

/** Deterministic AI display name for a 0-based AI-seat ordinal. */
export function aiNameForOrdinal(ordinal: number): string;
```

**`src/backend/service/gameService.ts`** — internal change only: import `aiNameForOrdinal`; use it in the `addAiSeats` loop in place of the `CPU ${...}` literal. No signature change.

**`src/frontend/component/game-ui/AiAvatar.vue`** — new presentational atom:

```ts
defineProps<{ size?: "sm" | "md" }>(); // default "md"
```

**`src/frontend/component/CreateGameView.vue`** — add `fillAiSeats()` method, an `aiPreviewNames` computed (`Array.from({ length: numAiSeats }, (_, i) => aiNameForOrdinal(i))`), the Fill button, and the preview block. No `<script>` prop or request-shape change.

**No changes** to `src/shared/model.ts`, `src/shared/engine-types.ts`, `SerializableGame`, socket payloads, `socketAiUtils.ts`, `tonkDisplay.ts`, or `AiBadge.vue`.

## Frontend Design

**Approved direction: naming + Direction B + Fill button (LOCKED).** The frontend-architect mockup gate is cleared — the owner approved "naming + direction B + fill button" on issue #136 (2026-07-02). The approved mockup is `ai-opponent-naming-and-avatars.html` (source on branch `lld-121-ai-opponent-naming-and-avatars`). **Do not re-run the mockup step.** Note the mockup document's own written "Recommendation" favored Direction A (monogram); the *owner's selection overrides it* — build **Direction B** (the geometric bot glyph), not A, and not the suit-token Direction C (rejected: suit pips can be misread as game state on a busy board).

**Bot identity palette.**
- `--ai-accent: #7fb2ff` (already present, LLD 120).
- **New:** `--ai-accent-line: rgba(127, 178, 255, 0.5)`, `--ai-accent-dim: rgba(127, 178, 255, 0.16)`.
- Chosen to never collide with the warm `--gold-accent (#c9a84c)` turn glow.

**`AiAvatar.vue` (Direction B glyph):**
- A disc: `border-radius: 50%`, dark radial fill (`radial-gradient(circle at 35% 30%, #12305c, #0a1a33)`), `1.5px` ring in `--ai-accent`, soft outer halo `box-shadow: 0 0 0 2px var(--ai-accent-dim)`.
- Inside, a centered inline SVG (viewBox `0 0 24 24`, `stroke="var(--ai-accent)"` — or the literal `#7fb2ff` since SVG stroke cannot read a CSS var inside scoped styles unless bound; bind via `currentColor` with the disc setting `color: var(--ai-accent)`): rounded-rect head `rect x=5 y=7 w=14 h=11 rx=3`, two filled eye dots `circle cx=9.5/14.5 cy=12.5 r=1.4`, antenna `line x1=12 y1=4 x2=12 y2=7` + dot `circle cx=12 cy=3.5 r=1`. Glyph fills ≈60% of the disc.
- `size="sm"` ≈26px disc (board/lobby); `size="md"` ≈34px (create preview).
- `flex-shrink: 0`; `aria-hidden="true"`; `data-testid="ai-avatar"`.

**Lobby (`GameLobbyView.vue`):** avatar (sm) before the name inside `.lobby__player`; badge stays after the name. Human rows unchanged. Avatar is `flex-shrink: 0`; name keeps ellipsis behavior; badge and avatar never clip on mobile.

**Big2 board (`OpponentRow.vue`):** avatar (sm) beside `.opponent__name` in `.opponent__info`. `.opponent--active` gold border/pulse untouched. An active bot shows gold glow + blue avatar + CPU badge together.

**Tonk board (`TonkSeatRail.vue`):** avatar (sm) beside `.tonk-seat__name`. Compact/wrapping rail behavior (6+/7+ seats) and turn/phase/tally styling untouched. Full 8-seat table (1 human + 7 bots) must stay readable at density.

**Create-game (`CreateGameView.vue`):** existing stepper + practice note kept. Add the Fill button in the AI-seats field and, when `numAiSeats >= 1`, the live name preview (avatar md + name chips). At 0: no preview; form unchanged. This is the only create-game visual change and is covered by the approved mockup.

**Reduced-motion / mobile:** avatar is static (no animation) — no `prefers-reduced-motion` handling needed. Existing pulse animations are unchanged.

## State Model

- **Persisted (Supabase `games` row):** `playerDisplayNames[aiId]` now holds a pool name ("Ace") instead of "CPU 1". Written by `addAiSeats` exactly as before (same code path, different string). `game_config.aiPlayerIds`/`practice` unchanged. No schema/migration change.
- **In-memory (engine `InternalGameState`):** unchanged. The engine remains AI-agnostic; names are ordinary display strings that flow through `startGame`'s `playerDisplayNames` mapping and the existing view builders. `isAi` still injected only at the socket boundary (LLD 120).
- **Client:** `AiAvatar` renders purely from the existing `isAi` display flag; `aiPreviewNames` is transient create-form state derived from `numAiSeats`. Nothing new persisted client-side.
- **Security boundary:** unchanged from LLD 120. `isAi` is still computed server-side from `aiPlayerIds`; the avatar/badge gate on that flag, never on the name string. A client cannot mark a human as AI by naming itself "Ace".

## Edge Cases

1. **Active bot seat (turn + identity together).** Shows gold border/pulse (turn) *and* blue avatar + CPU badge (identity). Warm vs cool, separate roles — no collision. Visually verified (Manual test).
2. **Full 8-seat Tonk table (1 human + 7 bots).** Bots named Ace…Gambit (7 names, exactly filling the pool). Compact rail drops the card fan; avatar keeps seats distinguishable. Must render cleanly without wrapping breakage.
3. **`numAiSeats` beyond the pool (defensive).** Cannot occur in normal play (max 7 bots ≤ pool size), but `aiNameForOrdinal` cycles with a numeric suffix ("Ace 2") so names remain unique and deterministic if a larger table is ever configured.
4. **Human display name collides with a pool name** (e.g. a human literally named "Cortex"). The human shows no avatar/badge — identity keys off `isAi` (id ∈ `aiPlayerIds`), not the string (LLD 120 Edge Case 10 unchanged).
5. **Human-only game (`numAiSeats === 0`).** No `aiPlayerIds` ⇒ every seat `isAi` falsy ⇒ no avatars, no badges. Create form byte-for-byte the LLD-120 form. Primary regression case.
6. **Mobile lobby row.** Avatar `flex-shrink: 0`; the name ellipsizes; avatar, name, badge, and Remove/host controls never clip.
7. **Rematch of a practice game.** `createRematch` strips AI markers ⇒ fresh human-only game ⇒ no avatars/names-from-pool. No change needed (LLD 120 Edge Case 9 stands).
8. **Create-game preview vs actual seats.** Preview uses the same `aiNameForOrdinal` as the backend, so previewed names match seated names exactly (ordinal-aligned). If the two ever diverge it is a bug caught by the shared-helper test.
9. **Fill button at max.** When `numAiSeats === maxAiSeats`, the Fill button is disabled (idempotent no-op if somehow invoked, since it clamps to `maxAiSeats`).
10. **`maxPlayers` lowered after Fill.** The existing `watch(maxPlayers)` clamp (LLD 120) already re-clamps `numAiSeats` down; the preview shrinks accordingly. No new handling.

## Dependencies

- **Must exist (merged):** LLD 118 (#137) — `addAiSeats`, `aiPlayerIds`, AI turn-driving, stats exclusion. LLD 120 (#138) — the `isAi` server derivation, `AiBadge.vue`, the badge wiring in `GameLobbyView`/`OpponentRow`/`TonkSeatRail`, `SeatRow.isAi` in `tonkDisplay.ts`, the create-game stepper and `numAiSeats` request/validation. **This LLD consumes all of them and must not modify game logic, turn-driving, stats exclusion, `isAi` derivation, or the create request shape.**
- **Existing tokens:** `--ai-accent` in `game-variables.css`.
- **No new migration, no new shared type beyond `aiNames.ts`, no socket-payload change.**

## Test Requirements

Automated unless inherently visual. Follow testing-principles: pure-function tests, self-contained, no shared state.

### Unit — naming (`src/shared/aiNames.ts`)
- `aiNameForOrdinal(0..6)` returns Ace…Gambit in order (deterministic, matches pool).
- `aiNameForOrdinal(7)` cycles to "Ace 2"; `aiNameForOrdinal(13)` → "Gambit 2" (uniqueness + stability past the pool).
- Same ordinal always returns the same name (no randomness).

### Unit — backend (`gameService.addAiSeats`)
- Seating `n` bots assigns `playerDisplayNames[aiId]` = `aiNameForOrdinal(existingAiCount + i)` for each, in order (e.g. first 3 bots → Ace, Bishop, Cortex). Assert no `"CPU "` string is produced.
- Regression: `aiPlayerIds`/`practice` still set exactly as before; `addAiSeats` still throws `GAME_FULL`/`INVALID_AI_COUNT`/`GAME_ALREADY_STARTED` on the same conditions (behavior unchanged apart from the name string).

### Unit — frontend
- `AiAvatar.vue`: renders the inline SVG glyph and disc; `aria-hidden="true"`; `data-testid="ai-avatar"`; no emoji / no icon-font element; honors `size` (sm vs md class).
- `GameLobbyView`, `OpponentRow`, `TonkSeatRail`: a seat with `isAi: true` renders exactly one `AiAvatar` (alongside the existing `AiBadge`); a human seat renders neither. An active (turn) bot still carries the gold active class **and** the avatar + badge.
- `CreateGameView`: Fill button sets `numAiSeats = maxPlayers - 1`; disabled at max. Preview lists `aiNameForOrdinal(0..numAiSeats-1)` (chip count = `numAiSeats`) when `>= 1` and is absent at 0. Preview names match the shared helper. Request body still includes `numAiSeats` only when `> 0` (regression). Fill/preview not rendered for a guest or with no game type selected.

### Manual (visual only — cannot be asserted in DOM)
- On Big2 and Tonk, confirm an active bot seat shows the gold turn glow and the blue avatar + CPU badge simultaneously with no visual collision (warm vs cool lanes).
- Confirm the full 8-seat Tonk table (1 human + 7 bots) renders cleanly (no wrap/overflow breakage) and each bot's name + avatar is legible.
