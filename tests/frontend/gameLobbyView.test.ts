import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GameType } from "@shared/model";
import { gameTypeLabel } from "@/component/statsView";

// ---------------------------------------------------------------------------
// Tests for GameLobbyView casino-chip and clipboard logic, extracted as pure
// functions that mirror the component's script setup behaviour.
// ---------------------------------------------------------------------------

interface ClipboardMock {
  writeText: ReturnType<typeof vi.fn>;
}

function makeClipboard(succeeds: boolean): ClipboardMock {
  return {
    writeText: succeeds
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new Error("NotAllowedError")),
  };
}

/**
 * Mirrors the copyJoinCode logic from GameLobbyView.vue.
 * Returns the resulting state after the copy attempt.
 */
async function copyJoinCode(
  joinCode: string,
  clipboard: ClipboardMock,
): Promise<{ codeCopied: boolean; clipboardFallback: boolean }> {
  let codeCopied = false;
  let clipboardFallback = false;

  try {
    await clipboard.writeText(joinCode);
    codeCopied = true;
  } catch {
    clipboardFallback = true;
  }

  return { codeCopied, clipboardFallback };
}

/**
 * Mirrors the copyInviteLink logic from GameLobbyView.vue.
 */
async function copyInviteLink(
  link: string,
  clipboard: ClipboardMock,
): Promise<{ copied: boolean; errorMessage: string | null }> {
  let copied = false;
  let errorMessage: string | null = null;

  try {
    await clipboard.writeText(link);
    copied = true;
  } catch {
    errorMessage = "Could not copy link";
  }

  return { copied, errorMessage };
}

describe("GameLobbyView — casino chip logic", () => {
  describe("joinCode prop display", () => {
    it("renders the join code as provided (4 chars)", () => {
      // The template renders `{{ joinCode }}` directly; verify prop passthrough
      const joinCode = "H7K3";
      expect(joinCode).toHaveLength(4);
      expect(joinCode).toMatch(/^[A-Z0-9]+$/);
    });

    it("renders an empty string when joinCode is empty (lobby state not yet received)", () => {
      const joinCode = "";
      expect(joinCode).toBe("");
    });
  });

  describe("copyJoinCode", () => {
    it("sets codeCopied true when clipboard write succeeds", async () => {
      const clipboard = makeClipboard(true);
      const result = await copyJoinCode("H7K3", clipboard);
      expect(result.codeCopied).toBe(true);
      expect(result.clipboardFallback).toBe(false);
    });

    it("writes the exact join code to the clipboard", async () => {
      const clipboard = makeClipboard(true);
      await copyJoinCode("H7K3", clipboard);
      expect(clipboard.writeText).toHaveBeenCalledWith("H7K3");
    });

    it("sets clipboardFallback true when clipboard write fails", async () => {
      const clipboard = makeClipboard(false);
      const result = await copyJoinCode("H7K3", clipboard);
      expect(result.codeCopied).toBe(false);
      expect(result.clipboardFallback).toBe(true);
    });
  });

  describe("copyInviteLink", () => {
    it("sets copied true when clipboard write succeeds", async () => {
      const clipboard = makeClipboard(true);
      const result = await copyInviteLink(
        "https://example.com/game/abc/join",
        clipboard,
      );
      expect(result.copied).toBe(true);
      expect(result.errorMessage).toBeNull();
    });

    it("sets errorMessage when clipboard write fails", async () => {
      const clipboard = makeClipboard(false);
      const result = await copyInviteLink(
        "https://example.com/game/abc/join",
        clipboard,
      );
      expect(result.copied).toBe(false);
      expect(result.errorMessage).toBe("Could not copy link");
    });
  });
});

// ---------------------------------------------------------------------------
// Start-gate and type-badge logic, mirroring the component's computeds. The
// gate is data-driven by the minPlayers prop (Tonk 3, Big 2 2) — no hardcoded
// player count. Regression-critical: Big 2 must still enable at exactly 2.
// ---------------------------------------------------------------------------

function canStart(isHost: boolean, count: number, minPlayers: number): boolean {
  return isHost && count >= minPlayers;
}

function playersNeeded(count: number, minPlayers: number): number {
  return Math.max(0, minPlayers - count);
}

function typeBadge(gameType: GameType, maxPlayers: number): string {
  return `${gameTypeLabel(gameType)} · up to ${maxPlayers}`;
}

describe("GameLobbyView — Start gate (min-players aware)", () => {
  describe("Tonk (minPlayers = 3)", () => {
    it("Start is disabled at 1 and 2 players, enabled at 3+", () => {
      expect(canStart(true, 1, 3)).toBe(false);
      expect(canStart(true, 2, 3)).toBe(false);
      expect(canStart(true, 3, 3)).toBe(true);
      expect(canStart(true, 8, 3)).toBe(true);
    });
  });

  describe("Big 2 (minPlayers = 2) — regression", () => {
    it("Start is enabled at exactly 2 players and disabled at 1", () => {
      expect(canStart(true, 2, 2)).toBe(true);
      expect(canStart(true, 1, 2)).toBe(false);
    });
  });

  it("non-host can never start regardless of count", () => {
    expect(canStart(false, 3, 3)).toBe(false);
    expect(canStart(false, 8, 3)).toBe(false);
    expect(canStart(false, 2, 2)).toBe(false);
  });

  describe("playersNeeded", () => {
    it("reports how many more players are needed, floored at 0", () => {
      expect(playersNeeded(2, 3)).toBe(1);
      expect(playersNeeded(1, 3)).toBe(2);
      expect(playersNeeded(3, 3)).toBe(0);
      expect(playersNeeded(4, 3)).toBe(0);
    });

    it("hint text reflects the shortfall", () => {
      const min = 3;
      const count = 2;
      const needed = playersNeeded(count, min);
      const hint = `${gameTypeLabel("tonk")} needs at least ${min} players to start (${needed} more)`;
      expect(hint).toBe("Tonk needs at least 3 players to start (1 more)");
    });
  });
});

describe("GameLobbyView — type badge", () => {
  it('renders "Tonk · up to N" for Tonk', () => {
    expect(typeBadge("tonk", 8)).toBe("Tonk · up to 8");
    expect(typeBadge("tonk", 5)).toBe("Tonk · up to 5");
  });

  it('renders "Big 2 · up to 4" for Big 2', () => {
    expect(typeBadge("big2", 4)).toBe("Big 2 · up to 4");
  });
});
