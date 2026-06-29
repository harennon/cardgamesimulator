<script setup lang="ts">
import { ref } from "vue";
import { useRoute } from "vue-router";
import { axiosInstance } from "@/service/http";
import type { FeedbackCategory, SubmitFeedbackResponse } from "@shared/model";
import { restoreGuestSession } from "@/service/guestService";
import { getSession } from "@/service/authService";
import { useFeedbackContext } from "@/composables/useFeedbackContext";

const isOpen = ref(false);
const category = ref<FeedbackCategory>("bug");
const description = ref("");
const submitting = ref(false);
const errorMessage = ref("");
const showToast = ref(false);

const route = useRoute();

function openModal() {
  isOpen.value = true;
  errorMessage.value = "";
}

function closeModal() {
  isOpen.value = false;
  category.value = "bug";
  description.value = "";
  errorMessage.value = "";
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

  try {
    await axiosInstance.post<SubmitFeedbackResponse>("/api/feedback", {
      category: category.value,
      description: description.value,
      metadata: await buildMetadata(),
    });
    closeModal();
    showToast.value = true;
    setTimeout(() => {
      showToast.value = false;
    }, 3000);
  } catch {
    errorMessage.value = "Failed to submit. Please try again.";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="feedback-widget">
    <button
      v-if="!isOpen"
      class="feedback-widget__trigger"
      aria-label="Send feedback"
      data-testid="feedback-trigger"
      @click="openModal"
    >
      Feedback
    </button>

    <div
      v-if="isOpen"
      class="feedback-widget__overlay"
      @click.self="closeModal"
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
.feedback-widget__trigger {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 1000;
  font-family: var(--font-ui);
  font-size: 0.85rem;
  background: var(--table-rim);
  color: var(--gold-accent);
  border: 1px solid var(--gold-accent);
  border-radius: 6px;
  padding: 8px 16px;
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.feedback-widget__trigger:hover {
  background: var(--gold-accent);
  color: var(--bg-dark);
}

.feedback-widget__overlay {
  position: fixed;
  inset: 0;
  z-index: 1001;
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
  z-index: 1002;
  background: var(--table-rim);
  color: var(--gold-accent);
  border: 1px solid var(--gold-accent);
  border-radius: 6px;
  padding: 10px 20px;
  font-family: var(--font-ui);
  font-size: 0.9rem;
}
</style>
