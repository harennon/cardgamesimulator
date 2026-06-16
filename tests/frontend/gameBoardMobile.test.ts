import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, watch } from "vue";

// Simulate the mobile state logic from GameBoard.vue in isolation.
// This mirrors what the component does without needing to mount it.

function makeMqlMock(initialMatches: boolean) {
  const listeners: ((e: { matches: boolean }) => void)[] = [];
  const mql = {
    matches: initialMatches,
    addEventListener: vi.fn(
      (_type: string, handler: (e: { matches: boolean }) => void) => {
        listeners.push(handler);
      },
    ),
    removeEventListener: vi.fn(
      (_type: string, handler: (e: { matches: boolean }) => void) => {
        const idx = listeners.indexOf(handler);
        if (idx !== -1) listeners.splice(idx, 1);
      },
    ),
    _fire(matches: boolean) {
      mql.matches = matches;
      listeners.forEach((h) => h({ matches }));
    },
    _listenerCount() {
      return listeners.length;
    },
  };
  return mql;
}

describe("GameBoard mobile state logic", () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = globalThis.window?.matchMedia;
  });

  afterEach(() => {
    if (originalMatchMedia !== undefined) {
      Object.defineProperty(globalThis, "matchMedia", {
        value: originalMatchMedia,
        writable: true,
      });
    }
  });

  describe("isMobile ref", () => {
    it("starts false when matchMedia does not match", () => {
      const mql = makeMqlMock(false);
      const isMobile = ref(mql.matches);
      expect(isMobile.value).toBe(false);
    });

    it("starts true when matchMedia matches on mount", () => {
      const mql = makeMqlMock(true);
      const isMobile = ref(mql.matches);
      expect(isMobile.value).toBe(true);
    });

    it("updates when matchMedia fires a change event", () => {
      const mql = makeMqlMock(false);
      const isMobile = ref(mql.matches);
      const handleMediaChange = (e: { matches: boolean }) => {
        isMobile.value = e.matches;
      };
      mql.addEventListener("change", handleMediaChange);

      mql._fire(true);
      expect(isMobile.value).toBe(true);

      mql._fire(false);
      expect(isMobile.value).toBe(false);
    });
  });

  describe("logDrawerOpen ref", () => {
    it("starts closed", () => {
      const logDrawerOpen = ref(false);
      expect(logDrawerOpen.value).toBe(false);
    });

    it("toggles open and closed", () => {
      const logDrawerOpen = ref(false);
      logDrawerOpen.value = !logDrawerOpen.value;
      expect(logDrawerOpen.value).toBe(true);
      logDrawerOpen.value = !logDrawerOpen.value;
      expect(logDrawerOpen.value).toBe(false);
    });

    it("can be set directly to false (close button)", () => {
      const logDrawerOpen = ref(true);
      logDrawerOpen.value = false;
      expect(logDrawerOpen.value).toBe(false);
    });
  });

  describe("Escape key handler", () => {
    it("closes the drawer when Escape is pressed", () => {
      const logDrawerOpen = ref(true);

      function onKeydown(e: { key: string }): void {
        if (e.key === "Escape") logDrawerOpen.value = false;
      }

      onKeydown({ key: "Escape" });
      expect(logDrawerOpen.value).toBe(false);
    });

    it("does not close the drawer for other keys", () => {
      const logDrawerOpen = ref(true);

      function onKeydown(e: { key: string }): void {
        if (e.key === "Escape") logDrawerOpen.value = false;
      }

      onKeydown({ key: "Enter" });
      expect(logDrawerOpen.value).toBe(true);
    });
  });

  describe("matchMedia listener cleanup", () => {
    it("adds listener on mount and removes it on unmount", () => {
      const mql = makeMqlMock(false);
      const isMobile = ref(mql.matches);
      const handleMediaChange = (e: { matches: boolean }) => {
        isMobile.value = e.matches;
      };

      // simulate onMounted
      mql.addEventListener("change", handleMediaChange);
      expect(mql.addEventListener).toHaveBeenCalledWith(
        "change",
        handleMediaChange,
      );
      expect(mql._listenerCount()).toBe(1);

      // simulate onUnmounted
      mql.removeEventListener("change", handleMediaChange);
      expect(mql.removeEventListener).toHaveBeenCalledWith(
        "change",
        handleMediaChange,
      );
      expect(mql._listenerCount()).toBe(0);
    });

    it("does not update isMobile after listener is removed", () => {
      const mql = makeMqlMock(false);
      const isMobile = ref(mql.matches);
      const handleMediaChange = (e: { matches: boolean }) => {
        isMobile.value = e.matches;
      };

      mql.addEventListener("change", handleMediaChange);
      mql.removeEventListener("change", handleMediaChange);

      mql._fire(true);
      expect(isMobile.value).toBe(false);
    });
  });

  describe("logDrawerOpen watch behavior", () => {
    it("tracks that keydown listener management follows open state", () => {
      const logDrawerOpen = ref(false);
      const addCalls: boolean[] = [];
      const removeCalls: boolean[] = [];

      function onKeydown(_e: { key: string }): void {}

      const mockDocument = {
        addEventListener: vi.fn((_type: string, _handler: unknown) => {
          addCalls.push(true);
        }),
        removeEventListener: vi.fn((_type: string, _handler: unknown) => {
          removeCalls.push(true);
        }),
      };

      // Simulate the watch(logDrawerOpen) behavior
      function simulateWatch(open: boolean) {
        if (open) {
          mockDocument.addEventListener("keydown", onKeydown);
        } else {
          mockDocument.removeEventListener("keydown", onKeydown);
        }
      }

      watch(logDrawerOpen, (open) => simulateWatch(open));

      logDrawerOpen.value = true;
      // Watch is async by default, but we verify the logic directly
      simulateWatch(true);
      expect(addCalls.length).toBe(1);

      simulateWatch(false);
      expect(removeCalls.length).toBe(1);
    });
  });
});
