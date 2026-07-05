<script setup lang="ts">
import { ref } from "vue";
import { useRoute } from "vue-router";
import { axiosInstance } from "@/service/http";
import type { FeedbackCategory, SubmitFeedbackResponse } from "@shared/model";
import { restoreGuestSession } from "@/service/guestService";
import { getSession } from "@/service/authService";
import { useFeedbackContext } from "@/composables/useFeedbackContext";
import {
  useFeedbackAttachments,
  FEEDBACK_ATTACHMENT_LIMITS,
} from "@/composables/useFeedbackAttachments";

const isOpen = ref(false);
const category = ref<FeedbackCategory>("bug");
const description = ref("");
const submitting = ref(false);
const errorMessage = ref("");
const showToast = ref(false);

// Persists the feedback row id after the first successful POST so that a
// re-Submit after a partial upload failure retries attachments against the
// existing row rather than creating a duplicate.
const savedFeedbackId = ref<string | null>(null);

const route = useRoute();
const attach = useFeedbackAttachments();
const maxCount = FEEDBACK_ATTACHMENT_LIMITS.maxCount;

// Hidden file input ref
const fileInputRef = ref<HTMLInputElement | null>(null);

function openModal() {
  isOpen.value = true;
  errorMessage.value = "";
}

function closeModal() {
  isOpen.value = false;
  category.value = "bug";
  description.value = "";
  errorMessage.value = "";
  savedFeedbackId.value = null;
  attach.clear();
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

function onPickerClick() {
  if (attach.isFull.value) return;
  fileInputRef.value?.click();
}

function onFileInputChange(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files && input.files.length > 0) {
    void attach.addFiles(input.files);
    input.value = "";
  }
}

let isDragOver = ref(false);

function onDragOver(event: DragEvent) {
  if (attach.isFull.value) return;
  event.preventDefault();
  isDragOver.value = true;
}

function onDragLeave() {
  isDragOver.value = false;
}

function onDrop(event: DragEvent) {
  isDragOver.value = false;
  if (attach.isFull.value) return;
  event.preventDefault();
  const files = event.dataTransfer?.files;
  if (files && files.length > 0) {
    void attach.addFiles(files);
  }
}

function onPaste(event: ClipboardEvent) {
  const items = event.clipboardData?.items;
  if (!items) return;
  const imageItems: File[] = [];
  for (const item of Array.from(items)) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) imageItems.push(file);
    }
  }
  if (imageItems.length === 0) return;
  // Only intercept paste when clipboard carries images (CE6/CE7)
  event.preventDefault();
  if (!attach.isFull.value) {
    const namedFiles = imageItems.map((f, i) => {
      // Clipboard items often have a generic name; assign a meaningful one
      const ext = f.type.split("/")[1] ?? "png";
      return new File([f], f.name || `pasted-image-${i + 1}.${ext}`, {
        type: f.type,
      });
    });
    void attach.addFiles(namedFiles);
  }
}

async function submit() {
  if (description.value.trim().length === 0) return;
  if (submitting.value) return;

  submitting.value = true;
  errorMessage.value = "";

  // Only POST the feedback row when we don't already have a saved id from a
  // previous partial-failure attempt. This prevents duplicate rows on re-Submit.
  if (savedFeedbackId.value === null) {
    try {
      const resp = await axiosInstance.post<SubmitFeedbackResponse>(
        "/api/feedback",
        {
          category: category.value,
          description: description.value,
          metadata: await buildMetadata(),
        },
      );
      savedFeedbackId.value = resp.data.id;
    } catch {
      errorMessage.value = "Failed to submit. Please try again.";
      submitting.value = false;
      return;
    }
  }

  const feedbackId = savedFeedbackId.value!;

  if (attach.hasQueued.value) {
    const allDone = await attach.uploadAll(feedbackId);
    if (!allDone) {
      submitting.value = false;
      return;
    }
  }

  submitting.value = false;
  closeModal();
  showToast.value = true;
  setTimeout(() => {
    showToast.value = false;
  }, 3000);
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
      @paste="onPaste"
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

        <!-- Attachment block (LLD 155) -->
        <div class="attach">
          <div class="attach__head" :class="{ 'is-max': attach.isFull.value }">
            <span class="attach__label">Attachments</span>
            <span class="attach__count"
              >{{ attach.count.value }} / {{ maxCount }}</span
            >
          </div>

          <!-- Thumbnail strip -->
          <div v-if="attach.count.value > 0" class="thumbs">
            <div
              v-for="item in attach.items.value"
              :key="item.id"
              class="thumb"
              data-testid="feedback-thumb"
            >
              <img :src="item.previewUrl" :alt="item.name" class="thumb__img" />

              <!-- Uploading overlay -->
              <div
                v-if="item.status === 'uploading'"
                class="thumb__overlay thumb__overlay--uploading"
              >
                <span class="spinner" />
                <div class="thumb__bar" />
              </div>

              <!-- Done check -->
              <div v-if="item.status === 'done'" class="thumb__check">
                &#10003;
              </div>

              <!-- Error overlay -->
              <div
                v-if="item.status === 'error'"
                class="thumb__overlay thumb__overlay--error"
              >
                <span class="thumb__error-msg">{{ item.error }}</span>
              </div>

              <button
                class="thumb__remove"
                :disabled="submitting"
                data-testid="feedback-thumb-remove"
                @click="attach.remove(item.id)"
              >
                &times;
              </button>
            </div>
          </div>

          <!-- Downscale meta line -->
          <div v-if="attach.totalScaledBytes.value > 0" class="attach__meta">
            {{ Math.round(attach.totalOrigBytes.value / 1024) }} KB &rarr;
            {{ Math.round(attach.totalScaledBytes.value / 1024) }} KB
          </div>

          <!-- Drop zone / click to pick -->
          <div
            class="dropzone"
            :class="{
              'is-dragover': isDragOver,
              'is-disabled': attach.isFull.value,
            }"
            data-testid="feedback-dropzone"
            @click="onPickerClick"
            @dragover="onDragOver"
            @dragleave="onDragLeave"
            @drop="onDrop"
          >
            <span class="dropzone__hint">
              {{
                attach.isFull.value
                  ? "Max attachments reached"
                  : "Click, drop, or paste (Ctrl+V) to attach a screenshot"
              }}
            </span>
          </div>

          <!-- Hidden file input -->
          <input
            ref="fileInputRef"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            class="attach__file-input"
            data-testid="feedback-file-input"
            @change="onFileInputChange"
          />

          <!-- Transient rejection banner -->
          <div
            v-if="attach.lastError.value"
            class="attach__error"
            data-testid="feedback-attach-error"
          >
            {{ attach.lastError.value }}
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
            {{ submitting ? "Sending..." : "Submit" }}
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
  max-width: 400px;
  display: flex;
  flex-direction: column;
  gap: 16px;
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

/* ---- Attachment block ---- */

.attach {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.attach__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-family: var(--font-ui);
  font-size: 0.8rem;
  color: var(--text-muted);
}

.attach__head.is-max .attach__label {
  color: var(--gold-accent);
}

.attach__count {
  font-size: 0.75rem;
}

.thumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.thumb {
  position: relative;
  width: 72px;
  height: 72px;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--table-rim-light, #4a3520);
  background: rgba(0, 0, 0, 0.3);
}

.thumb__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb__remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  background: rgba(0, 0, 0, 0.65);
  border: none;
  border-radius: 50%;
  color: #fff;
  font-size: 11px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  padding: 0;
}

.thumb__remove:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.thumb__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.thumb__overlay--uploading {
  background: rgba(0, 0, 0, 0.5);
}

.thumb__overlay--error {
  background: rgba(160, 0, 0, 0.55);
  padding: 4px;
}

.thumb__error-msg {
  font-size: 0.6rem;
  color: #fff;
  text-align: center;
  word-break: break-word;
}

.thumb__check {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.4rem;
  color: #4caf50;
  background: rgba(0, 0, 0, 0.35);
}

/* Spinner */
.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* Indeterminate progress bar */
.thumb__bar {
  width: 80%;
  height: 3px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
  overflow: hidden;
  position: relative;
}

.thumb__bar::after {
  content: "";
  position: absolute;
  left: -40%;
  width: 40%;
  height: 100%;
  background: #fff;
  animation: indeterminate 1s linear infinite;
}

@keyframes indeterminate {
  to {
    left: 100%;
  }
}

.attach__meta {
  font-size: 0.72rem;
  color: var(--text-muted);
  font-family: var(--font-ui);
}

.dropzone {
  border: 1px dashed var(--table-rim-light, #4a3520);
  border-radius: 4px;
  padding: 10px 12px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}

.dropzone.is-dragover {
  border-color: var(--gold-accent);
  background: rgba(255, 200, 50, 0.06);
}

.dropzone.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.dropzone__hint {
  font-family: var(--font-ui);
  font-size: 0.78rem;
  color: var(--text-muted);
  pointer-events: none;
}

.attach__file-input {
  display: none;
}

.attach__error {
  font-family: var(--font-ui);
  font-size: 0.78rem;
  color: #e05555;
  background: rgba(224, 85, 85, 0.08);
  border-radius: 3px;
  padding: 4px 8px;
}
</style>
