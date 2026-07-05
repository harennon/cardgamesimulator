import { ref, computed } from "vue";
import type { Ref, ComputedRef } from "vue";

export type AttachmentStatus = "queued" | "uploading" | "done" | "error";

export interface Attachment {
  id: string;
  name: string;
  previewUrl: string;
  blob: Blob;
  origBytes: number;
  scaledBytes: number;
  status: AttachmentStatus;
}

export interface DownscaleResult {
  blob: Blob;
}

export interface FeedbackAttachmentDeps {
  downscale: (
    file: Blob,
    maxEdge: number,
    quality: number,
  ) => Promise<DownscaleResult | null>;
  uploadAttachment: (
    feedbackId: string,
    image: string,
    mimeType: string,
  ) => Promise<void>;
  createObjectURL: (b: Blob) => string;
  revokeObjectURL: (u: string) => void;
  blobToBase64: (b: Blob) => Promise<string>;
}

export const ATTACH_CAPS = {
  maxFiles: 3,
  maxBytes: 5 * 1024 * 1024,
  allowedTypes: ["image/png", "image/jpeg", "image/webp"] as const,
  maxEdge: 1600,
  quality: 0.8,
} as const;

export interface UseFeedbackAttachments {
  attachments: Ref<Attachment[]>;
  attachError: Ref<string>;
  isFull: ComputedRef<boolean>;
  canAddMore: ComputedRef<boolean>;
  addFiles(files: FileList | File[]): Promise<void>;
  remove(id: string): void;
  reset(): void;
  uploadAll(feedbackId: string, onlyIds?: string[]): Promise<boolean>;
}

function defaultDownscale(
  file: Blob,
  maxEdge: number,
  quality: number,
): Promise<DownscaleResult | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const { width, height } = img;
      const longest = Math.max(width, height);
      const scale = longest > maxEdge ? maxEdge / longest : 1;
      const targetW = Math.round(width * scale);
      const targetH = Math.round(height * scale);

      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, 0, 0, targetW, targetH);

      canvas.toBlob(
        (jpegBlob) => {
          if (!jpegBlob) {
            resolve(null);
            return;
          }
          // E-Reencode: if jpeg is larger than original, keep original
          if (jpegBlob.size > file.size) {
            resolve({ blob: new Blob([file], { type: file.type }) });
          } else {
            resolve({ blob: jpegBlob });
          }
        },
        "image/jpeg",
        quality,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

function defaultBlobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip "data:<mime>;base64," prefix
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("FileReader failed"));
    reader.readAsDataURL(b);
  });
}

async function defaultUploadAttachment(
  feedbackId: string,
  image: string,
  mimeType: string,
): Promise<void> {
  const { axiosInstance } = await import("@/service/http");
  await axiosInstance.post(`/api/feedback/${feedbackId}/attachments`, {
    image,
    mimeType,
  });
}

export function useFeedbackAttachments(
  deps?: Partial<FeedbackAttachmentDeps>,
): UseFeedbackAttachments {
  const downscale = deps?.downscale ?? defaultDownscale;
  const uploadAttachment = deps?.uploadAttachment ?? defaultUploadAttachment;
  const createObjectURL =
    deps?.createObjectURL ?? URL.createObjectURL.bind(URL);
  const revokeObjectURL =
    deps?.revokeObjectURL ?? URL.revokeObjectURL.bind(URL);
  const blobToBase64 = deps?.blobToBase64 ?? defaultBlobToBase64;

  const attachments = ref<Attachment[]>([]);
  const attachError = ref("");

  const isFull = computed(
    () => attachments.value.length >= ATTACH_CAPS.maxFiles,
  );
  const canAddMore = computed(() => !isFull.value);

  async function addFiles(files: FileList | File[]): Promise<void> {
    const fileArray = Array.from(files);
    for (const file of fileArray) {
      if (attachments.value.length >= ATTACH_CAPS.maxFiles) {
        attachError.value = "You can attach at most 3 images.";
        break;
      }

      const allowed = (ATTACH_CAPS.allowedTypes as readonly string[]).includes(
        file.type,
      );
      if (!allowed) {
        attachError.value = `${file.name} — only PNG, JPG and WebP images can be attached.`;
        continue;
      }

      const result = await downscale(
        file,
        ATTACH_CAPS.maxEdge,
        ATTACH_CAPS.quality,
      );
      if (result === null) {
        attachError.value = `${file.name} — could not read this image.`;
        continue;
      }

      if (result.blob.size > ATTACH_CAPS.maxBytes) {
        attachError.value = `${file.name} — still over 5 MB after resizing.`;
        continue;
      }

      const id = crypto.randomUUID();
      const previewUrl = createObjectURL(result.blob);
      attachments.value = [
        ...attachments.value,
        {
          id,
          name: file.name,
          previewUrl,
          blob: result.blob,
          origBytes: file.size,
          scaledBytes: result.blob.size,
          status: "queued",
        },
      ];
    }
  }

  function remove(id: string): void {
    const idx = attachments.value.findIndex((a) => a.id === id);
    if (idx === -1) return;
    const attachment = attachments.value[idx];
    if (attachment.status === "uploading") return;
    revokeObjectURL(attachment.previewUrl);
    attachments.value = attachments.value.filter((a) => a.id !== id);
  }

  function reset(): void {
    for (const a of attachments.value) {
      revokeObjectURL(a.previewUrl);
    }
    attachments.value = [];
    attachError.value = "";
  }

  async function uploadAll(
    feedbackId: string,
    onlyIds?: string[],
  ): Promise<boolean> {
    const targets = onlyIds
      ? attachments.value.filter(
          (a) => onlyIds.includes(a.id) && a.status !== "uploading",
        )
      : attachments.value.filter((a) => a.status === "queued");

    let allDone = true;

    for (const attachment of targets) {
      setStatus(attachment.id, "uploading");
      try {
        const base64 = await blobToBase64(attachment.blob);
        const mimeType = attachment.blob.type || "image/jpeg";
        await uploadAttachment(feedbackId, base64, mimeType);
        setStatus(attachment.id, "done");
      } catch {
        setStatus(attachment.id, "error");
        allDone = false;
      }
    }

    return allDone;
  }

  function setStatus(id: string, status: AttachmentStatus): void {
    attachments.value = attachments.value.map((a) =>
      a.id === id ? { ...a, status } : a,
    );
  }

  return {
    attachments,
    attachError,
    isFull,
    canAddMore,
    addFiles,
    remove,
    reset,
    uploadAll,
  };
}
