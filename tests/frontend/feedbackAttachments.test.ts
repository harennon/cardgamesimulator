import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock http service to avoid Supabase env-var requirement at import time.
// All tests inject their own uploadOne double, so the real axiosInstance
// is never called.
vi.mock("@/service/http", () => ({
  axiosInstance: {
    post: vi.fn(),
  },
}));

import {
  rejectReason,
  blobToBase64,
  uploadErrorMessage,
  useFeedbackAttachments,
  FEEDBACK_ATTACHMENT_LIMITS,
} from "../../src/frontend/composables/useFeedbackAttachments.js";
import type { AttachmentItem } from "../../src/frontend/composables/useFeedbackAttachments.js";

// ---------------------------------------------------------------------------
// Node-environment stubs for browser APIs used by the composable.
// The test environment has no jsdom; we inject all DOM-dependent paths.
// ---------------------------------------------------------------------------

// Stub URL.createObjectURL / revokeObjectURL
const revokedUrls: string[] = [];
let urlCounter = 0;
global.URL.createObjectURL = vi.fn(() => `blob:fake-${++urlCounter}`);
global.URL.revokeObjectURL = vi.fn((url: string) => {
  revokedUrls.push(url);
});

// Stub crypto.randomUUID
let uuidCounter = 0;
vi.stubGlobal("crypto", {
  randomUUID: () => `uuid-${++uuidCounter}`,
});

// Stub FileReader — Node has no FileReader; provide a minimal implementation
// that handles readAsDataURL by converting blob bytes to a data URI.
class NodeFileReader {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(blob: Blob): void {
    blob
      .arrayBuffer()
      .then((buf) => {
        const b64 = Buffer.from(buf).toString("base64");
        this.result = `data:${blob.type};base64,${b64}`;
        this.onload?.();
      })
      .catch(() => {
        this.onerror?.();
      });
  }
}
vi.stubGlobal("FileReader", NodeFileReader);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(name: string, type: string, size = 1000): File {
  return { name, type, size } as unknown as File;
}

/** Stub Downscaler: returns a Blob of the given size (default 500). */
function stubDownscale(scaledSize = 500): (file: File) => Promise<Blob | null> {
  return async (_file: File) => ({ size: scaledSize }) as unknown as Blob;
}

/** Stub Downscaler that always returns null (simulates decode failure). */
function failDownscale(): (file: File) => Promise<Blob | null> {
  return async () => null;
}

beforeEach(() => {
  vi.clearAllMocks();
  uuidCounter = 0;
  urlCounter = 0;
  revokedUrls.length = 0;
});

// ---------------------------------------------------------------------------
// rejectReason
// ---------------------------------------------------------------------------

describe("rejectReason", () => {
  it("returns null for image/png", () => {
    expect(rejectReason({ type: "image/png", name: "a.png" }, 0)).toBeNull();
  });

  it("returns null for image/jpeg", () => {
    expect(rejectReason({ type: "image/jpeg", name: "a.jpg" }, 0)).toBeNull();
  });

  it("returns null for image/webp", () => {
    expect(rejectReason({ type: "image/webp", name: "a.webp" }, 0)).toBeNull();
  });

  it("returns a type message for video/mp4", () => {
    const msg = rejectReason({ type: "video/mp4", name: "clip.mp4" }, 0);
    expect(msg).toContain("clip.mp4");
    expect(msg).toContain("PNG, JPG and WebP");
  });

  it("returns a type message for image/gif (not in allowed list)", () => {
    const msg = rejectReason({ type: "image/gif", name: "anim.gif" }, 0);
    expect(msg).toContain("anim.gif");
    expect(msg).toContain("PNG, JPG and WebP");
  });

  it("returns the max-count message when currentCount >= 3", () => {
    const msg = rejectReason({ type: "image/png", name: "a.png" }, 3);
    expect(msg).toContain("3 images");
  });

  it("returns max-count message even for an allowed type when count is full", () => {
    const msg = rejectReason({ type: "image/jpeg", name: "b.jpg" }, 3);
    expect(msg).toContain("3 images");
  });
});

// ---------------------------------------------------------------------------
// blobToBase64
// ---------------------------------------------------------------------------

describe("blobToBase64", () => {
  it("returns a raw base64 string with no data: prefix", async () => {
    // Use real FileReader via a Buffer-backed Blob (Node 18+ supports Blob)
    const bytes = Buffer.from("hello");
    const blob = new Blob([bytes], { type: "image/jpeg" });
    const result = await blobToBase64(blob);
    expect(result).not.toContain("data:");
    expect(result).not.toContain(";base64,");
    // round-trip
    const decoded = Buffer.from(result, "base64").toString();
    expect(decoded).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// uploadErrorMessage
// ---------------------------------------------------------------------------

describe("uploadErrorMessage", () => {
  it("maps 413 to the too-large message", () => {
    const err = { response: { status: 413 } };
    expect(uploadErrorMessage(err)).toContain("too large");
  });

  it("maps 400 with size/large keyword in message to too-large", () => {
    const err = {
      response: { status: 400, data: { message: "File size exceeded" } },
    };
    expect(uploadErrorMessage(err)).toContain("too large");
  });

  it("maps 400 without size keyword to server message", () => {
    const err = {
      response: { status: 400, data: { message: "Invalid mime type" } },
    };
    expect(uploadErrorMessage(err)).toBe("Invalid mime type");
  });

  it("maps 400 with no server message to generic rejection", () => {
    const err = { response: { status: 400, data: {} } };
    expect(uploadErrorMessage(err)).toBe("This image was rejected.");
  });

  it("maps 4xx with server message to that message", () => {
    const err = { response: { status: 403, data: { message: "Forbidden" } } };
    expect(uploadErrorMessage(err)).toBe("Forbidden");
  });

  it("maps a network error (no response) to connection message", () => {
    const err = new Error("Network Error");
    expect(uploadErrorMessage(err)).toContain("connection");
  });

  it("maps 5xx to connection message", () => {
    const err = { response: { status: 500 } };
    expect(uploadErrorMessage(err)).toContain("connection");
  });
});

// ---------------------------------------------------------------------------
// useFeedbackAttachments — validation / add path
// ---------------------------------------------------------------------------

describe("useFeedbackAttachments — addFiles", () => {
  it("pushes one queued item per accepted file with correct fields", async () => {
    const attach = useFeedbackAttachments({ downscale: stubDownscale(400) });
    const file = makeFile("shot.png", "image/png", 2000);
    await attach.addFiles([file]);

    expect(attach.count.value).toBe(1);
    const item = attach.items.value[0];
    expect(item.status).toBe("queued");
    expect(item.name).toBe("shot.png");
    expect(item.origBytes).toBe(2000);
    expect(item.scaledBytes).toBe(400);
    expect(item.previewUrl).toMatch(/^blob:/);
  });

  it("stops at maxCount when adding 4 files in one batch", async () => {
    const attach = useFeedbackAttachments({ downscale: stubDownscale() });
    const files = [
      makeFile("a.png", "image/png"),
      makeFile("b.jpg", "image/jpeg"),
      makeFile("c.webp", "image/webp"),
      makeFile("d.png", "image/png"),
    ];
    await attach.addFiles(files);

    expect(attach.count.value).toBe(3);
    expect(attach.lastError.value).toContain("3 images");
  });

  it("skips a disallowed type mid-batch but still adds valid siblings (CE3)", async () => {
    const attach = useFeedbackAttachments({ downscale: stubDownscale() });
    const files = [
      makeFile("a.png", "image/png"),
      makeFile("b.gif", "image/gif"),
      makeFile("c.jpg", "image/jpeg"),
    ];
    await attach.addFiles(files);

    expect(attach.count.value).toBe(2);
    const names = attach.items.value.map((i) => i.name);
    expect(names).toContain("a.png");
    expect(names).toContain("c.jpg");
    expect(names).not.toContain("b.gif");
    expect(attach.lastError.value).toContain("b.gif");
  });

  it("skips a file when downscaler returns null and sets the could-not-read message (CE5)", async () => {
    const attach = useFeedbackAttachments({ downscale: failDownscale() });
    const file = makeFile("corrupt.png", "image/png");
    await attach.addFiles([file]);

    expect(attach.count.value).toBe(0);
    expect(attach.lastError.value).toContain("corrupt.png");
    expect(attach.lastError.value).toContain("could not read");
  });

  it("picker and array converge: same addFiles produces identical queued items", async () => {
    const attach = useFeedbackAttachments({ downscale: stubDownscale(300) });

    // Simulate FileList-shaped object
    const fileArray = [makeFile("x.png", "image/png", 1500)];
    await attach.addFiles(fileArray);
    const fromArray = attach.items.value.map((i) => ({
      name: i.name,
      status: i.status,
      origBytes: i.origBytes,
    }));

    attach.clear();

    // Plain array
    await attach.addFiles([makeFile("x.png", "image/png", 1500)]);
    const fromPlain = attach.items.value.map((i) => ({
      name: i.name,
      status: i.status,
      origBytes: i.origBytes,
    }));

    expect(fromArray).toEqual(fromPlain);
  });

  it("isFull becomes true when count reaches maxCount", async () => {
    const attach = useFeedbackAttachments({ downscale: stubDownscale() });
    expect(attach.isFull.value).toBe(false);
    await attach.addFiles([
      makeFile("a.png", "image/png"),
      makeFile("b.jpg", "image/jpeg"),
      makeFile("c.webp", "image/webp"),
    ]);
    expect(attach.isFull.value).toBe(true);
  });

  it("totalOrigBytes and totalScaledBytes sum correctly", async () => {
    const attach = useFeedbackAttachments({ downscale: stubDownscale(200) });
    await attach.addFiles([
      makeFile("a.png", "image/png", 1000),
      makeFile("b.jpg", "image/jpeg", 2000),
    ]);
    expect(attach.totalOrigBytes.value).toBe(3000);
    expect(attach.totalScaledBytes.value).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// useFeedbackAttachments — remove / clear
// ---------------------------------------------------------------------------

describe("useFeedbackAttachments — remove and clear", () => {
  it("remove splices the item and revokes its object URL", async () => {
    const attach = useFeedbackAttachments({ downscale: stubDownscale() });
    await attach.addFiles([makeFile("a.png", "image/png")]);
    const id = attach.items.value[0].id;
    const url = attach.items.value[0].previewUrl;

    attach.remove(id);

    expect(attach.count.value).toBe(0);
    expect(revokedUrls).toContain(url);
  });

  it("remove is a no-op for an unknown id", () => {
    const attach = useFeedbackAttachments({ downscale: stubDownscale() });
    expect(() => attach.remove("nonexistent")).not.toThrow();
  });

  it("clear empties items and revokes all object URLs", async () => {
    const attach = useFeedbackAttachments({ downscale: stubDownscale() });
    await attach.addFiles([
      makeFile("a.png", "image/png"),
      makeFile("b.jpg", "image/jpeg"),
    ]);
    const urls = attach.items.value.map((i) => i.previewUrl);

    attach.clear();

    expect(attach.count.value).toBe(0);
    for (const url of urls) {
      expect(revokedUrls).toContain(url);
    }
  });

  it("clear also resets lastError", async () => {
    const attach = useFeedbackAttachments({ downscale: failDownscale() });
    await attach.addFiles([makeFile("bad.png", "image/png")]);
    expect(attach.lastError.value).not.toBe("");
    attach.clear();
    expect(attach.lastError.value).toBe("");
  });
});

// ---------------------------------------------------------------------------
// useFeedbackAttachments — uploadAll
// ---------------------------------------------------------------------------

describe("useFeedbackAttachments — uploadAll", () => {
  it("transitions queued → uploading → done and resolves true when all succeed", async () => {
    const uploadOneCalls: string[] = [];
    const uploadOne = vi.fn(
      async (feedbackId: string, _item: AttachmentItem) => {
        uploadOneCalls.push(feedbackId);
      },
    );
    const attach = useFeedbackAttachments({
      downscale: stubDownscale(),
      uploadOne,
    });

    await attach.addFiles([
      makeFile("a.png", "image/png"),
      makeFile("b.jpg", "image/jpeg"),
    ]);

    const result = await attach.uploadAll("feedback-id-1");

    expect(result).toBe(true);
    expect(uploadOne).toHaveBeenCalledTimes(2);
    expect(uploadOneCalls).toEqual(["feedback-id-1", "feedback-id-1"]);
    for (const item of attach.items.value) {
      expect(item.status).toBe("done");
    }
  });

  it("on one failure: that item ends error, sibling reaches done, returns false (CE8)", async () => {
    let callCount = 0;
    const uploadOne = vi.fn(
      async (_feedbackId: string, item: AttachmentItem) => {
        callCount++;
        if (item.name === "bad.jpg") {
          throw { response: { status: 500 } };
        }
      },
    );
    const attach = useFeedbackAttachments({
      downscale: stubDownscale(),
      uploadOne,
    });

    await attach.addFiles([
      makeFile("ok.png", "image/png"),
      makeFile("bad.jpg", "image/jpeg"),
    ]);

    const result = await attach.uploadAll("fid");

    expect(result).toBe(false);
    const okItem = attach.items.value.find((i) => i.name === "ok.png")!;
    const badItem = attach.items.value.find((i) => i.name === "bad.jpg")!;
    expect(okItem.status).toBe("done");
    expect(badItem.status).toBe("error");
    expect(badItem.error).toContain("connection");
  });

  it("does not propagate exceptions from uploadOne (CE8)", async () => {
    const uploadOne = vi.fn(async () => {
      throw new Error("network down");
    });
    const attach = useFeedbackAttachments({
      downscale: stubDownscale(),
      uploadOne,
    });
    await attach.addFiles([makeFile("a.png", "image/png")]);

    await expect(attach.uploadAll("fid")).resolves.toBe(false);
  });

  it("re-invoking uploadAll retries only error/queued items, never re-uploads done (CE8)", async () => {
    // First upload attempt for bad.jpg fails; all subsequent calls succeed.
    // ok.png always succeeds.
    const badJpgFailedOnce = { value: false };
    const uploadOne = vi.fn(
      async (_feedbackId: string, item: AttachmentItem) => {
        if (item.name === "bad.jpg" && !badJpgFailedOnce.value) {
          badJpgFailedOnce.value = true;
          throw { response: { status: 500 } };
        }
      },
    );
    const attach = useFeedbackAttachments({
      downscale: stubDownscale(),
      uploadOne,
    });

    await attach.addFiles([
      makeFile("ok.png", "image/png"),
      makeFile("bad.jpg", "image/jpeg"),
    ]);

    // First upload: ok.png succeeds, bad.jpg fails
    await attach.uploadAll("fid");

    // Reset call tracking only (not the fail-once flag)
    uploadOne.mockClear();

    // Second upload: only bad.jpg should be retried (it's in "error" state)
    const result = await attach.uploadAll("fid");

    expect(result).toBe(true);
    // uploadOne called exactly once (for bad.jpg only; ok.png is "done")
    expect(uploadOne).toHaveBeenCalledTimes(1);
    const retriedItem = uploadOne.mock.calls[0][1] as AttachmentItem;
    expect(retriedItem.name).toBe("bad.jpg");
  });

  it("uploadAll with no queued/error items returns true immediately", async () => {
    const uploadOne = vi.fn();
    const attach = useFeedbackAttachments({
      downscale: stubDownscale(),
      uploadOne,
    });
    // No items added
    const result = await attach.uploadAll("fid");
    expect(result).toBe(true);
    expect(uploadOne).not.toHaveBeenCalled();
  });

  it("hasQueued is true while items are queued, false when all done", async () => {
    const uploadOne = vi.fn(async () => {});
    const attach = useFeedbackAttachments({
      downscale: stubDownscale(),
      uploadOne,
    });
    await attach.addFiles([makeFile("a.png", "image/png")]);

    expect(attach.hasQueued.value).toBe(true);

    await attach.uploadAll("fid");

    expect(attach.hasQueued.value).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Submit orchestration — mirrors FeedbackWidget.submit() logic, DOM-free
// ---------------------------------------------------------------------------

interface SubmitDeps {
  postFeedback: () => Promise<{ id: string }>;
  attachments: ReturnType<typeof useFeedbackAttachments>;
}

/**
 * Mirrors the submit() function from FeedbackWidget.vue (as spec'd in the LLD
 * Test Requirements "submit orchestration" section).
 */
async function runSubmit(deps: SubmitDeps): Promise<{
  closed: boolean;
  toastShown: boolean;
  formError: string;
  description: string;
}> {
  let closed = false;
  let toastShown = false;
  let formError = "";
  const description = { value: "some feedback" };

  let id: string;
  try {
    const resp = await deps.postFeedback();
    id = resp.id;
  } catch {
    formError = "Failed to submit. Please try again.";
    return { closed, toastShown, formError, description: description.value };
  }

  if (!deps.attachments.hasQueued.value) {
    closed = true;
    toastShown = true;
    return { closed, toastShown, formError, description: description.value };
  }

  const allDone = await deps.attachments.uploadAll(id);
  if (allDone) {
    closed = true;
    toastShown = true;
  }

  return { closed, toastShown, formError, description: description.value };
}

describe("submit orchestration", () => {
  it("CE1: zero attachments — calls postFeedback once and closes (no uploadAll)", async () => {
    const postFeedback = vi.fn(() => Promise.resolve({ id: "fb-1" }));
    const uploadOne = vi.fn();
    const attach = useFeedbackAttachments({
      downscale: stubDownscale(),
      uploadOne,
    });
    // No addFiles — hasQueued is false

    const result = await runSubmit({ postFeedback, attachments: attach });

    expect(postFeedback).toHaveBeenCalledTimes(1);
    expect(uploadOne).not.toHaveBeenCalled();
    expect(result.closed).toBe(true);
    expect(result.toastShown).toBe(true);
  });

  it("with queued attachments: calls postFeedback then uploadAll(returnedId), closes on full success", async () => {
    const postFeedback = vi.fn(() => Promise.resolve({ id: "fb-42" }));
    const uploadOne = vi.fn(async () => {});
    const attach = useFeedbackAttachments({
      downscale: stubDownscale(),
      uploadOne,
    });
    await attach.addFiles([makeFile("a.png", "image/png")]);

    const result = await runSubmit({ postFeedback, attachments: attach });

    expect(postFeedback).toHaveBeenCalledTimes(1);
    expect(uploadOne).toHaveBeenCalledTimes(1);
    expect(uploadOne.mock.calls[0][0]).toBe("fb-42");
    expect(result.closed).toBe(true);
    expect(result.toastShown).toBe(true);
  });

  it("row POST failure: sets form error, does not call uploadAll, description preserved", async () => {
    const postFeedback = vi.fn(() => Promise.reject(new Error("server error")));
    const uploadOne = vi.fn();
    const attach = useFeedbackAttachments({
      downscale: stubDownscale(),
      uploadOne,
    });
    await attach.addFiles([makeFile("a.png", "image/png")]);

    const result = await runSubmit({ postFeedback, attachments: attach });

    expect(result.formError).toContain("Failed to submit");
    expect(uploadOne).not.toHaveBeenCalled();
    expect(result.closed).toBe(false);
    expect(result.description).toBe("some feedback");
  });

  it("partial upload failure: modal stays open, no toast, description preserved", async () => {
    const postFeedback = vi.fn(() => Promise.resolve({ id: "fb-3" }));
    const uploadOne = vi.fn(async () => {
      throw { response: { status: 500 } };
    });
    const attach = useFeedbackAttachments({
      downscale: stubDownscale(),
      uploadOne,
    });
    await attach.addFiles([makeFile("a.png", "image/png")]);

    const result = await runSubmit({ postFeedback, attachments: attach });

    expect(result.closed).toBe(false);
    expect(result.toastShown).toBe(false);
    expect(result.description).toBe("some feedback");
    expect(result.formError).toBe("");
  });

  it("double-submit guard: a second concurrent submit is a no-op", async () => {
    const postFeedback = vi.fn(() => Promise.resolve({ id: "fb-99" }));
    const uploadOne = vi.fn(async () => {});
    const attach = useFeedbackAttachments({
      downscale: stubDownscale(),
      uploadOne,
    });
    await attach.addFiles([makeFile("a.png", "image/png")]);

    const submitting = { value: false };

    async function guardedSubmit() {
      if (submitting.value) return null;
      submitting.value = true;
      try {
        return await runSubmit({ postFeedback, attachments: attach });
      } finally {
        submitting.value = false;
      }
    }

    // Launch two concurrent submits
    const [r1, r2] = await Promise.all([guardedSubmit(), guardedSubmit()]);

    // One should have run, one should have been a no-op
    expect(postFeedback).toHaveBeenCalledTimes(1);
    const results = [r1, r2];
    const ran = results.filter((r) => r !== null);
    const skipped = results.filter((r) => r === null);
    expect(ran).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });
});
