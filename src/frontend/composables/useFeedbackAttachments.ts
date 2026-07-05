import { ref, computed } from "vue";
import type { Ref, ComputedRef } from "vue";
import { axiosInstance } from "@/service/http";
import type {
  SubmitAttachmentRequest,
  SubmitAttachmentResponse,
} from "@shared/model";

export const FEEDBACK_ATTACHMENT_LIMITS = {
  maxCount: 3,
  maxEdgePx: 1600,
  jpegQuality: 0.8,
  allowedInputMimeTypes: ["image/png", "image/jpeg", "image/webp"],
  outputMimeType: "image/jpeg",
} as const;

export type AttachmentStatus = "queued" | "uploading" | "done" | "error";

export interface AttachmentItem {
  id: string;
  name: string;
  previewUrl: string;
  blob: Blob;
  origBytes: number;
  scaledBytes: number;
  status: AttachmentStatus;
  error?: string;
}

export type Downscaler = (file: File) => Promise<Blob | null>;

export interface UseFeedbackAttachments {
  items: Ref<readonly AttachmentItem[]>;
  count: ComputedRef<number>;
  isFull: ComputedRef<boolean>;
  lastError: Ref<string>;
  totalOrigBytes: ComputedRef<number>;
  totalScaledBytes: ComputedRef<number>;
  addFiles(files: FileList | File[]): Promise<void>;
  remove(id: string): void;
  clear(): void;
  hasQueued: ComputedRef<boolean>;
  uploadAll(feedbackId: string): Promise<boolean>;
}

/**
 * Returns null if acceptable, else a user-facing rejection message.
 */
export function rejectReason(
  file: { type: string; name: string },
  currentCount: number,
): string | null {
  if (currentCount >= FEEDBACK_ATTACHMENT_LIMITS.maxCount) {
    return `You can attach at most ${FEEDBACK_ATTACHMENT_LIMITS.maxCount} images.`;
  }
  const allowed: readonly string[] =
    FEEDBACK_ATTACHMENT_LIMITS.allowedInputMimeTypes;
  if (!allowed.includes(file.type)) {
    return `${file.name} — only PNG, JPG and WebP images can be attached.`;
  }
  return null;
}

/**
 * Converts a Blob to a raw base64 string (no data-URI prefix).
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result is "data:<mime>;base64,<data>" — strip the prefix
      const commaIndex = result.indexOf(",");
      resolve(result.slice(commaIndex + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Maps an upload failure to a per-thumb user-facing message.
 */
export function uploadErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "response" in err) {
    const response = (
      err as { response?: { status?: number; data?: { error?: string } } }
    ).response;
    if (response) {
      const status = response.status ?? 0;
      if (status === 413) {
        return "Image is too large — try a smaller screenshot.";
      }
      if (status === 400) {
        const msg = response.data?.error ?? "";
        if (
          msg.toLowerCase().includes("size") ||
          msg.toLowerCase().includes("large")
        ) {
          return "Image is too large — try a smaller screenshot.";
        }
        return msg || "This image was rejected.";
      }
      if (status >= 400 && status < 500) {
        return response.data?.error || "This image was rejected.";
      }
    }
  }
  return "Upload failed — check your connection and retry.";
}

/**
 * Draws the source image onto an offscreen <canvas> scaled so the longest edge
 * is <= maxEdgePx (never upscales), then encodes to JPEG at quality 0.8.
 * Resolves null if the image cannot be decoded.
 */
export async function canvasDownscale(file: File): Promise<Blob | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      const { naturalWidth: w, naturalHeight: h } = img;
      const maxEdge = FEEDBACK_ATTACHMENT_LIMITS.maxEdgePx;
      const longestEdge = Math.max(w, h);
      const scale = longestEdge > maxEdge ? maxEdge / longestEdge : 1;

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }

      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => resolve(blob),
        FEEDBACK_ATTACHMENT_LIMITS.outputMimeType,
        FEEDBACK_ATTACHMENT_LIMITS.jpegQuality,
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(null);
    };

    img.src = objectUrl;
  });
}

async function defaultUploadOne(
  feedbackId: string,
  item: AttachmentItem,
): Promise<void> {
  const base64 = await blobToBase64(item.blob);
  const body: SubmitAttachmentRequest = {
    image: base64,
    mimeType: FEEDBACK_ATTACHMENT_LIMITS.outputMimeType,
  };
  await axiosInstance.post<SubmitAttachmentResponse>(
    `/api/feedback/${feedbackId}/attachments`,
    body,
  );
}

export function useFeedbackAttachments(deps?: {
  downscale?: Downscaler;
  uploadOne?: (feedbackId: string, item: AttachmentItem) => Promise<void>;
}): UseFeedbackAttachments {
  const downscale = deps?.downscale ?? canvasDownscale;
  const uploadOneFn = deps?.uploadOne ?? defaultUploadOne;

  const items = ref<AttachmentItem[]>([]);
  const lastError = ref("");

  const count = computed(() => items.value.length);
  const isFull = computed(
    () => items.value.length >= FEEDBACK_ATTACHMENT_LIMITS.maxCount,
  );
  const hasQueued = computed(() =>
    items.value.some((i) => i.status === "queued" || i.status === "error"),
  );
  const totalOrigBytes = computed(() =>
    items.value.reduce((sum, i) => sum + i.origBytes, 0),
  );
  const totalScaledBytes = computed(() =>
    items.value.reduce((sum, i) => sum + i.scaledBytes, 0),
  );

  async function addFiles(files: FileList | File[]): Promise<void> {
    const fileArray = Array.from(files);
    lastError.value = "";

    for (const file of fileArray) {
      const rejection = rejectReason(file, items.value.length);
      if (rejection) {
        lastError.value = rejection;
        // If the rejection is "too many", stop processing further files
        if (items.value.length >= FEEDBACK_ATTACHMENT_LIMITS.maxCount) {
          break;
        }
        continue;
      }

      const blob = await downscale(file);
      if (!blob) {
        lastError.value = `${file.name} — could not read this image.`;
        continue;
      }

      const previewUrl = URL.createObjectURL(blob);
      const item: AttachmentItem = {
        id: crypto.randomUUID(),
        name: file.name,
        previewUrl,
        blob,
        origBytes: file.size,
        scaledBytes: blob.size,
        status: "queued",
      };
      items.value = [...items.value, item];
    }
  }

  function remove(id: string): void {
    const idx = items.value.findIndex((i) => i.id === id);
    if (idx === -1) return;
    URL.revokeObjectURL(items.value[idx].previewUrl);
    items.value = items.value.filter((i) => i.id !== id);
  }

  function clear(): void {
    for (const item of items.value) {
      URL.revokeObjectURL(item.previewUrl);
    }
    items.value = [];
    lastError.value = "";
  }

  async function uploadAll(feedbackId: string): Promise<boolean> {
    const targets = items.value.filter(
      (i) => i.status === "queued" || i.status === "error",
    );

    let allDone = true;

    for (const item of targets) {
      // Update status to uploading
      items.value = items.value.map((i) =>
        i.id === item.id
          ? { ...i, status: "uploading" as AttachmentStatus }
          : i,
      );

      try {
        await uploadOneFn(feedbackId, item);
        items.value = items.value.map((i) =>
          i.id === item.id
            ? { ...i, status: "done" as AttachmentStatus, error: undefined }
            : i,
        );
      } catch (err) {
        const msg = uploadErrorMessage(err);
        items.value = items.value.map((i) =>
          i.id === item.id
            ? { ...i, status: "error" as AttachmentStatus, error: msg }
            : i,
        );
        allDone = false;
      }
    }

    return allDone;
  }

  return {
    items: items as Ref<readonly AttachmentItem[]>,
    count,
    isFull,
    lastError,
    totalOrigBytes,
    totalScaledBytes,
    addFiles,
    remove,
    clear,
    hasQueued,
    uploadAll,
  };
}
