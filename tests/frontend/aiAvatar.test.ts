import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// Unit tests for AiAvatar.vue (structural contract, no DOM mounting).
//
// Follows the project pattern used for AiBadge: assert the contract by
// inspecting the component's source text.
// ---------------------------------------------------------------------------

const avatarSource = readFileSync(
  resolve(
    import.meta.dirname,
    "../../src/frontend/component/game-ui/AiAvatar.vue",
  ),
  "utf-8",
);

describe("AiAvatar.vue — structural contract", () => {
  it("contains an inline SVG glyph (not an emoji or icon font)", () => {
    expect(avatarSource).toContain("<svg");
    expect(avatarSource).toContain("viewBox");
  });

  it("has aria-hidden='true' (decorative — accessible label is the adjacent badge)", () => {
    expect(avatarSource).toContain('aria-hidden="true"');
  });

  it("has data-testid='ai-avatar'", () => {
    expect(avatarSource).toContain('data-testid="ai-avatar"');
  });

  it("contains no emoji characters", () => {
    // eslint-disable-next-line no-misleading-character-class
    expect(avatarSource).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it("has flex-shrink: 0 so it is never clipped on mobile", () => {
    expect(avatarSource).toContain("flex-shrink: 0");
  });

  it("uses --ai-accent color token (or currentColor bound to it)", () => {
    // Either a direct --ai-accent reference or currentColor (since the disc
    // sets color: var(--ai-accent) and SVG uses currentColor).
    const hasAccentToken = avatarSource.includes("--ai-accent");
    const hasCurrentColor = avatarSource.includes("currentColor");
    expect(hasAccentToken || hasCurrentColor).toBe(true);
  });

  it("uses --ai-accent-line and --ai-accent-dim tokens for ring/halo", () => {
    expect(avatarSource).toContain("--ai-accent-line");
    expect(avatarSource).toContain("--ai-accent-dim");
  });

  it("accepts size prop 'sm' and 'md' (class names present)", () => {
    expect(avatarSource).toContain("ai-avatar--sm");
    expect(avatarSource).toContain("ai-avatar--md");
  });

  it("SVG contains a rounded-rect head (rect element with rx)", () => {
    expect(avatarSource).toMatch(/<rect[^>]*rx/);
  });

  it("SVG contains eye circles", () => {
    // Two circle elements for eyes
    const circleMatches = avatarSource.match(/<circle/g) ?? [];
    expect(circleMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("SVG contains antenna line", () => {
    expect(avatarSource).toContain("<line");
  });

  it("disc uses a dark radial fill (radial-gradient)", () => {
    expect(avatarSource).toContain("radial-gradient");
  });

  it("disc uses 50% border-radius (circular)", () => {
    expect(avatarSource).toContain("border-radius: 50%");
  });
});
