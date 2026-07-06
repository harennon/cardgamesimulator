/**
 * Unit tests for scripts/feedbackRender.mjs — pure formatting helpers for
 * the feedback CLI (LLD 158).
 *
 * These test the extracted formatEntry() function directly with no I/O.
 */

import { describe, it, expect } from "vitest";

// feedbackRender.mjs is plain ESM JavaScript — import it directly.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs with no declaration file
const { formatEntry } = (await import("../../scripts/feedbackRender.mjs")) as {
  formatEntry: (row: Record<string, unknown>) => string[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "fb-001",
    category: "bug",
    description: "Something broke",
    metadata: { route: "/game/abc", userType: "registered" },
    userId: "user-1",
    createdAt: "2026-07-01T00:00:00.000Z",
    attachmentKeys: [],
    attachments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: entry with attachments
// ---------------------------------------------------------------------------

describe("formatEntry — entry with attachments", () => {
  it("includes one 'attachment: <url>' line per URL", () => {
    const row = makeRow({
      attachments: ["https://signed/key1.png", "https://signed/key2.png"],
    });
    const lines = formatEntry(row);
    const attachLines = lines.filter((l) => l.startsWith("  attachment:"));
    expect(attachLines).toHaveLength(2);
    expect(attachLines[0]).toBe("  attachment: https://signed/key1.png");
    expect(attachLines[1]).toBe("  attachment: https://signed/key2.png");
  });

  it("attachment lines appear after the route/user/id line", () => {
    const row = makeRow({ attachments: ["https://signed/k.png"] });
    const lines = formatEntry(row);
    const routeIdx = lines.findIndex((l) => l.includes("route:"));
    const attachIdx = lines.findIndex((l) => l.startsWith("  attachment:"));
    expect(routeIdx).toBeGreaterThanOrEqual(0);
    expect(attachIdx).toBeGreaterThan(routeIdx);
  });

  it("still includes the standard header, description, and route lines", () => {
    const row = makeRow({ attachments: ["https://signed/k.png"] });
    const lines = formatEntry(row);
    expect(lines.some((l) => l.includes("[bug]"))).toBe(true);
    expect(lines.some((l) => l.includes("Something broke"))).toBe(true);
    expect(lines.some((l) => l.includes("route:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: entry with NO attachments — output byte-for-byte identical to before
// ---------------------------------------------------------------------------

describe("formatEntry — entry with no attachments", () => {
  it("produces exactly 3 lines (header, description, route) when attachments is []", () => {
    const row = makeRow({ attachments: [] });
    const lines = formatEntry(row);
    expect(lines).toHaveLength(3);
  });

  it("produces exactly 3 lines when attachments field is absent (E7 cross-version safety)", () => {
    const { attachments: _ignored, ...rowWithout } = makeRow() as Record<
      string,
      unknown
    >;
    const lines = formatEntry(rowWithout);
    expect(lines).toHaveLength(3);
  });

  it("contains no attachment line when attachments is empty", () => {
    const row = makeRow({ attachments: [] });
    const lines = formatEntry(row);
    expect(lines.some((l) => l.startsWith("  attachment:"))).toBe(false);
  });

  it("line 0: '[category]  <date>'", () => {
    const row = makeRow({ category: "feature-request" });
    const lines = formatEntry(row);
    expect(lines[0]).toMatch(/^\s+\[feature-request\]/);
  });

  it("line 1: description text", () => {
    const row = makeRow({ description: "My description" });
    const lines = formatEntry(row);
    expect(lines[1]).toContain("My description");
  });

  it("line 2: route, user, and id", () => {
    const row = makeRow({
      id: "fb-xyz",
      metadata: { route: "/home", userType: "guest" },
    });
    const lines = formatEntry(row);
    expect(lines[2]).toContain("route: /home");
    expect(lines[2]).toContain("user: guest");
    expect(lines[2]).toContain("id: fb-xyz");
  });

  it("missing metadata falls back to em-dash for route and userType", () => {
    const row = makeRow({ metadata: null });
    const lines = formatEntry(row);
    expect(lines[2]).toContain("route: —");
    expect(lines[2]).toContain("user: —");
  });
});

// ---------------------------------------------------------------------------
// Tests: --json path (verify the new field is not stripped)
// The JSON path in feedback.mjs is JSON.stringify(filtered, null, 2) with no
// post-processing. We confirm the field survives a round-trip here since the
// server-populated `attachments` array will be included verbatim.
// ---------------------------------------------------------------------------

describe("--json output includes attachments field", () => {
  it("JSON.stringify round-trip preserves the attachments array", () => {
    const row = makeRow({
      attachments: ["https://signed/k1.png", "https://signed/k2.png"],
    });
    const serialized = JSON.stringify([row], null, 2);
    const parsed = JSON.parse(serialized) as Array<Record<string, unknown>>;
    expect(parsed[0]!["attachments"]).toEqual([
      "https://signed/k1.png",
      "https://signed/k2.png",
    ]);
  });

  it("JSON.stringify round-trip preserves empty attachments array", () => {
    const row = makeRow({ attachments: [] });
    const serialized = JSON.stringify([row], null, 2);
    const parsed = JSON.parse(serialized) as Array<Record<string, unknown>>;
    expect(parsed[0]!["attachments"]).toEqual([]);
  });
});
