import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// LLD 162 — action-ack timeout (emitWithTimeout)
//
// The helper is not exported directly; we test the observable effect via
// useGameActions methods, which all go through emitWithTimeout internally.
// Uses vi.useFakeTimers() so the 8-second timeout fires synchronously.
// ---------------------------------------------------------------------------

import type { TypedClientSocket } from "../../src/frontend/composables/useSocket.js";
import type { GameActionResponse } from "../../src/shared/socket-events.js";
import { useGameActions } from "../../src/frontend/composables/useGameActions.js";

const TIMEOUT_MS = 8000;
const TIMEOUT_ERROR = "Couldn't reach the server — reconnecting…";

type AckFn = (response: GameActionResponse) => void;

function makeSilentSocket(): TypedClientSocket {
  // emit records the call but never fires the ack — simulates offline drop.
  return {
    emit: vi.fn(),
  } as unknown as TypedClientSocket;
}

function makeRespondingSocket(
  response: GameActionResponse,
  delayMs = 0,
): { socket: TypedClientSocket; triggerAck: () => void } {
  let storedAck: AckFn | null = null;
  const socket = {
    emit: vi.fn(
      (
        _event: string,
        _payload: unknown,
        ack: (r: GameActionResponse) => void,
      ) => {
        storedAck = ack;
        if (delayMs === 0) {
          ack(response);
        }
        // else caller must call triggerAck() manually
      },
    ),
  } as unknown as TypedClientSocket;

  function triggerAck() {
    storedAck?.(response);
  }

  return { socket, triggerAck };
}

describe("useGameActions — ack timeout (LLD 162)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ack that never fires resolves to {success:false, error} after 8s", async () => {
    const socket = makeSilentSocket();
    const { pass, bind } = useGameActions();
    bind(socket);

    const resultPromise = pass("game-1");
    vi.advanceTimersByTime(TIMEOUT_MS);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toBe(TIMEOUT_ERROR);
  });

  it("actionPending resets to false after timeout", async () => {
    const socket = makeSilentSocket();
    const { pass, actionPending, bind } = useGameActions();
    bind(socket);

    expect(actionPending.value).toBe(false);
    const resultPromise = pass("game-1");
    expect(actionPending.value).toBe(true);

    vi.advanceTimersByTime(TIMEOUT_MS);
    await resultPromise;

    expect(actionPending.value).toBe(false);
  });

  it("actionError is set to the timeout message after timeout", async () => {
    const socket = makeSilentSocket();
    const { pass, actionError, bind } = useGameActions();
    bind(socket);

    const resultPromise = pass("game-1");
    vi.advanceTimersByTime(TIMEOUT_MS);
    await resultPromise;

    expect(actionError.value).toBe(TIMEOUT_ERROR);
  });

  it("ack arriving before 8s resolves normally (no timeout)", async () => {
    const { socket } = makeRespondingSocket({ success: true }, 0);
    const { pass, actionError, bind } = useGameActions();
    bind(socket);

    const result = await pass("game-1");

    expect(result.success).toBe(true);
    expect(actionError.value).toBeNull();
  });

  it("timer is cleared when ack arrives before timeout (no late double-resolve)", async () => {
    // Ack fires immediately; advancing time past 8s should NOT cause a second
    // resolve or reset actionError.
    const { socket } = makeRespondingSocket({ success: true }, 0);
    const { pass, actionError, bind } = useGameActions();
    bind(socket);

    const result = await pass("game-1");
    expect(result.success).toBe(true);

    // Advance past timeout window — no additional side effects.
    vi.advanceTimersByTime(TIMEOUT_MS + 1000);
    expect(actionError.value).toBeNull();
  });

  it("late ack arriving after timeout is ignored (E6 — no double-resolve, no state flap)", async () => {
    let storedAck: AckFn | null = null;
    const socket = {
      emit: vi.fn(
        (
          _event: string,
          _payload: unknown,
          ack: (r: GameActionResponse) => void,
        ) => {
          storedAck = ack;
          // ack NOT called yet
        },
      ),
    } as unknown as TypedClientSocket;

    const { pass, actionError, actionPending, bind } = useGameActions();
    bind(socket);

    const resultPromise = pass("game-1");

    // Timeout fires first
    vi.advanceTimersByTime(TIMEOUT_MS);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toBe(TIMEOUT_ERROR);
    expect(actionPending.value).toBe(false);

    // Late ack arrives — must be silently ignored
    const lateFiredAck = storedAck;
    expect(lateFiredAck).not.toBeNull();
    expect(() => lateFiredAck?.({ success: true })).not.toThrow();

    // State must not have changed after the late ack
    expect(actionError.value).toBe(TIMEOUT_ERROR);
    expect(actionPending.value).toBe(false);
  });

  it("playCards times out and sets the timeout error", async () => {
    const socket = makeSilentSocket();
    const { playCards, actionError, bind } = useGameActions();
    bind(socket);

    const resultPromise = playCards("game-1", [{ suit: "clubs", rank: "3" }]);
    vi.advanceTimersByTime(TIMEOUT_MS);
    await resultPromise;

    expect(actionError.value).toBe(TIMEOUT_ERROR);
  });

  it("discard times out and sets the timeout error", async () => {
    const socket = makeSilentSocket();
    const { discard, actionError, bind } = useGameActions();
    bind(socket);

    const resultPromise = discard("game-1", [{ suit: "clubs", rank: "Q" }]);
    vi.advanceTimersByTime(TIMEOUT_MS);
    await resultPromise;

    expect(actionError.value).toBe(TIMEOUT_ERROR);
  });

  it("drawCard times out and sets the timeout error", async () => {
    const socket = makeSilentSocket();
    const { drawCard, actionError, bind } = useGameActions();
    bind(socket);

    const resultPromise = drawCard("game-1", "stock");
    vi.advanceTimersByTime(TIMEOUT_MS);
    await resultPromise;

    expect(actionError.value).toBe(TIMEOUT_ERROR);
  });

  it("callTonk times out and sets the timeout error", async () => {
    const socket = makeSilentSocket();
    const { callTonk, actionError, bind } = useGameActions();
    bind(socket);

    const resultPromise = callTonk("game-1");
    vi.advanceTimersByTime(TIMEOUT_MS);
    await resultPromise;

    expect(actionError.value).toBe(TIMEOUT_ERROR);
  });

  it("rematch times out and sets the timeout error", async () => {
    const socket = makeSilentSocket();
    const { rematch, actionError, bind } = useGameActions();
    bind(socket);

    const resultPromise = rematch("game-1");
    vi.advanceTimersByTime(TIMEOUT_MS);
    await resultPromise;

    expect(actionError.value).toBe(TIMEOUT_ERROR);
  });
});
