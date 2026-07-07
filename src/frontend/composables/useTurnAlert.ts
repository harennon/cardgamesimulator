import { ref, computed, watch, onScopeDispose } from "vue";
import type { Ref } from "vue";
import type { GameType } from "@shared/engine-types";

export type NotifState = "unsupported" | "default" | "granted" | "denied";

export interface UseTurnAlertOptions {
  /** True only for a seated player (myPlayerIndex >= 0). Spectators pass false. */
  isPlayer: Ref<boolean>;
  /** True only while gameState.status === "IN_PROGRESS". Suppresses a
   *  spurious alert during Big2's post-COMPLETED SHOW_FINAL_PLAY reveal. */
  isInProgress: Ref<boolean>;
  /** From the board's existing isMyTurn computed. */
  isMyTurn: Ref<boolean>;
  /** From the board's gameState.gameType — drives the alert title label. */
  gameType: Ref<GameType>;
}

export interface UseTurnAlertReturn {
  /** Persisted chime toggle (localStorage). Default true. */
  soundEnabled: Ref<boolean>;
  setSoundEnabled(value: boolean): void;
  /** Live browser permission state ("unsupported" if Notification API absent). */
  notifState: Ref<NotifState>;
  /** Explicit opt-in only. Requests permission, updates notifState. No-op if unsupported/denied. */
  requestNotificationPermission(): Promise<void>;
  /** Idempotent; call from the first in-game user gesture to satisfy autoplay policy. */
  unlockAudio(): void;
}

/** "● Your turn — Big2" / "● Your turn — Tonk". */
export function buildAlertTitle(gameType: GameType): string {
  const label = gameType === "big2" ? "Big2" : "Tonk";
  return `● Your turn — ${label}`;
}

/** Inline SVG data-URI; badged adds a gold dot top-right. */
export function buildFaviconDataUri(badged: boolean): string {
  const badge = badged ? `<circle cx="20" cy="4" r="4" fill="#c9a84c"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><rect width="24" height="24" rx="4" fill="#1a5c34"/><text x="12" y="17" font-size="14" text-anchor="middle" fill="#c9a84c">♠</text>${badge}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function readSoundEnabled(): boolean {
  try {
    const stored = localStorage.getItem("turnAlert.sound");
    if (stored === null) return true;
    return stored !== "off";
  } catch {
    return true;
  }
}

function writeSoundEnabled(value: boolean): void {
  try {
    localStorage.setItem("turnAlert.sound", value ? "on" : "off");
  } catch {
    // private mode or storage unavailable — keep in-memory only
  }
}

function readNotifState(): NotifState {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission as NotifState;
}

export function useTurnAlert(opts: UseTurnAlertOptions): UseTurnAlertReturn {
  const { isPlayer, isInProgress, isMyTurn, gameType } = opts;

  // --- Reactive state ---
  const soundEnabled = ref<boolean>(readSoundEnabled());
  const notifState = ref<NotifState>(readNotifState());

  // --- Internal mutable state (not reactive) ---
  let flashTimer: ReturnType<typeof setInterval> | null = null;
  let originalTitle = "";
  let originalIconLinks: HTMLLinkElement[] = [];
  let managedIconLink: HTMLLinkElement | null = null;
  let pendingNotification: Notification | null = null;
  let audioCtx: AudioContext | null = null;

  // --- Helpers ---

  function armFavicon(): void {
    if (typeof document === "undefined" || !document.head) return;
    if (managedIconLink) return; // idempotent

    // Detach all rel="icon" links (not apple-touch-icon)
    const existing = Array.from(
      document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'),
    );
    originalIconLinks = existing;
    for (const link of existing) {
      document.head.removeChild(link);
    }

    // Inject single managed SVG link
    const managed = document.createElement("link");
    managed.rel = "icon";
    managed.type = "image/svg+xml";
    managed.href = buildFaviconDataUri(true);
    document.head.appendChild(managed);
    managedIconLink = managed;
  }

  function clearFavicon(): void {
    if (typeof document === "undefined" || !document.head) return;
    if (!managedIconLink) return;

    document.head.removeChild(managedIconLink);
    managedIconLink = null;

    // Re-insert originals in their original order
    for (const link of originalIconLinks) {
      document.head.appendChild(link);
    }
    originalIconLinks = [];
  }

  function playChime(): void {
    if (!audioCtx) return;
    try {
      const ctx = audioCtx;
      const now = ctx.currentTime;

      function beep(freq: number, startAt: number): void {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.15, startAt);
        gain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.2);
        osc.start(startAt);
        osc.stop(startAt + 0.25);
      }

      beep(880, now);
      beep(1175, now + 0.15);
    } catch {
      // AudioContext unavailable or suspended — silent degrade
    }
  }

  function armAlert(): void {
    const alertTitle = buildAlertTitle(gameType.value);
    originalTitle = typeof document !== "undefined" ? document.title : "";

    // Title flash
    const reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reducedMotion) {
      if (typeof document !== "undefined") {
        document.title = alertTitle;
      }
    } else {
      if (flashTimer === null) {
        if (typeof document !== "undefined") {
          document.title = alertTitle;
        }
        flashTimer = setInterval(() => {
          if (typeof document === "undefined") return;
          document.title =
            document.title === alertTitle ? originalTitle : alertTitle;
        }, 1000);
      }
    }

    // Favicon badge
    armFavicon();

    // Chime
    if (soundEnabled.value) {
      playChime();
    }

    // Notification
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      try {
        const label = gameType.value === "big2" ? "Big2" : "Tonk";
        const notif = new Notification(`Your turn — ${label}`, {
          body: "Tap to return to your game",
          tag: "turn-alert",
        });
        notif.onclick = () => {
          if (typeof window !== "undefined") window.focus();
        };
        pendingNotification = notif;
      } catch {
        // Notification constructor can throw in some environments
      }
    }
  }

  function clearAlert(): void {
    // Stop flash, restore title
    if (flashTimer !== null) {
      clearInterval(flashTimer);
      flashTimer = null;
    }
    if (typeof document !== "undefined" && originalTitle) {
      document.title = originalTitle;
    }
    originalTitle = "";

    // Restore favicon
    clearFavicon();

    // Close pending notification
    if (pendingNotification) {
      try {
        pendingNotification.close();
      } catch {
        // ignore
      }
      pendingNotification = null;
    }
  }

  // --- Derived trigger ---
  // document.hidden is not Vue-reactive, so we mirror it via a ref updated by
  // the visibilitychange listener. This makes shouldAlert fully reactive.
  const hiddenRef = ref(
    typeof document !== "undefined" ? document.hidden : false,
  );

  function onVisibilityChange(): void {
    hiddenRef.value = typeof document !== "undefined" ? document.hidden : false;
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  const shouldAlert = computed(
    () =>
      isPlayer.value && isInProgress.value && isMyTurn.value && hiddenRef.value,
  );

  watch(shouldAlert, (newVal) => {
    if (newVal) {
      armAlert();
    } else {
      clearAlert();
    }
  });

  // --- Public API ---

  function setSoundEnabled(value: boolean): void {
    soundEnabled.value = value;
    writeSoundEnabled(value);
  }

  async function requestNotificationPermission(): Promise<void> {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "denied") return;
    try {
      const result = await Notification.requestPermission();
      notifState.value = result as NotifState;
    } catch {
      // ignore
    }
  }

  function unlockAudio(): void {
    if (typeof window === "undefined") return;
    try {
      if (!audioCtx) {
        const win = window as Window &
          typeof globalThis & {
            AudioContext?: typeof AudioContext;
            webkitAudioContext?: typeof AudioContext;
          };
        const AC = win.AudioContext ?? win.webkitAudioContext;
        if (!AC) return;
        audioCtx = new AC();
      }
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
    } catch {
      // AudioContext unavailable — silent degrade
    }
  }

  // --- Cleanup ---
  onScopeDispose(() => {
    clearAlert();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    if (audioCtx) {
      try {
        audioCtx.close();
      } catch {
        // ignore
      }
      audioCtx = null;
    }
  });

  return {
    soundEnabled,
    setSoundEnabled,
    notifState,
    requestNotificationPermission,
    unlockAudio,
  };
}
