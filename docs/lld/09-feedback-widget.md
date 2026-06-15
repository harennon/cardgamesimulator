# LLD 9: Feedback Widget

In-app feedback mechanism for playtesters. A floating button opens a modal where users can submit categorized feedback with auto-captured context. Submissions are stored in the database for direct querying (no admin UI in v1).

---

## 1. Scope

### In scope

- Floating "Feedback" button visible on all routes (bottom-right corner)
- Modal/drawer UI with category dropdown and free-text description
- Auto-capture of contextual metadata (route, game status, user type, browser/viewport)
- `POST /feedback` REST endpoint (accepts both authenticated and guest users)
- `Feedback` TypeORM entity for persistence
- `FeedbackRepository` interface and `PostgresDB` implementation
- `FeedbackService` for validation and submission
- Unit tests for the service layer (validation, metadata construction)
- Integration tests for the endpoint (happy path, validation failures, auth)
- Frontend Vue 3 component following existing patterns

### Out of scope

- Admin UI or dashboard for reading feedback (query the database directly)
- Email/notification on feedback submission
- Screenshot attachment or rich media
- Feedback voting, upvoting, or threading
- Rate limiting beyond basic server-side validation (acceptable for a small playtest group)
- Analytics or aggregation

---

## 2. Approach

### Key technical decisions

1. **Feedback is a standalone feature with no game engine coupling.** It does not touch game state, WebSocket events, or the engine layer. It is a pure REST + UI feature. This keeps it simple and independently deployable.

2. **Both guests and registered users can submit feedback.** The `authMiddleware` (which accepts both Supabase JWTs and guest tokens) protects the endpoint. The `userId` field on the entity is nullable: guests may have a temporary session ID stored, or null if their session has expired. Either way, the metadata captures `userType: "guest" | "registered"`.

3. **Metadata is a JSON column, not structured columns.** The auto-captured context (route, game status, browser info, viewport) is informational and may evolve. Storing it as a single `jsonb` column avoids schema migrations for every new field. The `category` and `description` remain as typed columns since they are always present and queryable.

4. **No debounce or rate-limit for v1.** The playtest group is small (< 20 users). If spam becomes an issue, add per-user rate-limiting later. The 500-character limit on description prevents large payloads.

5. **Frontend component is global (mounted in App.vue), not per-route.** The button and modal render at the App level so they survive route transitions. The component reads `useRoute()` to capture the current route path for metadata.

6. **Toast notification uses a simple reactive ref, not a toast library.** A transient "Thanks!" message shown for 3 seconds, then auto-hidden. No external dependency needed for a single toast pattern.

7. **Modal is rendered conditionally (v-if), not hidden with CSS.** This keeps the DOM clean when feedback is not being submitted.

---

## 3. Interfaces / Types

### Shared types (addition to `src/shared/model.ts`)

```typescript
export type FeedbackCategory = "bug" | "confusing-ux" | "feature-request" | "other";

export interface SubmitFeedbackRequest {
  category: FeedbackCategory;
  description: string; // 1-500 characters, required
}

export interface SubmitFeedbackResponse {
  id: string;
  createdAt: string; // ISO 8601
}
```

### Feedback entity (`src/backend/database/entities/Feedback.ts`)

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from "typeorm";
import type { FeedbackCategory } from "@shared/model";

@Entity("feedback")
export class Feedback {
  @PrimaryGeneratedColumn("uuid")
  id: string = "";

  @Column({ type: "varchar", length: 20 })
  category: FeedbackCategory = "other";

  @Column({ type: "varchar", length: 500 })
  description: string = "";

  @Column({ type: "jsonb", nullable: true })
  metadata: FeedbackMetadata | null = null;

  @Column({ type: "uuid", nullable: true })
  userId: string | null = null; // null for guests whose session expired

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date = new Date();
}
```

### FeedbackMetadata shape

```typescript
// Stored as JSON in the metadata column — not a separate table
export interface FeedbackMetadata {
  route: string;                           // e.g., "/game/abc123"
  gameId?: string;                         // if on a game route
  gameStatus?: string;                     // e.g., "IN_PROGRESS", "COMPLETED"
  userType: "guest" | "registered";
  browser: string;                         // navigator.userAgent (truncated to 200 chars)
  viewport: { width: number; height: number };
  timestamp: string;                       // ISO 8601 client-side timestamp
}
```

### FeedbackRepository (addition to `src/backend/database/database.ts`)

```typescript
export interface FeedbackRepository {
  createFeedback(feedback: Feedback): Promise<Feedback>;
}
```

### FeedbackService (`src/backend/service/feedbackService.ts`)

```typescript
import type { FeedbackRepository } from "@/database/database";
import type { FeedbackCategory } from "@shared/model";
import type { FeedbackMetadata } from "@/database/entities/Feedback";
import { Feedback } from "@/database/entities/Feedback";

export interface FeedbackInput {
  category: FeedbackCategory;
  description: string;
  metadata: FeedbackMetadata | null;
  userId: string | null;
}

export class FeedbackService {
  constructor(private readonly feedbackRepo: FeedbackRepository) {}

  async submitFeedback(input: FeedbackInput): Promise<Feedback> {
    this.validate(input);

    const feedback = new Feedback();
    feedback.category = input.category;
    feedback.description = input.description.trim();
    feedback.metadata = input.metadata;
    feedback.userId = input.userId;

    return this.feedbackRepo.createFeedback(feedback);
  }

  private validate(input: FeedbackInput): void {
    const validCategories: FeedbackCategory[] = [
      "bug", "confusing-ux", "feature-request", "other",
    ];
    if (!validCategories.includes(input.category)) {
      throw new ValidationError("Invalid category");
    }
    const trimmed = input.description?.trim() ?? "";
    if (trimmed.length === 0) {
      throw new ValidationError("Description is required");
    }
    if (trimmed.length > 500) {
      throw new ValidationError("Description must be 500 characters or fewer");
    }
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
```

---

## 4. Frontend Component Design

### Component tree

```
App.vue
  └── FeedbackWidget.vue (global, always mounted)
        ├── Feedback button (floating, bottom-right)
        ├── Feedback modal (v-if="isOpen")
        │     ├── Category <select>
        │     ├── Description <textarea>
        │     └── Submit / Cancel buttons
        └── Toast message (v-if="showToast")
```

### FeedbackWidget.vue

Location: `src/frontend/component/FeedbackWidget.vue`

```vue
<template>
  <div class="feedback-widget">
    <!-- Floating button -->
    <button
      v-if="!isOpen"
      class="feedback-widget__trigger"
      @click="openModal"
      aria-label="Send feedback"
    >
      Feedback
    </button>

    <!-- Modal overlay -->
    <div v-if="isOpen" class="feedback-widget__overlay" @click.self="closeModal">
      <div class="feedback-widget__modal">
        <h3 class="feedback-widget__title">Send Feedback</h3>

        <label class="feedback-widget__label">
          Category
          <select v-model="category" class="feedback-widget__select">
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
            @click="closeModal"
            :disabled="submitting"
          >
            Cancel
          </button>
          <button
            class="feedback-widget__btn feedback-widget__btn--submit"
            @click="submit"
            :disabled="submitting || description.trim().length === 0"
          >
            {{ submitting ? "Sending..." : "Submit" }}
          </button>
        </div>
      </div>
    </div>

    <!-- Toast -->
    <div v-if="showToast" class="feedback-widget__toast">
      Thanks for your feedback!
    </div>
  </div>
</template>
```

### Script logic (Composition API)

```typescript
import { ref } from "vue";
import { useRoute } from "vue-router";
import { axiosInstance } from "@/service/http";
import type { FeedbackCategory, SubmitFeedbackResponse } from "@shared/model";
import { getSession } from "@/service/authService";
import { restoreGuestSession } from "@/service/guestService";

// State
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
  // Reset form on close
  category.value = "bug";
  description.value = "";
  errorMessage.value = "";
}

function buildMetadata() {
  const session = restoreGuestSession();
  return {
    route: route.fullPath,
    gameId: (route.params.gameId as string) || undefined,
    userType: session ? "guest" : "registered",
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
    await axiosInstance.post<SubmitFeedbackResponse>("/feedback", {
      category: category.value,
      description: description.value,
      metadata: buildMetadata(),
    });
    closeModal();
    showToast.value = true;
    setTimeout(() => { showToast.value = false; }, 3000);
  } catch (err: unknown) {
    errorMessage.value = "Failed to submit. Please try again.";
  } finally {
    submitting.value = false;
  }
}
```

### Mounting in App.vue

Add `<FeedbackWidget />` as the last child in `App.vue`'s template, after `<router-view />`. This keeps it visible across all routes.

### Styling approach

- Floating button: `position: fixed; bottom: 20px; right: 20px; z-index: 1000;`
- Uses existing CSS variables from `game-variables.css` (`--gold-accent`, `--table-rim`, `--text-primary`, `--font-ui`)
- Modal: centered overlay with dark backdrop, max-width 400px
- Toast: fixed bottom-center, fades in/out with opacity transition
- Scoped styles within the component (matches existing pattern in `ActionPanel.vue`)

---

## 5. Backend Implementation

### POST /feedback handler (`src/backend/api/feedback/submitFeedback.ts`)

```typescript
import { type Request, type Response } from "@/util/types";
import { Handler } from "@/api/handler";
import type { SubmitFeedbackRequest, SubmitFeedbackResponse } from "@shared/model";
import { FeedbackService, ValidationError } from "@/service/feedbackService";
import { feedbackRepo } from "@/database";

export class SubmitFeedbackHandler extends Handler {
  public static INSTANCE: SubmitFeedbackHandler = new SubmitFeedbackHandler();
  private readonly feedbackService: FeedbackService;

  private constructor() {
    super();
    this.feedbackService = new FeedbackService(feedbackRepo);
  }

  public override async post(
    request: Request,
    response: Response<SubmitFeedbackResponse | { error: string }>,
  ) {
    const body = request.body as SubmitFeedbackRequest & { metadata?: unknown };
    const userId = request.userId ?? null; // null if auth somehow passed without userId

    try {
      const feedback = await this.feedbackService.submitFeedback({
        category: body.category,
        description: body.description,
        metadata: body.metadata as any ?? null,
        userId,
      });

      response.status(201).json({
        id: feedback.id,
        createdAt: feedback.createdAt.toISOString(),
      });
    } catch (err: unknown) {
      if (err instanceof ValidationError) {
        response.status(400).json({ error: err.message });
        return;
      }
      throw err; // Let errorHandler middleware handle unexpected errors
    }
  }
}
```

### PostgresDB addition

```typescript
// In src/backend/database/postgres.ts — add to the class:

public async createFeedback(feedback: Feedback): Promise<Feedback> {
  return this.dataSource!.getRepository(Feedback).save(feedback);
}
```

The `entities` array in the `DataSource` config must include the `Feedback` entity.

### Route registration in server.ts

```typescript
import { SubmitFeedbackHandler } from "@/api/feedback/submitFeedback";

// Register with authMiddleware (accepts both registered users and guests)
this.app.use("/feedback", authMiddleware, SubmitFeedbackHandler.INSTANCE.router);
```

### Database index addition (`src/backend/database/index.ts`)

```typescript
import type { FeedbackRepository } from "./database";

export const feedbackRepo: FeedbackRepository = PostgresDB.INSTANCE;
```

---

## 6. File Organization

```
New files:
  src/backend/database/entities/Feedback.ts      -- Feedback TypeORM entity
  src/backend/service/feedbackService.ts         -- Validation + submission service
  src/backend/api/feedback/submitFeedback.ts     -- POST /feedback handler
  src/frontend/component/FeedbackWidget.vue      -- Floating button + modal + toast
  tests/service/feedbackService.test.ts          -- Unit tests for FeedbackService
  tests/integration/feedback.test.ts             -- Integration tests for endpoint

Modified files:
  src/shared/model.ts                            -- Add FeedbackCategory, SubmitFeedbackRequest, SubmitFeedbackResponse
  src/backend/database/database.ts               -- Add FeedbackRepository interface
  src/backend/database/postgres.ts               -- Add createFeedback method, Feedback entity to DataSource
  src/backend/database/index.ts                  -- Export feedbackRepo
  src/backend/server.ts                          -- Register /feedback route
  src/frontend/component/App.vue                 -- Mount FeedbackWidget
  tests/integration/helpers/testServer.ts        -- Register /feedback route in test server
```

---

## 7. Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | Empty description submitted | Server returns 400 with `"Description is required"`. Frontend disables Submit when description is empty (belt and suspenders). |
| 2 | Description exceeds 500 characters | Frontend enforces `maxlength="500"` on textarea. Server validates and returns 400 if exceeded (handles modified requests). |
| 3 | Invalid category value | Server validates against the allowed set; returns 400 `"Invalid category"`. |
| 4 | Guest submits feedback after session expires | `authMiddleware` rejects with 401. Guest sees the error. Acceptable — sessions last 4 hours which covers typical playtests. |
| 5 | User submits feedback while offline / network error | Frontend shows "Failed to submit. Please try again." Error message. Modal stays open so user can retry. |
| 6 | User double-clicks submit | `submitting` ref disables the button during the request. Only one request fires. |
| 7 | Metadata fields missing (old client, JS error) | `metadata` column is nullable. If the frontend fails to build metadata, the submission still succeeds with `metadata: null`. |
| 8 | Very long userAgent string | Truncated to 200 characters client-side in `buildMetadata()`. |
| 9 | Modal open during route transition | Modal uses `useRoute()` reactively. If user navigates while modal is open, the route captured in metadata will be the new route on submit. This is acceptable — the route at submission time is what matters. |
| 10 | Database write failure | Handler lets the error propagate to `errorHandler` middleware which returns 500. Frontend shows generic error message. |

---

## 8. Dependencies

- **LLD 6 (Frontend Game UI)** -- component patterns, App.vue structure, composables, route setup
- **Existing infrastructure:**
  - `src/backend/api/handler.ts` -- Handler base class
  - `src/backend/database/database.ts` -- repository interface pattern
  - `src/backend/database/postgres.ts` -- PostgresDB implementation
  - `src/backend/middleware/authMiddleware.ts` -- auth middleware (guest + registered)
  - `src/backend/middleware/errorHandler.ts` -- error handling
  - `src/backend/server.ts` -- route registration
  - `src/frontend/service/http.ts` -- axios instance with auth interceptor
  - `src/frontend/routes.ts` -- vue-router setup
  - `tests/integration/helpers/testServer.ts` -- test server factory

---

## 9. Test Requirements

### Unit tests: FeedbackService (`tests/service/feedbackService.test.ts`)

| # | Test | What it verifies |
|---|------|------------------|
| 1 | Accepts valid feedback with all categories | Each of the 4 categories is accepted without error |
| 2 | Rejects empty description | Throws `ValidationError` with "Description is required" |
| 3 | Rejects whitespace-only description | Throws `ValidationError` (trimmed length is 0) |
| 4 | Rejects description over 500 characters | Throws `ValidationError` with length message |
| 5 | Rejects invalid category | Throws `ValidationError` with "Invalid category" |
| 6 | Trims description before saving | `feedbackRepo.createFeedback` called with trimmed text |
| 7 | Passes metadata through to repository | Metadata object stored as-is on the entity |
| 8 | Handles null userId (guest) | Entity created with `userId: null`, no error |
| 9 | Returns the created entity | Return value matches what the repository returns |

Test approach: mock `FeedbackRepository` (simple object with `createFeedback` spy). Construct inputs directly. Verify calls and thrown errors.

### Integration tests: Feedback endpoint (`tests/integration/feedback.test.ts`)

| # | Test | What it verifies |
|---|------|------------------|
| 1 | `POST /feedback` returns 201 with valid input | Happy path: registered user submits, gets `{ id, createdAt }` response |
| 2 | `POST /feedback` returns 201 for guest user | Guest token accepted, feedback stored with guest's userId |
| 3 | `POST /feedback` returns 400 for empty description | Validation error returned |
| 4 | `POST /feedback` returns 400 for invalid category | Validation error returned |
| 5 | `POST /feedback` returns 401 without auth token | Unauthenticated request rejected |
| 6 | Metadata is stored correctly | Submit with metadata, query DB directly, verify JSON contents |
| 7 | Description is trimmed | Submit with leading/trailing whitespace, verify stored value is trimmed |

Test approach: use `createTestServer()` from existing test infrastructure. Create a Supabase test user for authenticated requests. Use `supertest` for HTTP assertions. For guest tests, create a guest session first via `POST /guest/session`.
