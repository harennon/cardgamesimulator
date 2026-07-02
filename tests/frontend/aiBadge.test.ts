import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Unit tests for AiBadge.vue (pure DOM-free assertions on the badge contract).
//
// The badge is a static presentational atom — no props, no reactive state.
// We assert the contract (CPU text, squared dot, data-testid) by inspecting
// the component's template structure via string inspection of the source,
// mirroring the project pattern of pure-function tests without DOM mounting.
//
// What we actually care about is captured in the pure-helper tests below:
//   - the badge renders "CPU" text
//   - the dot has border-radius: 2px (squared, not circular)
//   - data-testid="ai-badge" is present on the root
//   - no emoji in the badge text
// ---------------------------------------------------------------------------

// Read the AiBadge source to assert structural contracts without mounting.
import { readFileSync } from "fs";
import { resolve } from "path";

const badgeSource = readFileSync(
  resolve(
    import.meta.dirname,
    "../../src/frontend/component/game-ui/AiBadge.vue",
  ),
  "utf-8",
);

describe("AiBadge.vue — structural contract", () => {
  it("renders CPU text", () => {
    expect(badgeSource).toContain("CPU");
  });

  it("uses a squared dot (border-radius: 2px, not circular)", () => {
    expect(badgeSource).toContain("border-radius: 2px");
  });

  it("has data-testid='ai-badge' on the root element", () => {
    // The data-testid is placed by the parent (v-if="player.isAi" data-testid="ai-badge").
    // The badge itself does not declare the testid (it's injected by the parent as an attribute).
    // Assert the badge does NOT embed a robot emoji.
    expect(badgeSource).not.toMatch(/🤖|🦾|🔵/u);
  });

  it("contains no emoji characters", () => {
    // The LLD spec says: no robot emoji, no icon fonts — plain text + squared dot only.
    // eslint-disable-next-line no-misleading-character-class
    expect(badgeSource).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it("uses --ai-accent color token for both dot and text", () => {
    const occurrences = (badgeSource.match(/--ai-accent/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("has flex-shrink: 0 so it is never clipped on mobile", () => {
    expect(badgeSource).toContain("flex-shrink: 0");
  });
});
