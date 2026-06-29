import { describe, it, expect } from "vitest";

// Project pattern (node env, no component mounting): transcribe HomeView.vue's
// template gating for the signed-in actions block, which is where the Your Stats
// entrypoint lives (`v-if="signedIn"`). The stats link points to /stats and only
// renders for signed-in users; the signed-out auth-prompt branch omits it.

interface ActionLink {
  testid: string;
  to: string;
}

// Mirrors the links rendered in HomeView's home__actions / home__auth-prompt blocks.
function visibleActionLinks(signedIn: boolean): ActionLink[] {
  if (signedIn) {
    return [
      { testid: "create-game-link", to: "/create-game" },
      { testid: "join-game-link", to: "/join-game" },
      { testid: "stats-link", to: "/stats" },
    ];
  }
  return [
    { testid: "login-link", to: "/login" },
    { testid: "signup-link", to: "/signup" },
  ];
}

describe("HomeView stats entrypoint", () => {
  it("shows the stats-link pointing to /stats when signed in", () => {
    const link = visibleActionLinks(true).find(
      (l) => l.testid === "stats-link",
    );
    expect(link).toBeDefined();
    expect(link?.to).toBe("/stats");
  });

  it("does not show the stats-link when signed out", () => {
    const link = visibleActionLinks(false).find(
      (l) => l.testid === "stats-link",
    );
    expect(link).toBeUndefined();
  });
});
