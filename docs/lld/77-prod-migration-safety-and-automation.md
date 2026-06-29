# LLD 77: Prod Migration Safety & Automation

**Status: Design — docs only. No code in this LLD.** This is the design gate for parent issue #86. The design-reviewer must sign off before sub-issues #89 (fixture) / #90 (verification harness + drift-job structure) / and the scheduled-tier sub-issue implement anything. It is authored as **one coherent document** per the standing CEO scope decision: drift detection, a prod-shaped test fixture, and scripted post-apply verification are the three legs of a *single* capability — "apply a migration to prod and **know** it did what the migration says." Splitting the legs produces dangerous half-states (e.g. automating `supabase db push` without drift detection would *automate* the silent failure), so the legs share one threat model, one mechanism, and one boundary spec here.

This LLD defines the contracts the implementation sub-issues build to; it does not implement them.

---

## 1. Scope

### In scope (this design defines the contracts for)

- **Threat model** for the LLD 66 prod incident class (§3).
- **Drift-detection gate** — fail-closed, allowlist / expected-diff design (§5, criterion 1).
- **Post-condition contract** — how each migration declares a machine-checkable post-condition and how a release is blocked until it passes (§6, criterion 2).
- **Prod-shaped fixture** — generalizing migration 006's inline throwaway-schema pattern into a reusable fixture carrying prod's TypeORM-era drift (§7, criterion 3).
- **Mechanism recommendation** for the eventual automated apply, with the Railway ordering hazard addressed (§8, criterion 4).
- **Credential boundary** — per-criterion mapping of autonomous-safe vs. human-owned steps (§9).
- **Sequencing** — #83 (prod drift cleanup) lands first for a clean baseline (§10).

### Explicitly NOT in scope

- **Implementing** any of the above. This LLD specifies contracts; #89/#90/scheduled-tier implement them.
- Editing existing migrations (`001`–`006`). They are applied; the discipline is forward-only (LLD 66 §3, §8.5).
- Storing or referencing **any prod credential, project ref, connection string, or secret**. This document contains none, by requirement (§9, AC).
- Wiring `supabase link --linked` / `supabase db push` to the **live** prod project. That is a human-owned operation (§9); this LLD designs the *structure* that points at a placeholder/local target.
- Changing application/runtime code, game engine, RLS policy semantics, or the deploy container. The `docker-entrypoint.sh` analysis in §8 is a *rejection rationale*, not a change.
- The actual content of #83's drift-cleanup migration (its own issue). This LLD only **sequences** it and consumes its clean baseline (§10).
- `.claude/workflows/*` automation. (Operator note: #87's ship-batch fixes are blocked by the sensitive-file write gate and are out of scope here — they need human implementation; do not let autonomous batches keep selecting them.)

---

## 2. Approach (key decisions)

1. **One document, three legs + one deferred leg.** The prerequisite tier (criteria 1–3: drift gate, post-condition verification, prod-shaped fixture) is designed to **stand alone** and close the "green CI, broken prod" gap **on its own, independent of whether the scheduled tier (criterion 4, automated `db push`) ever ships** (§4). This is a hard requirement of this LLD, restated in §4 and §8.5.

2. **Fail-closed everywhere.** The drift gate **fails the build** on unexpected diff; verification **blocks the release** on a failed post-condition. Warn-only is explicitly rejected (§5.4) — the LLD 66 incident proves a warning a human can skip is equivalent to no control under the "loosely monitored, not strict per-release" shipping model.

3. **The fixture is the leg that would have caught `004` at test time.** A migration tested only against a clean `supabase start` DB cannot exhibit prod's TypeORM-era drift (the `player_stats_pkey1` name that broke `004`). The prod-shaped fixture (§7) reproduces that drift so a test fails *before* prod does.

4. **Reuse the proven pattern, do not invent infrastructure.** The post-condition harness and the fixture both build directly on the in-tree throwaway-schema mechanism (`makePgClient` + `readMigrationSql`, `SET search_path TO "<schema>", public`) already shipped for the I4 backfill test and the 006 repair tests (`tests/integration/player-stats.test.ts`). No new test runner, no new DB, no Docker change. This honors architecture-principles #10 (deploy cheap) and CLAUDE.md simplicity.

5. **Sequence #83 first.** A clean prod baseline makes the drift gate's allowlist tractable: after #83, the *only* expected diff is the set of unapplied in-tree migrations. Without it, the allowlist would have to permanently encode TypeORM-era noise, which is brittle and hides real drift (§10).

---

## 3. Threat Model — the LLD 66 incident class

The incident is the reference exemplar. Migration `004` repointed `player_stats`'s PK by a **hardcoded** constraint name (`DROP CONSTRAINT IF EXISTS player_stats_pkey`). Prod's PK was named `player_stats_pkey1` (a TypeORM-era leftover — see LLD 1 note in execution-plan). The hardcoded drop matched nothing, the guarded `ADD` saw a PK still present and no-op'd, so the composite PK was **never applied** on prod. `005`'s RPC uses `ON CONFLICT (user_id, game_type)`, which requires that exact constraint — so every stats write would have errored on prod. CI was green; the failure was caught only because a human ran a manual post-apply `SELECT` before merging the consumer. `006` repaired it (name-agnostic), and a follow-up `db diff --linked` revealed broader drift (#83).

The class generalizes into five threat vectors. Each maps to the leg that neutralizes it.

| # | Threat vector | Why it bites | Neutralized by |
|---|---------------|--------------|----------------|
| T1 | **Fresh-CI-DB vs. prod-TypeORM-history divergence.** `supabase start` builds a clean DB with conventional names; `001`'s `CREATE TABLE IF NOT EXISTS` no-op'd against pre-existing TypeORM tables in prod, so prod carries drifted constraint names (`*_pkey1`) and stray grants that CI never sees. | Migrations that reference schema by *convention* (hardcoded names) pass CI and fail prod. | **Prod-shaped fixture (§7)** — tests run against a DB carrying the drift, so name-coupled migrations fail at test time. |
| T2 | **Silent half-apply (NOTICE, not ERROR).** `DROP ... IF EXISTS` and guarded `DO $$` blocks degrade to no-ops, emitting a NOTICE, not raising. A migration "succeeds" while doing nothing. | `supabase db push` exits 0; nothing signals the schema is wrong. | **Post-condition verification (§6)** — the migration asserts its *intended end state*; a no-op'd migration fails the assertion. |
| T3 | **Fire-and-forget writes hide the runtime failure.** `recordGameCompletion` is fire-and-forget with a `catch` (LLD 66 §8.3). A broken `ON CONFLICT` target throws *per write* but is swallowed — no crash, no error response, no health-check failure. Stats silently stop. | Monitoring shows green; the only symptom is "stats stopped," invisible without proactive inspection. | **Post-condition verification (§6)** — moves detection to *apply time* (before any runtime write), and the **drift gate (§5)** catches the schema mismatch pre-deploy. |
| T4 | **Deploy path applies NO migrations.** Railway auto-deploys application *code* on merge to `main` (`railway.json` → `Dockerfile.production` → `docker-entrypoint.sh`, which only starts nginx + node; verified: zero migration logic). `supabase/migrations/*` are applied to prod by a **separate, manual** `supabase db push`. | The two are decoupled: code and schema can diverge silently. | **Mechanism recommendation (§8)** + the **ordering rule (§8.3)**. |
| T5 | **Ordering hazard: backend ahead of schema.** Because of T4, if the consuming backend merges first, Railway ships code expecting a schema the prod DB doesn't have yet — exactly the "6-arg RPC missing" silent stats-loss window (LLD 66 §8.3). | Auto-deploy-on-merge races the manual migration. | **Ordering rule (§8.3)**: schema applied + verified *before* the consuming merge; scheduled tier (§8) closes the race by making apply non-manual and gated. |

**Failure-severity characterization (drives the fail-closed requirement):** the incident class is *silent data/feature loss, never a crash*. Because nothing in monitoring surfaces it (T3) and the human verification step is skippable under a loosely-monitored release model, **a warn-only control is equivalent to no control.** Every gate this LLD specifies must fail closed.

---

## 4. The prerequisite tier stands ALONE (hard requirement)

**The prerequisite tier (criteria 1–3: drift gate, post-condition verification, prod-shaped fixture) closes the "green CI, broken prod" gap on its own, independent of whether the scheduled tier (criterion 4, automated `db push`) ever ships.** This is a binding requirement of this LLD, not an aspiration.

Justification, vector by vector: even if the prod migration is applied **100% manually forever** (the status quo of T4), the prerequisite tier still neutralizes T1 (fixture catches name-coupled migrations at test time), T2 (post-condition fails a no-op'd migration at apply time), T3 (detection moved to apply/pre-deploy, off the silent runtime path), and T5 (the §8.3 ordering rule is a process/gate, not automation). The scheduled tier (criterion 4) only removes the *manual* `db push` step and the human-ordering discipline it depends on — it is a convenience/robustness improvement layered on top, **gated by** the prerequisite tier so automation never runs ahead of verification. If criterion 4 is never built, the gap is still closed.

Therefore: **#89 and #90 (prerequisite-tier sub-issues) are shippable and valuable with no dependency on the scheduled tier.** The scheduled tier is explicitly downstream and optional.

---

## 5. Drift-Detection Gate (criterion 1) — fail-closed allowlist / expected-diff

### 5.1 Purpose

A CI / pre-deploy job runs `supabase db diff --linked` against the linked prod DB and **fails the build** unless the diff is exactly an explicitly-allowlisted, expected set. It distinguishes **"expected pending migration"** (in-tree migration files not yet applied to prod — benign) from **"unexpected drift"** (prod schema differs from what the applied migrations imply — dangerous, the T1 class).

### 5.2 What "expected" means — the expected-diff model

After #83 establishes a clean baseline, the prod schema should equal the cumulative effect of all **applied** migrations. The only legitimate diff is:

- **Expected pending:** the in-tree migration files present in `supabase/migrations/` that have **not yet** been applied to prod. These are *exactly* the migrations the current branch intends to push. The diff they produce is predictable and allowlisted.
- **Unexpected drift:** anything else — a constraint named differently than the migrations declare, a grant the migrations never issued, a column present/absent unexpectedly. This is the T1 signal and **fails the gate**.

The gate's job is to subtract the *expected pending* set from the observed diff and assert the remainder is empty.

### 5.3 Allowlist / expected-diff encoding (the contract #90 builds to)

The expected diff is encoded as a **declarative allowlist file**, version-controlled alongside migrations, so the gate is reviewable and diffable in PRs. Recommended location and shape (the implementer owns exact serialization; this is the required contract):

`supabase/migrations/expected-diff.allowlist.json` (or `.yaml`):

```jsonc
{
  // The migration filenames expected to be pending (not yet applied to prod) on this branch.
  // The gate ignores diff hunks attributable to applying these in order.
  "expectedPending": [
    "007_tonk_deck_rounds_target.sql"
  ],
  // Explicitly-acknowledged, reviewed residual diffs that are NOT yet cleaned up.
  // Each entry REQUIRES a justification and an owning issue. Intended to be EMPTY
  // after #83. A non-empty list is a reviewed exception, never a silent default.
  "acknowledgedResidual": [
    // { "object": "...", "reason": "...", "issue": "#NN" }   // example shape only
  ]
}
```

Semantics the gate MUST implement:

1. Compute `observed = supabase db diff --linked` (the structured diff).
2. Compute `expected = effect of applying every file in expectedPending, in filename order, to the linked prod's current state`.
3. `residual = observed − expected − acknowledgedResidual`.
4. **If `residual` is non-empty → exit non-zero (fail the build).** Print the residual so a human sees exactly what unexpected object drifted.
5. If `expectedPending` lists a file that is **already applied** (no longer pending), or omits a file that **is** pending → also fail (the allowlist is stale; force it back in sync). This prevents the allowlist from rotting into a rubber stamp.

### 5.4 Fail-closed — warn-only is rejected

The gate **exits non-zero and fails the build** on any non-empty residual. Warn-only is explicitly **not acceptable** (per criterion 1 and §3's severity characterization): a warning is a NOTICE-class signal a human can ignore, which is precisely how the LLD 66 incident would have slipped through. The only way past the gate is to (a) clean up the drift, or (b) add a *reviewed, justified, issue-linked* `acknowledgedResidual` entry in the same PR — a deliberate, auditable act, not a default.

### 5.5 Credential reality (cross-ref §9)

`supabase db diff --linked` requires a live prod link (credential). Therefore the gate's **structure** (the allowlist file, the diff-subtraction logic, its fail-closed exit semantics, and a unit test of the subtraction logic against a *captured/fixture* diff) is **autonomous-safe** and built by #90 pointed at a placeholder/local target. **Wiring `--linked` to the live prod project and storing the prod link secret in CI is human-owned** (§9). The autonomous deliverable is a gate that runs green against a local/fixture diff and is ready to be pointed at prod by a human flipping in the credential.

---

## 6. Post-Condition Verification (criterion 2) — machine-checkable, release-blocking

### 6.1 Purpose

The manual post-apply `SELECT` that caught the LLD 66 incident becomes a **required, scripted, non-skippable** step. Each migration declares a machine-checkable **post-condition** — an assertion of its intended end state. The release is **blocked until every applied migration's post-condition passes**. This neutralizes T2 (a no-op'd migration fails its own post-condition) and T3 (detection at apply time, off the silent runtime path).

### 6.2 Post-condition declaration format (the contract #90 builds to)

Each migration `NNN_name.sql` gets a co-located post-condition file. Recommended: a **SQL assertion file** that raises on failure, because it runs identically in the fixture harness, in CI against `supabase start`, and against prod via `psql` — one artifact, three contexts, no language coupling.

`supabase/migrations/postconditions/NNN_name.postcondition.sql`:

```sql
-- Post-condition for 004/006: player_stats PK is EXACTLY the composite (user_id, game_type).
-- Name-agnostic (asserts shape, never a constraint name) so it holds on prod and fresh alike.
DO $$
DECLARE cols text[];
BEGIN
  SELECT array_agg(att.attname::text ORDER BY att.attname::text)
    INTO cols
  FROM pg_constraint c
  JOIN unnest(c.conkey) AS k ON true
  JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = k
  WHERE c.conrelid = 'player_stats'::regclass AND c.contype = 'p';

  IF cols IS DISTINCT FROM ARRAY['game_type','user_id'] THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED (004/006): player_stats PK is %, expected composite (user_id, game_type).', cols;
  END IF;
END $$;
```

Required properties of a post-condition (the contract):

1. **Machine-checkable & self-failing.** It `RAISE EXCEPTION`s on violation; a non-zero exit from the runner means "release blocked." No human reads a number.
2. **Name-agnostic / shape-based.** It asserts the *intended structure* (PK columns, function arg count, grant set, column presence), never an artifact name — so the same file is correct on drifted prod and clean CI. This is the lesson `006` encodes (name-agnostic repair).
3. **Idempotent & read-only.** It mutates nothing; safe to run repeatedly, in any context.
4. **Co-located and required.** A migration without a post-condition file is itself a gate failure (the runner asserts 1:1 coverage). This prevents "forgot to verify."

> Not every migration needs a *bespoke* assertion; a migration whose only effect is, e.g., adding a nullable column can declare a trivial column-presence post-condition. The rule is "every migration declares one," not "every migration needs a complex one."

### 6.3 The verification runner (the contract #90 builds to)

A small runner (a script + an integration test wrapper) that:

1. Discovers `postconditions/*.postcondition.sql` and asserts 1:1 coverage with applied migrations (missing post-condition → fail).
2. Executes each against a target DB (via `makePgClient` for the fixture/CI path; via `psql`/`supabase` for the prod path).
3. **Exits non-zero if any post-condition raises**, which **blocks the release**.

Where it runs:
- **As an integration test** against the prod-shaped fixture (§7) and against the clean `supabase start` DB — *autonomous-safe*, the core deliverable of #90.
- **As a release-checklist step** against prod after `db push` — the scripted replacement for the manual `SELECT`. Pointing it at prod is *human-owned* (§9); the runner itself is credential-free.

### 6.4 Relationship to the release checklist

This formalizes LLD 66 §8.3 step 2 ("verify the guard passed and the schema is correct") from prose into an executable, non-skippable gate. Under the scheduled tier (§8) the runner becomes an automated gate between `db push` and the consuming-code deploy.

---

## 7. Prod-Shaped Fixture (criterion 3) — generalizing the 006 pattern

### 7.1 What it generalizes

`tests/integration/player-stats.test.ts` already proved the pattern: the **I4 backfill test** and the **006 repair tests** each `CREATE SCHEMA`, `SET search_path TO "<schema>", public`, materialize a *specific pre-migration shape* (including prod's `player_stats_pkey1`-named PK), run the **real** migration SQL via `readMigrationSql(...)`, assert, and `DROP SCHEMA ... CASCADE`. This LLD generalizes that one-off, hand-rolled setup into a **reusable fixture** that carries prod's known TypeORM-era drift, so *any* migration test can run against a prod-shaped baseline.

### 7.2 The drift the fixture must carry

From the threat model (T1) and the verified migrations (`001` grants `anon` only `SELECT`; prod additionally carries TypeORM-era artifacts):

- **Drifted constraint names:** PKs named `*_pkey1` (e.g. `player_stats_pkey1`, and analogously on `games` / `feedback` if present) instead of the conventional `*_pkey`. This is the exact artifact that broke `004`.
- **Stray `anon` write grants:** `INSERT/UPDATE/DELETE` granted to `anon` on `games` / `player_stats` / `feedback` — RLS-neutralized but present (the in-tree `001` grants `anon` only `SELECT`; the extra writes are TypeORM-era residue, the surface #83 removes).
- The fixture must make the carried-drift set **declarative and named** so tests can opt into "prod-shaped" vs "fresh" baselines, and so the set shrinks as #83 cleans prod (the fixture tracks the real baseline).

### 7.3 Fixture API surface (the contract #89 builds to)

A helper module, e.g. `tests/integration/helpers/prodShapedFixture.ts`, building on the existing `makePgClient` / `readMigrationSql`. Required surface (signatures illustrative; the implementer owns exact types):

```typescript
export interface ProdShapedFixture {
  /** The throwaway schema name created for this fixture instance. */
  readonly schema: string;
  /** Connected pg Client with search_path already set to "<schema>", public. */
  readonly client: import("pg").Client;
  /** Run real migration SQL (by filename) against this schema, in order. */
  applyMigrations(fileNames: string[]): Promise<void>;
  /** Run a post-condition file (by filename) against this schema; rejects if it RAISEs. */
  runPostcondition(fileName: string): Promise<void>;
  /** Drop the schema and end the client. Always called in finally. */
  teardown(): Promise<void>;
}

export interface ProdShapedOptions {
  /** Which drift artifacts to seed. Defaults to the full known prod-drift set (§7.2). */
  drift?: {
    pkey1ConstraintNames?: boolean;   // name PKs *_pkey1 (TypeORM-era)
    strayAnonWriteGrants?: boolean;    // anon INSERT/UPDATE/DELETE
  };
  /** Baseline tables to materialize before applying migrations under test. */
  baseline?: "typeorm-era" | "fresh";
}

/** Create an isolated prod-shaped schema, seed the requested drift, connect. */
export function createProdShapedFixture(
  opts?: ProdShapedOptions,
): Promise<ProdShapedFixture>;
```

Required properties:

1. **Self-contained & isolated.** One throwaway schema per fixture instance, created and dropped within the test (testing-principles #3). No shared state, no `beforeEach` game state. Identical isolation to the existing 006 tests.
2. **Runs the REAL migration SQL.** Via `readMigrationSql` — it must exercise the shipped `.sql`, never a test-only re-implementation (testing-principles #5: extend real artifacts, don't mock them).
3. **`search_path`-scoped.** Unqualified table names in migrations resolve into the throwaway schema, exactly as `004`/`006` already rely on (their headers note "Table name is unqualified so it resolves via search_path").
4. **Declarative drift.** The carried drift is named and toggleable so it tracks the real prod baseline and shrinks as #83 lands.
5. **Credential-free.** Connects only to the **local** `supabase start` Postgres via the existing `makePgClient` defaults (`localhost:54322`, `postgres/postgres`). No prod connection, no secret — *fully autonomous-safe* (§9).

### 7.4 What it would have caught

`004` tested against `createProdShapedFixture({ drift: { pkey1ConstraintNames: true } })` then verified with the §6 PK post-condition would have **failed at test time**: the hardcoded `DROP CONSTRAINT IF EXISTS player_stats_pkey` matches nothing against a `player_stats_pkey1`-named PK, the composite PK is never applied, and the post-condition raises. This is the leg that closes T1 before prod.

---

## 8. Mechanism Recommendation (criterion 4) — scheduled-tier automated apply

This is the **deferred** tier. It is designed here so the boundary is locked, but it does not ship until the prerequisite tier is in place and it is **gated by** §5+§6 so automation never runs ahead of verification.

### 8.1 Options considered

| Option | How it applies migrations | Verdict |
|--------|---------------------------|---------|
| **A. `docker-entrypoint.sh` hook** | Run `supabase db push` (or `psql`) on container start, before `node ... index.js`. | **Rejected.** (1) **Worsens the ordering hazard T5**: the entrypoint runs *inside the already-deployed backend image* — by the time it executes, Railway has already shipped the code expecting the new schema. Apply-on-boot is structurally "code first, schema second." (2) Every replica/restart/wake (Railway sleep-on-idle, LLD 13) would re-run it; concurrent boots race on DDL. (3) Couples schema authority to the runtime container and needs prod DB admin creds *inside* the app image. Violates the "backend must never deploy ahead of its schema" rule. |
| **B. GitHub Action (separate workflow, gated)** | A workflow step runs the gate (§5) + `supabase db push` + the verification runner (§6) as an explicit job, **ordered before** the consuming-code deploy. | **Recommended.** Decouples schema-apply from the runtime container; runs *before* code reaches prod; is fail-closed (a failed gate/verification fails the job and stops the release); auditable; reuses the existing `.github/workflows/ci.yml` surface (which already runs `supabase start`); the prod link credential lives in GitHub Secrets, injected by a human, never in the repo. |
| **C. CI job inside existing `ci.yml`** | Same as B but as a job in the existing pipeline rather than a dedicated workflow. | **Acceptable variant of B.** Same properties; choice between B and C is an implementation detail (a dedicated workflow isolates the prod-touching, credentialed step from the always-on PR pipeline, which is cleaner — mild preference for a dedicated workflow). |

### 8.2 Recommendation

**Adopt a gated GitHub Action / CI job (Option B/C), not an entrypoint hook.** The migration-apply sequence is a single fail-closed job:

```
1. drift gate (§5)              — fail build on unexpected residual
2. supabase db push             — apply pending migrations to prod
3. verification runner (§6)     — fail release if any post-condition raises
   ──────────────────────────── (only if 1–3 all pass) ────────────────────────────
4. deploy/allow-merge of consuming backend code
```

Step 4 (the backend deploy) must be **downstream** of 1–3, which is exactly how the ordering hazard is resolved (§8.3).

### 8.3 Railway auto-deploy-on-merge ordering hazard (must be addressed)

The hazard (T4/T5): Railway **auto-deploys the backend on merge to `main`**; the manual `db push` is decoupled. If backend code merges first, it deploys ahead of its schema → silent stats loss (LLD 66 §8.3).

The mechanism resolves it by **inverting the order and making schema-apply a precondition of code reaching prod**:

- **Two-merge / sequenced design (preferred, works today, no automation needed):** migration files land and are applied + verified to prod **first** (PR 1); the consuming backend merges **second** (PR 2), at which point Railway auto-deploys against an already-migrated, already-verified DB. This is the §8.3 release checklist from LLD 66, now backed by the §5 gate and §6 runner instead of a manual `SELECT`.
- **Scheduled-tier automation:** the gated job (§8.2 steps 1–3) runs **before** the step that allows the consuming code to deploy. Concretely this means the prod-touching migrate-and-verify job is a *required upstream* of the Railway deploy trigger (e.g. the deploy is promoted only after the migrate job succeeds), so automation can never ship code ahead of schema. If a single-merge model is ever required, the migrate-and-verify job must complete (and pass) before the deploy job is allowed to run — the deploy job `needs:` the migrate job.

**The invariant the mechanism must preserve: the backend never deploys ahead of its schema.** Any implementation of criterion 4 that cannot guarantee this ordering is rejected (which is why the entrypoint hook is out).

### 8.4 Idempotent & fail-closed

`supabase db push` is idempotent against already-applied migrations (it applies only pending ones); combined with the in-migration idempotency discipline (`IF [NOT] EXISTS`, guarded `DO $$`) of `001`–`006`, re-runs are safe. The job is fail-closed: any non-zero exit from the gate, the push, or the verification runner aborts the release and does not promote the backend deploy.

### 8.5 Scheduled tier is optional (restate)

Per §4, criterion 4 is a convenience layered on top of a prerequisite tier that already closes the gap. If it never ships, the two-merge sequenced design (§8.3) plus the prerequisite-tier gates remain a complete, safe path.

---

## 9. Credential Boundary (per-criterion mapping)

**This LLD contains no prod credentials, project refs, connection strings, or secrets — by requirement.** Every criterion is split into an autonomous-safe deliverable (built with no prod access, pointed at a placeholder/local target) and a human-owned wiring step (live prod link + secret storage).

| Criterion | Autonomous-safe (credential-free; #89/#90 build this) | Human-owned (live prod + secrets) |
|-----------|-------------------------------------------------------|-----------------------------------|
| This LLD (§1–§11) | The entire design document. No credential needed or present. | — |
| **1. Drift gate (§5)** | The allowlist file format, the diff-subtraction + fail-closed logic, and a unit test of that logic against a **captured/fixture diff**. The job *structure* pointed at a **local/placeholder** target. | `supabase link --project-ref <prod>`; storing the prod link secret in GitHub Secrets; flipping the job to `--linked` against live prod. |
| **2. Post-condition verification (§6)** | The `.postcondition.sql` declaration format, the post-condition files for existing migrations, the runner + 1:1-coverage check, run against the **fixture** and **local `supabase start`**. | Running the runner against **prod** after `db push` (the release-checklist step); any prod connection string. |
| **3. Prod-shaped fixture (§7)** | The entire fixture — it connects only to the **local** `supabase start` Postgres via `makePgClient` defaults. Fully autonomous. | None. (This leg is 100% autonomous-safe — a deliberate design property.) |
| **4. Scheduled-tier apply (§8)** | The gated job/workflow *structure* (gate → push → verify → deploy ordering), written against a **placeholder/local** target with the credential read from a secret reference that is empty in the repo. | Storing `RAILWAY_TOKEN` / prod Supabase link secret; enabling the job against live prod; the actual `db push` to prod. |

**Sequencing note for the operator:** #83 (drift cleanup, §10) and all live-prod wiring are human-owned (they touch the live DB / store secrets). #89 and #90 (fixture, verification harness, drift-job structure) are autonomous-safe and can ship without any prod access.

---

## 10. Sequencing — #83 first (clean baseline)

**#83 (prod schema drift cleanup) is sequenced FIRST**, before the drift gate goes live, so the gate has a clean, known baseline to assert against.

- #83 removes the TypeORM-era residue on the live prod DB: `*_pkey1` constraint names on `games` / `feedback` (the `player_stats` PK was already repaired by `006` in PR #81), and the stray `anon` `INSERT/UPDATE/DELETE` grants (the in-tree `001` grants `anon` only `SELECT` — the writes are residue).
- **Why first:** after #83, the *only* legitimate diff between prod and the applied-migration cumulative effect is the set of unapplied in-tree migrations (the §5.2 "expected pending"). Without #83, the §5 allowlist would have to permanently encode TypeORM-era noise as `acknowledgedResidual`, which (a) is brittle, (b) grows the allowlist into a rubber stamp, and (c) risks masking *real* drift behind the noise. A clean baseline makes the expected-diff tractable and keeps `acknowledgedResidual` empty.
- #83 is an external dependency, already tracked, and human-owned (it mutates live prod). This LLD does not author its migration; it consumes its clean result.

**Dependency order:** `#83 (clean prod) → drift gate goes live (§5) → [prerequisite tier complete] → #60's games-table migration may reach prod → [optionally] scheduled tier (§8)`.

---

## 11. Test Requirements

Per testing-principles: self-contained, isolated, run the real artifacts (no mocks of the SQL), deterministic. These specify what the prerequisite-tier sub-issues (#89/#90) must test; this LLD writes no tests itself.

### Unit — drift gate logic (§5)
- Residual computation: `observed − expected − acknowledgedResidual` = ∅ → pass; non-empty → **non-zero exit** (fail-closed). Drive with **captured/fixture diff fixtures** (no prod). 
- Stale-allowlist detection: an `expectedPending` entry that is already applied → fail; a pending migration missing from `expectedPending` → fail.
- A reviewed `acknowledgedResidual` entry suppresses exactly its one object and nothing else.

### Unit / integration — post-condition runner (§6)
- 1:1 coverage: a migration with no post-condition file → runner fails.
- A post-condition that `RAISE`s → runner exits non-zero (release-blocking).
- A passing post-condition against both the fixture and a clean `supabase start` DB → exits zero. (Same `.sql`, two contexts — proves name-agnosticism.)

### Integration — prod-shaped fixture (§7)
- **Regression-of-incident (the headline test):** `004` applied via `createProdShapedFixture({ drift: { pkey1ConstraintNames: true } })`, then the PK post-condition (§6.2) → **fails** (reproduces the LLD 66 incident at test time). The same `004`+`006` sequence against the fixture → **passes** (proves `006` repairs it).
- Fixture isolation: schema created and dropped within the test; two fixtures don't collide; teardown runs in `finally` (mirror the existing 006 tests).
- Drift toggles: `strayAnonWriteGrants: true` materializes the `anon` write grants; a post-condition asserting the cleaned grant set (post-#83) fails against the drifted fixture and passes against `baseline: "fresh"`.
- Real-SQL guarantee: the fixture executes `readMigrationSql(...)` output, not a re-implementation.

### Out of scope for automated tests (human-verified, credentialed)
- Anything touching live prod: `--linked` diff, `db push` to prod, the prod-side verification run. These are §9 human-owned steps, validated by the operator during the release, not by autonomous CI.

---

## 12. Dependencies

| Dependency | Status | Why |
|------------|--------|-----|
| **#83 — prod schema drift cleanup** | Tracked, human-owned, **sequenced first** (§10) | Clean baseline for the drift gate's expected-diff. External; this LLD consumes its result. |
| `tests/integration/helpers/pgClient.ts` (`makePgClient`, `readMigrationSql`) | Shipped | Foundation for the fixture (§7) and the post-condition runner (§6). Reused, not changed. |
| `tests/integration/player-stats.test.ts` (I4 + 006 throwaway-schema tests) | Shipped | The seed pattern the fixture generalizes (§7.1). |
| `supabase/migrations/006_fix_player_stats_composite_pk.sql` | Shipped | The name-agnostic repair whose discipline the post-condition format encodes (§6.2). |
| `supabase/migrations/001`–`005` | Applied | The applied set the expected-diff (§5.2) and post-conditions (§6) assert against. **Not edited.** |
| `railway.json`, `Dockerfile.production`, `docker-entrypoint.sh` | Shipped | Source of the T4/T5 deploy-path facts; the mechanism (§8) reasons about them. **Not changed.** |
| `.github/workflows/ci.yml` (`supabase start` jobs) | Shipped | Host for the drift gate / verification job (§5, §8). Extended by #90/scheduled tier, not by this LLD. |
| LLD 66 (§8.3 release checklist, fire-and-forget stats) | Shipped | The incident reference (§3) and the manual gate the §6 runner replaces. |
| LLD 10 / LLD 13 (deployment, Railway sleep-on-idle) | Shipped | Establish auto-deploy-on-merge (T4) and per-wake restart (the §8.1 entrypoint-rejection rationale). |

---

## 13. Open Questions / Escalations

None require CEO escalation. The scope (one capability, not split; prerequisite tier stands alone; #83 first; no prod creds) is fixed by the standing CEO decision recorded in the execution plan (Phase 6). Two implementation-time confirmations for #89/#90, neither blocking this design:

1. **Exact `supabase db diff --linked` output shape** for the gate's diff-subtraction (§5.3) — confirm against the installed Supabase CLI version at implementation time; the gate logic is written against the structured diff, and the unit tests use captured fixtures, so this does not block the design.
2. **The precise residual prod-drift set after #83** (§7.2) — the fixture's default drift set should be reconciled against #83's actual cleanup so the fixture tracks the real baseline. Until #83 lands, the fixture seeds the *known* set (`*_pkey1` names, stray `anon` writes); #89 updates it if #83 reveals more.
