# LLD 94: Record loss-centric stats for Tonk on game completion (StatsService reads breakdown.trueLoser)

Parent issue: #60 (order 2 of 4). Small, additive, backend-only.

## Scope

**Covers:** Making `StatsService.recordGameCompletion` (`src/backend/service/statsService.ts`)
derive win/loss correctly for **loss-centric** games (Tonk). Tonk has exactly ONE loser per
completed game — the TRUE LOSER (joker-drawer). Everyone else won, **including** players whose
final tally also crossed 150. Today the service derives win/loss purely from `state.winner`
(single-winner model), which records every non-`winner` player as a loss — wrong for Tonk
(it would record N-1 losses instead of exactly 1).

The fix: when a player's `PlayerScore.breakdown.trueLoser` field is **present**, derive
win/loss from it. When it's **absent** (Big2), keep the existing `state.winner` derivation
completely unchanged.

**Does NOT cover:**
- The `deckRoundsTarget` plumbing (separate issue under #60). This change is independent of it.
- Any frontend change.
- The Tonk average-score stat (per-game-type segmentation — that is LLD 66 / #78, separate).
- Changing the generic stats plumbing: the `incrementStats` RPC signature, the `StatsDelta`
  shape, the SQL migrations, or the guest-skip mechanism. Those are read/used as-is.
- Recomputing `trueLoser` — the engine already writes it (see State Model). We only READ it.

## Approach

`recordGameCompletion` iterates `state.scores` and builds a `StatsDelta` per non-guest player.
The only change is **how `gamesWon` / `gamesLost` are computed** for each player. Introduce a
small per-player branch:

1. Read `breakdown = playerScore.breakdown`.
2. If `breakdown` is present **and** has a `trueLoser` key (loss-centric path, Tonk):
   - `gamesLost = breakdown.trueLoser === 1 ? 1 : 0`
   - `gamesWon = 1 - gamesLost` (the complement)
3. Otherwise (single-winner path, Big2 — `breakdown` absent or has no `trueLoser` key):
   - keep the existing derivation **byte-for-byte**:
     - `gamesWon = playerScore.playerId === state.winner ? 1 : 0`
     - `gamesLost = playerScore.playerId !== state.winner ? 1 : 0`

`gamesPlayed` stays `1`. `totalScore` stays `playerScore.score` (unchanged pass-through —
for Tonk this is the final tally; for Big2 the placement score). The guest skip
(`if (this.isGuest(...)) continue;`), the early returns (`status !== "COMPLETED"`,
empty/null `scores`), the per-player try/catch, and `state.gameType` pass-through are all
untouched.

**Why detect on the `trueLoser` key, not on `state.gameType === "tonk"`:** The architecture
principle is server-authoritative, engine-owned outcomes. The engine already encodes the
loss-centric verdict in the per-player breakdown; keying off the data the engine produced
(rather than re-branching on game type in the service) keeps the service free of game-specific
rule knowledge and means a future loss-centric game gets correct stats with no service change.
It also makes the Big2 path provably untouched: Big2 `PlayerScore`s carry no `breakdown` at all,
so they can never enter the new branch.

**Why the complement (not "did this player also cross 150"):** This is the core correctness
point. In Tonk, multiple players can cross the 150 LOSE_THRESHOLD in the same match, but only
ONE of them (resolved by the engine's deterministic joker draw, `resolveMatchEnd`) is the TRUE
LOSER. All other 150-crossers still **won** for stats purposes. So `gamesWon` must be the
complement of `trueLoser`, NOT derived from `breakdown.lost` or the tally. Only `trueLoser`
distinguishes the single loser.

## Interfaces / Types

No type changes. The relevant existing shapes (read-only here):

```ts
// src/shared/engine-types.ts
interface PlayerScore {
  readonly playerId: PlayerId;
  readonly score: number;                       // Tonk: final tally; Big2: placement score
  readonly breakdown?: Record<string, number>;  // Tonk only; absent for Big2
}

// src/backend/database/database.ts — UNCHANGED
interface StatsDelta {
  gamesPlayed: number; // always 1
  gamesWon: number;    // 1 or 0
  gamesLost: number;   // 1 or 0
  totalScore: number;
}
```

Tonk's `breakdown` (written by `tonk-engine.ts` `completeMatch`) contains keys
`lost`, `trueLoser`, `finalTally` (all `0` or `1`/tally). This LLD reads only `trueLoser`.

Detection predicate (specification, not final code):

```ts
const breakdown = playerScore.breakdown;
const isLossCentric =
  breakdown !== undefined && breakdown.trueLoser !== undefined;

let gamesWon: number;
let gamesLost: number;
if (isLossCentric) {
  gamesLost = breakdown!.trueLoser === 1 ? 1 : 0;
  gamesWon = 1 - gamesLost;
} else {
  gamesWon = playerScore.playerId === state.winner ? 1 : 0;
  gamesLost = playerScore.playerId !== state.winner ? 1 : 0;
}
```

## State Model

No new state. No persistence-schema change. Data flow only:

- The Tonk engine (`tonk-engine.ts` → `completeMatch`) is the single source of truth for the
  TRUE LOSER. On match end it writes per-player `breakdown.trueLoser = (i === trueLoserIndex ? 1 : 0)`
  into `state.scores`. Exactly one seat has `trueLoser === 1`.
- `state.scores` (with breakdowns) is already persisted/cached as part of `InternalGameState`
  when the game transitions to `COMPLETED`. `StatsService` consumes it on that transition.
- `StatsService` is stateless; it reads the completed state and writes deltas via
  `statsRepo.incrementStats`. No in-memory state added.

## Edge Cases

1. **Multiple 150-crossers, one true loser (the headline Tonk case):** Several players have
   `breakdown.lost === 1`, but only one has `breakdown.trueLoser === 1`. Result: that one gets
   `gamesLost: 1, gamesWon: 0`; **every** other player (including the other 150-crossers) gets
   `gamesWon: 1, gamesLost: 0`. Driven entirely by `trueLoser`.
2. **Big2 completion (`breakdown` absent):** Predicate is false → existing `state.winner`
   derivation runs unchanged. Winner `gamesWon: 1`; the other three `gamesLost: 1`.
3. **`breakdown` present but lacks a `trueLoser` key:** Treated as single-winner path
   (predicate requires the `trueLoser` key specifically). This guards against a partial/foreign
   breakdown silently flipping the branch. (Not expected from current engines; defensive.)
4. **`trueLoser` present but not exactly 1 (e.g. 0):** Non-`1` ⇒ `gamesLost: 0, gamesWon: 1`.
   Only the literal value `1` marks the loser; this matches the engine's `i === trueLoserIndex ? 1 : 0`.
5. **Guest is the true loser (or a winner):** Guest is skipped by the existing `isGuest` check
   **before** the win/loss branch — no row written for guests regardless of outcome. Unchanged.
6. **Status not COMPLETED / empty `scores` / null `scores`:** Existing early returns fire before
   any per-player logic. Unchanged.
7. **`state.winner` for Tonk:** The engine sets `state.winner` to the lowest-tally seat (display
   only). The loss-centric path **ignores** `state.winner` entirely, so this display-only winner
   never corrupts Tonk stats.
8. **Per-player `incrementStats` throws:** Existing try/catch logs and continues to the next
   player. Unchanged.

## Dependencies

- **Exists already (no new dependency):**
  - `tonk-engine.ts` `completeMatch` writes `breakdown.trueLoser` — verified present
    (`src/backend/engine/tonk/tonk-engine.ts`, `completeMatch`).
  - `resolveMatchEnd` (`src/backend/engine/tonk/scoring.ts`) computes the single `trueLoserIndex`.
  - `PlayerScore.breakdown` field (`src/shared/engine-types.ts`).
  - `incrementStats` / `StatsDelta` (`src/backend/database/database.ts`) — used as-is.
- **No dependency on:** `deckRoundsTarget` plumbing, any frontend work, LLD 66 / #78
  (Tonk average-score). This LLD ships independently.

## Test Requirements

### Unit (`tests/service/statsService.test.ts`) — primary coverage

Extend the existing suite (keep its self-contained, no-shared-state style; build states inline).

- **Tonk: multiple 150-crossers, one true loser.** Construct a `COMPLETED` state with
  `gameType: "tonk"`, ≥3 players, `scores` where two players have `breakdown.lost === 1` but
  only ONE has `breakdown.trueLoser === 1`, and the rest have `trueLoser === 0`. Assert:
  - the true-loser player's delta is `gamesLost: 1, gamesWon: 0`.
  - **every** other player (including the second 150-crosser) gets `gamesWon: 1, gamesLost: 0`.
  - across all players exactly one `gamesLost` and `N-1` `gamesWon`.
  - derivation ignores `state.winner`: set `state.winner` to a NON-true-loser player and confirm
    that player still gets `gamesWon: 1` (proves `trueLoser`, not `winner`, drives it).
- **Tonk: `gamesPlayed` and `totalScore` pass-through.** Each player's delta has
  `gamesPlayed: 1` and `totalScore === playerScore.score` (the final tally). `StatsDelta` keys
  unchanged.
- **Big2 regression (existing path byte-for-byte).** A `big2` completed state with no
  `breakdown` on any score: winner gets `gamesWon: 1, gamesLost: 0`; non-winners get
  `gamesWon: 0, gamesLost: 1`. (The existing winner/non-winner tests already assert this; ensure
  they still pass unchanged — they are the regression guard.)
- **Defensive: `breakdown` present without `trueLoser` key** → falls to single-winner path
  (derives from `state.winner`).
- **Guest true loser is skipped.** A Tonk state where the true loser is a guest: `incrementStats`
  is not called for that guest; non-guest players still recorded with correct win/loss.

### Integration (`tests/integration/player-stats.test.ts`) — no new infra required

The existing A3 test ("separate big2 and tonk entries with non-bleeding counters") already
records a Tonk result directly via `incrementStats` and is unaffected. No new integration test is
mandatory for this change because driving a full Tonk game to completion through the socket layer
is out of scope here (Tonk actions UI / engine wiring tracked separately). If a Tonk
full-game integration smoke arrives later, it should assert: exactly one player has
`gamesLost: 1` and all others `gamesWon: 1` after completion. Note this as a follow-up, not a
blocker.

### Not tested

- Engine production of `trueLoser` (owned by Tonk engine tests, not this service).
- `incrementStats` SQL/RPC behavior (owned by `player-stats.test.ts` repo-level tests).
