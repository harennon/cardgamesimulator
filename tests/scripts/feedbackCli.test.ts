/**
 * Unit tests for scripts/lib/renderFeedback.mjs — CLI rendering logic.
 * No network, no auth. Tests the pure render function against stubbed API data.
 */
import { describe, it, expect } from "vitest";
import { renderFeedback } from "../../scripts/lib/renderFeedback.mjs";

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const entryWithAttachments = {
  id: "fb-id-1",
  category: "bug",
  description: "Something broke",
  createdAt: new Date("2026-01-01T12:00:00.000Z").toISOString(),
  metadata: { route: "/game/test", userType: "registered" },
  userId: "user-1",
  attachments: [
    { key: "fb-id-1/att-1.png", url: "https://signed.url/att-1.png?token=abc" },
    {
      key: "fb-id-1/att-2.png",
      url: "https://signed.url/att-2.png?token=def",
    },
  ],
};

const entryWithNoAttachments = {
  id: "fb-id-2",
  category: "feature-request",
  description: "Add dark mode",
  createdAt: new Date("2026-01-02T08:00:00.000Z").toISOString(),
  metadata: { route: "/", userType: "guest" },
  userId: null,
  attachments: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderFeedback — default human-readable output", () => {
  it("entry with attachments: output contains each signed URL on its own line under an attachments label", () => {
    const output = renderFeedback([entryWithAttachments], { json: false });

    expect(output).toContain("attachments (2):");
    expect(output).toContain("https://signed.url/att-1.png?token=abc");
    expect(output).toContain("https://signed.url/att-2.png?token=def");
    // each URL on its own line (indented with spaces)
    const lines = output.split("\n");
    const url1Line = lines.find((l) =>
      l.includes("https://signed.url/att-1.png?token=abc"),
    );
    const url2Line = lines.find((l) =>
      l.includes("https://signed.url/att-2.png?token=def"),
    );
    expect(url1Line).toBeDefined();
    expect(url2Line).toBeDefined();
  });

  it("entry without attachments: no attachment lines appear in the output", () => {
    const output = renderFeedback([entryWithNoAttachments], { json: false });

    expect(output).not.toContain("attachments");
    expect(output).not.toContain("https://");
  });

  it("entry without attachments: other fields are rendered exactly as before", () => {
    const output = renderFeedback([entryWithNoAttachments], { json: false });

    expect(output).toContain("[feature-request]");
    expect(output).toContain("Add dark mode");
    expect(output).toContain("route: /");
    expect(output).toContain("user: guest");
    expect(output).toContain("id: fb-id-2");
  });

  it("mixed list: attached entry has URL lines; no-attachment entry has none", () => {
    const output = renderFeedback(
      [entryWithAttachments, entryWithNoAttachments],
      { json: false },
    );

    // Header
    expect(output).toContain("Feedback (2 entries)");
    // Attached entry
    expect(output).toContain("attachments (2):");
    expect(output).toContain("https://signed.url/att-1.png?token=abc");
    // No-attachment entry's description
    expect(output).toContain("Add dark mode");
  });

  it("returns 'No feedback found.' for an empty list", () => {
    const output = renderFeedback([], { json: false });
    expect(output).toBe("No feedback found.");
  });

  it("defensive: entry with missing attachments field renders as if no attachments (E8 version skew)", () => {
    const legacyEntry = {
      ...entryWithNoAttachments,
      attachments: undefined as unknown as [],
    };
    const output = renderFeedback([legacyEntry], { json: false });
    expect(output).not.toContain("attachments");
  });
});

describe("renderFeedback — --json output", () => {
  it("emitted JSON includes the attachments array for the attached entry", () => {
    const output = renderFeedback([entryWithAttachments], { json: true });
    const parsed = JSON.parse(output) as (typeof entryWithAttachments)[];
    expect(parsed[0].attachments).toHaveLength(2);
    expect(parsed[0].attachments[0].url).toBe(
      "https://signed.url/att-1.png?token=abc",
    );
    expect(parsed[0].attachments[0].key).toBe("fb-id-1/att-1.png");
  });

  it("emitted JSON has attachments:[] for the no-attachment entry", () => {
    const output = renderFeedback([entryWithNoAttachments], { json: true });
    const parsed = JSON.parse(output) as (typeof entryWithNoAttachments)[];
    expect(parsed[0].attachments).toEqual([]);
  });

  it("emitted JSON for mixed list matches the API response shape byte-for-byte", () => {
    const rows = [entryWithAttachments, entryWithNoAttachments];
    const output = renderFeedback(rows, { json: true });
    expect(output).toBe(JSON.stringify(rows, null, 2));
  });
});
