/**
 * Linked-prod drift adapter (LLD 77a, issue #91).
 *
 * Pure, I/O-free normalizer that turns the RAW stdout of two Supabase CLI
 * commands into the structured-diff shape the shipped verdict logic
 * (scripts/lib/drift-gate.mjs) already consumes:
 *
 *   { objects: [{object}], expectedFromPending: [{object}], pending: [<file>] }
 *
 * Two independent sources (LLD 77a §2.1):
 *   - `supabase db diff --linked --schema public`  → residual `objects`
 *   - `supabase migration list --linked`           → `pending`
 *
 * Kept pure so it is unit-tested against captured raw-output fixtures with zero
 * prod access — exactly how drift-gate.mjs / destructive-ddl.mjs are tested. The
 * thin `--linked` branch in verify-drift.mjs runs the CLI and hands stdout here.
 *
 * DIRECTION (confirmed against the real prod capture, 2026-07-04):
 * `supabase db diff --linked` builds a shadow DB from the LOCAL migrations and
 * diffs shadow -> prod. So a `drop`/`revoke` statement means PROD IS MISSING the
 * object (it exists in the migrations but not yet on prod — e.g. an unapplied
 * migration). A `create`/`grant` statement means prod has an object the
 * migrations do not (residual). See scripts/fixtures/captures/README.md.
 *
 * GAP-A / GAP-B (design-review REQUIRED changes):
 *   - Gap B (precedence): every classified diff statement is first checked for
 *     attribution to a PENDING migration (its object is declared by a file in the
 *     `pending` set). Pending-attributable statements are DROPPED as benign; only
 *     the rest become residual `objects`. The whole game_history cluster (table +
 *     2 indexes + pkey constraint + all the revokes + get_windowed_stats) is the
 *     worked example — every piece attributes to pending migration 010.
 *   - Gap A (cross-consistency): if a statement attributes to a migration that is
 *     NOT actually in the pending set, THROW. This prevents a grammar misread from
 *     silently swallowing a real residual by mis-attributing it to a non-pending
 *     migration.
 *
 * FAIL-CLOSED (LLD 77a §5): any unclassifiable statement, empty-but-not-sentinel
 * output, unparseable migration-list table, or unmappable pending version key
 * THROWS. The adapter never returns a partial/best-effort result.
 *
 * EXPECTED-FROM-PENDING SEAM (design-review REQUIRED change E1/E2): the strategy
 * for producing `expectedFromPending` lives behind the single
 * `buildExpectedFromPending()` boundary. v1 uses E1 (the classifier already drops
 * pending-attributable statements, so `expectedFromPending` is empty); swapping to
 * E2 (shadow-apply) only touches that one function.
 */

/**
 * @typedef {object} RawLinkedOutput
 * @property {string} dbDiffStdout        stdout of `supabase db diff --linked --schema public`
 * @property {string} migrationListStdout stdout of `supabase migration list --linked`
 */

/**
 * @typedef {object} AdapterResult
 * @property {{object:string}[]} objects  residual drift objects (§4.2)
 * @property {{object:string}[]} expectedFromPending  objects attributable to pending migrations (E1 → [])
 * @property {string[]} pending           in-tree migration filenames not applied to prod (sorted)
 */

/** Thrown when the adapter cannot classify/parse an input (fail-closed). */
export class LinkedDiffError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "LinkedDiffError";
  }
}

/** The exact documented no-change sentinel emitted by `db diff` (V3). */
const NO_CHANGES_SENTINEL = "No schema changes found";

/**
 * CLI progress/noise lines that `db diff` interleaves with the DDL. These are
 * printed to stdout by the CLI (not stderr) and carry no schema meaning, so they
 * are stripped BEFORE statement parsing. Matching is anchored per-line.
 * @type {RegExp[]}
 */
const DB_DIFF_NOISE_LINE = [
  /^Seeding globals /i,
  /^Applying migration /i,
  /^Diffing schemas:/i,
  /^Finished supabase db diff /i,
  /^Initialising /i,
  /^Connecting to /i,
];

/**
 * Preamble statements the diff engine emits that set session state and touch no
 * schema object. They must be IGNORED (not thrown on) — but nothing beyond this
 * short, explicit allowlist is ignored, so the classifier stays fail-closed.
 * @type {RegExp[]}
 */
const DB_DIFF_PREAMBLE_STATEMENT = [
  /^set\s+check_function_bodies\s*=/i,
  /^set\s+search_path\s*=/i,
];

// A double-quoted identifier segment: "public" or "game_history". Postgres
// dumps schema-qualified names as "schema"."name"; the schema is optional for a
// few forms. Captured group is the bare identifier text.
const ID = `"([^"]+)"`;

/**
 * Split raw db-diff stdout into individual DDL statements.
 *
 * Strategy: drop noise lines, then split on `;` at statement boundaries. Function
 * bodies use dollar-quoting (`$function$ ... $function$` / `$$ ... $$`), whose
 * bodies can contain `;`, so we track dollar-quote tags and only treat a `;` as a
 * terminator when we are OUTSIDE a dollar-quoted body. SQL string literals and
 * `--` line comments are also respected so a `;` inside them is not a boundary.
 *
 * @param {string} dbDiffStdout
 * @returns {string[]} trimmed non-empty statements (no trailing `;`)
 */
export function splitDdlStatements(dbDiffStdout) {
  const denoised = dbDiffStdout
    .split("\n")
    .filter((line) => !DB_DIFF_NOISE_LINE.some((re) => re.test(line.trim())))
    .join("\n");

  /** @type {string[]} */
  const statements = [];
  let buf = "";
  let i = 0;
  const n = denoised.length;
  /** @type {string|null} */
  let dollarTag = null; // e.g. "$function$" or "$$" when inside a body

  while (i < n) {
    const rest = denoised.slice(i);

    if (dollarTag) {
      // Inside a dollar-quoted body: look only for the closing tag.
      if (rest.startsWith(dollarTag)) {
        buf += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      buf += denoised[i];
      i++;
      continue;
    }

    // Opening of a dollar-quoted body: $tag$ (tag is [A-Za-z0-9_]*).
    const dollarOpen = rest.match(/^\$[A-Za-z0-9_]*\$/);
    if (dollarOpen) {
      dollarTag = dollarOpen[0];
      buf += dollarTag;
      i += dollarTag.length;
      continue;
    }

    const c = denoised[i];

    // `--` line comment → skip to end of line (keep the newline).
    if (c === "-" && denoised[i + 1] === "-") {
      let j = i + 2;
      while (j < n && denoised[j] !== "\n") j++;
      i = j;
      continue;
    }

    // Single-quoted string literal (with '' escape).
    if (c === "'") {
      buf += c;
      let j = i + 1;
      while (j < n) {
        if (denoised[j] === "'" && denoised[j + 1] === "'") {
          buf += "''";
          j += 2;
          continue;
        }
        buf += denoised[j];
        if (denoised[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }

    if (c === ";") {
      const trimmed = buf.trim();
      if (trimmed) statements.push(trimmed);
      buf = "";
      i++;
      continue;
    }

    buf += c;
    i++;
  }

  if (dollarTag) {
    throw new LinkedDiffError(
      `db diff parse error: unterminated dollar-quoted body (${dollarTag}).`,
    );
  }
  // Any trailing non-terminated text that isn't just whitespace is suspicious.
  if (buf.trim()) {
    throw new LinkedDiffError(
      `db diff parse error: trailing text with no terminating ';': ${buf.trim().slice(0, 120)}`,
    );
  }
  return statements;
}

/**
 * @typedef {object} ClassifiedObject
 * @property {string} object     stable id (fixture grammar: constraint:<t>:<name>,
 *                               grant:<role>:<t>:<PRIV>, table:<schema>:<name>,
 *                               index:<schema>:<name>, function:<schema>:<name>).
 *                               NEW (LLD 77b, v1):
 *                                 rls:<schema>:<table>           — ENABLE ROW LEVEL SECURITY
 *                                 policy:<schema>:<table>:<CMD>  — CREATE POLICY (CMD in
 *                                                                  SELECT|INSERT|UPDATE|DELETE|ALL;
 *                                                                  name-agnostic, grammar B).
 * @property {"add"|"drop"} direction  "drop" = the statement REMOVES the object
 *                               from prod (drop/revoke — per the confirmed
 *                               direction, prod is MISSING it, so it's declared by
 *                               a migration not yet on prod). "add" = the statement
 *                               ADDS it to prod (create/grant/alter…add — prod has
 *                               an object the migrations don't → residual).
 * @property {string|null} table  the table the object hangs off (for table/index/
 *                               constraint/grant), used for pending attribution;
 *                               null for a bare function.
 */

/**
 * Classify a single DDL statement, matching the fixture grammar exactly. Returns
 * a ClassifiedObject per affected object (grant/revoke → one per privilege).
 * Preamble/session-state statements return []. THROWS on anything unrecognized
 * (fail-closed, F3).
 *
 * `direction` is the load-bearing attribution signal (LLD 77a A2, confirmed by the
 * real capture): `db diff` builds a shadow from the migrations and diffs shadow →
 * prod, so a DROP/REVOKE means prod lacks an object the migrations declare (the
 * pending-migration signature), and a CREATE/GRANT/ADD means prod has an extra
 * object (the residual signature).
 *
 * @param {string} stmt  a single DDL statement (no trailing `;`)
 * @returns {ClassifiedObject[]}
 */
export function classifyStatement(stmt) {
  const s = stmt.trim();

  // Preamble/session-state statements → ignore.
  if (DB_DIFF_PREAMBLE_STATEMENT.some((re) => re.test(s))) return [];

  // --- constraint: ALTER TABLE [ONLY] <t> {ADD|DROP} CONSTRAINT <name> ...
  {
    const re = new RegExp(
      `^alter\\s+table\\s+(?:only\\s+)?(?:${ID}\\.)?${ID}\\s+(add|drop)\\s+constraint\\s+${ID}`,
      "i",
    );
    const m = s.match(re);
    if (m) {
      // groups: [schema?, table, add|drop, constraintName]
      const table = m[3] ? m[2] : m[1];
      const verb = m[3] ? m[3] : m[2];
      const name = m[4] ?? m[3];
      const direction = /^drop$/i.test(verb) ? "drop" : "add";
      return [{ object: `constraint:${table}:${name}`, direction, table }];
    }
  }

  // --- index: {CREATE|DROP} [UNIQUE] INDEX [IF (NOT )?EXISTS] [<schema>.]<name> ...
  {
    const re = new RegExp(
      `^(create|drop)\\s+(?:unique\\s+)?index\\s+(?:if\\s+(?:not\\s+)?exists\\s+)?(?:${ID}\\.)?${ID}`,
      "i",
    );
    const m = s.match(re);
    if (m) {
      const verb = m[1];
      const schema = m[3] ? m[2] : "public";
      const name = m[3] ?? m[2];
      const direction = /^drop$/i.test(verb) ? "drop" : "add";
      // An index has no table token in a DROP INDEX statement; its table is not
      // directly available. Attribution falls back to the index NAME (§adapter).
      return [{ object: `index:${schema}:${name}`, direction, table: null }];
    }
  }

  // --- table: {CREATE|DROP} TABLE [IF (NOT )?EXISTS] [<schema>.]<name> ...
  {
    const re = new RegExp(
      `^(create|drop)\\s+table\\s+(?:if\\s+(?:not\\s+)?exists\\s+)?(?:${ID}\\.)?${ID}`,
      "i",
    );
    const m = s.match(re);
    if (m) {
      const verb = m[1];
      const schema = m[3] ? m[2] : "public";
      const name = m[3] ?? m[2];
      const direction = /^drop$/i.test(verb) ? "drop" : "add";
      return [{ object: `table:${schema}:${name}`, direction, table: name }];
    }
  }

  // --- function: {DROP FUNCTION [IF EXISTS] | CREATE [OR REPLACE] FUNCTION}
  //     [<schema>.]<name>(<args>) ...  Handles quoted ("public"."fn") and
  //     unquoted (public.fn) forms — the capture uses both.
  {
    const re =
      /^(drop\s+function(?:\s+if\s+exists)?|create(?:\s+or\s+replace)?\s+function)\s+(?:(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\.)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*\(/i;
    const m = s.match(re);
    if (m) {
      const schema = m[2] ?? m[3] ?? "public";
      const name = m[4] ?? m[5];
      const direction = /^drop/i.test(m[1]) ? "drop" : "add";
      return [{ object: `function:${schema}:${name}`, direction, table: null }];
    }
  }

  // --- grant/revoke on a table: {GRANT|REVOKE} <priv-list> ON [TABLE] [<schema>.]<t>
  //     {TO|FROM} <role>. One id per privilege token: grant:<role>:<t>:<PRIV>.
  {
    const re = new RegExp(
      `^(grant|revoke)\\s+(.+?)\\s+on\\s+(?:table\\s+)?(?:${ID}\\.)?${ID}\\s+(?:to|from)\\s+${ID}`,
      "i",
    );
    const m = s.match(re);
    if (m) {
      const verb = m[1];
      const privList = m[2];
      const table = m[4] ? m[4] : m[3];
      const role = m[5] ?? m[4];
      const direction = /^revoke$/i.test(verb) ? "drop" : "add";
      const privs = privList
        .split(",")
        .map((p) => p.trim().toUpperCase())
        .filter(Boolean);
      if (privs.length === 0) {
        throw new LinkedDiffError(
          `Unclassifiable grant/revoke (no privileges): ${s.slice(0, 200)}`,
        );
      }
      return privs.map((priv) => ({
        object: `grant:${role}:${table}:${priv}`,
        direction,
        table,
      }));
    }
  }

  // --- RLS enable (LLD 77b v1): ALTER TABLE [ONLY] <t> ENABLE ROW LEVEL SECURITY
  //     Anchored to `enable ... security$` so `disable ... security` (deferred
  //     verb) does NOT match and falls through to the F3 throw. Prod-missing the
  //     shadow-declared RLS ⇒ direction:"drop" (pending-attributable — §Approach).
  {
    const re = new RegExp(
      `^alter\\s+table\\s+(?:only\\s+)?(?:${ID}\\.)?${ID}\\s+enable\\s+row\\s+level\\s+security$`,
      "i",
    );
    const m = s.match(re);
    if (m) {
      // groups: [schema?, table]
      const schema = m[2] ? m[1] : "public";
      const table = m[2] ?? m[1];
      return [{ object: `rls:${schema}:${table}`, direction: "drop", table }];
    }
  }

  // --- create policy (LLD 77b v1): CREATE POLICY <name> ON <t> [FOR <cmd>] ...
  //     Anchored to `^create policy`; `drop policy` / `alter policy` (deferred
  //     verbs) do NOT match and fall through to F3. Name-agnostic id (grammar B):
  //     the policy name is captured but discarded from the id; the `FOR <cmd>`
  //     clause defaults to ALL (Postgres default). direction:"drop" (prod-missing).
  {
    const re = new RegExp(
      `^create\\s+policy\\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\\s+on\\s+(?:${ID}\\.)?${ID}(?:\\s+for\\s+(select|insert|update|delete|all))?`,
      "i",
    );
    const m = s.match(re);
    if (m) {
      // groups: [schema?, table, for-cmd?]
      const schema = m[2] ? m[1] : "public";
      const table = m[2] ?? m[1];
      const cmd = (m[3] ?? "ALL").toUpperCase();
      return [
        {
          object: `policy:${schema}:${table}:${cmd}`,
          direction: "drop",
          table,
        },
      ];
    }
  }

  throw new LinkedDiffError(
    `Unclassifiable db diff statement (fail-closed, F3): ${s.slice(0, 200)}`,
  );
}

/**
 * Parse `supabase migration list --linked` stdout into applied/pending version
 * keys (LLD 77a §4.4). The table has three columns `Local | Remote | Time`; a row
 * with a non-empty LOCAL and blank REMOTE = pending. The CLI wraps each cell value
 * in backticks and prints harmless "Skipping migration ..." warnings for the
 * `.json` allowlist files — those and all non-table noise are ignored.
 *
 * @param {string} migrationListStdout
 * @returns {{ pendingKeys: string[], appliedKeys: string[] }}
 */
export function parseMigrationList(migrationListStdout) {
  const lines = migrationListStdout.split("\n");
  // Locate the header row: contains both "Local" and "Remote".
  const headerIdx = lines.findIndex(
    (l) => /\blocal\b/i.test(l) && /\bremote\b/i.test(l),
  );
  if (headerIdx === -1) {
    throw new LinkedDiffError(
      "migration list parse error (F6): could not find the 'Local | Remote | Time' header.",
    );
  }

  /** Extract the value inside the first backtick pair, or empty string. */
  const cellValue = (cell) => {
    const m = cell.match(/`([^`]*)`/);
    return m ? m[1].trim() : cell.trim();
  };

  /** @type {string[]} */
  const pendingKeys = [];
  /** @type {string[]} */
  const appliedKeys = [];
  let sawDataRow = false;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // Skip the box-drawing separator row (dashes / dashes + pipes only).
    if (/^[\s|+-]+$/.test(line)) continue;

    // A data row is delimited by the pipe glyph `|` (ASCII) or `│` (box-drawing).
    const cells = line.split(/[|│]/);
    if (cells.length < 2) {
      // Not a table row (stray noise after the table) — ignore rather than throw:
      // the CLI can print a trailing blank/hint. Data rows always have >=2 cells.
      continue;
    }
    const local = cellValue(cells[0]);
    const remote = cellValue(cells[1]);
    if (!local) {
      // No LOCAL value: either prod-ahead-of-tree (remote-only) or malformed.
      // A remote-only row means prod has a migration the repo lacks — treat as an
      // applied key we cannot map (surfaced by the caller's cross-check).
      if (remote) {
        sawDataRow = true;
        appliedKeys.push(remote);
      }
      continue;
    }
    sawDataRow = true;
    if (remote) appliedKeys.push(local);
    else pendingKeys.push(local);
  }

  if (!sawDataRow) {
    throw new LinkedDiffError(
      "migration list parse error (F6): header found but no well-formed data rows.",
    );
  }
  return { pendingKeys, appliedKeys };
}

/**
 * Version-key mapping (LLD 77a §4.4 step 4, resolves A4). The real capture shows
 * the CLI prints the bare numeric prefix (`010`) in the LOCAL/REMOTE columns, so
 * an in-tree file `NNN_name.sql` maps by the digits before its first underscore.
 * To stay robust to the "full basename" form the LLD flagged, a key also matches
 * a file whose basename equals the key. Each pending key MUST map to exactly one
 * in-tree file or we THROW (F5) — never silently drop a pending migration.
 *
 * @param {string[]} versionKeys       keys from migration list (LOCAL cells)
 * @param {string[]} inTreeFiles       basenames of supabase/migrations/*.sql
 * @returns {string[]}                 sorted in-tree filenames
 */
export function mapVersionKeysToFiles(versionKeys, inTreeFiles) {
  /** @param {string} key */
  const matchesFile = (key, file) => {
    if (file === key) return true; // full-basename form
    const prefix = file.split("_")[0]; // NNN prefix
    return prefix === key;
  };

  /** @type {string[]} */
  const mapped = [];
  for (const key of versionKeys) {
    const hits = inTreeFiles.filter((f) => matchesFile(key, f));
    if (hits.length !== 1) {
      throw new LinkedDiffError(
        `Pending migration version key '${key}' maps to ${hits.length} in-tree files (expected exactly 1) — A4 assumption violated (F5). Hits: [${hits.join(", ")}]`,
      );
    }
    mapped.push(hits[0]);
  }
  return mapped.sort();
}

/**
 * E1/E2 SEAM (design-review REQUIRED change): produce `expectedFromPending`.
 *
 * v1 uses strategy E1: the precedence rule (Gap B) already DROPs every statement
 * attributable to a pending migration before it can become a residual `object`, so
 * nothing is left to subtract via `expectedFromPending` — it is empty. The gate's
 * `residual = observed − expectedFromPending − acknowledged` still holds (observed
 * already excludes pending-attributable statements).
 *
 * To switch to E2 (shadow-apply pending SQL and enumerate the object ids each
 * pending migration introduces), replace ONLY this function's body; nothing else
 * in the adapter threads through the parser core.
 *
 * @param {ClassifiedObject[]} _residual  the surviving residual objects
 * @param {PendingObjects} _pendingObjects  what the pending migrations declare
 * @returns {{object:string}[]}
 */
function buildExpectedFromPending(_residual, _pendingObjects) {
  return [];
}

/**
 * @typedef {object} PendingObjects
 * @property {Set<string>} tables     table names created by a pending migration.
 * @property {Set<string>} functions  function names created by a pending migration.
 * @property {Map<string,string>} byName  declared name → the pending file that
 *                                    declares it (for Gap-A cross-consistency).
 * @property {Set<string>} rlsTables  table names a pending migration adds RLS or a
 *                                    policy to (LLD 77b, via a RAW-TEXT scan that
 *                                    reads inside `DO $$` guard blocks).
 * @property {Map<string,string>} rlsByName  rls/policy target table → the pending
 *                                    file that first declares it in scan order.
 */

/**
 * Enumerate the objects the pending migrations DECLARE, so a `db diff` drop/revoke
 * (prod-missing) can be attributed to a pending migration (Gap B) and cross-checked
 * (Gap A). Derived by scanning the pending migration SQL for the top-level objects
 * it creates — tables and functions. Indexes/constraints/grants are attributed via
 * their owning TABLE (the game_history cluster is the worked example: table +
 * indexes + pkey constraint + 15 revokes + get_windowed_stats all attribute to
 * migration 010). Fail-closed: a drop whose owning name is not declared by any
 * pending migration is NOT attributed (→ surfaced as residual by the caller).
 *
 * RLS/policy targets (LLD 77b) are collected into `rlsTables`/`rlsByName` by a
 * RAW-TEXT regex scan over the whole migration SQL — deliberately NOT via
 * splitDdlStatements/classifyStatement, because 011's `CREATE POLICY` lives inside
 * a `DO $$ ... END $$;` guard block that the splitter treats as opaque. A raw-text
 * scan matches inside the block body (it is just text to the regex), so the guarded
 * policy's target table is visible for attribution (§State Model Gap 2).
 *
 * @param {{file:string, sql:string}[]} pendingMigrations
 * @returns {PendingObjects}
 */
export function pendingDeclaredObjects(pendingMigrations) {
  /** @type {Set<string>} */
  const tables = new Set();
  /** @type {Set<string>} */
  const functions = new Set();
  /** @type {Map<string,string>} */
  const byName = new Map();
  /** @type {Set<string>} */
  const rlsTables = new Set();
  /** @type {Map<string,string>} */
  const rlsByName = new Map();

  const tableRe =
    /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?[A-Za-z0-9_]+"?\.)?"?([A-Za-z0-9_]+)"?/gi;
  const functionRe =
    /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"?[A-Za-z0-9_]+"?\.)?"?([A-Za-z0-9_]+)"?/gi;
  // RAW-TEXT scans (LLD 77b Gap 2): tolerate the migration-authored forms
  // (unquoted or quoted table names, the 002/011 grammar), including inside
  // `DO $$` blocks. These read the whole SQL string, NOT split statements.
  const enableRlsRe =
    /\balter\s+table\s+(?:only\s+)?(?:"?[A-Za-z0-9_]+"?\.)?"?([A-Za-z0-9_]+)"?\s+enable\s+row\s+level\s+security/gi;
  const createPolicyRe =
    /\bcreate\s+policy\s+(?:"[^"]+"|[A-Za-z0-9_]+)\s+on\s+(?:"?[A-Za-z0-9_]+"?\.)?"?([A-Za-z0-9_]+)"?/gi;

  for (const { file, sql } of pendingMigrations) {
    tableRe.lastIndex = 0;
    let m;
    while ((m = tableRe.exec(sql)) !== null) {
      tables.add(m[1]);
      if (!byName.has(m[1])) byName.set(m[1], file);
    }
    functionRe.lastIndex = 0;
    while ((m = functionRe.exec(sql)) !== null) {
      functions.add(m[1]);
      if (!byName.has(m[1])) byName.set(m[1], file);
    }
    enableRlsRe.lastIndex = 0;
    while ((m = enableRlsRe.exec(sql)) !== null) {
      rlsTables.add(m[1]);
      if (!rlsByName.has(m[1])) rlsByName.set(m[1], file);
    }
    createPolicyRe.lastIndex = 0;
    while ((m = createPolicyRe.exec(sql)) !== null) {
      rlsTables.add(m[1]);
      if (!rlsByName.has(m[1])) rlsByName.set(m[1], file);
    }
  }
  return { tables, functions, byName, rlsTables, rlsByName };
}

/**
 * Every table name CREATEd anywhere in the tree (pending OR applied). Used to
 * resolve which table a DROP INDEX belongs to WITHOUT over-attributing to a
 * pending table whose short name merely prefixes a longer applied table's index.
 * @param {{file:string, sql:string}[]} inTreeMigrations
 * @returns {Set<string>}
 */
export function allDeclaredTables(inTreeMigrations) {
  const tableRe =
    /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?[A-Za-z0-9_]+"?\.)?"?([A-Za-z0-9_]+)"?/gi;
  /** @type {Set<string>} */
  const tables = new Set();
  for (const { sql } of inTreeMigrations) {
    tableRe.lastIndex = 0;
    let m;
    while ((m = tableRe.exec(sql)) !== null) tables.add(m[1]);
  }
  return tables;
}

/**
 * Resolve the table a DROP INDEX belongs to, by matching the index name against
 * the Postgres index-naming conventions over the FULL set of in-tree tables and
 * picking the LONGEST match (so `idx_game_history_user_played` resolves to
 * `game_history`, never the shorter `game`). Returns null if no in-tree table
 * matches. Accepted forms:
 *   <table>          (exact)
 *   <table>_…        (implicit PK/unique index, e.g. game_history_pkey)
 *   idx_<table>_…    (our explicit index convention, e.g.
 *                     idx_game_history_user_played → game_history)
 * @param {string} indexName
 * @param {Set<string>} allTables
 * @returns {string|null}
 */
function indexOwningTable(indexName, allTables) {
  /** @type {string|null} */
  let best = null;
  for (const table of allTables) {
    if (
      indexName === table ||
      indexName.startsWith(`${table}_`) ||
      indexName.startsWith(`idx_${table}_`)
    ) {
      if (best === null || table.length > best.length) best = table;
    }
  }
  return best;
}

/**
 * Decide whether a `db diff` DROP/REVOKE (prod-missing object) is attributable to
 * a PENDING migration — i.e. prod lacks it only because the migration that
 * declares it has not been applied yet. Returns the declaring pending filename, or
 * null if it is NOT attributable (which the caller treats as real residual drift:
 * prod is missing an object an APPLIED migration should have created).
 *
 *   - table:<schema>:<name> / constraint:<name-table>:* / grant:<role>:<table>:* →
 *     attributed iff <table> is a pending-created table.
 *   - function:<schema>:<name> → attributed iff <name> is a pending-created function.
 *   - index:<schema>:<name>    → resolve the index's OWNING table (the longest
 *     in-tree table matching the naming convention) and attribute iff THAT owning
 *     table is pending. This rejects the over-attribution where a short pending
 *     table name (e.g. `game`) coincidentally prefixes an applied table's index
 *     (`idx_game_history_user_played`, owned by `game_history`) — the longest
 *     match wins, so the applied `game_history` owner is chosen and, not being
 *     pending, the drop surfaces as residual. Guarded by DROP direction.
 *   - rls:<schema>:<table> / policy:<schema>:<table>:<CMD> (LLD 77b) → dedicated
 *     branch evaluated FIRST. Attributed iff the target table is affected by a
 *     pending migration — either pending-CREATEd (pending.tables) OR pending-RLS'd
 *     (pending.rlsTables). pending.tables is consulted FIRST (the create-table
 *     byName is the more specific fact); in the milestone case the RLS target table
 *     (game_history) is created by APPLIED 010 so attribution comes via rlsTables.
 *
 * @param {ClassifiedObject} obj
 * @param {PendingObjects} pending
 * @param {Set<string>} allTables  every table CREATEd anywhere in the tree
 * @returns {string|null}  the declaring pending filename, or null
 */
function pendingAttribution(obj, pending, allTables) {
  const kind = obj.object.split(":")[0];

  // LLD 77b: RLS/policy route through ONE dedicated branch, evaluated FIRST, so
  // they never fall through the generic pending.tables branch ambiguously.
  // obj.table is always set for these kinds (the RLS/policy target table).
  if (kind === "rls" || kind === "policy") {
    if (obj.table && pending.tables.has(obj.table)) {
      return pending.byName.get(obj.table) ?? null;
    }
    if (obj.table && pending.rlsTables.has(obj.table)) {
      return pending.rlsByName.get(obj.table) ?? null;
    }
    return null;
  }

  if (obj.table && pending.tables.has(obj.table)) {
    return pending.byName.get(obj.table) ?? null;
  }
  const parts = obj.object.split(":");
  if (kind === "function") {
    const name = parts[2];
    return pending.functions.has(name)
      ? (pending.byName.get(name) ?? null)
      : null;
  }
  if (kind === "index") {
    const owner = indexOwningTable(parts[2], allTables);
    if (owner !== null && pending.tables.has(owner)) {
      return pending.byName.get(owner) ?? null;
    }
    return null;
  }
  return null;
}

/**
 * Pure: raw CLI stdout → structured diff. THROWS on any unclassifiable/ambiguous
 * input (fail-closed, §5). Never returns a partial/best-effort result.
 *
 * @param {RawLinkedOutput} raw
 * @param {{file:string, sql:string}[]} inTreeMigrations  every supabase/migrations/*.sql (basename + contents), sorted
 * @returns {AdapterResult}
 */
export function adaptLinkedDiff(raw, inTreeMigrations) {
  const inTreeFiles = inTreeMigrations.map((m) => m.file).sort();

  // --- 1. pending (from migration list) — the load-bearing #156 source. ------
  const { pendingKeys } = parseMigrationList(raw.migrationListStdout);
  const pending = mapVersionKeysToFiles(pendingKeys, inTreeFiles);
  const pendingSet = new Set(pending);
  const pendingMigrations = inTreeMigrations.filter((m) =>
    pendingSet.has(m.file),
  );

  // Objects DECLARED by the pending migrations, for Gap-A/Gap-B attribution.
  const pendingObjects = pendingDeclaredObjects(pendingMigrations);
  // Every table in the tree (pending + applied) — needed to resolve a DROP INDEX
  // to its true owning table without over-attributing to a short pending name.
  const allTables = allDeclaredTables(inTreeMigrations);

  // --- 2. residual objects (from db diff) ------------------------------------
  const dbTrimmed = raw.dbDiffStdout.trim();

  // Sentinel short-circuit: EXACTLY the documented no-change message → clean.
  // Some CLI versions interleave the sentinel with progress noise; accept it iff
  // the sentinel line is present AND no DDL statements survive the split.
  const denoisedForSentinel = dbTrimmed
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !DB_DIFF_NOISE_LINE.some((re) => re.test(l)));
  const isSentinel =
    denoisedForSentinel.length === 1 &&
    denoisedForSentinel[0] === NO_CHANGES_SENTINEL;

  /** @type {ClassifiedObject[]} */
  const residual = [];

  if (!isSentinel) {
    const statements = splitDdlStatements(raw.dbDiffStdout);

    // F4: no statements survived but it wasn't the sentinel → suspicious (empty
    // or truncated run). Never treat that as clean.
    if (statements.length === 0) {
      throw new LinkedDiffError(
        "db diff produced no DDL statements and was not the exact 'No schema changes found' sentinel (F4). Refusing to treat empty output as clean.",
      );
    }

    for (const stmt of statements) {
      const classified = classifyStatement(stmt); // throws F3 on unknown
      for (const obj of classified) {
        if (obj.direction === "drop") {
          // A DROP/REVOKE means prod is MISSING the object (confirmed direction).
          // --- Gap B (precedence): attribution to a pending migration runs FIRST.
          const declFile = pendingAttribution(obj, pendingObjects, allTables);
          if (declFile) {
            // --- Gap A (cross-consistency): the declaring migration MUST be in
            // the pending set. pendingObjects is built only from pending
            // migrations, so this should always hold — assert defensively so a
            // future mis-attribution can never silently swallow a real residual.
            if (!pendingSet.has(declFile)) {
              throw new LinkedDiffError(
                `Gap-A cross-consistency violation: '${stmt.slice(0, 120)}' (object ${obj.object}) attributed to '${declFile}' which is NOT in the pending set [${pending.join(", ")}].`,
              );
            }
            // Benign: prod lacks an object a pending migration will add. Drop it.
            continue;
          }
          // Not attributable to any pending migration → prod is missing an object
          // that an ALREADY-APPLIED migration should have created. That is real
          // drift; surface it (fail-closed — never silently drop an unattributable
          // DROP by mis-reading it as pending).
          residual.push(obj);
          continue;
        }
        // direction === "add": prod HAS an object the migrations don't → residual.
        residual.push(obj);
      }
    }
  }

  // De-duplicate object ids (a diff may repeat, e.g. constraint + its index).
  const seen = new Set();
  /** @type {{object:string}[]} */
  const objects = [];
  for (const r of residual) {
    if (seen.has(r.object)) continue;
    seen.add(r.object);
    objects.push({ object: r.object });
  }

  // --- 3. expectedFromPending (E1 seam) --------------------------------------
  const expectedFromPending = buildExpectedFromPending(
    residual,
    pendingObjects,
  );

  return { objects, expectedFromPending, pending };
}
