# LLD 125: CPU/AI players incorrectly show as disconnected in game

## Scope

Fix a display-only defect: in any game containing AI/CPU seats, both board
components render a red "disconnected" label under every bot, because AI seats
never open a WebSocket and the backend correctly reports `isConnected: false`
for them. The label must be suppressed for AI seats while still appearing for
genuinely offline human opponents.

**In scope**

- `src/frontend/component/game-ui/OpponentRow.vue` (Big2 board) — guard the
  disconnected label.
- `src/frontend/component/game-ui/TonkSeatRail.vue` (Tonk seat rail) — guard the
  disconnected label.
- A frontend unit test covering both branches for both components.

**Explicitly NOT in scope**

- No backend changes. `injectConnectionStatus`
  (`socketHandler.ts:41-58`) and `connectionManager.isPlayerConnected`
  (`connectionManager.ts:144-149`) are correct: AI seats have no socket, so
  `isConnected: false` is accurate data. Do not touch them.
- No changes to the AI auto-play path (`shouldAutoPlay` / `autoPlayAbandoned`) —
  bots already take their turns correctly; this bug is purely cosmetic.
- Do not remove or refactor the existing disconnect logic, the `AiBadge`, the
  active-turn gold-glow border, the pulse indicator, or the `OpponentTimer`.
- No new props, no shared types changes, no new CSS tokens, no new components.
- The lobby has no disconnect indicator, so no lobby change is needed.

## Approach

The data reaching the client is already correct. `PlayerPublicInfo` carries both
`isConnected: boolean` and `isAi?: boolean` (`src/shared/engine-types.ts:89-90`),
and both are injected at the same serialization boundary. Both components already
read `isAi` a few lines above (it drives `<AiBadge v-if="...isAi" />`).

The fix is a guard addition on the existing `v-if`, so the label renders only for
seats that are **both** offline **and** human:

- `OpponentRow.vue:20`:
  `v-if="!player.isConnected"` → `v-if="!player.isConnected && !player.isAi"`
- `TonkSeatRail.vue:38`:
  `v-if="!seat.isConnected"` → `v-if="!seat.isConnected && !seat.isAi"`

`isAi` is optional (`boolean | undefined`); `!undefined === true`, so human seats
(where `isAi` is absent or `false`) keep their existing behaviour, and only
`isAi === true` seats suppress the label. This is the recommended and approved
direction — a two-line guard, no alternative approaches warranted.

Rationale for not centralizing into a helper: the change is a single boolean AND
on data already present in each template; extracting a helper would add
indirection for two one-line predicates. The `TonkSeatRail` seat object comes
from the pure `railSeats` helper (`tonkDisplay.ts`), which already propagates
both `isConnected` and `isAi`, so no derivation change is needed there either.

## Frontend Design

**Approved direction (confirmed in issue thread): recommended fix.**

- Guard the disconnected label so it only shows for genuinely offline **humans**.
- Two one-line template edits only; `isAi` is already in scope in both templates.
- Preserve unchanged: `AiBadge`, the `.opponent--active` / `.tonk-seat--active`
  gold-glow border, the pulse turn-indicator, and `OpponentTimer` gating.
- No visual tokens, styles, props, or components are added or removed. The
  `.opponent__disconnected` / `.tonk-seat__disconnected` styles stay as-is; only
  the condition under which the element mounts changes.
- No mockup review needed: this removes an erroneous label rather than
  introducing new UI. The only visible change is that bots no longer show the
  false red "disconnected" text; disconnected humans look exactly as before.

## Interfaces / Types

No new or changed types. Relies on existing `PlayerPublicInfo`
(`src/shared/engine-types.ts`):

```ts
interface PlayerPublicInfo {
  readonly playerId: string;
  readonly displayName: string;
  readonly cardCount: number;
  readonly isConnected: boolean;
  readonly isAi?: boolean; // derived server-side from gameConfig.aiPlayerIds
}
```

The Tonk seat row shape returned by `railSeats(...)` already carries
`isConnected` and `isAi` (`tonkDisplay.ts:113-135`); no signature change.

## State Model

No state change. The label's visibility is a pure render-time derivation of
already-broadcast public state:

```
showDisconnectedLabel(seat) = seat.isConnected === false && seat.isAi !== true
```

- `isConnected` is derived per-broadcast, server-side, from live socket presence
  (in-memory `connectionManager`) — not persisted. Accurate for AI seats
  (always `false`).
- `isAi` is derived server-side from `gameConfig.aiPlayerIds` at the same
  serialization boundary — accurate.

Nothing is persisted or cached differently by this change.

## Edge Cases

1. **AI seat, `isConnected: false` (the bug):** label suppressed
   (`!false && !true` → `true && false` → false). Fixed.
2. **Human seat, `isConnected: false`:** label shown (`isAi` absent/false →
   `!false && !undefined` → `true`). Unchanged — preserves existing behaviour.
3. **Human seat, `isConnected: true`:** no label (unchanged).
4. **AI seat, `isConnected: true`:** would never happen (bots have no socket),
   but the guard still yields no label — harmless and correct.
5. **`isAi` absent (`undefined`) on a human seat:** `!undefined === true`, so the
   guard collapses to the original `!isConnected` — no regression for the common
   human-only game.
6. **Active AI seat (bot is to act):** gold border, pulse, and `OpponentTimer`
   remain (those are gated on `isActive`, independent of this guard); only the
   disconnected label is suppressed.
7. **Local player:** already filtered out of `OpponentRow` (`myPlayerIndex`) and
   `railSeats`, so unaffected.

## Dependencies

- LLD 118/120 (AI-seat foundation) — provides `isAi` on `PlayerPublicInfo` and
  the `injectBoardAi` serialization path. Already shipped (#137/#138).
- No other LLDs block this. Purely a frontend guard on existing data.

## Test Requirements

Follow the established project pattern for these components: pure-function unit
tests under `tests/frontend/` in the `node` environment, transcribing the
template `v-if` predicate as a small pure function — no DOM mount, no
`@vue/test-utils`, no jsdom (matches `tests/frontend/OpponentRow.test.ts` and
`tests/frontend/aiBadgeRendering.test.ts`; testing-principles §1). This keeps the
test aligned with the vitest config (`include: tests/**/*.test.ts`,
`environment: "node"`) with no new tooling.

**Unit (required by acceptance criteria) — new test file (e.g.
`tests/frontend/disconnectedLabel.test.ts`):**

Define a predicate mirroring the guarded `v-if`:
`showsDisconnected(seat) = seat.isConnected === false && seat.isAi !== true`,
and assert it covers both components (Big2 `OpponentRow` and Tonk
`TonkSeatRail`, which share the same `PlayerPublicInfo` fields):

- AI seat with `isAi: true, isConnected: false` → label NOT shown (returns
  false). *(Big2 and Tonk.)*
- Human seat with `isConnected: false` (no `isAi`) → label STILL shown
  (returns true). *(Big2 and Tonk.)*
- Human seat with `isAi: false, isConnected: false` → label shown.
- Connected seat (AI or human), `isConnected: true` → label not shown.

**Regression guard (recommended):**

- Keep it self-contained (testing-principles §3): construct each
  `PlayerPublicInfo` inline per `it` block, no shared mutable state.

**Not needed:**

- No backend/integration tests — no backend behaviour changes.
- No DOM-mount / visual test — the render decision is fully captured by the
  boolean predicate; testing-principles §5 (bias against manual tests) applies.
- Manual verification is optional (open a game with an AI seat, confirm no red
  label under bots; disconnect a human, confirm their label appears).
