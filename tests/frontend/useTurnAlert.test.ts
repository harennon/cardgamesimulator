/**
 * Tests for useTurnAlert composable and its pure helpers.
 *
 * Tests run in vitest's node environment (no jsdom).  Browser globals
 * (document, window, Notification, AudioContext, localStorage, matchMedia)
 * are stubbed inline per test using vi.stubGlobal / Object.defineProperty,
 * following the patterns in gameBoardMobile.test.ts and useTurnCountdown.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, effectScope, nextTick } from "vue";
import {
  buildAlertTitle,
  buildFaviconDataUri,
  useTurnAlert,
} from "../../src/frontend/composables/useTurnAlert.js";
import type { UseTurnAlertOptions } from "../../src/frontend/composables/useTurnAlert.js";

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe("buildAlertTitle", () => {
  it("returns big2 alert title", () => {
    expect(buildAlertTitle("big2")).toBe("● Your turn — Big2");
  });

  it("returns tonk alert title", () => {
    expect(buildAlertTitle("tonk")).toBe("● Your turn — Tonk");
  });
});

describe("buildFaviconDataUri", () => {
  it("returns a data:image/svg+xml URI for normal favicon", () => {
    const uri = buildFaviconDataUri(false);
    expect(uri.startsWith("data:image/svg+xml,")).toBe(true);
  });

  it("returns a data:image/svg+xml URI for badged favicon", () => {
    const uri = buildFaviconDataUri(true);
    expect(uri.startsWith("data:image/svg+xml,")).toBe(true);
  });

  it("normal and badged URIs differ", () => {
    expect(buildFaviconDataUri(false)).not.toBe(buildFaviconDataUri(true));
  });

  it("badged URI contains the extra dot circle element", () => {
    const normal = decodeURIComponent(
      buildFaviconDataUri(false).replace("data:image/svg+xml,", ""),
    );
    const badged = decodeURIComponent(
      buildFaviconDataUri(true).replace("data:image/svg+xml,", ""),
    );
    expect(normal).not.toContain('cx="20"');
    expect(badged).toContain('cx="20"');
  });
});

// ---------------------------------------------------------------------------
// Helpers for composable tests
// ---------------------------------------------------------------------------

/** Minimal document stub with a controllable head and title. */
function makeDocumentStub(opts: { hidden?: boolean } = {}) {
  // Simulate four links: apple-touch-icon + three rel="icon"
  function makeLink(rel: string, href: string, sizes?: string) {
    return {
      rel,
      href,
      type: "",
      sizes: sizes ?? "",
      tagName: "LINK",
    } as unknown as HTMLLinkElement;
  }

  const atiLink = makeLink("apple-touch-icon", "/apple-touch-icon.png");
  const icon32 = makeLink("icon", "/favicon-32x32.png", "32x32");
  const icon16 = makeLink("icon", "/favicon-16x16.png", "16x16");
  const icoLink = makeLink("icon", "/favicon.ico");

  const children: HTMLLinkElement[] = [atiLink, icon32, icon16, icoLink];

  const head = {
    querySelectorAll: vi.fn((selector: string) => {
      if (selector === 'link[rel~="icon"]') {
        return children.filter((c) => c.rel === "icon");
      }
      return [];
    }),
    removeChild: vi.fn((node: HTMLLinkElement) => {
      const idx = children.indexOf(node);
      if (idx !== -1) children.splice(idx, 1);
    }),
    appendChild: vi.fn((node: HTMLLinkElement) => {
      children.push(node);
    }),
    // Helper for tests to inspect state
    _children: children,
    _atiLink: atiLink,
  };

  return {
    title: "My Game",
    hidden: opts.hidden ?? false,
    head,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    createElement: vi.fn((tag: string) => {
      const el = { tagName: tag.toUpperCase(), rel: "", type: "", href: "" };
      return el as unknown as HTMLLinkElement;
    }),
  };
}

function makeWindowStub(reducedMotion = false) {
  return {
    focus: vi.fn(),
    matchMedia: vi.fn((_query: string) => ({
      matches: reducedMotion,
    })),
  };
}

function makeLocalStorageStub() {
  const store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, val: string) => {
      store[key] = val;
    }),
    _store: store,
  };
}

function makeNotificationStub(permission: NotificationPermission = "default") {
  const instances: { title: string; opts: NotificationOptions }[] = [];
  const Ctor = vi.fn(function (
    this: { onclick: (() => void) | null; close: ReturnType<typeof vi.fn> },
    title: string,
    opts: NotificationOptions,
  ) {
    instances.push({ title, opts });
    this.onclick = null;
    this.close = vi.fn();
  }) as unknown as typeof Notification & {
    _instances: typeof instances;
    permission: NotificationPermission;
    requestPermission: ReturnType<typeof vi.fn>;
  };
  (Ctor as { permission: NotificationPermission }).permission = permission;
  (Ctor as { requestPermission: ReturnType<typeof vi.fn> }).requestPermission =
    vi.fn().mockResolvedValue("granted");
  (Ctor as { _instances: typeof instances })._instances = instances;
  return Ctor;
}

/** Build default opts for useTurnAlert with all signals false / not-my-turn. */
function makeOpts(
  overrides: Partial<{
    isPlayer: boolean;
    isInProgress: boolean;
    isMyTurn: boolean;
    gameType: "big2" | "tonk";
  }> = {},
): UseTurnAlertOptions {
  return {
    isPlayer: ref(overrides.isPlayer ?? true),
    isInProgress: ref(overrides.isInProgress ?? true),
    isMyTurn: ref(overrides.isMyTurn ?? false),
    gameType: ref(overrides.gameType ?? "big2"),
  };
}

// ---------------------------------------------------------------------------
// Composable tests — arming / trigger logic
// ---------------------------------------------------------------------------

describe("useTurnAlert — trigger logic", () => {
  let docStub: ReturnType<typeof makeDocumentStub>;
  let winStub: ReturnType<typeof makeWindowStub>;
  let lsStub: ReturnType<typeof makeLocalStorageStub>;

  beforeEach(() => {
    vi.useFakeTimers();
    docStub = makeDocumentStub({ hidden: true });
    winStub = makeWindowStub(false);
    lsStub = makeLocalStorageStub();
    vi.stubGlobal("document", docStub);
    vi.stubGlobal("window", winStub);
    vi.stubGlobal("localStorage", lsStub);
    vi.stubGlobal("Notification", makeNotificationStub("default"));
    vi.stubGlobal("AudioContext", undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("arms alert when isPlayer + isInProgress + isMyTurn + hidden all true", async () => {
    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();

    // Title should become the alert string
    expect(docStub.title).toBe("● Your turn — Big2");
    scope.stop();
  });

  it("does not arm when tab is focused (document.hidden = false)", async () => {
    const focusedDoc = makeDocumentStub({ hidden: false });
    vi.stubGlobal("document", focusedDoc);

    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();

    expect(focusedDoc.title).toBe("My Game"); // unchanged
    scope.stop();
  });

  it("does not arm for spectator (isPlayer = false)", async () => {
    const opts = makeOpts({ isPlayer: false, isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();

    expect(docStub.title).toBe("My Game");
    scope.stop();
  });

  it("does not arm at game over (isInProgress = false)", async () => {
    const opts = makeOpts({ isInProgress: false, isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();

    expect(docStub.title).toBe("My Game");
    scope.stop();
  });

  it("arms when visibility flips to hidden while isMyTurn is already true", async () => {
    const visibleDoc = makeDocumentStub({ hidden: false });
    vi.stubGlobal("document", visibleDoc);

    const opts = makeOpts({ isMyTurn: true });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    // Simulate tab going hidden: update the stub and fire the listener
    visibleDoc.hidden = true;
    const visCall = visibleDoc.addEventListener.mock.calls.find(
      (c: [string, unknown]) => c[0] === "visibilitychange",
    );
    expect(visCall).toBeDefined();
    const visHandler = visCall![1] as () => void;
    visHandler();
    await nextTick();

    expect(visibleDoc.title).toBe("● Your turn — Big2");
    scope.stop();
  });

  it("clears alert when isMyTurn goes false while still hidden", async () => {
    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    // Arm
    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();
    expect(docStub.title).toBe("● Your turn — Big2");

    // Clear via turn passing
    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = false;
    await nextTick();
    expect(docStub.title).toBe("My Game");
    scope.stop();
  });

  it("clears alert when tab becomes visible", async () => {
    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    // Arm
    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();
    expect(docStub.title).toBe("● Your turn — Big2");

    // Simulate tab focus
    docStub.hidden = false;
    const visCall = docStub.addEventListener.mock.calls.find(
      (c: [string, unknown]) => c[0] === "visibilitychange",
    );
    const visHandler = visCall![1] as () => void;
    visHandler();
    await nextTick();

    expect(docStub.title).toBe("My Game");
    scope.stop();
  });

  it("disposes cleanly and restores title", async () => {
    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();
    expect(docStub.title).toBe("● Your turn — Big2");

    scope.stop();
    expect(docStub.title).toBe("My Game");
  });
});

// ---------------------------------------------------------------------------
// Favicon tests
// ---------------------------------------------------------------------------

describe("useTurnAlert — favicon management", () => {
  let docStub: ReturnType<typeof makeDocumentStub>;
  let winStub: ReturnType<typeof makeWindowStub>;

  beforeEach(() => {
    vi.useFakeTimers();
    docStub = makeDocumentStub({ hidden: true });
    winStub = makeWindowStub(false);
    vi.stubGlobal("document", docStub);
    vi.stubGlobal("window", winStub);
    vi.stubGlobal("localStorage", makeLocalStorageStub());
    vi.stubGlobal("Notification", makeNotificationStub("default"));
    vi.stubGlobal("AudioContext", undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("removes rel=icon links from head and injects one managed SVG on arm", async () => {
    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();

    // Three rel=icon links should have been removed
    expect(docStub.head.removeChild).toHaveBeenCalledTimes(3);
    // One managed SVG link appended
    expect(docStub.head.appendChild).toHaveBeenCalledTimes(1);
    const appended = (docStub.head.appendChild as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { rel: string; type: string; href: string };
    expect(appended.rel).toBe("icon");
    expect(appended.type).toBe("image/svg+xml");
    expect(appended.href).toBe(buildFaviconDataUri(true));

    scope.stop();
  });

  it("leaves apple-touch-icon untouched on arm", async () => {
    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();

    // querySelectorAll was called with link[rel~="icon"] — apple-touch-icon
    // won't be returned by that selector, so it should not appear in removeChild
    const removed = (
      docStub.head.removeChild as ReturnType<typeof vi.fn>
    ).mock.calls.map((c: [HTMLLinkElement]) => c[0]);
    expect(
      removed.every((n: HTMLLinkElement) => n.rel !== "apple-touch-icon"),
    ).toBe(true);

    scope.stop();
  });

  it("restores original rel=icon links on clear", async () => {
    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();

    // Clear
    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = false;
    await nextTick();

    // appendChild should have been called 4 times: 1 managed + 3 restored
    expect(docStub.head.appendChild).toHaveBeenCalledTimes(4);

    scope.stop();
  });

  it("arm is idempotent: two rising edges do not double-detach or inject a second link", async () => {
    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    // First arm
    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();

    const removeCount1 = (docStub.head.removeChild as ReturnType<typeof vi.fn>)
      .mock.calls.length;
    const appendCount1 = (docStub.head.appendChild as ReturnType<typeof vi.fn>)
      .mock.calls.length;

    // Second rising edge (e.g. visibility flips while still armed)
    // Simulate by re-triggering visibility: tab hides again
    const visCall = docStub.addEventListener.mock.calls.find(
      (c: [string, unknown]) => c[0] === "visibilitychange",
    );
    const visHandler = visCall![1] as () => void;
    docStub.hidden = true;
    visHandler();
    await nextTick();

    expect(docStub.head.removeChild).toHaveBeenCalledTimes(removeCount1);
    expect(docStub.head.appendChild).toHaveBeenCalledTimes(appendCount1);

    scope.stop();
  });

  it("handles no rel=icon links gracefully (still injects managed link)", async () => {
    // Override querySelectorAll to return nothing
    docStub.head.querySelectorAll = vi.fn(() => []);

    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();

    expect(docStub.head.removeChild).not.toHaveBeenCalled();
    expect(docStub.head.appendChild).toHaveBeenCalledTimes(1);

    scope.stop();
  });

  it("restores title and favicon on scope disposal", async () => {
    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();

    scope.stop();

    expect(docStub.title).toBe("My Game");
    // After stop, removeChild was called once (for managed link during clear)
    // and appendChild was called 4 times total (1 managed + 3 restored)
    expect(docStub.head.appendChild).toHaveBeenCalledTimes(4);
  });

  it("removes visibilitychange listener on scope disposal", () => {
    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));
    scope.stop();
    expect(docStub.removeEventListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
  });
});

// ---------------------------------------------------------------------------
// Reduced motion tests
// ---------------------------------------------------------------------------

describe("useTurnAlert — reduced motion", () => {
  let docStub: ReturnType<typeof makeDocumentStub>;

  beforeEach(() => {
    vi.useFakeTimers();
    docStub = makeDocumentStub({ hidden: true });
    vi.stubGlobal("document", docStub);
    vi.stubGlobal("window", makeWindowStub(true)); // reduced motion = true
    vi.stubGlobal("localStorage", makeLocalStorageStub());
    vi.stubGlobal("Notification", makeNotificationStub("default"));
    vi.stubGlobal("AudioContext", undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sets title once (no setInterval) when prefers-reduced-motion matches", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();

    expect(docStub.title).toBe("● Your turn — Big2");
    // setInterval should NOT have been called for the flash timer
    expect(setIntervalSpy).not.toHaveBeenCalled();

    scope.stop();
  });
});

// ---------------------------------------------------------------------------
// Chime / sound tests
// ---------------------------------------------------------------------------

describe("useTurnAlert — chime", () => {
  let docStub: ReturnType<typeof makeDocumentStub>;
  let lsStub: ReturnType<typeof makeLocalStorageStub>;

  beforeEach(() => {
    vi.useFakeTimers();
    docStub = makeDocumentStub({ hidden: true });
    lsStub = makeLocalStorageStub();
    vi.stubGlobal("document", docStub);
    vi.stubGlobal("window", makeWindowStub(false));
    vi.stubGlobal("localStorage", lsStub);
    vi.stubGlobal("Notification", makeNotificationStub("default"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not attempt chime before unlockAudio is called", async () => {
    const oscStart = vi.fn();
    const ctxInstance0 = {
      state: "suspended",
      currentTime: 0,
      destination: {},
      resume: vi.fn().mockResolvedValue(undefined),
      createOscillator: vi.fn(() => ({
        connect: vi.fn(),
        type: "",
        frequency: { value: 0 },
        start: oscStart,
        stop: vi.fn(),
      })),
      createGain: vi.fn(() => ({
        connect: vi.fn(),
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
      })),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const AudioContextStub = vi.fn(function () {
      return ctxInstance0;
    });
    vi.stubGlobal("AudioContext", AudioContextStub);
    // Also put it on window since unlockAudio reads window.AudioContext
    vi.stubGlobal("window", {
      ...makeWindowStub(false),
      AudioContext: AudioContextStub,
    });

    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();

    // No oscillator started because audioCtx was never created
    expect(oscStart).not.toHaveBeenCalled();
    scope.stop();
  });

  it("plays chime when soundEnabled + audio unlocked", async () => {
    const oscStart = vi.fn();
    const resumeMock = vi.fn().mockResolvedValue(undefined);
    const ctxInstance = {
      state: "running",
      currentTime: 0,
      destination: {},
      resume: resumeMock,
      createOscillator: vi.fn(() => ({
        connect: vi.fn(),
        type: "",
        frequency: { value: 0 },
        start: oscStart,
        stop: vi.fn(),
      })),
      createGain: vi.fn(() => ({
        connect: vi.fn(),
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
      })),
      close: vi.fn().mockResolvedValue(undefined),
    };
    // Must use function keyword so `new AC()` works as a constructor
    const AudioContextStub = vi.fn(function () {
      return ctxInstance;
    });
    vi.stubGlobal("AudioContext", AudioContextStub);
    vi.stubGlobal("window", {
      ...makeWindowStub(false),
      AudioContext: AudioContextStub,
    });

    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    let result: ReturnType<typeof useTurnAlert> | undefined;
    scope.run(() => {
      result = useTurnAlert(opts);
    });

    result!.unlockAudio();

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();

    // Two beeps should have been started
    expect(oscStart).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it("does not play chime when soundEnabled is false", async () => {
    const oscStart = vi.fn();
    const ctxInstance2 = {
      state: "running",
      currentTime: 0,
      destination: {},
      resume: vi.fn().mockResolvedValue(undefined),
      createOscillator: vi.fn(() => ({
        connect: vi.fn(),
        type: "",
        frequency: { value: 0 },
        start: oscStart,
        stop: vi.fn(),
      })),
      createGain: vi.fn(() => ({
        connect: vi.fn(),
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
      })),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const AudioContextStub = vi.fn(function () {
      return ctxInstance2;
    });
    vi.stubGlobal("AudioContext", AudioContextStub);
    vi.stubGlobal("window", {
      ...makeWindowStub(false),
      AudioContext: AudioContextStub,
    });

    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    let result: ReturnType<typeof useTurnAlert> | undefined;
    scope.run(() => {
      result = useTurnAlert(opts);
    });

    result!.unlockAudio();
    result!.setSoundEnabled(false);

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();

    expect(oscStart).not.toHaveBeenCalled();
    // Title/favicon still applies
    expect(docStub.title).toBe("● Your turn — Big2");
    scope.stop();
  });

  it("setSoundEnabled persists to localStorage", async () => {
    vi.stubGlobal("window", makeWindowStub(false));
    vi.stubGlobal("AudioContext", undefined);

    const opts = makeOpts();
    const scope = effectScope();
    let result: ReturnType<typeof useTurnAlert> | undefined;
    scope.run(() => {
      result = useTurnAlert(opts);
    });

    result!.setSoundEnabled(false);
    expect(lsStub.setItem).toHaveBeenCalledWith("turnAlert.sound", "off");

    result!.setSoundEnabled(true);
    expect(lsStub.setItem).toHaveBeenCalledWith("turnAlert.sound", "on");

    scope.stop();
  });

  it("new composable instance hydrates soundEnabled from localStorage", async () => {
    lsStub._store["turnAlert.sound"] = "off";
    vi.stubGlobal("window", makeWindowStub(false));
    vi.stubGlobal("AudioContext", undefined);

    const opts = makeOpts();
    const scope = effectScope();
    let result: ReturnType<typeof useTurnAlert> | undefined;
    scope.run(() => {
      result = useTurnAlert(opts);
    });

    expect(result!.soundEnabled.value).toBe(false);
    scope.stop();
  });

  it("absent localStorage key defaults soundEnabled to true", async () => {
    vi.stubGlobal("window", makeWindowStub(false));
    vi.stubGlobal("AudioContext", undefined);

    const opts = makeOpts();
    const scope = effectScope();
    let result: ReturnType<typeof useTurnAlert> | undefined;
    scope.run(() => {
      result = useTurnAlert(opts);
    });

    expect(result!.soundEnabled.value).toBe(true);
    scope.stop();
  });
});

// ---------------------------------------------------------------------------
// Notification tests
// ---------------------------------------------------------------------------

describe("useTurnAlert — notifications", () => {
  let docStub: ReturnType<typeof makeDocumentStub>;

  beforeEach(() => {
    vi.useFakeTimers();
    docStub = makeDocumentStub({ hidden: true });
    vi.stubGlobal("document", docStub);
    vi.stubGlobal("window", makeWindowStub(false));
    vi.stubGlobal("localStorage", makeLocalStorageStub());
    vi.stubGlobal("AudioContext", undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fires Notification when permission is granted", async () => {
    const NotifStub = makeNotificationStub("granted");
    vi.stubGlobal("Notification", NotifStub);

    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();

    expect(NotifStub).toHaveBeenCalledTimes(1);
    expect(NotifStub._instances[0].title).toBe("Your turn — Big2");
    expect(NotifStub._instances[0].opts.tag).toBe("turn-alert");
    scope.stop();
  });

  it("does not fire Notification when permission is default", async () => {
    const NotifStub = makeNotificationStub("default");
    vi.stubGlobal("Notification", NotifStub);

    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();

    expect(NotifStub).not.toHaveBeenCalled();
    scope.stop();
  });

  it("does not fire Notification when permission is denied", async () => {
    const NotifStub = makeNotificationStub("denied");
    vi.stubGlobal("Notification", NotifStub);

    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();

    expect(NotifStub).not.toHaveBeenCalled();
    scope.stop();
  });

  it("mounting and arming never calls requestPermission", async () => {
    const NotifStub = makeNotificationStub("default");
    vi.stubGlobal("Notification", NotifStub);

    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();

    expect(NotifStub.requestPermission).not.toHaveBeenCalled();
    scope.stop();
  });

  it("requestNotificationPermission calls requestPermission exactly once and updates notifState", async () => {
    const NotifStub = makeNotificationStub("default");
    vi.stubGlobal("Notification", NotifStub);

    const opts = makeOpts();
    const scope = effectScope();
    let result: ReturnType<typeof useTurnAlert> | undefined;
    scope.run(() => {
      result = useTurnAlert(opts);
    });

    expect(result!.notifState.value).toBe("default");
    await result!.requestNotificationPermission();

    expect(NotifStub.requestPermission).toHaveBeenCalledTimes(1);
    expect(result!.notifState.value).toBe("granted");
    scope.stop();
  });

  it("requestNotificationPermission is a no-op when unsupported", async () => {
    vi.stubGlobal("Notification", undefined);

    const opts = makeOpts();
    const scope = effectScope();
    let result: ReturnType<typeof useTurnAlert> | undefined;
    scope.run(() => {
      result = useTurnAlert(opts);
    });

    expect(result!.notifState.value).toBe("unsupported");
    await expect(
      result!.requestNotificationPermission(),
    ).resolves.toBeUndefined();
    scope.stop();
  });

  it("pending notification is closed on clear", async () => {
    const NotifStub = makeNotificationStub("granted");
    vi.stubGlobal("Notification", NotifStub);

    const opts = makeOpts({ isMyTurn: false });
    const scope = effectScope();
    scope.run(() => useTurnAlert(opts));

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = true;
    await nextTick();

    const instance = NotifStub._instances[0];
    const notifObj = (NotifStub as ReturnType<typeof vi.fn>).mock
      .instances[0] as { close: ReturnType<typeof vi.fn> };

    (opts.isMyTurn as ReturnType<typeof ref<boolean>>).value = false;
    await nextTick();

    expect(notifObj.close).toHaveBeenCalled();
    void instance;
    scope.stop();
  });
});

// ---------------------------------------------------------------------------
// TurnAlertMenu component prop-driven rows
// (We test the logic expressed by the template via extracted functions,
// following the project pattern of not mounting components in node env.)
// ---------------------------------------------------------------------------

describe("TurnAlertMenu — prop-driven row visibility logic", () => {
  /** Mirrors v-if="notifState !== 'unsupported'" for the desktop-alerts row */
  function desktopRowVisible(
    notifState: "unsupported" | "default" | "granted" | "denied",
  ): boolean {
    return notifState !== "unsupported";
  }

  /** Mirrors v-if="notifState === 'default'" for the Enable button */
  function enableButtonVisible(
    notifState: "unsupported" | "default" | "granted" | "denied",
  ): boolean {
    return notifState === "default";
  }

  it("hides desktop-alerts row when notifState is unsupported", () => {
    expect(desktopRowVisible("unsupported")).toBe(false);
  });

  it("shows desktop-alerts row for default/granted/denied", () => {
    expect(desktopRowVisible("default")).toBe(true);
    expect(desktopRowVisible("granted")).toBe(true);
    expect(desktopRowVisible("denied")).toBe(true);
  });

  it("shows Enable button only when notifState is default", () => {
    expect(enableButtonVisible("default")).toBe(true);
    expect(enableButtonVisible("granted")).toBe(false);
    expect(enableButtonVisible("denied")).toBe(false);
    expect(enableButtonVisible("unsupported")).toBe(false);
  });
});
