import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  useFeedbackAttachments,
  ATTACH_CAPS,
} from "../../src/frontend/composables/useFeedbackAttachments.js";
import type {
  FeedbackAttachmentDeps,
  DownscaleResult,
} from "../../src/frontend/composables/useFeedbackAttachments.js";

// ---------------------------------------------------------------------------
// Tests for useFeedbackAttachments composable.
//
// Project frontend tests run in a node environment (no jsdom). All browser
// dependencies (downscale, uploadAttachment, URL helpers, blobToBase64) are
// injected as fakes. The composable logic — validation, downscale
// orchestration, and upload state machine — is tested directly.
// ---------------------------------------------------------------------------

function makeBlob(size: number, type = "image/jpeg"): Blob {
  return { size, type, slice: vi.fn() } as unknown as Blob;
}

function makeFile(name: string, size: number, type = "image/jpeg"): File {
  return { name, size, type, slice: vi.fn() } as unknown as File;
}

function makeDeps(
  overrides?: Partial<FeedbackAttachmentDeps>,
): FeedbackAttachmentDeps {
  let urlCounter = 0;
  return {
    downscale: vi
      .fn()
      .mockResolvedValue({
        blob: makeBlob(100, "image/jpeg"),
      } as DownscaleResult),
    uploadAttachment: vi.fn().mockResolvedValue(undefined),
    createObjectURL: vi
      .fn()
      .mockImplementation(() => `blob://url-${++urlCounter}`),
    revokeObjectURL: vi.fn(),
    blobToBase64: vi.fn().mockResolvedValue("base64data"),
    ...overrides,
  };
}

describe("useFeedbackAttachments", () => {
  describe("initial state", () => {
    it("starts with empty attachments", () => {
      const { attachments } = useFeedbackAttachments(makeDeps());
      expect(attachments.value).toEqual([]);
    });

    it("starts with empty attachError", () => {
      const { attachError } = useFeedbackAttachments(makeDeps());
      expect(attachError.value).toBe("");
    });

    it("isFull is false initially", () => {
      const { isFull } = useFeedbackAttachments(makeDeps());
      expect(isFull.value).toBe(false);
    });

    it("canAddMore is true initially", () => {
      const { canAddMore } = useFeedbackAttachments(makeDeps());
      expect(canAddMore.value).toBe(true);
    });
  });

  describe("addFiles — picker path (File[])", () => {
    it("adds two valid PNGs as queued attachments with correct metadata", async () => {
      const deps = makeDeps({
        downscale: vi
          .fn()
          .mockResolvedValueOnce({ blob: makeBlob(50, "image/jpeg") })
          .mockResolvedValueOnce({ blob: makeBlob(75, "image/jpeg") }),
      });
      const { attachments, addFiles } = useFeedbackAttachments(deps);

      const f1 = makeFile("photo1.png", 200, "image/png");
      const f2 = makeFile("photo2.png", 300, "image/png");
      await addFiles([f1, f2]);

      expect(attachments.value).toHaveLength(2);
      expect(attachments.value[0].name).toBe("photo1.png");
      expect(attachments.value[0].origBytes).toBe(200);
      expect(attachments.value[0].scaledBytes).toBe(50);
      expect(attachments.value[0].status).toBe("queued");
      expect(attachments.value[1].name).toBe("photo2.png");
      expect(attachments.value[1].origBytes).toBe(300);
      expect(attachments.value[1].scaledBytes).toBe(75);
      expect(attachments.value[1].status).toBe("queued");
    });

    it("calls createObjectURL once per successfully added file", async () => {
      const deps = makeDeps();
      const { addFiles } = useFeedbackAttachments(deps);
      await addFiles([
        makeFile("a.jpg", 100, "image/jpeg"),
        makeFile("b.jpg", 100, "image/jpeg"),
      ]);
      expect(deps.createObjectURL).toHaveBeenCalledTimes(2);
    });

    it("assigns a unique id to each attachment", async () => {
      const deps = makeDeps({
        downscale: vi
          .fn()
          .mockResolvedValueOnce({ blob: makeBlob(50, "image/jpeg") })
          .mockResolvedValueOnce({ blob: makeBlob(50, "image/jpeg") }),
      });
      const { attachments, addFiles } = useFeedbackAttachments(deps);
      await addFiles([
        makeFile("a.png", 100, "image/png"),
        makeFile("b.png", 100, "image/png"),
      ]);
      const ids = attachments.value.map((a) => a.id);
      expect(new Set(ids).size).toBe(2);
    });
  });

  describe("addFiles — paste path (E10/E11)", () => {
    it("only passes image items to addFiles when clipboard has mixed items", async () => {
      const deps = makeDeps();
      const { addFiles } = useFeedbackAttachments(deps);

      // Simulate the component's paste filter: only image/* items
      const imageFile = makeFile("pasted-image.png", 100, "image/png");
      const filteredFiles = [imageFile]; // text/plain already filtered out
      await addFiles(filteredFiles);

      expect(deps.downscale).toHaveBeenCalledTimes(1);
    });

    it("text-only clipboard produces no addFiles call (E10)", async () => {
      const deps = makeDeps();
      const { addFiles, attachments } = useFeedbackAttachments(deps);

      // text-only paste: component filters to zero image items, so addFiles([])
      await addFiles([]);
      expect(attachments.value).toHaveLength(0);
      expect(deps.downscale).not.toHaveBeenCalled();
    });

    it("paste gives file the name 'pasted-image.png'", async () => {
      const deps = makeDeps();
      const { attachments, addFiles } = useFeedbackAttachments(deps);
      await addFiles([makeFile("pasted-image.png", 100, "image/png")]);
      expect(attachments.value[0].name).toBe("pasted-image.png");
    });
  });

  describe("rejection — wrong type (E1)", () => {
    it("rejects a video file with inline error, not added", async () => {
      const deps = makeDeps();
      const { attachments, attachError, addFiles } =
        useFeedbackAttachments(deps);

      await addFiles([makeFile("clip.mp4", 100, "video/mp4")]);

      expect(attachments.value).toHaveLength(0);
      expect(attachError.value).toContain("only PNG, JPG and WebP");
      expect(deps.downscale).not.toHaveBeenCalled();
    });

    it("includes the filename in the type-rejection error", async () => {
      const deps = makeDeps();
      const { attachError, addFiles } = useFeedbackAttachments(deps);
      await addFiles([makeFile("bad.gif", 100, "image/gif")]);
      expect(attachError.value).toContain("bad.gif");
    });

    it("continues past the bad file and adds the next valid one", async () => {
      const deps = makeDeps();
      const { attachments, addFiles } = useFeedbackAttachments(deps);
      await addFiles([
        makeFile("bad.gif", 100, "image/gif"),
        makeFile("good.jpg", 100, "image/jpeg"),
      ]);
      expect(attachments.value).toHaveLength(1);
      expect(attachments.value[0].name).toBe("good.jpg");
    });
  });

  describe("rejection — over count (E2)", () => {
    it("stops at 3 and sets error when a 4th file is added", async () => {
      const deps = makeDeps({
        downscale: vi
          .fn()
          .mockResolvedValue({ blob: makeBlob(50, "image/jpeg") }),
      });
      const { attachments, attachError, addFiles } =
        useFeedbackAttachments(deps);

      await addFiles([
        makeFile("a.jpg", 100, "image/jpeg"),
        makeFile("b.jpg", 100, "image/jpeg"),
        makeFile("c.jpg", 100, "image/jpeg"),
      ]);
      expect(attachments.value).toHaveLength(3);

      await addFiles([makeFile("d.jpg", 100, "image/jpeg")]);
      expect(attachments.value).toHaveLength(3);
      expect(attachError.value).toContain("at most 3");
    });

    it("isFull flips true at exactly 3 files", async () => {
      const deps = makeDeps({
        downscale: vi
          .fn()
          .mockResolvedValue({ blob: makeBlob(50, "image/jpeg") }),
      });
      const { isFull, canAddMore, addFiles } = useFeedbackAttachments(deps);
      expect(isFull.value).toBe(false);

      await addFiles([
        makeFile("a.jpg", 100, "image/jpeg"),
        makeFile("b.jpg", 100, "image/jpeg"),
        makeFile("c.jpg", 100, "image/jpeg"),
      ]);
      expect(isFull.value).toBe(true);
      expect(canAddMore.value).toBe(false);
    });

    it("removing one from a full list re-enables canAddMore", async () => {
      const deps = makeDeps({
        downscale: vi
          .fn()
          .mockResolvedValue({ blob: makeBlob(50, "image/jpeg") }),
      });
      const { attachments, isFull, canAddMore, addFiles, remove } =
        useFeedbackAttachments(deps);

      await addFiles([
        makeFile("a.jpg", 100, "image/jpeg"),
        makeFile("b.jpg", 100, "image/jpeg"),
        makeFile("c.jpg", 100, "image/jpeg"),
      ]);
      expect(isFull.value).toBe(true);

      remove(attachments.value[0].id);
      expect(isFull.value).toBe(false);
      expect(canAddMore.value).toBe(true);
    });

    it("loop breaks on overflow so extra files in the same call are skipped", async () => {
      const deps = makeDeps({
        downscale: vi
          .fn()
          .mockResolvedValue({ blob: makeBlob(50, "image/jpeg") }),
      });
      const { attachments, addFiles } = useFeedbackAttachments(deps);

      // Pass 5 files at once; only first 3 should be added
      await addFiles([
        makeFile("a.jpg", 100, "image/jpeg"),
        makeFile("b.jpg", 100, "image/jpeg"),
        makeFile("c.jpg", 100, "image/jpeg"),
        makeFile("d.jpg", 100, "image/jpeg"),
        makeFile("e.jpg", 100, "image/jpeg"),
      ]);
      expect(attachments.value).toHaveLength(3);
      expect(deps.downscale).toHaveBeenCalledTimes(3);
    });
  });

  describe("rejection — oversize after downscale (E-StillTooBig)", () => {
    it("rejects a file still over 5 MB after downscale", async () => {
      const oversizedBlob = makeBlob(ATTACH_CAPS.maxBytes + 1, "image/jpeg");
      const deps = makeDeps({
        downscale: vi.fn().mockResolvedValue({ blob: oversizedBlob }),
      });
      const { attachments, attachError, addFiles } =
        useFeedbackAttachments(deps);

      await addFiles([
        makeFile("huge.jpg", ATTACH_CAPS.maxBytes + 1, "image/jpeg"),
      ]);

      expect(attachments.value).toHaveLength(0);
      expect(attachError.value).toContain("still over 5 MB");
    });
  });

  describe("rejection — undecodable image (E3)", () => {
    it("sets 'could not read' error when downscale returns null", async () => {
      const deps = makeDeps({
        downscale: vi.fn().mockResolvedValue(null),
      });
      const { attachments, attachError, addFiles } =
        useFeedbackAttachments(deps);

      await addFiles([makeFile("corrupt.png", 100, "image/png")]);

      expect(attachments.value).toHaveLength(0);
      expect(attachError.value).toContain("could not read this image");
    });

    it("includes the filename in the undecodable error", async () => {
      const deps = makeDeps({
        downscale: vi.fn().mockResolvedValue(null),
      });
      const { attachError, addFiles } = useFeedbackAttachments(deps);
      await addFiles([makeFile("corrupt.jpg", 100, "image/jpeg")]);
      expect(attachError.value).toContain("corrupt.jpg");
    });
  });

  describe("remove()", () => {
    it("revokes the object URL and drops the entry", async () => {
      const deps = makeDeps();
      const { attachments, addFiles, remove } = useFeedbackAttachments(deps);
      await addFiles([makeFile("a.jpg", 100, "image/jpeg")]);
      const id = attachments.value[0].id;
      const url = attachments.value[0].previewUrl;

      remove(id);

      expect(attachments.value).toHaveLength(0);
      expect(deps.revokeObjectURL).toHaveBeenCalledWith(url);
    });

    it("does nothing for an unknown id", async () => {
      const deps = makeDeps();
      const { attachments, addFiles, remove } = useFeedbackAttachments(deps);
      await addFiles([makeFile("a.jpg", 100, "image/jpeg")]);

      remove("unknown-id");

      expect(attachments.value).toHaveLength(1);
      expect(deps.revokeObjectURL).not.toHaveBeenCalled();
    });

    it("does not remove an uploading file", async () => {
      const deps = makeDeps({
        uploadAttachment: vi.fn().mockImplementation(
          () => new Promise(() => {}), // never resolves
        ),
      });
      const { attachments, addFiles, remove, uploadAll } =
        useFeedbackAttachments(deps);
      await addFiles([makeFile("a.jpg", 100, "image/jpeg")]);
      const id = attachments.value[0].id;

      // start upload (don't await — intentionally keep it in-flight)
      uploadAll("feed-1");

      remove(id);

      // should still be there (status = uploading)
      expect(attachments.value).toHaveLength(1);
    });
  });

  describe("reset()", () => {
    it("revokes all object URLs and clears the list", async () => {
      const deps = makeDeps({
        downscale: vi
          .fn()
          .mockResolvedValue({ blob: makeBlob(50, "image/jpeg") }),
      });
      const { attachments, attachError, addFiles, reset } =
        useFeedbackAttachments(deps);
      await addFiles([
        makeFile("a.jpg", 100, "image/jpeg"),
        makeFile("b.jpg", 100, "image/jpeg"),
      ]);
      expect(attachments.value).toHaveLength(2);

      reset();

      expect(attachments.value).toHaveLength(0);
      expect(deps.revokeObjectURL).toHaveBeenCalledTimes(2);
    });

    it("clears attachError on reset", async () => {
      const deps = makeDeps({ downscale: vi.fn().mockResolvedValue(null) });
      const { attachError, addFiles, reset } = useFeedbackAttachments(deps);
      await addFiles([makeFile("bad.png", 100, "image/png")]);
      expect(attachError.value).not.toBe("");

      reset();

      expect(attachError.value).toBe("");
    });
  });

  describe("uploadAll — happy path", () => {
    it("all succeed: every file ends done, returns true", async () => {
      const deps = makeDeps({
        downscale: vi
          .fn()
          .mockResolvedValue({ blob: makeBlob(50, "image/jpeg") }),
        uploadAttachment: vi.fn().mockResolvedValue(undefined),
      });
      const { attachments, addFiles, uploadAll } = useFeedbackAttachments(deps);
      await addFiles([
        makeFile("a.jpg", 100, "image/jpeg"),
        makeFile("b.jpg", 100, "image/jpeg"),
        makeFile("c.jpg", 100, "image/jpeg"),
      ]);

      const result = await uploadAll("feed-id-1");

      expect(result).toBe(true);
      expect(attachments.value.every((a) => a.status === "done")).toBe(true);
    });

    it("uploads sequentially (assert call order)", async () => {
      const callOrder: number[] = [];
      const deps = makeDeps({
        downscale: vi
          .fn()
          .mockResolvedValue({ blob: makeBlob(50, "image/jpeg") }),
        uploadAttachment: vi
          .fn()
          .mockImplementationOnce(async () => {
            callOrder.push(1);
          })
          .mockImplementationOnce(async () => {
            callOrder.push(2);
          })
          .mockImplementationOnce(async () => {
            callOrder.push(3);
          }),
      });
      const { addFiles, uploadAll } = useFeedbackAttachments(deps);
      await addFiles([
        makeFile("a.jpg", 100, "image/jpeg"),
        makeFile("b.jpg", 100, "image/jpeg"),
        makeFile("c.jpg", 100, "image/jpeg"),
      ]);

      await uploadAll("feed-id-1");

      expect(callOrder).toEqual([1, 2, 3]);
    });

    it("passes the base64 from blobToBase64 and mimeType to uploadAttachment", async () => {
      const blob = makeBlob(50, "image/jpeg");
      const deps = makeDeps({
        downscale: vi.fn().mockResolvedValue({ blob }),
        blobToBase64: vi.fn().mockResolvedValue("encoded-data-here"),
        uploadAttachment: vi.fn().mockResolvedValue(undefined),
      });
      const { addFiles, uploadAll } = useFeedbackAttachments(deps);
      await addFiles([makeFile("a.jpg", 100, "image/jpeg")]);

      await uploadAll("feed-42");

      expect(deps.uploadAttachment).toHaveBeenCalledWith(
        "feed-42",
        "encoded-data-here",
        "image/jpeg",
      );
    });
  });

  describe("uploadAll — failure path (E7)", () => {
    it("one fails: 1st and 3rd done, 2nd error, returns false", async () => {
      const deps = makeDeps({
        downscale: vi
          .fn()
          .mockResolvedValue({ blob: makeBlob(50, "image/jpeg") }),
        uploadAttachment: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("Network error"))
          .mockResolvedValueOnce(undefined),
      });
      const { attachments, addFiles, uploadAll } = useFeedbackAttachments(deps);
      await addFiles([
        makeFile("a.jpg", 100, "image/jpeg"),
        makeFile("b.jpg", 100, "image/jpeg"),
        makeFile("c.jpg", 100, "image/jpeg"),
      ]);

      const result = await uploadAll("feed-id-1");

      expect(result).toBe(false);
      expect(attachments.value[0].status).toBe("done");
      expect(attachments.value[1].status).toBe("error");
      expect(attachments.value[2].status).toBe("done");
    });

    it("never throws even on failure", async () => {
      const deps = makeDeps({
        uploadAttachment: vi.fn().mockRejectedValue(new Error("500")),
      });
      const { addFiles, uploadAll } = useFeedbackAttachments(deps);
      await addFiles([makeFile("a.jpg", 100, "image/jpeg")]);

      await expect(uploadAll("feed-1")).resolves.toBe(false);
    });
  });

  describe("uploadAll — retry (E8)", () => {
    it("retry re-uploads only the errored file to the same feedbackId", async () => {
      const deps = makeDeps({
        downscale: vi
          .fn()
          .mockResolvedValue({ blob: makeBlob(50, "image/jpeg") }),
        uploadAttachment: vi
          .fn()
          .mockResolvedValueOnce(undefined) // file 1 ok
          .mockRejectedValueOnce(new Error("fail")) // file 2 fails
          .mockResolvedValueOnce(undefined), // retry file 2 ok
      });
      const { attachments, addFiles, uploadAll } = useFeedbackAttachments(deps);
      await addFiles([
        makeFile("a.jpg", 100, "image/jpeg"),
        makeFile("b.jpg", 100, "image/jpeg"),
      ]);

      await uploadAll("feed-99");
      expect(attachments.value[1].status).toBe("error");

      const erroredId = attachments.value[1].id;
      const retryResult = await uploadAll("feed-99", [erroredId]);

      expect(retryResult).toBe(true);
      expect(attachments.value[1].status).toBe("done");
      expect(deps.uploadAttachment).toHaveBeenCalledTimes(3);
      // All calls use the same feedbackId
      const calls = (deps.uploadAttachment as ReturnType<typeof vi.fn>).mock
        .calls;
      expect(calls.every((c: unknown[]) => c[0] === "feed-99")).toBe(true);
    });
  });

  describe("uploadAll — only queued files are targeted by default", () => {
    it("does not re-upload already done files", async () => {
      const deps = makeDeps({
        downscale: vi
          .fn()
          .mockResolvedValue({ blob: makeBlob(50, "image/jpeg") }),
        uploadAttachment: vi.fn().mockResolvedValue(undefined),
      });
      const { attachments, addFiles, uploadAll } = useFeedbackAttachments(deps);
      await addFiles([makeFile("a.jpg", 100, "image/jpeg")]);

      await uploadAll("feed-1");
      expect(attachments.value[0].status).toBe("done");

      vi.clearAllMocks();
      await uploadAll("feed-1");

      expect(deps.uploadAttachment).not.toHaveBeenCalled();
    });
  });
});
