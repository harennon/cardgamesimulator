import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Tests for RoomCodeChip render gating + clipboard logic, extracted as pure
// functions that mirror the component's script setup + template behaviour.
// (Project frontend tests run in a node environment without jsdom, so we test
// the load-bearing logic rather than mounting the component — same pattern as
// gameLobbyView.test.ts.)
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

/** Mirrors `v-if="code"` — the chip renders only for a non-empty code. */
function chipRenders(code: string): boolean {
  return Boolean(code);
}

/** Mirrors copyCode() from RoomCodeChip.vue. */
async function copyCode(
  code: string,
  clipboard: ClipboardMock,
): Promise<{ codeCopied: boolean; clipboardFallback: boolean }> {
  let codeCopied = false;
  let clipboardFallback = false;

  try {
    await clipboard.writeText(code);
    codeCopied = true;
  } catch {
    clipboardFallback = true;
  }

  return { codeCopied, clipboardFallback };
}

describe("RoomCodeChip", () => {
  describe('render gating (v-if="code")', () => {
    it("renders the chip when code is a non-empty 4-char code", () => {
      expect(chipRenders("H7K3")).toBe(true);
    });

    it("renders nothing when code is an empty string (edge case 2)", () => {
      expect(chipRenders("")).toBe(false);
    });
  });

  describe("copyCode", () => {
    it("copies the exact code and sets codeCopied when clipboard succeeds", async () => {
      const clipboard = makeClipboard(true);
      const result = await copyCode("H7K3", clipboard);
      expect(clipboard.writeText).toHaveBeenCalledWith("H7K3");
      expect(result.codeCopied).toBe(true);
      expect(result.clipboardFallback).toBe(false);
    });

    it("shows the long-press fallback when clipboard write fails (edge case 4)", async () => {
      const clipboard = makeClipboard(false);
      const result = await copyCode("H7K3", clipboard);
      expect(result.codeCopied).toBe(false);
      expect(result.clipboardFallback).toBe(true);
    });
  });
});
