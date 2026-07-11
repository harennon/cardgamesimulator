#!/usr/bin/env node
/**
 * errors.mjs — Query Sentry REST API for captured frontend errors.
 *
 * Usage:
 *   node scripts/errors.mjs [options]
 *
 * Options:
 *   --json                   Emit a JSON array to stdout
 *   --recent <N>             Only show issues last seen within N hours
 *   --since <ISO>            Only show issues last seen after <ISO date>
 *   --correlation-id <id>    Filter by correlation_id tag (cx_...)
 *   --game-id <id>           Filter by game_id tag
 *
 * Reads credentials from .env.admin:
 *   SENTRY_AUTH_TOKEN — personal auth token (scopes: project:read, event:read)
 *   SENTRY_ORG        — Sentry org slug
 *   SENTRY_PROJECT    — Sentry project slug
 */
import { config } from "dotenv";

config({ path: ".env.admin" });

const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN;
const SENTRY_ORG = process.env.SENTRY_ORG;
const SENTRY_PROJECT = process.env.SENTRY_PROJECT;

if (!SENTRY_AUTH_TOKEN || !SENTRY_ORG || !SENTRY_PROJECT) {
  console.error(
    "Missing .env.admin — needs SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT",
  );
  process.exit(1);
}

const SENTRY_API = "https://sentry.io/api/0";
const headers = {
  Authorization: `Bearer ${SENTRY_AUTH_TOKEN}`,
  "Content-Type": "application/json",
};

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const jsonMode = args.includes("--json");
const recentHours = getArg("--recent");
const sinceIso = getArg("--since");
const filterCorrelationId = getArg("--correlation-id");
const filterGameId = getArg("--game-id");

// Compute --since cutoff (--recent takes priority over --since)
let sinceCutoff = null;
if (recentHours) {
  const h = parseFloat(recentHours);
  if (isNaN(h) || h <= 0) {
    console.error("--recent must be a positive number (hours)");
    process.exit(1);
  }
  sinceCutoff = new Date(Date.now() - h * 3600 * 1000);
} else if (sinceIso) {
  sinceCutoff = new Date(sinceIso);
  if (isNaN(sinceCutoff.getTime())) {
    console.error("--since value is not a valid ISO date:", sinceIso);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Sentry API helpers
// ---------------------------------------------------------------------------

async function sentryGet(path) {
  const url = `${SENTRY_API}${path}`;
  const res = await fetch(url, { headers });
  if (res.status === 401 || res.status === 403) {
    console.error(
      `Sentry auth failed (${res.status}) — check SENTRY_AUTH_TOKEN`,
    );
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Sentry API error ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
}

/** Fetch all pages of issues, respecting the Link header. */
async function fetchAllIssues(query) {
  let url = `${SENTRY_API}/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/issues/?query=${encodeURIComponent(query)}&limit=100`;
  const issues = [];
  while (url) {
    const res = await fetch(url, { headers });
    if (res.status === 401 || res.status === 403) {
      console.error(
        `Sentry auth failed (${res.status}) — check SENTRY_AUTH_TOKEN`,
      );
      process.exit(1);
    }
    if (!res.ok) {
      console.error(`Sentry API error ${res.status}: ${await res.text()}`);
      process.exit(1);
    }
    const page = await res.json();
    issues.push(...page);
    // Follow Link: <url>; rel="next" pagination
    const link = res.headers.get("Link") ?? "";
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }
  return issues;
}

/** Fetch the latest event for an issue to get breadcrumbs and tags. */
async function fetchLatestEvent(issueId) {
  try {
    return await sentryGet(
      `/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/issues/${issueId}/events/latest/`,
    );
  } catch {
    return null;
  }
}

/** Extract tag value by key from an event's tags array. */
function getTag(tags, key) {
  if (!Array.isArray(tags)) return null;
  const entry = tags.find((t) => t.key === key);
  return entry?.value ?? null;
}

/** Summarise breadcrumbs as an array of strings for the output shape. */
function summariseBreadcrumbs(event) {
  const crumbs = event?.breadcrumbs?.values ?? [];
  if (!crumbs.length) return [];

  // Count consecutive identical messages and collapse them.
  const collapsed = [];
  for (const crumb of crumbs) {
    const label = crumb.message || crumb.category || "unknown";
    const last = collapsed[collapsed.length - 1];
    if (last && last.label === label) {
      last.count += 1;
    } else {
      collapsed.push({ label, count: 1 });
    }
  }

  return collapsed
    .slice(-10) // last 10 unique crumbs
    .map((c) => (c.count > 1 ? `${c.label} (x${c.count})` : c.label));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Build Sentry query — tag filters can be added here.
let sentryQuery = "is:unresolved";
if (filterCorrelationId) {
  sentryQuery += ` correlation_id:${filterCorrelationId}`;
}
if (filterGameId) {
  sentryQuery += ` game_id:${filterGameId}`;
}

const issues = await fetchAllIssues(sentryQuery);

// Apply time filter (Sentry API query params for date are less granular, so
// we filter client-side for correctness).
let filtered = issues;
if (sinceCutoff) {
  filtered = issues.filter((issue) => {
    const lastSeen = new Date(issue.lastSeen);
    return lastSeen >= sinceCutoff;
  });
}

if (filtered.length === 0) {
  if (!jsonMode) {
    console.log("No issues found.");
  } else {
    console.log("[]");
  }
  process.exit(0);
}

// Enrich each issue with breadcrumb summary and correlation tags.
const results = await Promise.all(
  filtered.map(async (issue) => {
    const event = await fetchLatestEvent(issue.id);
    const tags = event?.tags ?? [];

    // E12: emit null for missing tags rather than dropping the issue.
    const correlationId = getTag(tags, "correlation_id");
    const gameId = getTag(tags, "game_id");

    return {
      correlationId,
      gameId,
      title: issue.title,
      type: issue.level ?? "error",
      count: issue.count ?? 0,
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
      permalink: issue.permalink,
      breadcrumbSummary: summariseBreadcrumbs(event),
    };
  }),
);

if (jsonMode) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

// Human-readable digest
console.log(`\n  Errors (${results.length} issues)\n`);
for (const r of results) {
  const cx = r.correlationId ? `cx:${r.correlationId}` : "cx:—";
  const gid = r.gameId ? `game:${r.gameId}` : "";
  const tags = [cx, gid].filter(Boolean).join("  ");
  console.log(
    `  [${r.type}]  ${r.title.slice(0, 80)}  (x${r.count})  ${r.lastSeen}`,
  );
  console.log(`    ${tags}`);
  if (r.breadcrumbSummary.length > 0) {
    console.log(`    breadcrumbs: ${r.breadcrumbSummary.join(" → ")}`);
  }
  console.log(`    ${r.permalink}`);
  console.log("");
}
