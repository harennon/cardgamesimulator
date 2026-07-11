import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref, computed } from "vue";
import type { Ref, ComputedRef } from "vue";
import type {
  Attachment,
  UseFeedbackAttachments,
} from "../../src/frontend/composables/useFeedbackAttachments.js";

// ---------------------------------------------------------------------------
// Tests for the submit() orchestration flow from FeedbackWidget.vue.
//
// Mirrors the component's two-phase submit as an injectable function
// (same extraction style as feedbackBuildMetadata.test.ts / roomCodeChip.test.ts).
// Tests run in the node environment (no jsdom / @vue/test-utils).
// ---------------------------------------------------------------------------

interface SubmitFeedbackResponse {
  id: string;
  createdAt: string;
}

interface SubmitDeps {
  postFeedback: (
    category: string,
    description: string,
  ) => Promise<SubmitFeedbackResponse>;
  attachments: UseFeedbackAttachments;
  closeModal: () => void;
  showToast: () => void;
}

interface SubmitState {
  description: string;
  category: string;
  submitting: boolean;
  errorMessage: string;
  attachError: string;
  feedbackId: string | null;
}

/**
 * Mirrors submit() from FeedbackWidget.vue (two-phase: postFeedback → uploadAll).
 * Returns the updated state after execution.
 */
async function runSubmit(
  state: SubmitState,
  deps: SubmitDeps,
): Promise<SubmitState> {
  if (state.description.trim().length === 0) return state;

  const next = {
    ...state,
    submitting: true,
    errorMessage: "",
    attachError: "",
  };

  let feedbackId = state.feedbackId;

  // Phase 1: POST /api/feedback only if we don't already have an id
  if (!feedbackId) {
    try {
      const res = await deps.postFeedback(next.category, next.description);
      feedbackId = res.id;
      next.feedbackId = feedbackId;
    } catch {
      return {
        ...next,
        submitting: false,
        errorMessage: "Failed to submit. Please try again.",
        feedbackId: null,
      };
    }
  }

  // Phase 2: upload attachments (if any queued)
  const queued = deps.attachments.attachments.value.filter(
    (a) => a.status === "queued",
  );

  if (queued.length === 0) {
    deps.closeModal();
    deps.showToast();
    return { ...next, submitting: false, feedbackId };
  }

  const allDone = await deps.attachments.uploadAll(feedbackId);

  if (allDone) {
    deps.closeModal();
    deps.showToast();
    return { ...next, submitting: false, feedbackId };
  }

  // At least one attachment failed — keep modal open
  return {
    ...next,
    submitting: false,
    attachError: "Some attachments failed to upload. Retry or remove them.",
    feedbackId,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBlob(size = 50): Blob {
  return { size, type: "image/jpeg", slice: vi.fn() } as unknown as Blob;
}

function makeQueuedAttachment(id: string): Attachment {
  return {
    id,
    name: `file-${id}.jpg`,
    previewUrl: `blob://url-${id}`,
    blob: makeBlob(),
    origBytes: 100,
    scaledBytes: 50,
    status: "queued",
  };
}

function makeDoneAttachment(id: string): Attachment {
  return { ...makeQueuedAttachment(id), status: "done" };
}

function makeAttachmentsComposable(
  initialAttachments: Attachment[],
  uploadAllResult: boolean,
): UseFeedbackAttachments {
  const attachments = ref<Attachment[]>(initialAttachments);
  const uploadAllMock = vi.fn().mockResolvedValue(uploadAllResult);
  return {
    attachments,
    attachError: ref(""),
    isFull: computed(() => attachments.value.length >= 3),
    canAddMore: computed(() => attachments.value.length < 3),
    addFiles: vi.fn(),
    remove: vi.fn(),
    reset: vi.fn(),
    uploadAll: uploadAllMock,
  };
}

function makeInitialState(overrides?: Partial<SubmitState>): SubmitState {
  return {
    description: "Test description",
    category: "bug",
    submitting: false,
    errorMessage: "",
    attachError: "",
    feedbackId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("feedbackSubmitFlow", () => {
  describe("E5 — description-only submit (no attachments)", () => {
    it("calls postFeedback once, does not call uploadAll, closes modal and shows toast", async () => {
      const postFeedback = vi
        .fn()
        .mockResolvedValue({ id: "fb-1", createdAt: "2026-01-01T00:00:00Z" });
      const closeModal = vi.fn();
      const showToast = vi.fn();
      const attachments = makeAttachmentsComposable([], true);

      const result = await runSubmit(makeInitialState(), {
        postFeedback,
        attachments,
        closeModal,
        showToast,
      });

      expect(postFeedback).toHaveBeenCalledTimes(1);
      expect(attachments.uploadAll).not.toHaveBeenCalled();
      expect(closeModal).toHaveBeenCalledTimes(1);
      expect(showToast).toHaveBeenCalledTimes(1);
      expect(result.submitting).toBe(false);
      expect(result.errorMessage).toBe("");
    });
  });

  describe("happy path with attachments", () => {
    it("postFeedback → id, then uploadAll(id) → all done → close + toast", async () => {
      const postFeedback = vi
        .fn()
        .mockResolvedValue({ id: "fb-2", createdAt: "2026-01-01T00:00:00Z" });
      const closeModal = vi.fn();
      const showToast = vi.fn();
      const attachments = makeAttachmentsComposable(
        [makeQueuedAttachment("a1"), makeQueuedAttachment("a2")],
        true,
      );

      const result = await runSubmit(makeInitialState(), {
        postFeedback,
        attachments,
        closeModal,
        showToast,
      });

      expect(postFeedback).toHaveBeenCalledTimes(1);
      expect(attachments.uploadAll).toHaveBeenCalledWith("fb-2");
      expect(closeModal).toHaveBeenCalledTimes(1);
      expect(showToast).toHaveBeenCalledTimes(1);
      expect(result.submitting).toBe(false);
      expect(result.feedbackId).toBe("fb-2");
    });
  });

  describe("E6 — step-1 failure preserves description", () => {
    it("postFeedback rejects → form-error set, uploadAll not called, description unchanged", async () => {
      const postFeedback = vi.fn().mockRejectedValue(new Error("Network fail"));
      const closeModal = vi.fn();
      const showToast = vi.fn();
      const attachments = makeAttachmentsComposable(
        [makeQueuedAttachment("a1")],
        true,
      );

      const state = makeInitialState({ description: "My important report" });
      const result = await runSubmit(state, {
        postFeedback,
        attachments,
        closeModal,
        showToast,
      });

      expect(result.errorMessage).toBe("Failed to submit. Please try again.");
      expect(attachments.uploadAll).not.toHaveBeenCalled();
      expect(closeModal).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalled();
      expect(result.submitting).toBe(false);
      // Description is preserved in caller's state — description was not cleared
      // (the function receives it as part of state and returns without mutating it)
      expect(state.description).toBe("My important report");
    });

    it("feedbackId remains null after step-1 failure", async () => {
      const postFeedback = vi.fn().mockRejectedValue(new Error("fail"));
      const attachments = makeAttachmentsComposable([], true);

      const result = await runSubmit(makeInitialState(), {
        postFeedback,
        attachments,
        closeModal: vi.fn(),
        showToast: vi.fn(),
      });

      expect(result.feedbackId).toBeNull();
    });
  });

  describe("E7 — attachment failure preserves description", () => {
    it("postFeedback ok, uploadAll returns false → modal stays open, description unchanged", async () => {
      const postFeedback = vi
        .fn()
        .mockResolvedValue({ id: "fb-3", createdAt: "2026-01-01T00:00:00Z" });
      const closeModal = vi.fn();
      const showToast = vi.fn();
      const attachments = makeAttachmentsComposable(
        [makeQueuedAttachment("a1"), makeQueuedAttachment("a2")],
        false, // uploadAll returns false
      );

      const state = makeInitialState({ description: "Describe the bug here" });
      const result = await runSubmit(state, {
        postFeedback,
        attachments,
        closeModal,
        showToast,
      });

      expect(closeModal).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalled();
      expect(result.submitting).toBe(false);
      expect(result.attachError).not.toBe("");
      // Description is preserved (not cleared)
      expect(state.description).toBe("Describe the bug here");
    });

    it("feedbackId is retained after attachment failure (for Retry)", async () => {
      const postFeedback = vi.fn().mockResolvedValue({
        id: "fb-retain",
        createdAt: "2026-01-01T00:00:00Z",
      });
      const attachments = makeAttachmentsComposable(
        [makeQueuedAttachment("a1")],
        false,
      );

      const result = await runSubmit(makeInitialState(), {
        postFeedback,
        attachments,
        closeModal: vi.fn(),
        showToast: vi.fn(),
      });

      expect(result.feedbackId).toBe("fb-retain");
    });
  });

  describe("no duplicate feedback row on Retry (E8)", () => {
    it("resubmit with existing feedbackId skips postFeedback and calls uploadAll with stored id", async () => {
      const postFeedback = vi
        .fn()
        .mockResolvedValue({ id: "new-id", createdAt: "2026-01-01" });
      const attachments = makeAttachmentsComposable(
        [makeQueuedAttachment("a1")],
        true,
      );

      // Simulate: feedbackId already set from prior attempt
      const state = makeInitialState({ feedbackId: "fb-existing" });
      await runSubmit(state, {
        postFeedback,
        attachments,
        closeModal: vi.fn(),
        showToast: vi.fn(),
      });

      // postFeedback must NOT be called again
      expect(postFeedback).not.toHaveBeenCalled();
      // uploadAll called with the existing id
      expect(attachments.uploadAll).toHaveBeenCalledWith("fb-existing");
    });
  });

  describe("E7-413 — attachment 413 graceful error (LLD 163)", () => {
    it("when uploadAll returns false (e.g. 413 from nginx), attachError shows the friendly message", async () => {
      // uploadAll returns false regardless of whether the underlying cause was a
      // 413, network error, or any other rejection — the modal stays open and
      // the friendly message is shown instead of raw nginx HTML.
      const postFeedback = vi
        .fn()
        .mockResolvedValue({ id: "fb-413", createdAt: "2026-01-01T00:00:00Z" });
      const closeModal = vi.fn();
      const showToast = vi.fn();
      const attachments = makeAttachmentsComposable(
        [makeQueuedAttachment("img1")],
        false, // uploadAll returns false — simulates 413 caught inside uploadAll
      );

      const result = await runSubmit(makeInitialState(), {
        postFeedback,
        attachments,
        closeModal,
        showToast,
      });

      expect(closeModal).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalled();
      expect(result.attachError).toBe(
        "Some attachments failed to upload. Retry or remove them.",
      );
      expect(result.submitting).toBe(false);
    });

    it("feedbackId is retained after 413 failure so retry does not create a duplicate row", async () => {
      const postFeedback = vi
        .fn()
        .mockResolvedValue({
          id: "fb-413-retain",
          createdAt: "2026-01-01T00:00:00Z",
        });
      const attachments = makeAttachmentsComposable(
        [makeQueuedAttachment("img2")],
        false,
      );

      const result = await runSubmit(makeInitialState(), {
        postFeedback,
        attachments,
        closeModal: vi.fn(),
        showToast: vi.fn(),
      });

      expect(result.feedbackId).toBe("fb-413-retain");
    });
  });

  describe("empty description guard", () => {
    it("does nothing when description is empty", async () => {
      const postFeedback = vi.fn();
      const closeModal = vi.fn();
      const showToast = vi.fn();
      const attachments = makeAttachmentsComposable([], true);

      const result = await runSubmit(makeInitialState({ description: "   " }), {
        postFeedback,
        attachments,
        closeModal,
        showToast,
      });

      expect(postFeedback).not.toHaveBeenCalled();
      expect(closeModal).not.toHaveBeenCalled();
      expect(result.submitting).toBe(false);
    });
  });
});
