<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { useRoute } from "vue-router";
import { axiosInstance } from "@/service/http";
import type { FeedbackCategory, SubmitFeedbackResponse } from "@shared/model";
import { restoreGuestSession } from "@/service/guestService";
import { getSession } from "@/service/authService";
import { useFeedbackContext } from "@/composables/useFeedbackContext";
import { useFeedbackAttachments } from "@/composables/useFeedbackAttachments";

const isOpen = ref(false);
const category = ref<FeedbackCategory>("bug");
const description = ref("");
const submitting = ref(false);
const errorMessage = ref("");
const showToast = ref(false);
const feedbackId = ref<string | null>(null);
const isDragover = ref(false);

const route = useRoute();

const {
  attachments,
  attachError,
  isFull,
  canAddMore,
  addFiles,
  remove,
  reset,
  uploadAll,
} = useFeedbackAttachments();

const fileInputRef = ref<HTMLInputElement | null>(null);

function openModal() {
  isOpen.value = true;
  errorMessage.value = "";
  feedbackId.value = null;
}

function closeModal() {
  isOpen.value = false;
  category.value = "bug";
  description.value = "";
  errorMessage.value = "";
  feedbackId.value = null;
  reset();
}

async function buildMetadata() {
  let session = null;
  try {
    session = await getSession();
  } catch {
    session = null;
  }
  const guestSession = restoreGuestSession();
  const { gamePhase } = useFeedbackContext();
  return {
    route: route.fullPath,
    gameId: (route.params.gameId as string) || undefined,
    gamePhase: gamePhase.value,
    userType: guestSession ? "guest" : "registered",
    authState: session ? "authenticated" : "anonymous",
    browser: navigator.userAgent.slice(0, 200),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    timestamp: new Date().toISOString(),
  };
}

async function submit() {
  if (description.value.trim().length === 0) return;

  submitting.value = true;
  errorMessage.value = "";
  attachError.value = "";

  // Phase 1: POST feedback row (only if no id yet — avoids duplicate on retry)
  if (!feedbackId.value) {
    try {
      const res = await axiosInstance.post<SubmitFeedbackResponse>(
        "/api/feedback",
        {
          category: category.value,
          description: description.value,
          metadata: await buildMetadata(),
        },
      );
      feedbackId.value = res.data.id;
    } catch {
      errorMessage.value = "Failed to submit. Please try again.";
      submitting.value = false;
      return;
    }
  }

  // Phase 2: upload attachments (if any queued)
  const queued = attachments.value.filter((a) => a.status === "queued");
  if (queued.length === 0) {
    closeModal();
    showToastBriefly();
    submitting.value = false;
    return;
  }

  const allDone = await uploadAll(feedbackId.value!);

  if (allDone) {
    closeModal();
    showToastBriefly();
  } else {
    attachError.value =
      "Some attachments failed to upload. Retry or remove them.";
  }

  submitting.value = false;
}

async function retryAttachment(id: string) {
  if (!feedbackId.value) return;
  // Re-mark the errored file as queued before retry
  const a = attachments.value.find((x) => x.id === id);
  if (!a || a.status !== "error") return;
  a.status = "queued";
  attachError.value = "";
  submitting.value = true;
  const allDone = await uploadAll(feedbackId.value, [id]);
  if (!allDone) {
    attachError.value =
      "Some attachments failed to upload. Retry or remove them.";
  } else if (attachments.value.every((x) => x.status === "done")) {
    closeModal();
    showToastBriefly();
  }
  submitting.value = false;
}

function showToastBriefly() {
  showToast.value = true;
  setTimeout(() => {
    showToast.value = false;
  }, 3000);
}

function onDropzoneClick() {
  if (!canAddMore.value) return;
  fileInputRef.value?.click();
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!input.files?.length) return;
  await addFiles(input.files);
  input.value = "";
}

function onDragover(event: DragEvent) {
  event.preventDefault();
  isDragover.value = true;
}

function onDragleave(event: DragEvent) {
  // E12: ignore dragleave when relatedTarget is still inside the modal
  const modal = event.currentTarget as HTMLElement;
  if (modal.contains(event.relatedTarget as Node)) return;
  isDragover.value = false;
}

async function onDrop(event: DragEvent) {
  event.preventDefault();
  isDragover.value = false;
  if (!event.dataTransfer?.files.length) return;
  await addFiles(event.dataTransfer.files);
}

async function onPaste(event: ClipboardEvent) {
  if (!isOpen.value) return;
  const items = Array.from(event.clipboardData?.items ?? []);
  const imageItems = items.filter((item) => item.type.startsWith("image/"));
  if (imageItems.length === 0) return; // E10: let text paste through normally
  event.preventDefault();
  const files = imageItems
    .map((item) => item.getAsFile())
    .filter((f): f is File => f !== null)
    .map((f) => new File([f], "pasted-image.png", { type: f.type }));
  await addFiles(files);
}

onMounted(() => {
  document.addEventListener("paste", onPaste);
});

onUnmounted(() => {
  document.removeEventListener("paste", onPaste);
});

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// The floating trigger now lives in HelpCluster (LLD 111 §3.5 Option A). This
// component owns only the modal + submit + toast; the parent opens it and reads
// `isOpen` so it can hide its bug-icon trigger while the modal is up.
defineExpose({ open: openModal, isOpen });
</script>

<template>
  <div class="feedback-widget">
    <div
      v-if="isOpen"
      class="feedback-widget__overlay"
      @click.self="closeModal"
      @dragover="onDragover"
      @dragleave="onDragleave"
      @drop="onDrop"
      :class="{ 'is-dragover': isDragover }"
    >
      <div class="feedback-widget__modal" data-testid="feedback-modal">
        <h3 class="feedback-widget__title">Send Feedback</h3>

        <label class="feedback-widget__label">
          Category
          <select
            v-model="category"
            class="feedback-widget__select"
            data-testid="feedback-category"
          >
            <option value="bug">Bug</option>
            <option value="confusing-ux">Confusing UX</option>
            <option value="feature-request">Feature Request</option>
            <option value="other">Other</option>
          </select>
        </label>

        <label class="feedback-widget__label">
          Description
          <textarea
            v-model="description"
            class="feedback-widget__textarea"
            data-testid="feedback-description"
            maxlength="500"
            placeholder="Describe what happened..."
            rows="4"
          />
          <span class="feedback-widget__charcount">
            {{ description.length }}/500
          </span>
        </label>

        <!-- Attachment block: between Description and Actions -->
        <div class="feedback-widget__attach">
          <div class="feedback-widget__attach-header">
            <span class="feedback-widget__attach-label">
              <svg
                class="feedback-widget__attach-icon"
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <rect
                  x="1"
                  y="3"
                  width="14"
                  height="10"
                  rx="1.5"
                  stroke="currentColor"
                  stroke-width="1.3"
                />
                <circle cx="5.5" cy="6.5" r="1.5" fill="currentColor" />
                <path
                  d="M1 11l4-3 3 2.5 2.5-2L15 11"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linejoin="round"
                />
              </svg>
              Screenshots (optional)
            </span>
            <span
              class="feedback-widget__attach-count"
              :class="{ 'is-max': isFull }"
              data-testid="feedback-attach-count"
            >
              {{ attachments.length }} / 3
            </span>
          </div>

          <!-- Thumbnail row -->
          <div v-if="attachments.length > 0" class="feedback-widget__thumbs">
            <div
              v-for="a in attachments"
              :key="a.id"
              class="feedback-widget__thumb"
              :class="`is-${a.status}`"
              data-testid="feedback-thumb"
            >
              <img
                :src="a.previewUrl"
                :alt="a.name"
                class="feedback-widget__thumb-img"
              />

              <!-- uploading overlay -->
              <div
                v-if="a.status === 'uploading'"
                class="feedback-widget__thumb-overlay"
              >
                <span class="feedback-widget__spinner" />
              </div>

              <!-- done badge -->
              <div
                v-if="a.status === 'done'"
                class="feedback-widget__thumb-done"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M2 6l3 3 5-5"
                    stroke="#4caf50"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </div>

              <!-- error overlay -->
              <div
                v-if="a.status === 'error'"
                class="feedback-widget__thumb-overlay feedback-widget__thumb-overlay--error"
              >
                <span class="feedback-widget__thumb-error-msg"
                  >Upload failed</span
                >
                <button
                  class="feedback-widget__thumb-retry"
                  data-testid="feedback-thumb-retry"
                  @click.stop="retryAttachment(a.id)"
                >
                  Retry
                </button>
              </div>

              <!-- remove button (disabled while uploading) -->
              <button
                v-if="a.status !== 'uploading'"
                class="feedback-widget__thumb-remove"
                data-testid="feedback-thumb-remove"
                :aria-label="`Remove ${a.name}`"
                @click.stop="remove(a.id)"
              >
                ×
              </button>
            </div>
          </div>

          <!-- Downscale meta line -->
          <p
            v-if="attachments.some((a) => a.origBytes !== a.scaledBytes)"
            class="feedback-widget__attach-meta"
          >
            Auto-resized to 1600px max ·
            {{ formatMB(attachments.reduce((s, a) => s + a.origBytes, 0)) }} →
            {{ formatMB(attachments.reduce((s, a) => s + a.scaledBytes, 0)) }}
            before upload
          </p>

          <!-- Drop zone -->
          <div
            class="feedback-widget__dropzone"
            :class="{
              'is-disabled': isFull,
              'is-dragover': isDragover && !isFull,
            }"
            data-testid="feedback-dropzone"
            @click="onDropzoneClick"
          >
            <svg
              class="feedback-widget__dropzone-icon"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M12 16V8M12 8l-3 3M12 8l3 3"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M5 20h14"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
              />
            </svg>
            <span v-if="!isFull" class="feedback-widget__dropzone-text">
              Click to upload or drag &amp; drop
              <span class="feedback-widget__dropzone-hint">
                or paste with Ctrl+V · PNG, JPG, WebP · up to 3
              </span>
            </span>
            <span
              v-else
              class="feedback-widget__dropzone-text feedback-widget__dropzone-text--max"
            >
              Maximum of 3 images reached — remove one to add another
            </span>
          </div>

          <input
            ref="fileInputRef"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            class="feedback-widget__file-input"
            data-testid="feedback-file-input"
            @change="onFileChange"
          />

          <!-- Attachment-level error -->
          <div
            v-if="attachError"
            class="feedback-widget__attach-error"
            data-testid="feedback-attach-error"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle
                cx="6"
                cy="6"
                r="5.25"
                stroke="#e05555"
                stroke-width="1.5"
              />
              <path
                d="M6 4v3"
                stroke="#e05555"
                stroke-width="1.5"
                stroke-linecap="round"
              />
              <circle cx="6" cy="8.5" r="0.5" fill="#e05555" />
            </svg>
            {{ attachError }}
          </div>
        </div>

        <div v-if="errorMessage" class="feedback-widget__error">
          {{ errorMessage }}
        </div>

        <div class="feedback-widget__actions">
          <button
            class="feedback-widget__btn feedback-widget__btn--cancel"
            :disabled="submitting"
            @click="closeModal"
          >
            Cancel
          </button>
          <button
            class="feedback-widget__btn feedback-widget__btn--submit"
            data-testid="feedback-submit"
            :disabled="submitting || description.trim().length === 0"
            @click="submit"
          >
            <span
              v-if="submitting"
              class="feedback-widget__spinner feedback-widget__spinner--inline"
            />
            {{ submitting ? "Sending…" : "Submit" }}
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="showToast"
      class="feedback-widget__toast"
      data-testid="feedback-toast"
    >
      Thanks for your feedback!
    </div>
  </div>
</template>

<style scoped>
.feedback-widget__overlay {
  position: fixed;
  inset: 0;
  z-index: 1101;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
}

.feedback-widget__modal {
  background: var(--bg-card, #1a1008);
  border: 1px solid var(--table-rim-light, #4a3520);
  border-radius: 8px;
  padding: 24px;
  width: 100%;
  max-width: 420px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: 90vh;
  overflow-y: auto;
}

.feedback-widget__title {
  font-family: var(--font-ui);
  font-size: 1.1rem;
  color: var(--gold-accent);
  margin: 0;
}

.feedback-widget__label {
  font-family: var(--font-ui);
  font-size: 0.85rem;
  color: var(--text-primary);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.feedback-widget__select,
.feedback-widget__textarea {
  font-family: var(--font-ui);
  font-size: 0.9rem;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--table-rim-light, #4a3520);
  border-radius: 4px;
  color: var(--text-primary);
  padding: 8px;
  resize: vertical;
}

.feedback-widget__charcount {
  font-size: 0.75rem;
  color: var(--text-muted);
  text-align: right;
}

.feedback-widget__error {
  font-family: var(--font-ui);
  font-size: 0.85rem;
  color: #e05555;
}

.feedback-widget__actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.feedback-widget__btn {
  font-family: var(--font-ui);
  font-size: 0.85rem;
  border-radius: 4px;
  padding: 8px 18px;
  cursor: pointer;
  transition: opacity 0.15s ease;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.feedback-widget__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.feedback-widget__btn--cancel {
  background: transparent;
  border: 1px solid var(--text-muted);
  color: var(--text-muted);
}

.feedback-widget__btn--submit {
  background: var(--gold-accent);
  border: 1px solid var(--gold-accent);
  color: var(--bg-dark);
  font-weight: 600;
}

.feedback-widget__toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1102;
  background: var(--table-rim);
  color: var(--gold-accent);
  border: 1px solid var(--gold-accent);
  border-radius: 6px;
  padding: 10px 20px;
  font-family: var(--font-ui);
  font-size: 0.9rem;
}

/* ── Attachment block ───────────────────────────────────────────────────── */

.feedback-widget__attach {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.feedback-widget__attach-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-family: var(--font-ui);
  font-size: 0.8rem;
  color: var(--text-muted);
}

.feedback-widget__attach-label {
  display: flex;
  align-items: center;
  gap: 5px;
}

.feedback-widget__attach-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.feedback-widget__attach-count {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.feedback-widget__attach-count.is-max {
  color: var(--gold-accent);
}

/* ── Thumbnails ─────────────────────────────────────────────────────────── */

.feedback-widget__thumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.feedback-widget__thumb {
  position: relative;
  width: 74px;
  height: 74px;
  border-radius: 6px;
  overflow: hidden;
  border: 1.5px solid var(--table-rim-light, #4a3520);
  flex-shrink: 0;
}

.feedback-widget__thumb.is-error {
  border-color: #e05555;
}

.feedback-widget__thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.feedback-widget__thumb-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.feedback-widget__thumb-overlay--error {
  background: rgba(60, 0, 0, 0.7);
}

.feedback-widget__thumb-error-msg {
  font-family: var(--font-ui);
  font-size: 0.6rem;
  color: #e05555;
  text-align: center;
  line-height: 1.2;
  padding: 0 4px;
}

.feedback-widget__thumb-retry {
  font-family: var(--font-ui);
  font-size: 0.65rem;
  color: #ff9999;
  background: none;
  border: none;
  cursor: pointer;
  text-decoration: underline;
  padding: 0;
}

.feedback-widget__thumb-done {
  position: absolute;
  bottom: 4px;
  left: 4px;
  background: rgba(0, 0, 0, 0.6);
  border-radius: 50%;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.feedback-widget__thumb-remove {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.65);
  border: none;
  color: #fff;
  font-size: 0.85rem;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

/* ── Downscale meta ─────────────────────────────────────────────────────── */

.feedback-widget__attach-meta {
  font-family: var(--font-ui);
  font-size: 0.72rem;
  color: var(--text-muted);
  margin: 0;
}

/* ── Drop zone ──────────────────────────────────────────────────────────── */

.feedback-widget__dropzone {
  border: 1.5px dashed var(--table-rim-light, #4a3520);
  border-radius: 6px;
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s,
    transform 0.12s;
  text-align: center;
  color: var(--text-muted);
}

.feedback-widget__dropzone:hover:not(.is-disabled) {
  border-color: var(--gold-accent);
  background: rgba(212, 175, 55, 0.04);
}

.feedback-widget__dropzone.is-dragover {
  border: 1.5px solid var(--gold-accent);
  background: rgba(212, 175, 55, 0.08);
  box-shadow: 0 0 8px rgba(212, 175, 55, 0.25);
  transform: scale(1.01);
}

.feedback-widget__dropzone.is-disabled {
  border-style: dotted;
  opacity: 0.45;
  cursor: not-allowed;
}

.feedback-widget__dropzone-icon {
  color: var(--text-muted);
}

.feedback-widget__dropzone-text {
  font-family: var(--font-ui);
  font-size: 0.8rem;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.feedback-widget__dropzone-text--max {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.feedback-widget__dropzone-hint {
  font-size: 0.72rem;
  color: var(--text-muted);
  opacity: 0.75;
}

.feedback-widget__file-input {
  display: none;
}

/* ── Attachment-level error ─────────────────────────────────────────────── */

.feedback-widget__attach-error {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  font-family: var(--font-ui);
  font-size: 0.8rem;
  color: #e05555;
  line-height: 1.4;
}

/* ── Spinner ────────────────────────────────────────────────────────────── */

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.feedback-widget__spinner {
  display: inline-block;
  width: 18px;
  height: 18px;
  border: 2px solid rgba(0, 0, 0, 0.2);
  border-top-color: rgba(0, 0, 0, 0.7);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}

.feedback-widget__spinner--inline {
  width: 12px;
  height: 12px;
}
</style>
