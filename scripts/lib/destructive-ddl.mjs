/**
 * Destructive-DDL scanner logic (issue #91 CI guardrail).
 *
 * Pure, I/O-free SQL scanning + fail-closed semantics. The CLI
 * (verify-no-destructive-ddl.mjs) reads each supabase/migrations/*.sql off disk
 * and the sibling destructive-ddl.allowlist.json, then feeds their raw text here;
 * this module decides which destructive statements each migration contains and
 * whether the allowlist permits them. Kept pure so it is unit-tested against
 * inline SQL strings with no filesystem access (mirrors scripts/lib/drift-gate.mjs).
 *
 * Scope is DATA safety: the ban list is DROP TABLE, ALTER TABLE ... DROP COLUMN,
 * DELETE (FROM), and TRUNCATE — statements that destroy rows or the columns/tables
 * holding them. DROP FUNCTION / DROP INDEX are intentionally NOT banned: they
 * remove code / derived objects and destroy no data.
 *
 * Why a CI/review-layer gate and not DB privileges: Postgres role privileges
 * cannot express "alter but not drop" (both flow from indivisible table
 * ownership), so the destructive-change ban is enforced here, where the SQL is
 * visible and parseable — the same philosophy as the drift gate.
 *
 * Detection model:
 *   1. Neutralize SQL comments (`-- ...`, `/* ... *​/`) and string literals
 *      ('...', including doubled-quote '' escapes) by replacing them with spaces
 *      of equal length. This keeps byte offsets stable so surviving matches map
 *      back to the correct line, and guarantees a banned keyword sitting inside a
 *      comment or string can never trigger a false positive.
 *   2. Run each destructive-statement pattern over the neutralized SQL. Patterns
 *      are case-insensitive and tolerant of arbitrary whitespace/newlines between
 *      keywords (e.g. `DROP   TABLE`, `drop\n table`). The IF EXISTS variants are
 *      caught for free because the leading keyword pair still matches.
 *   3. `DELETE` is matched only as `DELETE FROM` — the sole form of a destructive
 *      DELETE statement — so the `DELETE` privilege token inside
 *      `GRANT/REVOKE ... DELETE` (which destroys nothing) is not a false positive.
 *      REVOKE, `ALTER ... DROP DEFAULT`/`DROP CONSTRAINT`, and `DROP FUNCTION`/
 *      `DROP INDEX` are intentionally not in the ban list (they add/adjust, or
 *      remove code/derived objects, but never destroy data), so migrations 001-010
 *      pass clean with an empty allowlist.
 */

/**
 * @typedef {object} DestructiveOp
 * @property {string} op         Canonical operation name (allowlist key), e.g. "DROP TABLE".
 * @property {number} line       1-indexed line where the statement starts.
 * @property {string} text       The matched keyword text, for the error message.
 */

/**
 * @typedef {object} MigrationFinding
 * @property {string} file       Migration filename (basename).
 * @property {DestructiveOp[]} ops   Destructive ops found (post comment/string strip).
 */

/**
 * @typedef {Record<string, string[]>} DestructiveAllowlist
 *   Maps a migration filename to the list of canonical destructive ops permitted
 *   in it (e.g. { "099_dedup.sql": ["DELETE"] }). A `$comment` key, if present,
 *   is ignored by the matcher.
 */

/**
 * @typedef {object} ScanResult
 * @property {boolean} ok            True iff every destructive op is allowlisted.
 * @property {MigrationFinding[]} findings  Per-file destructive ops (only files with ops).
 * @property {string[]} violations   Human-readable "file: op (line N)" for un-allowlisted ops.
 */

/**
 * Canonical destructive-statement patterns. Each `re` is applied to the
 * comment/string-stripped SQL. `\s+` between keywords makes matching tolerant of
 * extra spaces and newlines; the `g` flag lets us find every occurrence and its
 * offset. The order fixes precedence for reporting (DROP COLUMN before the object
 * DROPs is irrelevant since the patterns are disjoint).
 * @type {{ op: string, re: RegExp }[]}
 */
const PATTERNS = [
  { op: "DROP TABLE", re: /\bDROP\s+TABLE\b/gi },
  // ALTER TABLE ... DROP COLUMN. Does NOT match DROP DEFAULT / DROP CONSTRAINT.
  { op: "DROP COLUMN", re: /\bDROP\s+COLUMN\b/gi },
  // Only DELETE FROM is a destructive statement; the DELETE privilege in
  // GRANT/REVOKE lists is not followed by FROM in this position and is skipped.
  { op: "DELETE", re: /\bDELETE\s+FROM\b/gi },
  { op: "TRUNCATE", re: /\bTRUNCATE\b/gi },
];

/**
 * Replace SQL comments and string literals with equal-length blanks so a banned
 * keyword inside them cannot match, while byte offsets (and thus line numbers)
 * stay accurate. Handles `-- line comments`, `/* block comments *​/` (including
 * multi-line), and single-quoted string literals with `''` escapes. Dollar-quoted
 * bodies ($$...$$, used by the plpgsql functions) are left as-is: they contain
 * only INSERT/UPDATE/SELECT/RAISE in the real migrations, none of which are in the
 * ban list, and treating their contents as live SQL keeps the scanner strict.
 * @param {string} sql
 * @returns {string}
 */
export function stripCommentsAndStrings(sql) {
  const out = sql.split("");
  const blank = (start, end) => {
    for (let k = start; k < end; k++) {
      // Preserve newlines so line numbering is unchanged; blank everything else.
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      // Line comment: to end of line.
      let j = i + 2;
      while (j < n && sql[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && next === "*") {
      // Block comment: to closing */ (or EOF if unterminated).
      let j = i + 2;
      while (j < n && !(sql[j] === "*" && sql[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
    } else if (c === "'") {
      // Single-quoted string literal, with '' as an embedded-quote escape.
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2; // escaped quote, stays inside the string
          continue;
        }
        if (sql[j] === "'") {
          j++; // closing quote
          break;
        }
        j++;
      }
      blank(i, j);
      i = j;
    } else {
      i++;
    }
  }
  return out.join("");
}

/**
 * Find every destructive statement in one migration's SQL.
 * @param {string} sql   Raw migration file contents.
 * @returns {DestructiveOp[]}
 */
export function findDestructiveOps(sql) {
  const cleaned = stripCommentsAndStrings(sql);
  /** @type {DestructiveOp[]} */
  const ops = [];
  for (const { op, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(cleaned)) !== null) {
      const line = cleaned.slice(0, m.index).split("\n").length;
      ops.push({ op, line, text: m[0].replace(/\s+/g, " ") });
    }
  }
  return ops.sort((a, b) => a.line - b.line);
}

/**
 * Evaluate a set of migrations against the allowlist. Pure: no I/O.
 * Fail-closed — any destructive op without a matching per-file allowlist entry
 * fails the gate.
 * @param {{ file: string, sql: string }[]} migrations
 * @param {DestructiveAllowlist} allowlist
 * @returns {ScanResult}
 */
export function evaluateDestructiveDdl(migrations, allowlist) {
  /** @type {MigrationFinding[]} */
  const findings = [];
  /** @type {string[]} */
  const violations = [];

  for (const { file, sql } of migrations) {
    const ops = findDestructiveOps(sql);
    if (ops.length === 0) continue;
    findings.push({ file, ops });
    const permitted = new Set(allowlist[file] ?? []);
    for (const op of ops) {
      if (!permitted.has(op.op)) {
        violations.push(`${file}: ${op.op} (line ${op.line})`);
      }
    }
  }

  return { ok: violations.length === 0, findings, violations };
}
