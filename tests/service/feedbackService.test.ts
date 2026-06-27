import { describe, it, expect, vi } from "vitest";
import {
  FeedbackService,
  ValidationError,
} from "../../src/backend/service/feedbackService.js";
import type { FeedbackRepository } from "../../src/backend/database/database.js";
import { Feedback } from "../../src/backend/database/entities/Feedback.js";
import type { FeedbackInput } from "../../src/backend/service/feedbackService.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFeedbackRepo(
  overrides: Partial<FeedbackRepository> = {},
): FeedbackRepository {
  return {
    createFeedback: vi.fn().mockImplementation(async (f: Feedback) => f),
    getAllFeedback: vi.fn().mockResolvedValue([]),
    deleteFeedback: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeInput(overrides: Partial<FeedbackInput> = {}): FeedbackInput {
  return {
    category: "bug",
    description: "Something broke",
    metadata: null,
    userId: "user-123",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FeedbackService.submitFeedback", () => {
  it("accepts valid feedback with category: bug", async () => {
    const repo = makeFeedbackRepo();
    const service = new FeedbackService(repo);
    await expect(
      service.submitFeedback(makeInput({ category: "bug" })),
    ).resolves.not.toThrow();
  });

  it("accepts valid feedback with category: confusing-ux", async () => {
    const repo = makeFeedbackRepo();
    const service = new FeedbackService(repo);
    await expect(
      service.submitFeedback(makeInput({ category: "confusing-ux" })),
    ).resolves.not.toThrow();
  });

  it("accepts valid feedback with category: feature-request", async () => {
    const repo = makeFeedbackRepo();
    const service = new FeedbackService(repo);
    await expect(
      service.submitFeedback(makeInput({ category: "feature-request" })),
    ).resolves.not.toThrow();
  });

  it("accepts valid feedback with category: other", async () => {
    const repo = makeFeedbackRepo();
    const service = new FeedbackService(repo);
    await expect(
      service.submitFeedback(makeInput({ category: "other" })),
    ).resolves.not.toThrow();
  });

  it("rejects empty description", async () => {
    const repo = makeFeedbackRepo();
    const service = new FeedbackService(repo);
    await expect(
      service.submitFeedback(makeInput({ description: "" })),
    ).rejects.toThrow(ValidationError);
    await expect(
      service.submitFeedback(makeInput({ description: "" })),
    ).rejects.toThrow("Description is required");
  });

  it("rejects whitespace-only description", async () => {
    const repo = makeFeedbackRepo();
    const service = new FeedbackService(repo);
    await expect(
      service.submitFeedback(makeInput({ description: "   " })),
    ).rejects.toThrow(ValidationError);
    await expect(
      service.submitFeedback(makeInput({ description: "   " })),
    ).rejects.toThrow("Description is required");
  });

  it("rejects description over 500 characters", async () => {
    const repo = makeFeedbackRepo();
    const service = new FeedbackService(repo);
    const longDesc = "a".repeat(501);
    await expect(
      service.submitFeedback(makeInput({ description: longDesc })),
    ).rejects.toThrow(ValidationError);
    await expect(
      service.submitFeedback(makeInput({ description: longDesc })),
    ).rejects.toThrow("Description must be 500 characters or fewer");
  });

  it("accepts description of exactly 500 characters", async () => {
    const repo = makeFeedbackRepo();
    const service = new FeedbackService(repo);
    const maxDesc = "a".repeat(500);
    await expect(
      service.submitFeedback(makeInput({ description: maxDesc })),
    ).resolves.not.toThrow();
  });

  it("rejects invalid category", async () => {
    const repo = makeFeedbackRepo();
    const service = new FeedbackService(repo);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      service.submitFeedback(makeInput({ category: "invalid" as any })),
    ).rejects.toThrow(ValidationError);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      service.submitFeedback(makeInput({ category: "invalid" as any })),
    ).rejects.toThrow("Invalid category");
  });

  it("trims description before saving", async () => {
    const repo = makeFeedbackRepo();
    const service = new FeedbackService(repo);
    await service.submitFeedback(makeInput({ description: "  hello  " }));
    const call = vi.mocked(repo.createFeedback).mock.calls[0]![0];
    expect(call.description).toBe("hello");
  });

  it("passes metadata through to repository", async () => {
    const repo = makeFeedbackRepo();
    const service = new FeedbackService(repo);
    const metadata = {
      route: "/game/abc",
      userType: "registered" as const,
      browser: "Mozilla/5.0",
      viewport: { width: 1280, height: 800 },
      timestamp: "2026-06-15T00:00:00.000Z",
    };
    await service.submitFeedback(makeInput({ metadata }));
    const call = vi.mocked(repo.createFeedback).mock.calls[0]![0];
    expect(call.metadata).toEqual(metadata);
  });

  it("handles null userId (guest)", async () => {
    const repo = makeFeedbackRepo();
    const service = new FeedbackService(repo);
    await expect(
      service.submitFeedback(makeInput({ userId: null })),
    ).resolves.not.toThrow();
    const call = vi.mocked(repo.createFeedback).mock.calls[0]![0];
    expect(call.userId).toBeNull();
  });

  it("returns the entity returned by the repository", async () => {
    const saved = new Feedback();
    saved.id = "feedback-uuid";
    saved.category = "bug";
    saved.description = "Something broke";
    saved.createdAt = new Date("2026-06-15T00:00:00.000Z");

    const repo = makeFeedbackRepo({
      createFeedback: vi.fn().mockResolvedValue(saved),
    });
    const service = new FeedbackService(repo);
    const result = await service.submitFeedback(makeInput());
    expect(result).toBe(saved);
  });
});
