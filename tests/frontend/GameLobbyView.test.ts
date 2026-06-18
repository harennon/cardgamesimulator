import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, computed } from "vue";

// Tests for GameLobbyView invite-code logic.
// The component logic is extracted and tested as pure functions —
// no DOM mounting required (environment: node).

// ── Helpers mirroring the component's computed/methods ───────────────

function makeShortCode(gameId: string): string {
  const raw = gameId.replace(/-/g, "").slice(0, 8).toUpperCase();
  return `${raw.slice(0, 4)} ${raw.slice(4, 8)}`;
}

function makeInviteLink(origin: string, gameId: string): string {
  return `${origin}/game/${gameId}/join`;
}

async function copyGameCode(
  gameId: string,
  clipboard: { writeText: (s: string) => Promise<void> },
  codeCopied: { value: boolean },
  errorMessage: { value: string | null },
): Promise<void> {
  try {
    await clipboard.writeText(gameId);
    codeCopied.value = true;
    setTimeout(() => {
      codeCopied.value = false;
    }, 2000);
  } catch {
    errorMessage.value = "Could not copy code";
  }
}

async function copyInviteLink(
  inviteLink: string,
  clipboard: { writeText: (s: string) => Promise<void> },
  linkCopied: { value: boolean },
  errorMessage: { value: string | null },
): Promise<void> {
  try {
    await clipboard.writeText(inviteLink);
    linkCopied.value = true;
    setTimeout(() => {
      linkCopied.value = false;
    }, 2000);
  } catch {
    errorMessage.value = "Could not copy link";
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("GameLobbyView — shortCode computed", () => {
  it("formats a standard UUID as first 8 hex chars, uppercased, space-separated groups of 4", () => {
    const gameId = "a7f2b9d1-1234-5678-abcd-ef0123456789";
    expect(makeShortCode(gameId)).toBe("A7F2 B9D1");
  });

  it("uses the first 8 hex chars after stripping dashes", () => {
    const gameId = "00112233-4455-6677-8899-aabbccddeeff";
    expect(makeShortCode(gameId)).toBe("0011 2233");
  });

  it("uppercases lowercase hex digits", () => {
    const gameId = "abcdef12-0000-0000-0000-000000000000";
    expect(makeShortCode(gameId)).toBe("ABCD EF12");
  });

  it("handles a UUID where hex chars span the first segment fully", () => {
    const gameId = "ffffffff-0000-0000-0000-000000000000";
    expect(makeShortCode(gameId)).toBe("FFFF FFFF");
  });
});

describe("GameLobbyView — copyGameCode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls clipboard.writeText with the full UUID (not the short code)", async () => {
    const gameId = "a7f2b9d1-1234-5678-abcd-ef0123456789";
    const writeText = vi.fn().mockResolvedValue(undefined);
    const codeCopied = ref(false);
    const errorMessage = ref<string | null>(null);

    await copyGameCode(gameId, { writeText }, codeCopied, errorMessage);

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(gameId);
    // NOT the short code
    expect(writeText).not.toHaveBeenCalledWith("A7F2 B9D1");
  });

  it("sets codeCopied to true after successful copy", async () => {
    const gameId = "a7f2b9d1-1234-5678-abcd-ef0123456789";
    const writeText = vi.fn().mockResolvedValue(undefined);
    const codeCopied = ref(false);
    const errorMessage = ref<string | null>(null);

    await copyGameCode(gameId, { writeText }, codeCopied, errorMessage);

    expect(codeCopied.value).toBe(true);
  });

  it("resets codeCopied to false after 2000ms", async () => {
    const gameId = "a7f2b9d1-1234-5678-abcd-ef0123456789";
    const writeText = vi.fn().mockResolvedValue(undefined);
    const codeCopied = ref(false);
    const errorMessage = ref<string | null>(null);

    await copyGameCode(gameId, { writeText }, codeCopied, errorMessage);
    expect(codeCopied.value).toBe(true);

    vi.advanceTimersByTime(2000);
    expect(codeCopied.value).toBe(false);
  });

  it("does not reset codeCopied before 2000ms have elapsed", async () => {
    const gameId = "a7f2b9d1-1234-5678-abcd-ef0123456789";
    const writeText = vi.fn().mockResolvedValue(undefined);
    const codeCopied = ref(false);
    const errorMessage = ref<string | null>(null);

    await copyGameCode(gameId, { writeText }, codeCopied, errorMessage);
    vi.advanceTimersByTime(1999);
    expect(codeCopied.value).toBe(true);
  });

  it("sets errorMessage when clipboard API throws", async () => {
    const gameId = "a7f2b9d1-1234-5678-abcd-ef0123456789";
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    const codeCopied = ref(false);
    const errorMessage = ref<string | null>(null);

    await copyGameCode(gameId, { writeText }, codeCopied, errorMessage);

    expect(codeCopied.value).toBe(false);
    expect(errorMessage.value).toBe("Could not copy code");
  });
});

describe("GameLobbyView — copyInviteLink (regression)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("copies the full invite URL to clipboard", async () => {
    const gameId = "a7f2b9d1-1234-5678-abcd-ef0123456789";
    const origin = "https://danbing.app";
    const link = makeInviteLink(origin, gameId);
    const writeText = vi.fn().mockResolvedValue(undefined);
    const linkCopied = ref(false);
    const errorMessage = ref<string | null>(null);

    await copyInviteLink(link, { writeText }, linkCopied, errorMessage);

    expect(writeText).toHaveBeenCalledWith(
      "https://danbing.app/game/a7f2b9d1-1234-5678-abcd-ef0123456789/join",
    );
  });

  it("sets linkCopied to true after successful copy", async () => {
    const link = "https://danbing.app/game/some-id/join";
    const writeText = vi.fn().mockResolvedValue(undefined);
    const linkCopied = ref(false);
    const errorMessage = ref<string | null>(null);

    await copyInviteLink(link, { writeText }, linkCopied, errorMessage);

    expect(linkCopied.value).toBe(true);
  });

  it("resets linkCopied to false after 2000ms", async () => {
    const link = "https://danbing.app/game/some-id/join";
    const writeText = vi.fn().mockResolvedValue(undefined);
    const linkCopied = ref(false);
    const errorMessage = ref<string | null>(null);

    await copyInviteLink(link, { writeText }, linkCopied, errorMessage);
    vi.advanceTimersByTime(2000);
    expect(linkCopied.value).toBe(false);
  });

  it("sets errorMessage when clipboard API throws", async () => {
    const link = "https://danbing.app/game/some-id/join";
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    const linkCopied = ref(false);
    const errorMessage = ref<string | null>(null);

    await copyInviteLink(link, { writeText }, linkCopied, errorMessage);

    expect(linkCopied.value).toBe(false);
    expect(errorMessage.value).toBe("Could not copy link");
  });
});

describe("GameLobbyView — independent copy state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("codeCopied and linkCopied are independent — both can be true simultaneously", async () => {
    const gameId = "a7f2b9d1-1234-5678-abcd-ef0123456789";
    const link =
      "https://danbing.app/game/a7f2b9d1-1234-5678-abcd-ef0123456789/join";
    const writeText = vi.fn().mockResolvedValue(undefined);
    const codeCopied = ref(false);
    const linkCopied = ref(false);
    const errorMessage = ref<string | null>(null);

    await copyGameCode(gameId, { writeText }, codeCopied, errorMessage);
    await copyInviteLink(link, { writeText }, linkCopied, errorMessage);

    expect(codeCopied.value).toBe(true);
    expect(linkCopied.value).toBe(true);
  });
});

describe("GameLobbyView — shortCode reactive computed", () => {
  it("recomputes when gameId changes", () => {
    const gameIdRef = ref("a7f2b9d1-1234-5678-abcd-ef0123456789");
    const shortCode = computed(() => {
      const raw = gameIdRef.value.replace(/-/g, "").slice(0, 8).toUpperCase();
      return `${raw.slice(0, 4)} ${raw.slice(4, 8)}`;
    });

    expect(shortCode.value).toBe("A7F2 B9D1");

    gameIdRef.value = "00112233-4455-6677-8899-aabbccddeeff";
    expect(shortCode.value).toBe("0011 2233");
  });
});
