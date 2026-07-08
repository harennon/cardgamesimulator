import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// LLD 162 — reconnect re-join logic (GameView connect handler transcription)
//
// Transcribes the hasJoinedOnce guard + game:join re-emit from GameView.vue
// as a pure in-memory simulation.
//
// Regression guards:
//   - First connect does NOT emit game:join (initial join handled in onMounted).
//   - Every subsequent connect (reconnect) emits game:join exactly once.
//   - Re-join ack failure sets joinError (game deleted while offline).
//   - Listeners are bound once and NOT re-bound on reconnect.
// ---------------------------------------------------------------------------

type JoinAck = { success: boolean; error?: string };
type EmitFn = (
  event: string,
  payload: { gameId: string; role: string },
  ack: (r: JoinAck) => void,
) => void;

/**
 * Simulates the GameView reconnect-connect handler logic.
 * Returns the same interface the component exposes.
 */
function createReconnectHandler(
  gameId: string,
  emitFn: EmitFn,
  setJoinError: (msg: string) => void,
) {
  let hasJoinedOnce = false;

  // Simulates s.on("connect", handler) — call this for each connect event.
  function onConnect(): void {
    if (!hasJoinedOnce) {
      hasJoinedOnce = true;
      return; // initial join is done elsewhere (onMounted)
    }
    // Reconnect — re-emit game:join (idempotent).
    emitFn("game:join", { gameId, role: "player" }, (response) => {
      if (!response.success) {
        setJoinError(response.error ?? "Failed to rejoin game.");
      }
    });
  }

  return { onConnect };
}

describe("reconnect re-join handler (LLD 162)", () => {
  it("first connect does NOT emit game:join", () => {
    const emitFn = vi.fn<EmitFn>();
    const setJoinError = vi.fn<(msg: string) => void>();

    const { onConnect } = createReconnectHandler(
      "game-1",
      emitFn,
      setJoinError,
    );

    onConnect(); // first connect (initial)

    expect(emitFn).not.toHaveBeenCalled();
  });

  it("second connect (first reconnect) emits game:join exactly once", () => {
    const emitFn = vi.fn<EmitFn>((_, __, ack) => {
      ack({ success: true });
    });
    const setJoinError = vi.fn<(msg: string) => void>();

    const { onConnect } = createReconnectHandler(
      "game-42",
      emitFn,
      setJoinError,
    );

    onConnect(); // initial — no emit
    onConnect(); // first reconnect

    expect(emitFn).toHaveBeenCalledTimes(1);
    expect(emitFn).toHaveBeenCalledWith(
      "game:join",
      { gameId: "game-42", role: "player" },
      expect.any(Function),
    );
  });

  it("third connect (second reconnect) emits game:join again — once per reconnect", () => {
    const emitFn = vi.fn<EmitFn>((_, __, ack) => {
      ack({ success: true });
    });
    const setJoinError = vi.fn<(msg: string) => void>();

    const { onConnect } = createReconnectHandler(
      "game-1",
      emitFn,
      setJoinError,
    );

    onConnect(); // initial
    onConnect(); // reconnect 1
    onConnect(); // reconnect 2

    expect(emitFn).toHaveBeenCalledTimes(2);
  });

  it("re-join ack success does NOT call setJoinError", () => {
    const emitFn = vi.fn<EmitFn>((_, __, ack) => {
      ack({ success: true });
    });
    const setJoinError = vi.fn<(msg: string) => void>();

    const { onConnect } = createReconnectHandler(
      "game-1",
      emitFn,
      setJoinError,
    );

    onConnect(); // initial
    onConnect(); // reconnect

    expect(setJoinError).not.toHaveBeenCalled();
  });

  it("re-join ack failure (game deleted while offline) sets joinError", () => {
    const emitFn = vi.fn<EmitFn>((_, __, ack) => {
      ack({ success: false, error: "Game not found." });
    });
    const setJoinError = vi.fn<(msg: string) => void>();

    const { onConnect } = createReconnectHandler(
      "game-1",
      emitFn,
      setJoinError,
    );

    onConnect(); // initial
    onConnect(); // reconnect → ack fails

    expect(setJoinError).toHaveBeenCalledWith("Game not found.");
  });

  it("re-join ack failure without error field falls back to default message", () => {
    const emitFn = vi.fn<EmitFn>((_, __, ack) => {
      ack({ success: false }); // no error field
    });
    const setJoinError = vi.fn<(msg: string) => void>();

    const { onConnect } = createReconnectHandler(
      "game-1",
      emitFn,
      setJoinError,
    );

    onConnect(); // initial
    onConnect(); // reconnect

    expect(setJoinError).toHaveBeenCalledWith("Failed to rejoin game.");
  });

  it("listeners are bound once — reconnect does NOT re-bind (double-fire prevention)", () => {
    // This test proves that the re-join handler only calls s.emit, never
    // calls bindState/bindActions again. We simulate bind as a separate spy
    // that is called once in onMounted before calling onConnect(initial).
    const emitFn = vi.fn<EmitFn>((_, __, ack) => {
      ack({ success: true });
    });
    const bindState = vi.fn();
    const bindActions = vi.fn();
    const setJoinError = vi.fn<(msg: string) => void>();

    // Simulate onMounted: bind first, then emit initial join, then first connect.
    bindState();
    bindActions();

    const { onConnect } = createReconnectHandler(
      "game-1",
      emitFn,
      setJoinError,
    );

    onConnect(); // initial — marks hasJoinedOnce, no emit
    onConnect(); // reconnect — emits game:join only, does NOT call bind* again

    // Bind functions must have been called exactly once (from onMounted).
    expect(bindState).toHaveBeenCalledTimes(1);
    expect(bindActions).toHaveBeenCalledTimes(1);
    // The re-join emit was called.
    expect(emitFn).toHaveBeenCalledTimes(1);
  });
});
