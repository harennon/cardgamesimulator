import { ref, watch, onScopeDispose, isRef } from "vue";
import type { Ref } from "vue";

export interface TurnAlertDeps {
  /** Defaults to real browser globals; overridden in tests. */
  getDocument?: () => Document;
  getWindow?: () => Window;
  /** () => Notification constructor or undefined if unsupported. */
  getNotification?: () => typeof Notification | undefined;
  /** Factory for an AudioContext, or undefined if unsupported. */
  createAudioContext?: () => AudioContext | undefined;
  /** localStorage-like store; defaults to window.localStorage. */
  storage?: Pick<Storage, "getItem" | "setItem">;
}

export interface UseTurnAlertOptions {
  /** True on the local player's turn (existing board computed). */
  isMyTurn: Ref<boolean>;
  /** Human label for the running game, e.g. "Big2" / "Tonk". */
  gameLabel: Ref<string> | string;
  /**
   * Gate: only players get alerts. Boards pass a ref that is false for
   * spectator/non-interactive contexts. Defaults to true.
   */
  enabled?: Ref<boolean>;
  deps?: TurnAlertDeps;
}

export interface UseTurnAlertReturn {
  /** Persisted chime setting; default true. Writing it updates localStorage. */
  turnSoundEnabled: Ref<boolean>;
  /** Live view of Notification.permission ("default" | "granted" | "denied" | "unsupported"). */
  notificationPermission: Ref<NotificationPermission | "unsupported">;
  /** Toggle the chime setting (persists). */
  toggleTurnSound(): void;
  /**
   * Request Notification permission. MUST be called only from a direct user
   * gesture. Resolves to the resulting permission; never throws. No-op if
   * unsupported or already decided.
   */
  requestNotificationPermission(): Promise<
    NotificationPermission | "unsupported"
  >;
  /** Unlock/resume the AudioContext. Call from the first in-game gesture. Idempotent. */
  unlockAudio(): void;
}

export const TURN_SOUND_STORAGE_KEY = "cgs.turnSound";
export const TITLE_FLASH_INTERVAL_MS = 1200;

export function useTurnAlert(opts: UseTurnAlertOptions): UseTurnAlertReturn {
  // Resolve injectable deps with real-browser defaults.
  const getDocument = opts.deps?.getDocument ?? (() => document);

  const getWindow = opts.deps?.getWindow ?? (() => window as Window);

  const getNotification =
    opts.deps?.getNotification ??
    (() => (typeof Notification !== "undefined" ? Notification : undefined));

  const createAudioContextDep =
    opts.deps?.createAudioContext ??
    (() => {
      const w = window as Window &
        typeof globalThis & { webkitAudioContext?: typeof AudioContext };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) return undefined;
      try {
        return new Ctor();
      } catch {
        return undefined;
      }
    });

  const storageBackend =
    opts.deps?.storage ??
    (typeof window !== "undefined" ? window.localStorage : undefined);

  const safeStorage = {
    getItem(key: string): string | null {
      try {
        return storageBackend?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    setItem(key: string, value: string): void {
      try {
        storageBackend?.setItem(key, value);
      } catch {
        // swallow — E12: localStorage unavailable
      }
    },
  };

  // Init: read turnSound from storage. Default ON.
  const storedSound = safeStorage.getItem(TURN_SOUND_STORAGE_KEY);
  const turnSoundEnabled = ref<boolean>(storedSound === "false" ? false : true);

  // Init: snapshot notification permission.
  const NotifCtor = getNotification();
  const notificationPermission = ref<NotificationPermission | "unsupported">(
    NotifCtor ? NotifCtor.permission : "unsupported",
  );

  // Internal state (non-reactive).
  let armed = false;
  let savedTitle: string | null = null;
  let flashIntervalId: ReturnType<typeof setInterval> | null = null;
  let injectedFaviconLink: HTMLLinkElement | null = null;
  // undefined = not yet saved; null = we injected a new link (nothing existed)
  let savedFaviconHref: string | null | undefined = undefined;
  let audioCtx: AudioContext | null = null;
  let audioUnlocked = false;
  // Use 'unknown' to avoid tight coupling to browser InstanceType in node tests.
  let activeNotification: unknown = null;

  const enabledRef: Ref<boolean> = opts.enabled ?? ref(true);
  const labelRef: Ref<string> = isRef(opts.gameLabel)
    ? opts.gameLabel
    : ref(opts.gameLabel);

  // -------------------------------------------------------------------------
  // Title flash
  // -------------------------------------------------------------------------

  function flashTitle(label: string): void {
    const doc = getDocument();
    savedTitle = doc.title;
    const attentionTitle = `● Your turn — ${label}`;
    doc.title = attentionTitle;

    // Read preference live at each arm, not cached at init (E11).
    const reducedMotion = getWindow().matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (!reducedMotion) {
      flashIntervalId = setInterval(() => {
        const d = getDocument();
        d.title = d.title === attentionTitle ? savedTitle! : attentionTitle;
      }, TITLE_FLASH_INTERVAL_MS);
    }
  }

  function restoreTitle(): void {
    if (flashIntervalId !== null) {
      clearInterval(flashIntervalId);
      flashIntervalId = null;
    }
    if (savedTitle !== null) {
      getDocument().title = savedTitle;
      savedTitle = null;
    }
  }

  // -------------------------------------------------------------------------
  // Favicon badge — canvas-generated, no new binary assets.
  // -------------------------------------------------------------------------

  function showFaviconBadge(): void {
    const doc = getDocument();
    const canvas = doc.createElement("canvas") as HTMLCanvasElement;
    const ctx =
      typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
    if (!ctx) return; // E8: canvas unavailable

    canvas.width = 32;
    canvas.height = 32;

    // Gold background — app accent color.
    ctx.fillStyle = "#c9a84c";
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(0, 0, 32, 32, 8);
    } else {
      ctx.rect(0, 0, 32, 32); // fallback for older browsers
    }
    ctx.fill();

    // Contrasting dot in the center.
    ctx.fillStyle = "#1a0f08";
    ctx.beginPath();
    ctx.arc(16, 16, 6, 0, Math.PI * 2);
    ctx.fill();

    const href = canvas.toDataURL();

    const existing = doc.querySelector(
      'link[rel="icon"]',
    ) as HTMLLinkElement | null;
    if (existing) {
      savedFaviconHref = existing.href;
      existing.href = href;
      injectedFaviconLink = existing;
    } else {
      const link = doc.createElement("link") as HTMLLinkElement;
      link.rel = "icon";
      link.href = href;
      try {
        (doc as Document).head?.appendChild(link);
      } catch {
        // ignore if head unavailable (test env)
      }
      injectedFaviconLink = link;
      savedFaviconHref = null; // null = we created it; restore = remove it
    }
  }

  function restoreFavicon(): void {
    if (!injectedFaviconLink) return;

    if (savedFaviconHref === null) {
      // We injected a fresh link element — remove it.
      try {
        injectedFaviconLink.parentNode?.removeChild(injectedFaviconLink);
      } catch {
        // ignore
      }
    } else if (savedFaviconHref !== undefined) {
      // We modified an existing link — restore its href.
      injectedFaviconLink.href = savedFaviconHref;
    }

    injectedFaviconLink = null;
    savedFaviconHref = undefined;
  }

  // -------------------------------------------------------------------------
  // Chime — generated via AudioContext, no audio file dependency.
  // -------------------------------------------------------------------------

  function playChime(): void {
    if (!turnSoundEnabled.value) return; // E4: setting OFF
    if (!getDocument().hidden) return;
    if (!audioUnlocked || !audioCtx) return; // E5: not yet unlocked

    // Best-effort resume if the context was re-suspended (E9).
    if (audioCtx.state === "suspended") {
      void audioCtx.resume().catch(() => {});
    }

    try {
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, audioCtx.currentTime);
      gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(
        0.001,
        audioCtx.currentTime + 0.15,
      );

      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.15);
    } catch {
      // silently skip on any audio error
    }
  }

  // -------------------------------------------------------------------------
  // Web Notification
  // -------------------------------------------------------------------------

  function fireNotification(label: string): void {
    const Ctor = getNotification();
    if (!Ctor) return; // E6: Notification unsupported
    if (Ctor.permission !== "granted") return; // E7: not granted

    try {
      const notification = new Ctor(`Your turn — ${label}`, {
        tag: "turn-alert",
        body: "It's your turn to play.",
      });
      activeNotification = notification;
    } catch {
      // silently skip
    }
  }

  // -------------------------------------------------------------------------
  // Arm / Clear
  // -------------------------------------------------------------------------

  function clear(): void {
    armed = false;
    restoreTitle();
    restoreFavicon();

    if (activeNotification !== null) {
      try {
        (activeNotification as { close(): void }).close();
      } catch {
        // ignore
      }
      activeNotification = null;
    }
  }

  function arm(): void {
    if (!enabledRef.value) return; // E14: spectator gate
    if (!getDocument().hidden) return; // E1: tab is focused

    // E10: rapid turn cycling — reset prior state before re-arming.
    if (armed) {
      clear();
    }

    armed = true;
    const label = labelRef.value;

    flashTitle(label);
    showFaviconBadge();
    playChime();
    fireNotification(label);
  }

  // -------------------------------------------------------------------------
  // Clear on visibility / focus
  // -------------------------------------------------------------------------

  function onVisibilityOrFocus(): void {
    if (!getDocument().hidden) {
      clear();
    }
  }

  const doc = getDocument();
  const win = getWindow();
  doc.addEventListener("visibilitychange", onVisibilityOrFocus);
  win.addEventListener("focus", onVisibilityOrFocus);

  // -------------------------------------------------------------------------
  // Watch isMyTurn for the false → true edge (and true → false while armed).
  // -------------------------------------------------------------------------

  watch(opts.isMyTurn, (newVal, oldVal) => {
    if (newVal && !oldVal) {
      arm();
    } else if (!newVal && armed) {
      // E3: turn passed while still hidden — stop the alert.
      clear();
    }
  });

  // -------------------------------------------------------------------------
  // Scope disposal — restore all state and detach listeners.
  // -------------------------------------------------------------------------

  onScopeDispose(() => {
    clear();
    doc.removeEventListener("visibilitychange", onVisibilityOrFocus);
    win.removeEventListener("focus", onVisibilityOrFocus);
  });

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function toggleTurnSound(): void {
    turnSoundEnabled.value = !turnSoundEnabled.value;
    safeStorage.setItem(TURN_SOUND_STORAGE_KEY, String(turnSoundEnabled.value));
  }

  async function requestNotificationPermission(): Promise<
    NotificationPermission | "unsupported"
  > {
    const Ctor = getNotification();
    if (!Ctor) return "unsupported"; // E6
    if (Ctor.permission !== "default") return Ctor.permission; // E7: already decided

    try {
      const result = await Ctor.requestPermission();
      notificationPermission.value = result;
      return result;
    } catch {
      return notificationPermission.value;
    }
  }

  function unlockAudio(): void {
    if (!audioCtx) {
      audioCtx = createAudioContextDep() ?? null;
    }
    if (!audioCtx) return;

    if (audioCtx.state === "suspended") {
      void audioCtx.resume().catch(() => {});
    }
    audioUnlocked = true;
  }

  return {
    turnSoundEnabled,
    notificationPermission,
    toggleTurnSound,
    requestNotificationPermission,
    unlockAudio,
  };
}
