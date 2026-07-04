# LLD 77a: Linked-Prod Drift Adapter (addendum to LLD 77 §5 / §9)

**Status: Design — docs only. No code in this LLD.** This is a focused addendum that
**completes LLD 77 §9's human-owned drift-gate wiring** (tracked as issue #91). LLD 77
designed the drift-gate *verdict logic* (`evaluateDriftGate`, §5.3) and shipped it
credential-free against fixtures. It deliberately left the `--linked` (live-prod) path a
**stub**: `scripts/verify-drift.mjs` runs `supabase db diff --linked --schema public`,
then hard-exits 2 with "supply a normalizer adapter to map it to `{ objects, pending }`".
This LLD designs that normalizer plus the surrounding wiring so `verify-drift.mjs --linked`
returns a real pass/fail verdict against live prod.

This addendum does **not** redesign the verdict logic (`scripts/lib/drift-gate.mjs`), the
push/verify/deploy stages, the post-condition runner, or the prod-shaped fixture — all
already built. It designs only the **adapter** that feeds `evaluateDriftGate` from a live
prod link, and the exact workflow edit that makes `supabase link` authenticate in CI.

---

## 0. Verified facts vs. assumptions (read this first)

The adapter parses the output of `supabase db diff --linked` and `supabase migration list
--linked`. **Nobody has run these against this prod project yet**, so the parse layer
carries real uncertainty. This section is the honest ledger; the design below is written to
be robust to the assumptions being wrong (fail-closed on any surprise), and §8 recommends a
one-time human capture to remove the uncertainty before merge.

### VERIFIED (against supabase.com/docs/reference/cli, fetched 2026-07-04)

- **V1 — `supabase db diff` emits SQL DDL text to stdout, not JSON.** "Output is written to
  stdout by default." The command runs a schema-diff engine (migra/pg-schema-diff) "to
  compare schema differences." *There is no JSON / machine-readable output flag for
  `db diff`.* (`supabase-db-diff`.)
- **V2 — `--linked` diffs LOCAL MIGRATION FILES against the linked (remote/prod) project.**
  Exact flag text: "Diffs local migration files against the linked project." The local
  migrations are the *desired/reference* state; the diff describes what the target (prod)
  would need to become to match them. (`supabase-db-diff`.)
- **V3 — no-diff output is a human-readable message, not empty / not JSON.** The documented
  sample ends with the line `No schema changes found`. (`supabase-db-diff`.)
- **V4 — `-f/--file` writes the diff to a *migration file*; `-o/--output` writes "explicit
  diff output to a file path".** Neither is a JSON toggle; both still emit SQL-diff text.
  (`supabase-db-diff`.)
- **V5 — `supabase migration list` (with `--linked`) compares local migration files against
  the remote `supabase_migrations.schema_migrations` history and prints a table with three
  columns: `LOCAL | REMOTE | TIME (UTC)`.** "Only the timestamps are compared to identify
  any differences." A row with a value in **LOCAL** and a **blank REMOTE** = "exists locally
  but not applied remotely" (i.e. *pending*). (`supabase-migration-list`.)
- **V6 — `supabase link` needs `SUPABASE_ACCESS_TOKEN` for non-interactive CI auth** (plus
  `--project-ref` and, for DB operations, `SUPABASE_DB_PASSWORD`). This matches the user's
  confirmation against the docs. The current workflow's `link`/`push` steps do **not** pass
  `SUPABASE_ACCESS_TOKEN`, so `link` cannot authenticate today (§6).

### ASSUMPTION (must be validated against a real prod diff before/at implementation)

- **A1 — the exact DDL statement grammar `db diff` emits for THIS project's drift class.**
  The residual-drift objects LLD 77 cares about are `constraint:<table>:<name>` and
  `grant:<role>:<table>:<PRIV>` (see fixtures). How `db diff` renders those as DDL
  (`ALTER TABLE ... ADD CONSTRAINT ...` vs `... DROP CONSTRAINT ...`; `GRANT ... TO anon`
  vs `REVOKE ...`; exact whitespace/casing/`ONLY` qualifier) is **not verified in-repo**.
  The parser (§4) is written against the *shapes we expect* and **fails closed on any
  statement it cannot classify** (§5), so an unknown shape blocks the release rather than
  passing silently.
- **A2 — the direction of the DDL for the residual class.** Because `--linked` treats local
  migrations as desired (V2), a *residual* object that exists on prod but is declared by no
  migration should appear in the diff as a statement that *removes it from prod's shape*
  (e.g. a `DROP CONSTRAINT` / `REVOKE` to make prod match local). A *pending* object
  (declared by an unapplied local migration, absent on prod) should appear as a statement
  that *adds it* (e.g. `ADD CONSTRAINT` / `CREATE` / `GRANT`). This directionality is the
  design's working model but is **not explicitly documented**; it must be confirmed on the
  first real capture (§8). The adapter's correctness for separating residual from pending
  leans on this — hence the belt-and-suspenders in A3.
- **A3 — whether `pending` can be derived from `db diff` at all, or must come from
  `migration list`.** The design does **not** try to infer `pending` from `db diff` DDL
  (too fragile, and it depends on A2). It derives `pending` from `supabase migration list
  --linked` (V5), which is an independent, purpose-built source. This is the load-bearing
  choice for the "green CI, broken prod via unapplied migration" property (the #156 failure
  class). See §4.2.
- **A4 — the migration version-key format for THIS repo.** Migrations are named
  `001_…`–`010_…` (sequential prefixes), **not** the Supabase-standard 14-digit timestamp.
  `migration list` "compares only the timestamps" (V5). Migrations 001–008 are already
  applied to prod (LLD 77 §3/§10), which proves the CLI accepts these prefixes as version
  keys — but the exact string the CLI shows in the `REMOTE`/`LOCAL` columns for a
  `001_…`-style file (the bare prefix `001`? the whole basename? something else?) is **not
  verified**. The `pending` parser (§4.2) normalizes on the version key the CLI actually
  prints and maps it back to the in-tree filename; the mapping rule is an assumption to
  confirm on first capture (§8). This is why §8's capture must include `migration list`
  output, not just `db diff`.

**Bottom line:** the *contract* (`{ objects, pending }`), the *sources* (`db diff` for
residual, `migration list` for pending), the *fail-closed discipline*, and the *workflow
auth edit* are finalizable now. The two things that **cannot** be finalized without a real
prod capture are the **DDL statement grammar** (A1/A2) and the **version-key string format**
(A4). §8 is the de-risking plan for both.

---

## 1. Scope

### In scope

- The adapter contract: raw CLI output → the `{ objects, expectedFromPending?, pending }`
  structured-diff shape that `verify-drift.mjs` already feeds to `evaluateDriftGate`.
- Where each field comes from: `objects` (residual) from `db diff --linked`; `pending` from
  `migration list --linked`. `expectedFromPending` handling (§4.3).
- The exact CLI/SQL calls, their ordering, and how their output is captured.
- The `SUPABASE_ACCESS_TOKEN` workflow edit (§6).
- Fail-closed behavior for every failure path (§5).
- Credential-free unit testing via captured raw-output fixtures (§7).

### Explicitly NOT in scope

- The verdict logic `evaluateDriftGate` (`scripts/lib/drift-gate.mjs`) — unchanged. The
  adapter produces its documented input shape; it does not alter its rules.
- The push / post-condition-verify / deploy stages (LLD 77 §6, §8) — already built; this
  addendum only completes the **drift-gate** step that precedes them.
- The prod-shaped fixture and post-condition runner (LLD 77 §6, §7) — already built.
- `#83`/`#75` prod drift cleanup itself — external, human-owned (LLD 77 §10). This adapter
  *reads* the post-cleanup baseline; it does not perform cleanup.
- Storing any secret in the repo. All prod credentials remain GitHub Secrets, injected by
  the operator (LLD 77 §9).

---

## 2. Approach (key decisions)

1. **Two independent sources, not one.** Residual drift comes from `db diff --linked`
   (schema shape); pending migrations come from `migration list --linked` (applied-history
   table). Deriving `pending` from the `db diff` DDL would be fragile (A2/A3) and would
   couple the "unapplied migration" detector to the DDL grammar. Keeping them separate means
   the #156 property (catch an unapplied migration) is guaranteed by a purpose-built CLI
   command, independent of how well we parse DDL.

2. **Parse-layer is a pure function, separated from the CLI invocation.** Mirroring how
   `drift-gate.mjs` is a pure module tested against fixtures, the adapter splits into:
   `scripts/lib/linked-diff-adapter.mjs` (pure: raw strings → `{ objects, pending }`) and the
   thin `--linked` branch in `verify-drift.mjs` (impure: runs the CLI, hands stdout to the
   pure module). This makes the risky parse logic (A1/A4) unit-testable credential-free
   against captured fixtures (§7).

3. **Fail closed on every ambiguity.** The parser classifies each DDL statement into a known
   residual shape or rejects it. An *unclassifiable* statement, an empty/short output that
   isn't the exact `No schema changes found` sentinel, a non-zero CLI exit, or an
   unparseable `migration list` table all cause a **non-zero exit** (release blocked). The
   adapter never emits a "best-effort" partial diff (§5). This is the direct consequence of
   LLD 77 §3's severity characterization: a warn/skip is equivalent to no control.

4. **The pure verdict logic is authoritative; the adapter only feeds it.** The adapter maps
   raw output to `{ objects, pending }` and passes it, plus the on-disk allowlist, to the
   *existing* `evaluateDriftGate`. All pass/fail decisions (residual non-empty, stale
   allowlist, unused acknowledgement) remain in `drift-gate.mjs`, unchanged (§4.4).

5. **Do not invent an output format.** The DDL grammar (A1/A2) and version-key format (A4)
   are flagged as assumptions and **must be reconciled against a real capture** (§8) before
   `--linked` is trusted. The parser is written to *fail closed* on anything it does not
   recognize, so a wrong assumption blocks the release — it does not pass a broken prod.

---

## 3. Where this sits in the workflow

Unchanged ordering from LLD 77 §8.2 / `prod-migrate.yml`. This addendum only makes step 1's
`--linked` variant real:

```
1. drift gate (§5)              ← THIS ADDENDUM completes the --linked path
2. supabase db push             (already built)
3. verification runner (§6)     (already built)
   ──────────── only if 1–3 pass ────────────
4. deploy consuming backend     (already built; needs: migrate-and-verify)
```

In `prod-migrate.yml` the relevant step is `Drift gate (linked prod) [human-wired]`, guarded
on `env.PROD_LINKED == 'true'`, which runs `supabase link …` then `node
scripts/verify-drift.mjs --linked`. This addendum specifies (a) what that script does inside
the `--linked` branch and (b) the missing `SUPABASE_ACCESS_TOKEN` on the `link` step (§6).

---

## 4. Adapter contract (inputs → `{ objects, pending }`)

### 4.1 Output shape (must match the existing fixture contract exactly)

The adapter produces the same structured-diff object the `--diff-file` path already reads
and `verify-drift.mjs` already consumes (see `scripts/fixtures/clean-diff.json`):

```jsonc
{
  "objects": [ { "object": "<stable id>" }, ... ],   // RESIDUAL drift objects only
  "expectedFromPending": [ { "object": "<stable id>" }, ... ],  // see §4.3
  "pending": [ "009_add_game_config.sql", ... ]      // in-tree filenames not applied to prod
}
```

`object` id grammar is the one the fixtures and `drift-gate.mjs` already use, e.g.
`constraint:player_stats:player_stats_pkey1`, `grant:anon:player_stats:INSERT` (see
`scripts/fixtures/drifted-diff.json`). The adapter MUST emit ids in that exact grammar so
`acknowledgedResidual` / `expectedPending` entries continue to match by string equality.

Proposed pure signature (illustrative; implementer owns exact types):

```js
// scripts/lib/linked-diff-adapter.mjs
/**
 * @typedef {object} RawLinkedOutput
 * @property {string} dbDiffStdout        stdout of `supabase db diff --linked --schema public`
 * @property {string} migrationListStdout stdout of `supabase migration list --linked`
 */
/**
 * @typedef {object} AdapterResult
 * @property {{object:string}[]} objects  residual drift objects (see §4.2)
 * @property {{object:string}[]} expectedFromPending  (see §4.3)
 * @property {string[]} pending           in-tree migration filenames not applied to prod
 */
/**
 * Pure: raw CLI stdout → structured diff. THROWS on any unclassifiable/ambiguous
 * input (fail-closed, §5). Never returns a partial/best-effort result.
 * @param {RawLinkedOutput} raw
 * @param {string[]} inTreeMigrationFiles  basenames from supabase/migrations/*.sql (sorted)
 * @returns {AdapterResult}
 */
export function adaptLinkedDiff(raw, inTreeMigrationFiles) { /* ... */ }
```

### 4.2 Deriving `objects` (residual) from `db diff --linked`

`db diff --linked --schema public` emits SQL DDL that would transform prod to match the
local migrations (V1, V2). The parser converts that DDL into stable object ids, keeping only
the **residual** class LLD 77 cares about.

Algorithm:

1. **Sentinel short-circuit.** If stdout, trimmed, is exactly the documented no-change
   sentinel `No schema changes found` (V3) → `objects = []`. (Match the exact string; do
   **not** treat "empty output" as clean — see §5, F4.)
2. **Statement split.** Split stdout into individual DDL statements (on `;` at statement
   boundaries, ignoring comments / blank lines). Preserve raw text per statement for error
   messages.
3. **Classify each statement** into one of the known residual shapes, producing an `object`
   id. The v1 classifier covers exactly the drift class in the threat model (T1) and the
   fixtures — constraints and role grants on the `public` tables:
   - `ALTER TABLE [ONLY] <t> DROP CONSTRAINT <name>` (and the `ADD CONSTRAINT` form, per A2)
     → `constraint:<t>:<name>`.
   - `REVOKE <PRIV> ON [TABLE] <t> FROM <role>` (and the `GRANT … TO <role>` form, per A2)
     → `grant:<role>:<t>:<PRIV>` (one id per privilege if the statement lists several).
   - **Any statement that does not match a known shape → THROW (fail-closed, §5 F3).** The
     v1 classifier is intentionally narrow; an unrecognized statement means either real
     drift we do not know how to name yet, or a grammar assumption (A1) that is wrong.
     Either way the release must block, not pass.
4. **Direction/pending disambiguation (depends on A2).** Because `db diff --linked` also
   renders *pending migrations* as DDL (prod lacks objects the local migrations add), the
   raw DDL can contain both residual AND pending-attributable statements. Two options for
   keeping `objects` = residual-only:
   - **Option R1 (recommended): diff against local, not prod-as-is.** Do not ask `db diff`
     to include pending effects. Instead compare *prod* to *the cumulative local migrations*
     using the direction where already-applied-but-drifted objects surface and
     not-yet-applied objects do **not**. Concretely, LLD 77 §5.2's model is "prod should
     equal the cumulative effect of *applied* migrations." The cleanest realization is to run
     the diff **prod vs. the applied set only** — but the CLI does not expose "applied set"
     directly. Since that is not directly available, R1 is de-risked by R2 below rather than
     relied on alone.
   - **Option R2 (belt-and-suspenders, always applied): subtract pending-attributable ids.**
     Whatever `db diff` returns, subtract any object id that is *attributable to a pending
     migration* (from §4.3's `expectedFromPending`). Formally the adapter returns the raw
     classified set as `objects` **and** the pending-attributable set as
     `expectedFromPending`, and lets `evaluateDriftGate` do `residual = observed − expected −
     acknowledged` (its existing rule). This means the adapter does **not** itself decide
     residual-vs-pending — it hands both sets to the pure gate, which already subtracts. This
     is the safer split and keeps the adapter dumb. **Adopt R2.**
   - **Consequence:** the adapter's `objects` = *all* classified statements from `db diff`;
     `expectedFromPending` = the subset attributable to pending migrations (§4.3). The gate
     subtracts. A residual object that is NOT attributable to any pending migration survives
     the subtraction → gate fails (correct). A pending-migration object is subtracted → gate
     passes (correct). This exactly reuses the shipped verdict logic.

> **A2 dependency, stated plainly:** R2 requires that we can independently compute the
> `expectedFromPending` ids (the objects a pending migration would add). §4.3 addresses how;
> if that cannot be computed reliably for a given migration, the adapter fails closed (it
> does not guess).

### 4.3 `expectedFromPending` — objects attributable to pending migrations

`evaluateDriftGate` subtracts `expectedFromPending` from `observed`. In the fixture path this
array is hand-authored in `clean-diff.json` (currently `[]`, because the pending migrations
009/010 add a column and a table that `db diff` renders as *additive* DDL that the
subtraction handles via emptiness — see note below). For the `--linked` path the adapter
must produce it. Two viable strategies, with a clear recommendation:

- **Strategy E1 (recommended for v1): keep `expectedFromPending = []` and rely on the
  classifier's narrowness.** The v1 classifier (§4.2 step 3) recognizes only *constraint* and
  *grant* residual shapes. The current pending migrations (009 adds a `jsonb` column; 010
  creates a table + RPC) render as `ADD COLUMN` / `CREATE TABLE` / `CREATE FUNCTION` DDL —
  **none of which the v1 classifier recognizes**, so under §4.2 step 3 they would THROW.
  That is wrong for pending migrations. Therefore the classifier must *ignore* (not throw on)
  additive DDL that is unambiguously attributable to a pending migration, while still
  throwing on unknown *constraint/grant* drift. The clean way to express this: the classifier
  recognizes (a) the residual class → emit id into `objects`; (b) a **known-benign additive
  class** (`CREATE TABLE`, `CREATE FUNCTION`/`CREATE OR REPLACE FUNCTION`, `ADD COLUMN … IF
  NOT EXISTS`-equivalent, `CREATE INDEX`, `CREATE POLICY`) → **only if** the affected object
  is declared by a file in `pending` (cross-checked against the parsed pending set) → drop it
  silently; (c) anything else → THROW. This keeps `expectedFromPending = []` while still
  being fail-closed on genuinely unknown statements.
  - **Risk:** matching "additive statement ↔ pending migration" requires parsing which object
    each additive statement touches and confirming a pending migration declares it. That is a
    second grammar dependency (A1). If confidence is low at implementation time, prefer E2.
- **Strategy E2 (fallback): compute `expectedFromPending` by applying pending SQL to a
  shadow.** Reuse the shipped prod-shaped-fixture machinery (LLD 77 §7): apply the pending
  migration SQL to a throwaway schema and diff *that* to enumerate the object ids each
  pending migration introduces, feeding them as `expectedFromPending`. This is the most
  faithful but adds a local-DB dependency to the `--linked` step. Given the drift gate step
  already runs after `supabase start` is available in other jobs, this is feasible but heavier.

**Recommendation:** ship **E1** for v1 (narrow classifier + benign-additive drop cross-checked
against `pending`), and record E2 as the fallback if the first real capture (§8) shows the
additive DDL is too varied to classify safely. **This decision cannot be finalized without
the §8 capture** — flagged as an open item.

> Note on the current fixture: `clean-diff.json` uses `objects: []`, `expectedFromPending:
> []`, `pending: [009, 010]`. That models "prod is clean; 009/010 are pending." The `--linked`
> adapter must reproduce the same verdict against live prod: no residual constraints/grants,
> 009/010 reported pending by `migration list`. E1 achieves this (additive DDL for 009/010 is
> dropped, not classified as residual), so `objects = []` and the gate passes exactly as the
> fixture does.

### 4.4 Deriving `pending` from `migration list --linked`

This is the load-bearing part for the #156 property (a migration in-tree but never applied to
prod must be caught). It does **not** come from `db diff`.

Algorithm (against V5's `LOCAL | REMOTE | TIME (UTC)` table):

1. Run `supabase migration list --linked` (auth via `SUPABASE_ACCESS_TOKEN` +
   `SUPABASE_DB_PASSWORD`, §6). Capture stdout.
2. Parse the table: skip the header row and any box-drawing separator lines; for each data
   row extract the `LOCAL` and `REMOTE` cells (columns are separated by the CLI's column
   glyph — the parser must tolerate the documented `│` separator and whitespace padding).
3. A row with a **non-empty LOCAL and empty REMOTE** = a local migration not applied to prod
   → **pending** (V5). Collect its version key.
4. **Map the version key back to the in-tree filename** (`supabase/migrations/NNN_*.sql`).
   The `object` grammar for `pending` in the existing contract is the *filename*
   (`009_add_game_config.sql`), and `expectedPending` in the allowlist uses filenames too.
   So the adapter maps each pending version key → the matching in-tree basename. **Mapping
   rule (assumption A4):** match the in-tree file whose CLI-reported version key equals the
   `LOCAL` cell value. If the CLI reports the bare numeric prefix (`009`), match on prefix;
   if it reports the full basename, match on basename. **If any pending version key does not
   map to exactly one in-tree file → THROW (fail-closed, §5 F5)** — an unmappable key means
   our A4 assumption is wrong and we must not silently drop a pending migration.
5. `pending` = the sorted list of mapped in-tree filenames.

**Cross-check (defense in depth):** the parser also verifies that every `REMOTE`-present
version maps to an in-tree file OR is explicitly older than the tree's first migration; a
`REMOTE` version with no in-tree counterpart is *prod-ahead-of-tree* drift and should THROW
(this would mean prod has a migration the repo doesn't — a serious divergence). This is a
recommended v1.1 hardening, not required for the core #156 property; flag as optional.

### 4.5 Why this catches #156 ("green CI, broken prod via unapplied migration")

If a migration file is committed but never `db push`ed to prod, `migration list --linked`
shows it LOCAL-only (blank REMOTE) → the adapter puts it in `pending`. The gate then requires
it to be in `expectedPending` (allowlist) — and, critically, the *release ordering* (LLD 77
§8.2) runs `db push` after the gate, so a pending migration is expected and then applied. The
failure #156 describes — a migration silently never reaching prod while CI is green — cannot
occur, because `pending` is derived from prod's *actual* applied-history table, not from CI's
local DB. A migration missing from prod is *visible* to the gate as pending; the subsequent
`db push` applies it; the post-condition runner then verifies it took effect. The chain is
closed only because `pending` reads live prod history (V5), which is exactly what the stub
could not do.

---

## 5. Fail-closed behavior (every failure path)

The adapter and the `--linked` branch exit **non-zero** (block the release) on every one of
these. None may fall through to a pass. `verify-drift.mjs` already exits 1 on gate failure
and 2 on usage/adapter errors; the adapter reuses that convention (exit 2 = "could not even
evaluate", which is still a hard block).

| # | Failure | Detection | Behavior |
|---|---------|-----------|----------|
| F1 | `supabase link` fails (bad/missing `SUPABASE_ACCESS_TOKEN`, wrong ref, network) | non-zero exit from `link` in the workflow step | step fails → job fails → deploy job never runs (`needs:`). The `link` and `verify-drift` calls are `&&`-chained / separate `run` lines so a link failure aborts. |
| F2 | `supabase db diff --linked` or `migration list --linked` exits non-zero (auth, network, CLI error) | `execFileSync` throws on non-zero exit (it already does in the stub) | catch → print stderr → `process.exit(2)`. Never treat a failed command as "no drift". |
| F3 | `db diff` emits a statement the classifier does not recognize | pure parser throws `UnclassifiedStatementError` with the raw statement | `--linked` branch catches → prints the offending statement → `exit(1)`. (This is the A1 guard.) |
| F4 | `db diff` stdout is empty or whitespace but NOT the exact `No schema changes found` sentinel | parser checks the sentinel explicitly (V3); anything else that yields zero statements but isn't the sentinel is suspicious | THROW → `exit(2)`. Empty output ≠ clean; it may be a truncated/aborted run. |
| F5 | a pending version key from `migration list` maps to zero or >1 in-tree files (A4 wrong) | mapping step (§4.4 step 4) | THROW → `exit(2)`. Never drop a pending migration silently. |
| F6 | `migration list` table cannot be parsed (unexpected columns/format, empty) | parser validates it found the `LOCAL/REMOTE` header and ≥0 well-formed rows | THROW → `exit(2)`. |
| F7 | `expectedFromPending` computation (E1) hits an additive statement it cannot attribute to a pending migration | classifier §4.3 (b) cross-check fails | THROW → `exit(1)` (treated as unknown drift, F3-class). |
| F8 | The `evaluateDriftGate` verdict is `ok: false` (residual, stale allowlist, unused ack) | existing gate logic | existing behavior: print reasons → `exit(1)`. Unchanged. |
| F9 | Prod is ahead of tree (a REMOTE-only migration with no in-tree file) — optional v1.1 | §4.4 cross-check | THROW → `exit(2)` (recommended, optional for v1). |

**Invariant:** the only path to `exit(0)` is: both CLI commands succeeded, every `db diff`
statement was either a classified residual object or a benign-additive statement attributable
to a pending migration, every pending key mapped to exactly one in-tree file, and
`evaluateDriftGate` returned `ok: true`. Any deviation exits non-zero.

---

## 6. `SUPABASE_ACCESS_TOKEN` workflow edit (exact)

**Problem (V6):** `supabase link --project-ref …` needs `SUPABASE_ACCESS_TOKEN` for
non-interactive auth, and `db diff --linked` / `migration list --linked` / `db push` all
require the link to have succeeded. The current `prod-migrate.yml` passes
`SUPABASE_PROJECT_REF` and `SUPABASE_DB_PASSWORD` to the linked-drift and push steps but
**not** `SUPABASE_ACCESS_TOKEN`, so `link` cannot authenticate in CI.

**Edit 1 — the linked drift-gate step** (`Drift gate (linked prod) [human-wired]`,
`prod-migrate.yml` lines ~55–62). Add `SUPABASE_ACCESS_TOKEN` to its `env:` block:

```yaml
      - name: Drift gate (linked prod) [human-wired]
        if: env.PROD_LINKED == 'true'
        run: |
          supabase link --project-ref "$SUPABASE_PROJECT_REF"
          node scripts/verify-drift.mjs --linked
        env:
          SUPABASE_PROJECT_REF: ${{ secrets.SUPABASE_PROJECT_REF }}
          SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}   # <-- ADD
```

**Edit 2 — the `supabase db push` step** (`prod-migrate.yml` lines ~66–70). `db push` also
operates against the linked project and needs the access token if it re-establishes/link
context in a fresh step (each `run` is a fresh shell; the link config persists on disk in the
runner workspace, but the token is required for any operation that re-auths). Add it
defensively:

```yaml
      - name: supabase db push [human-wired]
        if: env.PROD_LINKED == 'true'
        run: supabase db push
        env:
          SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}   # <-- ADD
```

**No new secret plumbing beyond these two `env:` additions.** The operator is setting
`SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`, and `SUPABASE_ACCESS_TOKEN` as repo secrets
(`RAILWAY_TOKEN` already exists). `PROD_LINKED` remains derived from
`secrets.SUPABASE_PROJECT_REF != ''`, so the gated steps still no-op when secrets are absent
— the workflow stays exercisable with zero secrets, exactly as today.

> **Assumption flag:** whether `db push` *strictly* needs the token in a separate step
> (Edit 2) depends on how the CLI persists link/auth state between `run` steps on the runner.
> Adding it is harmless and fail-safe; confirm necessity on the first real run. The drift-gate
> step (Edit 1) unambiguously needs it because it runs `supabase link` itself.

---

## 7. Credential-free testing

Mirror the existing pattern: the pure parse logic is unit-tested against **captured raw
output fixtures**, with zero prod access — exactly how `drift-gate.test.ts` tests the verdict
logic against `clean-diff.json` / `drifted-diff.json`.

### 7.1 New fixtures (raw CLI output, captured once — see §8)

Store representative *raw* CLI stdout (not the structured shape) so the parser is exercised
end-to-end:

- `scripts/fixtures/linked/db-diff.clean.txt` — the exact `No schema changes found` sentinel.
- `scripts/fixtures/linked/db-diff.residual.txt` — DDL exhibiting a `*_pkey1` constraint and
  a stray `anon` write grant (the T1 class; the raw form of `drifted-diff.json`).
- `scripts/fixtures/linked/db-diff.pending-additive.txt` — additive DDL for 009/010
  (`ADD COLUMN game_config …`, `CREATE TABLE game_history …`, `CREATE FUNCTION
  get_windowed_stats …`) to exercise the E1 benign-additive drop.
- `scripts/fixtures/linked/migration-list.all-applied.txt` — table with all migrations in
  both LOCAL and REMOTE (no pending).
- `scripts/fixtures/linked/migration-list.pending.txt` — table with 009/010 LOCAL-only
  (blank REMOTE) = the current expected prod state.
- `scripts/fixtures/linked/migration-list.unmappable.txt` — a pending row whose version key
  does not map to an in-tree file (drives F5).

**These fixtures are hand-authored to the best-known grammar until the §8 capture replaces
them with real bytes.** They must be labeled as such in a `$comment`/header so a reviewer
knows they are provisional (see §8).

### 7.2 Test requirements (what must be tested)

Unit — `scripts/lib/linked-diff-adapter.mjs` pure parser (new `tests/scripts/*.test.ts`):

- **Clean sentinel → `objects: []`** (from `db-diff.clean.txt`), and the gate then passes
  against the real allowlist (end-to-end with `evaluateDriftGate`, no prod).
- **Residual DDL → the exact `object` ids** `constraint:…:*_pkey1` and `grant:anon:…:INSERT`
  (from `db-diff.residual.txt`), matching `drifted-diff.json`'s ids byte-for-byte, and the
  gate then FAILS (fail-closed) — proving the raw→structured→verdict chain reproduces the
  `drifted-diff.json` result.
- **Pending-additive DDL is dropped, not classified as residual** (E1) → `objects: []` when
  every additive statement maps to a pending migration.
- **Unclassifiable statement → throws** (F3): a made-up `ALTER TABLE … SET …` or unknown
  statement raises `UnclassifiedStatementError`; the fixture includes one such line.
- **Empty-but-not-sentinel output → throws** (F4).
- **`migration list` parse:** `pending.txt` → `["009_add_game_config.sql",
  "010_create_game_history.sql"]`; `all-applied.txt` → `[]`.
- **Unmappable pending key → throws** (F5) from `migration-list.unmappable.txt`.
- **Malformed `migration list` table → throws** (F6).
- **Version-key mapping** (§4.4 step 4): both the "bare prefix" and "full basename" CLI forms
  map to the correct in-tree filename (guards A4 both ways).

Integration — none required against prod (that is the human-owned §9 step). The whole point
is that the parser is proven credential-free; the only prod validation is the §8 one-time
capture + a manual confirmation run by the operator during the first real release.

Explicitly **not** tested by autonomous CI: any live `--linked` call. Consistent with LLD 77
§11's "Out of scope for automated tests (human-verified, credentialed)."

---

## 8. De-risking the unverified grammar (REQUIRED before trusting `--linked`)

The design cannot be finalized in two places without seeing real prod output: the **DDL
grammar** (A1/A2, drives the §4.2 classifier and the E1-vs-E2 decision) and the **version-key
string** (A4, drives the §4.4 mapping). Recommended de-risking, in order:

1. **One-time human capture (operator, credentialed).** After `#83`/`#75` cleanup and after
   the operator has set the three secrets and run `supabase link` locally against prod, run
   and save verbatim:
   - `supabase db diff --linked --schema public > db-diff.actual.txt`
   - `supabase migration list --linked > migration-list.actual.txt`
   This is read-only (no `db push`), safe, and the single fact-check that removes A1/A2/A4.
   The operator pastes these into the PR (redacting nothing — schema DDL and version keys are
   not secrets; the connection string / password are never in this output).
2. **Reconcile fixtures to reality.** Replace the provisional §7.1 fixtures with the captured
   bytes; adjust the classifier regexes / mapping rule to match the real grammar; re-run the
   §7.2 unit tests. Only then is the E1-vs-E2 decision (§4.3) closed.
3. **First real release is human-supervised.** Per LLD 77 §9/§11, the first `--linked` gate
   run against live prod is validated by the operator, not autonomous CI. If the gate’s
   verdict disagrees with a manual `db diff` read, that is a parser bug to fix before relying
   on it — and because the adapter fails closed, a disagreement blocks rather than ships.

**This LLD is implementable now for everything except the final classifier regexes and the
version-key mapping constant, which are one small, well-isolated reconciliation step gated on
the §8.1 capture.** The implementer should build the pure adapter + fail-closed wiring +
provisional fixtures + tests, and land the capture reconciliation as the closing commit
(ideally in the same PR once the operator supplies the capture).

---

## 9. Interfaces / files touched

| File | Change | New/Edit |
|------|--------|----------|
| `scripts/lib/linked-diff-adapter.mjs` | New pure module: `adaptLinkedDiff(raw, inTreeFiles)` (§4). Throws on any ambiguity (§5). | New |
| `scripts/verify-drift.mjs` | Replace the `--linked` stub (lines ~53–68) with: run `db diff --linked --schema public` + `migration list --linked`, pass stdout to `adaptLinkedDiff`, feed the result to the existing `evaluateDriftGate` call. Preserve current exit conventions. | Edit |
| `scripts/lib/drift-gate.mjs` | **None.** Verdict logic unchanged. | — |
| `.github/workflows/prod-migrate.yml` | Add `SUPABASE_ACCESS_TOKEN` to the linked-drift step and (defensively) the push step (§6). | Edit |
| `scripts/fixtures/linked/*.txt` | New raw-output fixtures (§7.1), provisional until §8 capture. | New |
| `tests/scripts/linked-diff-adapter.test.ts` | New unit tests (§7.2). | New |
| `docs/lld/77-prod-migration-safety-and-automation.md` | Optional: a one-line pointer in §5.5/§9 to this addendum. | Edit (optional) |

The `--linked` branch of `verify-drift.mjs` after the edit (structure, not final code):

```
if (useLinked) {
  const dbDiffStdout       = run("supabase", ["db","diff","--linked","--schema","public"]); // F2 on throw
  const migrationListStdout= run("supabase", ["migration","list","--linked"]);              // F2 on throw
  const inTreeFiles        = listMigrationBasenames();  // supabase/migrations/*.sql, sorted
  const adapted            = adaptLinkedDiff({ dbDiffStdout, migrationListStdout }, inTreeFiles); // F3–F7 throw
  return adapted;   // → same evaluateDriftGate({ observed, expectedFromPending, allowlist, actualPending }) call
}
```

---

## 10. Dependencies

| Dependency | Status | Why |
|------------|--------|-----|
| `scripts/lib/drift-gate.mjs` (`evaluateDriftGate`) | Shipped | The verdict logic the adapter feeds. Unchanged. |
| `scripts/verify-drift.mjs` (`--diff-file` path, exit conventions) | Shipped | The adapter plugs into the existing `--linked` branch and reuses the exit conventions. |
| `scripts/fixtures/*.json`, `expected-diff.allowlist.json` | Shipped | The structured-diff and allowlist contract the adapter's output must match exactly (§4.1). |
| `prod-migrate.yml` (link → gate → push → verify → deploy ordering) | Shipped | The workflow the §6 edit patches; ordering unchanged. |
| `SUPABASE_ACCESS_TOKEN` / `SUPABASE_PROJECT_REF` / `SUPABASE_DB_PASSWORD` repo secrets | Human-owned (operator setting now) | Non-interactive `supabase link` + linked operations (V6). Never in the repo. |
| `#83`/`#75` prod drift cleanup | Human-owned, sequenced first (LLD 77 §10) | Establishes the clean baseline the adapter's residual set expects (`objects: []`). |
| One-time real `db diff` / `migration list` capture (§8) | Human-owned, **required before trusting `--linked`** | Removes A1/A2/A4; closes the E1-vs-E2 decision. |
| Supabase CLI (`supabase/setup-cli@v1`, `version: latest`) | Shipped in workflow | Provides `db diff --linked`, `migration list --linked`, `link`, `db push`. |

---

## 11. Test Requirements (summary)

Per testing-principles: pure function tested against captured fixtures, deterministic, no
prod, no network, no DB.

- **Unit (pure parser):** all cases in §7.2 — clean sentinel, residual→ids, benign-additive
  drop, unclassifiable→throw, empty-not-sentinel→throw, `migration list`→pending, unmappable
  key→throw, malformed table→throw, version-key mapping both forms.
- **Integration (raw→structured→verdict):** feed each parser output into the *real*
  `evaluateDriftGate` and assert the end-to-end verdict matches the equivalent JSON fixture
  (`db-diff.clean` ≙ `clean-diff.json` pass; `db-diff.residual` ≙ `drifted-diff.json` fail).
  Still credential-free.
- **Security / fail-closed:** every §5 failure path (F2–F7) has a test that asserts a
  non-zero exit / thrown error — the negative-space tests are the point of this LLD.
- **Not automated (human-owned, credentialed):** the live `--linked` run and the §8 capture
  reconciliation, validated by the operator on the first real release (LLD 77 §9/§11).

---

## 12. Open questions / escalations

None require CEO escalation — this is pure implementation-mechanism completion of an
already-approved capability (LLD 77, Phase 6). Two items are gated on the §8 capture, neither
blocking the bulk of implementation:

1. **DDL grammar (A1/A2)** — finalize the §4.2 classifier regexes and confirm the
   residual-vs-additive direction once a real `db diff --linked` capture exists.
2. **E1 vs. E2 for `expectedFromPending` (§4.3)** — default to E1 (narrow classifier +
   benign-additive drop); switch to E2 (shadow-apply pending SQL) only if the real additive
   DDL proves too varied to classify safely. Decided at capture time.

A third, purely mechanical item for the operator: confirm whether the `db push` step strictly
needs `SUPABASE_ACCESS_TOKEN` (§6 Edit 2) or whether the on-disk link state from the prior
step suffices; adding it is harmless either way.
```
