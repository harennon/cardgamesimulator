import { ref, shallowRef, readonly, onUnmounted } from "vue";
import { io, Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@shared/socket-events";
import { getAccessToken } from "@/service/authService";
import { getGuestToken } from "@/service/guestService";

export type TypedClientSocket = Socket<
  ServerToClientEvents,
  ClientToServerEvents
>;

export function useSocket() {
  const socket = shallowRef<TypedClientSocket | null>(null);
  const connected = ref(false);
  const error = ref<string | null>(null);

  async function connect(): Promise<void> {
    // Guard: prevent orphan sockets if connect() is called multiple times
    if (socket.value) {
      return;
    }

    // Try Supabase token first, fall back to guest token
    const token = (await getAccessToken()) ?? getGuestToken();
    if (!token) {
      error.value = "Not authenticated";
      return;
    }

    const s = io(import.meta.env.VITE_API_BASE_URL || "", {
      auth: { token },
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    s.on("connect", () => {
      connected.value = true;
      error.value = null;
    });
    s.on("disconnect", () => {
      connected.value = false;
    });
    s.on("connect_error", (err) => {
      error.value = err.message;
      connected.value = false;
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
    error: readonly(error),
    connect,
    disconnect,
  };
}
