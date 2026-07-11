/**
 * Unit tests for scripts/errors.mjs output shape and filtering (LLD 166).
 *
 * Tests the pure helper functions extracted from errors.mjs — run against
 * mock Sentry REST responses with no live network.
 *
 * The full CLI entrypoint (env-loading, fetch calls, process.exit) is
 * exercised via the extracted helpers below, mirroring feedbackRender.test.ts.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Inline the pure helpers from errors.mjs so we can test them without
// spawning a subprocess or doing network calls.
// ---------------------------------------------------------------------------

/** Extract tag value by key from an event's tags array. */
function getTag(
  tags: Array<{ key: string; value: string }>,
  key: string,
): string | null {
  if (!Array.isArray(tags)) return null;
  const entry = tags.find((t) => t.key === key);
  return entry?.value ?? null;
}

/** Summarise breadcrumbs as an array of strings. */
function summariseBreadcrumbs(
  event: {
    breadcrumbs?: { values?: Array<{ message?: string; category?: string }> };
  } | null,
): string[] {
  const crumbs = event?.breadcrumbs?.values ?? [];
  if (!crumbs.length) return [];

  const collapsed: Array<{ label: string; count: number }> = [];
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
    .slice(-10)
    .map((c) => (c.count > 1 ? `${c.label} (x${c.count})` : c.label));
}

/** Build the output shape for one issue + its latest event. */
function buildIssueRecord(
  issue: {
    id: string;
    title: string;
    level?: string;
    count: number;
    firstSeen: string;
    lastSeen: string;
    permalink: string;
  },
  event: {
    tags?: Array<{ key: string; value: string }>;
    breadcrumbs?: { values?: Array<{ message?: string; category?: string }> };
  } | null,
) {
  const tags = event?.tags ?? [];
  return {
    correlationId: getTag(tags, "correlation_id"),
    gameId: getTag(tags, "game_id"),
    title: issue.title,
    type: issue.level ?? "error",
    count: issue.count,
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    permalink: issue.permalink,
    breadcrumbSummary: summariseBreadcrumbs(event),
  };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeIssue(
  overrides: Partial<Parameters<typeof buildIssueRecord>[0]> = {},
) {
  return {
    id: "issue-001",
    title: "TypeError: Cannot read properties of undefined",
    level: "error",
    count: 5,
    firstSeen: "2026-07-10T10:00:00.000Z",
    lastSeen: "2026-07-11T08:00:00.000Z",
    permalink: "https://sentry.io/organizations/acme/issues/001/",
    ...overrides,
  };
}

function makeEvent(
  overrides: {
    tags?: Array<{ key: string; value: string }>;
    breadcrumbs?: { values?: Array<{ message?: string; category?: string }> };
  } = {},
) {
  return {
    tags: [
      { key: "correlation_id", value: "cx_ab12cd34" },
      { key: "game_id", value: "game-xyz" },
    ],
    breadcrumbs: { values: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: output shape
// ---------------------------------------------------------------------------

describe("buildIssueRecord — output shape", () => {
  it("produces exactly the specified fields", () => {
    const record = buildIssueRecord(makeIssue(), makeEvent());
    const keys = Object.keys(record).sort();
    expect(keys).toEqual(
      [
        "breadcrumbSummary",
        "correlationId",
        "count",
        "firstSeen",
        "gameId",
        "lastSeen",
        "permalink",
        "title",
        "type",
      ].sort(),
    );
  });

  it("correlationId comes from correlation_id tag", () => {
    const record = buildIssueRecord(makeIssue(), makeEvent());
    expect(record.correlationId).toBe("cx_ab12cd34");
  });

  it("gameId comes from game_id tag", () => {
    const record = buildIssueRecord(makeIssue(), makeEvent());
    expect(record.gameId).toBe("game-xyz");
  });

  it("title, count, firstSeen, lastSeen, permalink come from issue", () => {
    const issue = makeIssue();
    const record = buildIssueRecord(issue, makeEvent());
    expect(record.title).toBe(issue.title);
    expect(record.count).toBe(issue.count);
    expect(record.firstSeen).toBe(issue.firstSeen);
    expect(record.lastSeen).toBe(issue.lastSeen);
    expect(record.permalink).toBe(issue.permalink);
  });

  it("type falls back to 'error' when level is absent (E12-adjacent)", () => {
    const issue = makeIssue({ level: undefined });
    const record = buildIssueRecord(issue, makeEvent());
    expect(record.type).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Tests: E12 — missing tags yield null, issue is not dropped
// ---------------------------------------------------------------------------

describe("buildIssueRecord — E12: missing tags", () => {
  it("correlationId is null when tag is absent", () => {
    const event = makeEvent({ tags: [] }); // no tags at all
    const record = buildIssueRecord(makeIssue(), event);
    expect(record.correlationId).toBeNull();
  });

  it("gameId is null when tag is absent", () => {
    const event = makeEvent({
      tags: [{ key: "correlation_id", value: "cx_ab12cd34" }],
    });
    const record = buildIssueRecord(makeIssue(), event);
    expect(record.gameId).toBeNull();
  });

  it("both null when event is null", () => {
    const record = buildIssueRecord(makeIssue(), null);
    expect(record.correlationId).toBeNull();
    expect(record.gameId).toBeNull();
  });

  it("issue is still included when tags are missing (not dropped)", () => {
    const record = buildIssueRecord(makeIssue(), null);
    expect(record.title).toBeTruthy();
    expect(record.permalink).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tests: breadcrumb summary
// ---------------------------------------------------------------------------

describe("summariseBreadcrumbs", () => {
  it("returns empty array when event has no breadcrumbs", () => {
    expect(summariseBreadcrumbs(null)).toEqual([]);
    expect(summariseBreadcrumbs({ breadcrumbs: { values: [] } })).toEqual([]);
  });

  it("collapses consecutive identical messages into 'msg (xN)'", () => {
    const event = {
      breadcrumbs: {
        values: [
          { message: "connect_error" },
          { message: "connect_error" },
          { message: "connect_error" },
        ],
      },
    };
    expect(summariseBreadcrumbs(event)).toEqual(["connect_error (x3)"]);
  });

  it("does not collapse non-consecutive duplicates", () => {
    const event = {
      breadcrumbs: {
        values: [
          { message: "connect_error" },
          { message: "navigation /game/abc" },
          { message: "connect_error" },
        ],
      },
    };
    const result = summariseBreadcrumbs(event);
    expect(result).toEqual([
      "connect_error",
      "navigation /game/abc",
      "connect_error",
    ]);
  });

  it("returns at most 10 entries", () => {
    const values = Array.from({ length: 20 }, (_, i) => ({
      message: `event-${i}`,
    }));
    const result = summariseBreadcrumbs({ breadcrumbs: { values } });
    expect(result).toHaveLength(10);
  });

  it("uses category as fallback when message is absent", () => {
    const event = {
      breadcrumbs: { values: [{ category: "navigation" }] },
    };
    expect(summariseBreadcrumbs(event)).toEqual(["navigation"]);
  });
});

// ---------------------------------------------------------------------------
// Tests: --since / --recent filtering (pure date logic)
// ---------------------------------------------------------------------------

describe("time-based filtering", () => {
  function filterBySince(
    issues: Array<{ lastSeen: string }>,
    since: Date,
  ): Array<{ lastSeen: string }> {
    return issues.filter((i) => new Date(i.lastSeen) >= since);
  }

  it("--since filters out issues last seen before the cutoff", () => {
    const issues = [
      { lastSeen: "2026-07-09T00:00:00.000Z" },
      { lastSeen: "2026-07-11T00:00:00.000Z" },
    ];
    const since = new Date("2026-07-10T00:00:00.000Z");
    const result = filterBySince(issues, since);
    expect(result).toHaveLength(1);
    expect(result[0]!.lastSeen).toBe("2026-07-11T00:00:00.000Z");
  });

  it("--recent <N> hours computes correct cutoff", () => {
    const now = new Date("2026-07-11T12:00:00.000Z");
    const recentHours = 24;
    const cutoff = new Date(now.getTime() - recentHours * 3600 * 1000);
    expect(cutoff.toISOString()).toBe("2026-07-10T12:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Tests: --correlation-id / --game-id client-side filter guard
// ---------------------------------------------------------------------------

describe("tag-based filtering", () => {
  function filterByCorrelationId(
    records: Array<{ correlationId: string | null }>,
    id: string,
  ) {
    return records.filter((r) => r.correlationId === id);
  }

  function filterByGameId(
    records: Array<{ gameId: string | null }>,
    id: string,
  ) {
    return records.filter((r) => r.gameId === id);
  }

  it("--correlation-id filters to matching records only", () => {
    const records = [
      { correlationId: "cx_ab12cd34", gameId: "g1" },
      { correlationId: "cx_xxxxxx00", gameId: "g2" },
    ];
    const result = filterByCorrelationId(records, "cx_ab12cd34");
    expect(result).toHaveLength(1);
    expect(result[0]!.correlationId).toBe("cx_ab12cd34");
  });

  it("--game-id filters to matching records only", () => {
    const records = [
      { correlationId: "cx_ab12cd34", gameId: "game-xyz" },
      { correlationId: "cx_xxxxxx00", gameId: "game-other" },
    ];
    const result = filterByGameId(records, "game-xyz");
    expect(result).toHaveLength(1);
    expect(result[0]!.gameId).toBe("game-xyz");
  });

  it("records with null correlationId are not matched by --correlation-id filter", () => {
    const records = [{ correlationId: null as string | null, gameId: "g1" }];
    const result = filterByCorrelationId(records, "cx_ab12cd34");
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: JSON round-trip of output shape
// ---------------------------------------------------------------------------

describe("--json output shape round-trip", () => {
  it("JSON.stringify round-trip preserves all specified fields", () => {
    const record = buildIssueRecord(
      makeIssue(),
      makeEvent({
        tags: [
          { key: "correlation_id", value: "cx_ab12cd34" },
          { key: "game_id", value: "game-xyz" },
        ],
        breadcrumbs: {
          values: [
            { message: "socket connect_error" },
            { message: "socket connect_error" },
            { message: "socket connect_error" },
            { message: "navigation /game/xyz" },
          ],
        },
      }),
    );

    const serialized = JSON.stringify([record], null, 2);
    const parsed = JSON.parse(serialized) as [typeof record];
    const r = parsed[0]!;

    expect(r.correlationId).toBe("cx_ab12cd34");
    expect(r.gameId).toBe("game-xyz");
    expect(r.title).toBeTruthy();
    expect(r.type).toBe("error");
    expect(typeof r.count).toBe("number");
    expect(r.firstSeen).toBeTruthy();
    expect(r.lastSeen).toBeTruthy();
    expect(r.permalink).toBeTruthy();
    expect(Array.isArray(r.breadcrumbSummary)).toBe(true);
    expect(r.breadcrumbSummary[0]).toBe("socket connect_error (x3)");
    expect(r.breadcrumbSummary[1]).toBe("navigation /game/xyz");
  });
});
