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

export type { ConnectionState };

export type TypedClientSocket = Socket<
  ServerToClientEvents,
  ClientToServerEvents
>;

const MAX_RECONNECT_ATTEMPTS = 10;

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

    const s = io(import.meta.env.VITE_API_BASE_URL || "", {
      auth: { token },
      transports: ["websocket"],
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
      _updateConnectionState();
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
        _reconnectFailed = false; // not the "exhausted" terminal path
        connectionState.value = "terminal";
        return;
      }
      // cls === "retry": manager will attempt reconnection.
      connectionState.value = "reconnecting";
    });

    s.on("connect_error", (err) => {
      if (err.message === "SERVER_FULL") {
        terminalError.value =
          "Server is at capacity. Please try again shortly.";
        s.disconnect();
        return;
      }
      // All other connect_error events are transient reconnection attempts —
      // do NOT set an error string or flip connectionState here; the
      // disconnect/reconnect_attempt/reconnect_failed events govern the banner.
      connected.value = false;
    });

    // --- Manager-level reconnect events ---

    s.io.on("reconnect_attempt", (attempt: number) => {
      connectionState.value = "reconnecting";
      reconnectAttempt.value = attempt;
    });

    s.io.on("reconnect", () => {
      // The 'connect' socket event fires alongside this, so state is updated there.
    });

    s.io.on("reconnect_failed", () => {
      _reconnectFailed = true;
      connectionState.value = "terminal";
    });

    socket.value = s;
  }

  function disconnect(): void {
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
