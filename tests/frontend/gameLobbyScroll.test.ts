import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// 8-player no-scroll containment (LLD 97 E5, load-bearing). The vitest
// environment is "node" with no real layout, so the runtime
// scrollHeight <= clientHeight assertion lives in the Playwright e2e suite
// (e2e/tonk-create-lobby.spec.ts). Here we assert the *structural* contract the
// no-scroll behaviour depends on: the player list is the only growable region
// (bounded + internally scrollable) and the panel is capped to the viewport so
// it can never push the page into a scrollbar.
// ---------------------------------------------------------------------------

const source = readFileSync(
  resolve(__dirname, "../../src/frontend/component/game/GameLobbyView.vue"),
  "utf-8",
);

function ruleBody(selector: string): string {
  // Grab the declaration block for a single CSS rule (first match).
  const re = new RegExp(
    `${selector.replace(/[.[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
  );
  const m = source.match(re);
  return m ? m[1] : "";
}

describe("GameLobbyView — 8-player no-scroll containment (structural)", () => {
  it(".lobby__players scrolls internally (overflow-y: auto) and can shrink", () => {
    const body = ruleBody(".lobby__players");
    expect(body).toContain("overflow-y: auto");
    // min-height: 0 lets the flex child shrink below its content so the list,
    // not the panel, is what scrolls.
    expect(body).toContain("min-height: 0");
  });

  it(".lobby__panel is bounded to the viewport so it never forces page scroll", () => {
    const body = ruleBody(".lobby__panel");
    expect(body).toMatch(/max-height:\s*calc\(100vh/);
  });

  it("the fixed panel chrome (count, actions, invite) does not shrink", () => {
    // Each of these is flex-shrink: 0 so only the player list gives way.
    for (const selector of [
      ".lobby__header",
      ".lobby__count",
      ".lobby__chip-container",
      ".lobby__actions",
      ".lobby__invite",
    ]) {
      expect(ruleBody(selector)).toContain("flex-shrink: 0");
    }
  });
});
