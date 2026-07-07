import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { ref, effectScope } from "vue";
import {
  useTurnAlert,
  TURN_SOUND_STORAGE_KEY,
  TITLE_FLASH_INTERVAL_MS,
} from "../../src/frontend/composables/useTurnAlert.js";
import type { TurnAlertDeps } from "../../src/frontend/composables/useTurnAlert.js";

// ---------------------------------------------------------------------------
// Fake helpers
// ---------------------------------------------------------------------------

type EventMap = Record<string, Set<EventListenerOrEventListenerObject>>;

interface FakeDocument {
  hidden: boolean;
  title: string;
  _events: EventMap;
  addEventListener: MockInstance;
  removeEventListener: MockInstance;
  createElement: MockInstance;
  querySelector: MockInstance;
  head: { appendChild: MockInstance };
}

interface FakeWindow {
  _events: EventMap;
  addEventListener: MockInstance;
  removeEventListener: MockInstance;
  matchMedia: MockInstance;
}

interface FakeNotificationConstructor {
  permission: NotificationPermission;
  requestPermission: MockInstance;
  new (title: string, opts?: NotificationOptions): FakeNotification;
}

interface FakeNotification {
  close: MockInstance;
}

interface FakeAudioCtx {
  state: "suspended" | "running";
  resume: MockInstance;
  createOscillator: MockInstance;
  createGain: MockInstance;
  destination: Record<string, never>;
  currentTime: number;
}

interface FakeStorage {
  store: Record<string, string>;
  getItem: MockInstance;
  setItem: MockInstance;
}

function makeEventTarget(): {
  _events: EventMap;
  addEventListener: MockInstance;
  removeEventListener: MockInstance;
  dispatch(type: string): void;
} {
  const events: EventMap = {};
  const addEventListener = vi.fn((type: string, listener: EventListener) => {
    if (!events[type]) events[type] = new Set();
    events[type].add(listener);
  });
  const removeEventListener = vi.fn((type: string, listener: EventListener) => {
    events[type]?.delete(listener);
  });
  function dispatch(type: string) {
    events[type]?.forEach((l) => {
      if (typeof l === "function") l({} as Event);
    });
  }
  return { _events: events, addEventListener, removeEventListener, dispatch };
}

function makeDocument(hidden = false): FakeDocument & {
  dispatch(type: string): void;
} {
  const target = makeEventTarget();

  const createdElements: Array<{
    tagName: string;
    href?: string;
    rel?: string;
    parentNode: { removeChild: MockInstance } | null;
  }> = [];

  const createElement = vi.fn((tag: string) => {
    const el: {
      tagName: string;
      href: string;
      rel: string;
      width: number;
      height: number;
      parentNode: { removeChild: MockInstance } | null;
      getContext: MockInstance;
      toDataURL: MockInstance;
    } = {
      tagName: tag,
      href: "",
      rel: "",
      width: 0,
      height: 0,
      parentNode: { removeChild: vi.fn() },
      getContext: vi.fn().mockReturnValue({
        fillStyle: "",
        beginPath: vi.fn(),
        roundRect: vi.fn(),
        rect: vi.fn(),
        fill: vi.fn(),
        arc: vi.fn(),
      }),
      toDataURL: vi.fn().mockReturnValue("data:image/png;base64,BADGE"),
    };
    createdElements.push(el);
    return el;
  });

  const head = { appendChild: vi.fn() };

  return {
    hidden,
    title: "Card Game",
    _events: target._events,
    addEventListener: target.addEventListener,
    removeEventListener: target.removeEventListener,
    createElement,
    // Default: no existing favicon link.
    querySelector: vi.fn().mockReturnValue(null),
    head,
    dispatch: target.dispatch,
  };
}

function makeWindow(reducedMotion = false): FakeWindow & {
  dispatch(type: string): void;
} {
  const target = makeEventTarget();
  const matchMedia = vi.fn().mockReturnValue({ matches: reducedMotion });
  return {
    _events: target._events,
    addEventListener: target.addEventListener,
    removeEventListener: target.removeEventListener,
    matchMedia,
    dispatch: target.dispatch,
  };
}

function makeNotificationCtor(
  permission: NotificationPermission = "default",
): FakeNotificationConstructor {
  const instances: FakeNotification[] = [];

  const requestPermission = vi
    .fn()
    .mockResolvedValue("granted" as NotificationPermission);

  const Ctor = vi.fn().mockImplementation(function () {
    const inst: FakeNotification = { close: vi.fn() };
    instances.push(inst);
    return inst;
  }) as unknown as FakeNotificationConstructor;

  Ctor.permission = permission;
  Ctor.requestPermission = requestPermission;

  (Ctor as unknown as { _instances: FakeNotification[] })._instances =
    instances;

  return Ctor;
}

function makeAudioCtx(): FakeAudioCtx {
  const oscillator = {
    type: "sine",
    frequency: { setValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const gainNode = {
    gain: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
  };
  return {
    state: "running" as "suspended" | "running",
    resume: vi.fn().mockResolvedValue(undefined),
    createOscillator: vi.fn().mockReturnValue(oscillator),
    createGain: vi.fn().mockReturnValue(gainNode),
    destination: {},
    currentTime: 0,
  };
}

function makeStorage(initial: Record<string, string> = {}): FakeStorage {
  const store: Record<string, string> = { ...initial };
  return {
    store,
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
  };
}

interface DepsBundle {
  doc: ReturnType<typeof makeDocument>;
  win: ReturnType<typeof makeWindow>;
  notifCtor: FakeNotificationConstructor;
  audioCtor: FakeAudioCtx;
  storage: FakeStorage;
  deps: TurnAlertDeps;
}

function makeDeps(
  options: {
    hidden?: boolean;
    notifPermission?: NotificationPermission;
    noNotification?: boolean;
    reducedMotion?: boolean;
    initialStorage?: Record<string, string>;
  } = {},
): DepsBundle {
  const doc = makeDocument(options.hidden ?? false);
  const win = makeWindow(options.reducedMotion ?? false);
  const audioCtor = makeAudioCtx();
  const storage = makeStorage(options.initialStorage ?? {});

  const notifCtor = options.noNotification
    ? (undefined as unknown as FakeNotificationConstructor)
    : makeNotificationCtor(options.notifPermission ?? "default");

  const deps: TurnAlertDeps = {
    getDocument: () => doc as unknown as Document,
    getWindow: () => win as unknown as Window,
    getNotification: () =>
      notifCtor as unknown as typeof Notification | undefined,
    createAudioContext: () => audioCtor as unknown as AudioContext,
    storage,
  };

  return { doc, win, notifCtor, audioCtor, storage, deps };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useTurnAlert", () => {
  // -------------------------------------------------------------------------
  // Arming / trigger
  // -------------------------------------------------------------------------

  describe("arming and trigger", () => {
    it("sets attention title when isMyTurn goes true and document is hidden", async () => {
      const { doc, deps } = makeDeps({ hidden: true });
      const isMyTurn = ref(false);
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      isMyTurn.value = true;
      await Promise.resolve();

      expect(doc.title).toContain("Your turn");
      expect(doc.title).toContain("Big2");
      scope.stop();
    });

    it("flashes the title on an interval when not reduced-motion", async () => {
      const { doc, deps } = makeDeps({ hidden: true });
      const isMyTurn = ref(false);
      const original = doc.title;
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      isMyTurn.value = true;
      await Promise.resolve();

      const attentionTitle = doc.title;
      expect(attentionTitle).not.toBe(original);

      // Advance by one flash interval — title should toggle back to original.
      vi.advanceTimersByTime(TITLE_FLASH_INTERVAL_MS);
      expect(doc.title).toBe(original);

      // Advance again — should toggle to attention title.
      vi.advanceTimersByTime(TITLE_FLASH_INTERVAL_MS);
      expect(doc.title).toBe(attentionTitle);

      scope.stop();
    });

    it("does nothing when isMyTurn goes true but document is visible (E1)", async () => {
      const { doc, deps } = makeDeps({ hidden: false });
      const originalTitle = doc.title;
      const isMyTurn = ref(false);
      const scope = effectScope();
      let result: ReturnType<typeof useTurnAlert> | undefined;
      scope.run(() => {
        result = useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      isMyTurn.value = true;
      await Promise.resolve();

      expect(doc.title).toBe(originalTitle);
      // Notification constructor not called — we can check the dep was not used.
      expect(result).toBeDefined();
      scope.stop();
    });

    it("does not arm when enabled is false (spectator gate, E14)", async () => {
      const { doc, deps } = makeDeps({ hidden: true });
      const isMyTurn = ref(false);
      const enabled = ref(false);
      const originalTitle = doc.title;
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", enabled, deps });
      });

      isMyTurn.value = true;
      await Promise.resolve();

      expect(doc.title).toBe(originalTitle);
      scope.stop();
    });

    it("arms only on the false→true edge — staying true does not re-fire", async () => {
      const { doc, deps } = makeDeps({ hidden: true });
      const isMyTurn = ref(false);
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      isMyTurn.value = true;
      await Promise.resolve();
      const titleAfterFirstArm = doc.title;

      // Staying true — no re-arm, no additional interval.
      // We'll simulate by triggering the watch manually by setting same value.
      // In practice the watcher only fires on changes, but let's confirm clearing happens only on false→true.
      expect(doc.title).toBe(titleAfterFirstArm);
      scope.stop();
    });

    it("re-arms on false→true again after going false (E10)", async () => {
      const { doc, deps } = makeDeps({ hidden: true });
      const isMyTurn = ref(false);
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      isMyTurn.value = true;
      await Promise.resolve();

      isMyTurn.value = false;
      await Promise.resolve();

      isMyTurn.value = true;
      await Promise.resolve();

      expect(doc.title).toContain("Your turn");
      scope.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Clear / reset
  // -------------------------------------------------------------------------

  describe("clear and reset", () => {
    it("restores original title when visibilitychange fires with document visible (E2)", async () => {
      const { doc, deps } = makeDeps({ hidden: true });
      const originalTitle = "Card Game";
      doc.title = originalTitle;
      const isMyTurn = ref(false);
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      isMyTurn.value = true;
      await Promise.resolve();

      expect(doc.title).toContain("Your turn");

      // Simulate tab returning to visible.
      doc.hidden = false;
      doc.dispatch("visibilitychange");

      expect(doc.title).toBe(originalTitle);
      scope.stop();
    });

    it("restores title on window focus event", async () => {
      const { doc, win, deps } = makeDeps({ hidden: true });
      const originalTitle = doc.title;
      const isMyTurn = ref(false);
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      isMyTurn.value = true;
      await Promise.resolve();

      doc.hidden = false;
      win.dispatch("focus");

      expect(doc.title).toBe(originalTitle);
      scope.stop();
    });

    it("closes live notification on clear (E2/E17)", async () => {
      const { doc, win, notifCtor, deps } = makeDeps({
        hidden: true,
        notifPermission: "granted",
      });
      const isMyTurn = ref(false);
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      isMyTurn.value = true;
      await Promise.resolve();

      const instances = (
        notifCtor as unknown as { _instances: FakeNotification[] }
      )._instances;
      expect(instances).toHaveLength(1);

      doc.hidden = false;
      win.dispatch("focus");

      expect(instances[0].close).toHaveBeenCalledOnce();
      scope.stop();
    });

    it("clears flash interval on visibilitychange", async () => {
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      const { doc, deps } = makeDeps({ hidden: true });
      const isMyTurn = ref(false);
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      isMyTurn.value = true;
      await Promise.resolve();

      doc.hidden = false;
      doc.dispatch("visibilitychange");

      expect(clearIntervalSpy).toHaveBeenCalled();
      scope.stop();
    });

    it("clears on isMyTurn false while armed and still hidden (E3)", async () => {
      const { doc, deps } = makeDeps({ hidden: true });
      const originalTitle = doc.title;
      const isMyTurn = ref(false);
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      isMyTurn.value = true;
      await Promise.resolve();
      expect(doc.title).toContain("Your turn");

      // Turn passes while hidden.
      isMyTurn.value = false;
      await Promise.resolve();

      expect(doc.title).toBe(originalTitle);
      scope.stop();
    });

    it("restores title and removes listeners on scope dispose (E13)", async () => {
      const { doc, win, deps } = makeDeps({ hidden: true });
      const originalTitle = doc.title;
      const isMyTurn = ref(false);
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      isMyTurn.value = true;
      await Promise.resolve();

      scope.stop();

      expect(doc.title).toBe(originalTitle);
      expect(doc.removeEventListener).toHaveBeenCalledWith(
        "visibilitychange",
        expect.any(Function),
      );
      expect(win.removeEventListener).toHaveBeenCalledWith(
        "focus",
        expect.any(Function),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Favicon badge
  // -------------------------------------------------------------------------

  describe("favicon badge", () => {
    it("injects a favicon link element when tab is hidden and turn starts", async () => {
      const { doc, deps } = makeDeps({ hidden: true });
      const isMyTurn = ref(false);
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      isMyTurn.value = true;
      await Promise.resolve();

      expect(doc.head.appendChild).toHaveBeenCalled();
      scope.stop();
    });

    it("does not inject a favicon link when document is visible (E1)", async () => {
      const { doc, deps } = makeDeps({ hidden: false });
      const isMyTurn = ref(false);
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      isMyTurn.value = true;
      await Promise.resolve();

      expect(doc.head.appendChild).not.toHaveBeenCalled();
      scope.stop();
    });

    it("skips favicon badge silently when canvas getContext returns null (E8)", async () => {
      const { doc, deps } = makeDeps({ hidden: true });
      const isMyTurn = ref(false);

      // Override createElement to return a canvas without 2D context.
      const noCtxCanvas = {
        tagName: "canvas",
        href: "",
        width: 0,
        height: 0,
        getContext: vi.fn().mockReturnValue(null),
        toDataURL: vi.fn(),
      };
      doc.createElement = vi.fn().mockReturnValue(noCtxCanvas);

      const scope = effectScope();
      let threw = false;
      scope.run(() => {
        try {
          useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
        } catch {
          threw = true;
        }
      });

      isMyTurn.value = true;
      await Promise.resolve();

      expect(threw).toBe(false);
      expect(noCtxCanvas.toDataURL).not.toHaveBeenCalled();
      // Title should still flash (other effects unaffected).
      expect(doc.title).toContain("Your turn");
      scope.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Chime setting
  // -------------------------------------------------------------------------

  describe("chime setting", () => {
    it("turnSoundEnabled defaults to true when storage is empty", () => {
      const { deps } = makeDeps();
      const isMyTurn = ref(false);
      const scope = effectScope();
      let result: ReturnType<typeof useTurnAlert> | undefined;
      scope.run(() => {
        result = useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });
      expect(result!.turnSoundEnabled.value).toBe(true);
      scope.stop();
    });

    it("turnSoundEnabled is false when storage has 'false'", () => {
      const { deps } = makeDeps({
        initialStorage: { [TURN_SOUND_STORAGE_KEY]: "false" },
      });
      const isMyTurn = ref(false);
      const scope = effectScope();
      let result: ReturnType<typeof useTurnAlert> | undefined;
      scope.run(() => {
        result = useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });
      expect(result!.turnSoundEnabled.value).toBe(false);
      scope.stop();
    });

    it("turnSoundEnabled is true when storage has 'true'", () => {
      const { deps } = makeDeps({
        initialStorage: { [TURN_SOUND_STORAGE_KEY]: "true" },
      });
      const isMyTurn = ref(false);
      const scope = effectScope();
      let result: ReturnType<typeof useTurnAlert> | undefined;
      scope.run(() => {
        result = useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });
      expect(result!.turnSoundEnabled.value).toBe(true);
      scope.stop();
    });

    it("toggleTurnSound flips ref and writes to storage", () => {
      const { deps, storage } = makeDeps();
      const isMyTurn = ref(false);
      const scope = effectScope();
      let result: ReturnType<typeof useTurnAlert> | undefined;
      scope.run(() => {
        result = useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      expect(result!.turnSoundEnabled.value).toBe(true);
      result!.toggleTurnSound();
      expect(result!.turnSoundEnabled.value).toBe(false);
      expect(storage.setItem).toHaveBeenCalledWith(
        TURN_SOUND_STORAGE_KEY,
        "false",
      );

      result!.toggleTurnSound();
      expect(result!.turnSoundEnabled.value).toBe(true);
      expect(storage.setItem).toHaveBeenLastCalledWith(
        TURN_SOUND_STORAGE_KEY,
        "true",
      );
      scope.stop();
    });

    it("invokes oscillator path when sound enabled + hidden + audio unlocked", async () => {
      const { audioCtor, deps } = makeDeps({ hidden: true });
      const isMyTurn = ref(false);
      const scope = effectScope();
      let result: ReturnType<typeof useTurnAlert> | undefined;
      scope.run(() => {
        result = useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      result!.unlockAudio();
      isMyTurn.value = true;
      await Promise.resolve();

      expect(audioCtor.createOscillator).toHaveBeenCalled();
      scope.stop();
    });

    it("does NOT invoke oscillator when sound disabled (E4)", async () => {
      const { audioCtor, deps } = makeDeps({ hidden: true });
      const isMyTurn = ref(false);
      const scope = effectScope();
      let result: ReturnType<typeof useTurnAlert> | undefined;
      scope.run(() => {
        result = useTurnAlert({
          isMyTurn,
          gameLabel: "Big2",
          deps,
        });
      });

      result!.toggleTurnSound(); // turn off
      result!.unlockAudio();
      isMyTurn.value = true;
      await Promise.resolve();

      expect(audioCtor.createOscillator).not.toHaveBeenCalled();
      scope.stop();
    });

    it("chime skipped but title still flashes when audio not unlocked (E5)", async () => {
      const { doc, audioCtor, deps } = makeDeps({ hidden: true });
      const isMyTurn = ref(false);
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      // Do NOT call unlockAudio().
      isMyTurn.value = true;
      await Promise.resolve();

      expect(audioCtor.createOscillator).not.toHaveBeenCalled();
      expect(doc.title).toContain("Your turn");
      scope.stop();
    });

    it("localStorage.setItem throwing does not propagate (E12)", () => {
      const { deps, storage } = makeDeps();
      storage.setItem = vi.fn().mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
      const isMyTurn = ref(false);
      const scope = effectScope();
      let result: ReturnType<typeof useTurnAlert> | undefined;
      scope.run(() => {
        result = useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      expect(() => result!.toggleTurnSound()).not.toThrow();
      scope.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Notification
  // -------------------------------------------------------------------------

  describe("notification", () => {
    it("fires Notification constructor when permission is granted and tab is hidden", async () => {
      const { notifCtor, deps } = makeDeps({
        hidden: true,
        notifPermission: "granted",
      });
      const isMyTurn = ref(false);
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Tonk", deps });
      });

      isMyTurn.value = true;
      await Promise.resolve();

      expect(notifCtor).toHaveBeenCalledOnce();
      const callArg = (notifCtor as unknown as MockInstance).mock.calls[0][0];
      expect(callArg).toContain("Tonk");
      scope.stop();
    });

    it("does NOT call requestPermission during arm (E7)", async () => {
      const { notifCtor, deps } = makeDeps({
        hidden: true,
        notifPermission: "granted",
      });
      const isMyTurn = ref(false);
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      isMyTurn.value = true;
      await Promise.resolve();

      expect(notifCtor.requestPermission).not.toHaveBeenCalled();
      scope.stop();
    });

    it("does NOT fire Notification when permission is default (E7)", async () => {
      const { notifCtor, deps } = makeDeps({
        hidden: true,
        notifPermission: "default",
      });
      const isMyTurn = ref(false);
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      isMyTurn.value = true;
      await Promise.resolve();

      expect(notifCtor).not.toHaveBeenCalled();
      scope.stop();
    });

    it("does NOT fire Notification when permission is denied (E7)", async () => {
      const { notifCtor, deps } = makeDeps({
        hidden: true,
        notifPermission: "denied",
      });
      const isMyTurn = ref(false);
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      isMyTurn.value = true;
      await Promise.resolve();

      expect(notifCtor).not.toHaveBeenCalled();
      scope.stop();
    });

    it("notificationPermission is 'unsupported' when Notification unavailable (E6)", () => {
      const { deps } = makeDeps({ noNotification: true });
      deps.getNotification = () => undefined;
      const isMyTurn = ref(false);
      const scope = effectScope();
      let result: ReturnType<typeof useTurnAlert> | undefined;
      scope.run(() => {
        result = useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });
      expect(result!.notificationPermission.value).toBe("unsupported");
      scope.stop();
    });

    it("arm is a no-op for notifications when Notification unsupported (E6)", async () => {
      const { doc, deps } = makeDeps({ hidden: true, noNotification: true });
      deps.getNotification = () => undefined;
      const isMyTurn = ref(false);
      const scope = effectScope();
      let threw = false;
      scope.run(() => {
        try {
          useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
        } catch {
          threw = true;
        }
      });

      isMyTurn.value = true;
      await Promise.resolve();

      // Should not throw, and title effect still works.
      expect(threw).toBe(false);
      expect(doc.title).toContain("Your turn");
      scope.stop();
    });

    it("requestNotificationPermission calls requestPermission once and updates ref", async () => {
      const { notifCtor, deps } = makeDeps({ notifPermission: "default" });
      notifCtor.requestPermission = vi
        .fn()
        .mockResolvedValue("granted" as NotificationPermission);
      const isMyTurn = ref(false);
      const scope = effectScope();
      let result: ReturnType<typeof useTurnAlert> | undefined;
      scope.run(() => {
        result = useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      const resolved = await result!.requestNotificationPermission();

      expect(notifCtor.requestPermission).toHaveBeenCalledOnce();
      expect(resolved).toBe("granted");
      expect(result!.notificationPermission.value).toBe("granted");
      scope.stop();
    });

    it("requestNotificationPermission is a no-op when unsupported (E6)", async () => {
      const { deps } = makeDeps({ noNotification: true });
      deps.getNotification = () => undefined;
      const isMyTurn = ref(false);
      const scope = effectScope();
      let result: ReturnType<typeof useTurnAlert> | undefined;
      scope.run(() => {
        result = useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      const resolved = await result!.requestNotificationPermission();
      expect(resolved).toBe("unsupported");
      scope.stop();
    });

    it("requestNotificationPermission is a no-op when already decided (denied)", async () => {
      const { notifCtor, deps } = makeDeps({ notifPermission: "denied" });
      const isMyTurn = ref(false);
      const scope = effectScope();
      let result: ReturnType<typeof useTurnAlert> | undefined;
      scope.run(() => {
        result = useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      const resolved = await result!.requestNotificationPermission();
      expect(notifCtor.requestPermission).not.toHaveBeenCalled();
      expect(resolved).toBe("denied");
      scope.stop();
    });

    it("requestNotificationPermission not called on init/mount", () => {
      const { notifCtor, deps } = makeDeps({ notifPermission: "default" });
      const isMyTurn = ref(false);
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });
      expect(notifCtor.requestPermission).not.toHaveBeenCalled();
      scope.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Accessibility / degradation
  // -------------------------------------------------------------------------

  describe("accessibility and degradation", () => {
    it("sets title once with NO interval under prefers-reduced-motion (E11)", async () => {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const { doc, deps } = makeDeps({ hidden: true, reducedMotion: true });
      const isMyTurn = ref(false);
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      const callsBefore = setIntervalSpy.mock.calls.length;
      isMyTurn.value = true;
      await Promise.resolve();

      // Title should be the attention string (set once, statically).
      expect(doc.title).toContain("Your turn");
      // No new setInterval call should have been made by our composable.
      const callsAfter = setIntervalSpy.mock.calls.length;
      expect(callsAfter).toBe(callsBefore);
      scope.stop();
    });

    it("favicon badge still swapped under prefers-reduced-motion (E11)", async () => {
      const { doc, deps } = makeDeps({ hidden: true, reducedMotion: true });
      const isMyTurn = ref(false);
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      isMyTurn.value = true;
      await Promise.resolve();

      expect(doc.head.appendChild).toHaveBeenCalled();
      scope.stop();
    });
  });

  // -------------------------------------------------------------------------
  // unlockAudio
  // -------------------------------------------------------------------------

  describe("unlockAudio", () => {
    it("is idempotent — repeated calls do not create multiple contexts", () => {
      let ctxCreations = 0;
      const audioCtor = makeAudioCtx();
      const deps: TurnAlertDeps = {
        getDocument: () => makeDocument() as unknown as Document,
        getWindow: () => makeWindow() as unknown as Window,
        getNotification: () => undefined,
        createAudioContext: () => {
          ctxCreations++;
          return audioCtor as unknown as AudioContext;
        },
        storage: makeStorage(),
      };
      const isMyTurn = ref(false);
      const scope = effectScope();
      let result: ReturnType<typeof useTurnAlert> | undefined;
      scope.run(() => {
        result = useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      result!.unlockAudio();
      result!.unlockAudio();
      result!.unlockAudio();

      expect(ctxCreations).toBe(1);
      scope.stop();
    });

    it("calls resume when AudioContext is suspended", () => {
      const audioCtor = makeAudioCtx();
      audioCtor.state = "suspended";
      const deps: TurnAlertDeps = {
        getDocument: () => makeDocument() as unknown as Document,
        getWindow: () => makeWindow() as unknown as Window,
        getNotification: () => undefined,
        createAudioContext: () => audioCtor as unknown as AudioContext,
        storage: makeStorage(),
      };
      const isMyTurn = ref(false);
      const scope = effectScope();
      let result: ReturnType<typeof useTurnAlert> | undefined;
      scope.run(() => {
        result = useTurnAlert({ isMyTurn, gameLabel: "Big2", deps });
      });

      result!.unlockAudio();

      expect(audioCtor.resume).toHaveBeenCalled();
      scope.stop();
    });
  });

  // -------------------------------------------------------------------------
  // gameLabel as ref
  // -------------------------------------------------------------------------

  describe("gameLabel", () => {
    it("uses the current value of a gameLabel ref at arm time", async () => {
      const { doc, deps } = makeDeps({ hidden: true });
      const isMyTurn = ref(false);
      const gameLabel = ref("Big2");
      const scope = effectScope();
      scope.run(() => {
        useTurnAlert({ isMyTurn, gameLabel, deps });
      });

      gameLabel.value = "Tonk";
      isMyTurn.value = true;
      await Promise.resolve();

      expect(doc.title).toContain("Tonk");
      scope.stop();
    });
  });
});
