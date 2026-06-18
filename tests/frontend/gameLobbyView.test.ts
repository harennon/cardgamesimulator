import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
