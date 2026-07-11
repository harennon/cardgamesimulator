import { ref, shallowRef, readonly, onUnmounted } from "vue";
import type { DeepReadonly, ShallowRef, Ref } from "vue";
import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@shared/socket-events";
import { getAccessToken } from "@/service/authService";
import { getGuestToken } from "@/service/guestService";
import { classifyDisconnect, deriveConnectionState } from "./connectionState";
import type { ConnectionState } from "./connectionState";
import { recordBreadcrumb } from "@/observability/sentry";
import { useCorrelation } from "@/composables/useCorrelation";

// ---------------------------------------------------------------------------
// Socket breadcrumb throttle — module-scoped, not per-instance
// ---------------------------------------------------------------------------

const _socketBreadcrumbThrottle = new Map<
  string,
  { lastEmit: number; suppressed: number }
>();
export const SOCKET_BREADCRUMB_WINDOW_MS = 10_000;

function recordSocketFailure(
  reason: string,
  data: Record<string, unknown>,
): void {
  const { correlationId, gameId } = useCorrelation();
  const now = Date.now();
  const entry = _socketBreadcrumbThrottle.get(reason);

  if (entry && now - entry.lastEmit < SOCKET_BREADCRUMB_WINDOW_MS) {
    entry.suppressed += 1;
    return;
  }

  const suppressedSince = entry?.suppressed ?? 0;
  _socketBreadcrumbThrottle.set(reason, { lastEmit: now, suppressed: 0 });

  recordBreadcrumb({
    category: "socket",
    message: reason,
    level: "warning",
    data: {
      correlationId: correlationId.value,
      gameId: gameId.value,
      reason,
      ...data,
      ...(suppressedSince > 0 ? { suppressedSince } : {}),
    },
  });
}

export type { ConnectionState };

export type TypedClientSocket = Socket<
  ServerToClientEvents,
  ClientToServerEvents
>;

const MAX_RECONNECT_ATTEMPTS = 10;

/** Grace window before a transient disconnect surfaces the reconnecting banner. */
export const RECONNECTING_GRACE_MS = 1750;

export interface UseSocketReturn {
  socket: ShallowRef<TypedClientSocket | null>;
  connected: DeepReadonly<Ref<boolean>>;
  connectionState: DeepReadonly<Ref<ConnectionState>>;
  reconnectAttempt: DeepReadonly<Ref<number>>;
  maxReconnectAttempts: number;
  terminalError: DeepReadonly<Ref<string | null>>;
  connect(): Promise<void>;
  disconnect(): void;
}

export function useSocket(): UseSocketReturn {
  const socket = shallowRef<TypedClientSocket | null>(null);
  const connected = ref(false);
  const connectionState = ref<ConnectionState>("connected");
  const reconnectAttempt = ref(0);
  const terminalError = ref<string | null>(null);

  // Track whether the manager has fully exhausted reconnection.
  let _reconnectFailed = false;

  // One pending grace-timer handle per useSocket() instance.
  let _graceTimer: ReturnType<typeof setTimeout> | null = null;

  function _clearGraceTimer(): void {
    if (_graceTimer !== null) {
      clearTimeout(_graceTimer);
      _graceTimer = null;
    }
  }

  // Debounced entry into "reconnecting". Collapses repeated calls into one
  // pending transition. Does nothing if the timer is already pending.
  function _scheduleReconnecting(): void {
    if (_graceTimer !== null) return; // already pending — don't restart the clock
    _graceTimer = setTimeout(() => {
      _graceTimer = null;
      // Guard: only surface reconnecting if we are still disconnected and not terminal.
      if (!connected.value && !_reconnectFailed) {
        connectionState.value = "reconnecting";
      }
    }, RECONNECTING_GRACE_MS);
  }

  function _updateConnectionState(): void {
    connectionState.value = deriveConnectionState({
      connected: connected.value,
      reconnectFailed: _reconnectFailed,
    });
  }

  async function connect(): Promise<void> {
    // Guard: prevent orphan sockets if connect() is called multiple times.
    if (socket.value) {
      return;
    }

    _clearGraceTimer(); // no stale pending transition from a prior socket

    // Reset all state for a fresh connection attempt (handles the E12 re-mount case).
    connected.value = false;
    connectionState.value = "connected"; // will be updated as events arrive
    reconnectAttempt.value = 0;
    terminalError.value = null;
    _reconnectFailed = false;

    // Try Supabase token first, fall back to guest token.
    const token = (await getAccessToken()) ?? getGuestToken();
    if (!token) {
      terminalError.value = "Not authenticated";
      connectionState.value = "terminal";
      return;
    }

    const { correlationId } = useCorrelation();
    const s = io(import.meta.env.VITE_API_BASE_URL || "", {
      auth: { token, correlationId: correlationId.value },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: MAX_RECONNECT_ATTEMPTS,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    // --- Socket-level events ---

    s.on("connect", () => {
      connected.value = true;
      _reconnectFailed = false;
      reconnectAttempt.value = 0;
      _clearGraceTimer(); // cancel any pending "reconnecting" transition
      _updateConnectionState(); // → "connected", immediate (never debounced)
    });

    s.on("disconnect", (reason) => {
      connected.value = false;
      const cls = classifyDisconnect(reason as string);
      if (cls === "ignore") {
        // Our own teardown — do not change connectionState.
        return;
      }
      if (cls === "terminal") {
        // Server-initiated: manager will NOT auto-retry; show red banner.
        _clearGraceTimer(); // terminal is immediate — cancel any pending grace
        _reconnectFailed = false; // not the "exhausted" terminal path
        connectionState.value = "terminal";
        recordSocketFailure("disconnect", { reason, cls });
        return;
      }
      // cls === "retry": schedule reconnecting after the grace window.
      _scheduleReconnecting();
      recordSocketFailure("disconnect", { reason, cls });
    });

    s.on("connect_error", (err) => {
      if (err.message === "SERVER_FULL") {
        terminalError.value =
          "Server is at capacity. Please try again shortly.";
        // SERVER_FULL is distinct/un-throttled (rare, high-signal)
        recordBreadcrumb({
          category: "socket",
          message: "connect_error:server_full",
          level: "error",
          data: { reason: "server_full" },
        });
        s.disconnect();
        return;
      }
      // All other connect_error events are transient reconnection attempts —
      // do NOT set an error string or flip connectionState here; the
      // disconnect/reconnect_attempt/reconnect_failed events govern the banner.
      connected.value = false;
      recordSocketFailure("connect_error", { message: err.message });
    });

    // --- Manager-level reconnect events ---

    s.io.on("reconnect_attempt", (attempt: number) => {
      reconnectAttempt.value = attempt; // synchronous (not yet visible until banner shows)
      _scheduleReconnecting(); // debounced: no-op if timer already pending
    });

    s.io.on("reconnect", () => {
      // The 'connect' socket event fires alongside this, so state is updated there.
    });

    s.io.on("reconnect_failed", () => {
      _clearGraceTimer(); // terminal is immediate — cancel any pending grace
      _reconnectFailed = true;
      connectionState.value = "terminal";
    });

    socket.value = s;
  }

  function disconnect(): void {
    _clearGraceTimer(); // don't fire reconnecting after teardown
    socket.value?.disconnect();
    socket.value = null;
    connected.value = false;
  }

  onUnmounted(() => {
    disconnect();
  });

  return {
    socket,
    connected: readonly(connected),
    connectionState: readonly(connectionState),
    reconnectAttempt: readonly(reconnectAttempt),
    maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
    terminalError: readonly(terminalError),
    connect,
    disconnect,
  };
}
