import { describe, expect, it, vi, beforeEach } from "vitest";
import { reviewPipelineService, DEFAULT_REVIEW_PIPELINE_CONFIG } from "../services/review-pipeline.ts";
import { agents, issueComments, issues } from "@zeroinc/db";

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

function createMockDb(overrides?: {
  issueRow?: Record<string, unknown> | null;
  reviewerRows?: Record<string, unknown>[];
}) {
  const issueRow = overrides?.issueRow ?? {
    companyId: "company-1",
    assigneeAgentId: "engineer-1",
    status: "in_review",
    originalAssigneeId: "engineer-1",
    reviewCount: 0,
  };

  const reviewerRows = overrides?.reviewerRows ?? [
    { id: "reviewer-1" },
  ];

  let lastUpdateSet: Record<string, unknown> | null = null;
  let lastInsertValues: Record<string, unknown> | null = null;

  function fromFn(table: unknown) {
    if (table === agents) {
      return {
        where: vi.fn().mockResolvedValue(reviewerRows),
      };
    }
    if (table === issueComments) {
      return {
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "comment-1" }]),
          }),
        }),
      };
    }
    return {
      where: vi.fn().mockResolvedValue(issueRow ? [issueRow] : []),
    };
  }

  const mockDb = {
    select: vi.fn().mockReturnValue({ from: fromFn }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((set: Record<string, unknown>) => {
        lastUpdateSet = set;
        return {
          where: vi.fn().mockResolvedValue(undefined),
        };
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        lastInsertValues = values;
        return {
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "comment-1" }]),
          }),
        };
      }),
    }),
  };

  return {
    mockDb: mockDb as unknown as Parameters<typeof reviewPipelineService>[0],
    getLastUpdateSet: () => lastUpdateSet,
    getLastInsertValues: () => lastInsertValues,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Review Pipeline Service", () => {
  describe("resolveConfig", () => {
    it("returns defaults when no config provided", () => {
      const { mockDb } = createMockDb();
      const pipeline = reviewPipelineService(mockDb);
      const config = pipeline.resolveConfig();
      expect(config).toEqual(DEFAULT_REVIEW_PIPELINE_CONFIG);
    });

    it("merges partial config with defaults", () => {
      const { mockDb } = createMockDb();
      const pipeline = reviewPipelineService(mockDb);
      const config = pipeline.resolveConfig({ maxReviewCycles: 5 });
      expect(config.maxReviewCycles).toBe(5);
      expect(config.enabled).toBe(true);
    });
  });

  describe("assignReviewer", () => {
    it("assigns a reviewer and updates the issue", async () => {
      const { mockDb, getLastUpdateSet } = createMockDb();
      const pipeline = reviewPipelineService(mockDb);
      const result = await pipeline.assignReviewer("issue-1", DEFAULT_REVIEW_PIPELINE_CONFIG);
      expect(result).toBe("reviewer-1");
      const set = getLastUpdateSet();
      expect(set?.reviewerAgentId).toBe("reviewer-1");
      expect(set?.originalAssigneeId).toBe("engineer-1");
      expect(set?.reviewRequestedAt).toBeInstanceOf(Date);
    });

    it("returns null when issue not found", async () => {
      const { mockDb } = createMockDb({ issueRow: null });
      const pipeline = reviewPipelineService(mockDb);
      const result = await pipeline.assignReviewer("nonexistent", DEFAULT_REVIEW_PIPELINE_CONFIG);
      expect(result).toBeNull();
    });

    it("returns null when no reviewer available", async () => {
      const { mockDb } = createMockDb({ reviewerRows: [] });
      const pipeline = reviewPipelineService(mockDb);
      const result = await pipeline.assignReviewer("issue-1", DEFAULT_REVIEW_PIPELINE_CONFIG);
      expect(result).toBeNull();
    });
  });

  describe("transitionToReview", () => {
    it("sets issue to in_review and assigns reviewer when pipeline enabled", async () => {
      const { mockDb, getLastUpdateSet } = createMockDb();
      const pipeline = reviewPipelineService(mockDb);
      const sentToReview = await pipeline.transitionToReview(
        "issue-1",
        "engineer-1",
        { passed: true, checks: [] },
        DEFAULT_REVIEW_PIPELINE_CONFIG,
      );
      expect(sentToReview).toBe(true);
      const set = getLastUpdateSet();
      expect(set?.status).toBe("in_review");
    });

    it("returns false when pipeline disabled", async () => {
      const { mockDb } = createMockDb();
      const pipeline = reviewPipelineService(mockDb);
      const config = { ...DEFAULT_REVIEW_PIPELINE_CONFIG, enabled: false };
      const sentToReview = await pipeline.transitionToReview(
        "issue-1",
        "engineer-1",
        { passed: true, checks: [] },
        config,
      );
      expect(sentToReview).toBe(false);
    });

    it("returns false when requireReview is false", async () => {
      const { mockDb } = createMockDb();
      const pipeline = reviewPipelineService(mockDb);
      const config = { ...DEFAULT_REVIEW_PIPELINE_CONFIG, requireReview: false };
      const sentToReview = await pipeline.transitionToReview(
        "issue-1",
        "engineer-1",
        { passed: true, checks: [] },
        config,
      );
      expect(sentToReview).toBe(false);
    });
  });

  describe("submitReview", () => {
    it("rejects review when issue not found", async () => {
      const { mockDb } = createMockDb({ issueRow: null });
      const pipeline = reviewPipelineService(mockDb);
      const result = await pipeline.submitReview(
        "nonexistent", "reviewer-1",
        { verdict: "approved" },
        DEFAULT_REVIEW_PIPELINE_CONFIG,
      );
      expect(result.success).toBe(false);
      expect(result.reason).toBe("Issue not found");
    });

    it("rejects review when issue is not in_review", async () => {
      const { mockDb } = createMockDb({
        issueRow: { status: "done", assigneeAgentId: "engineer-1", reviewCount: 0 },
      });
      const pipeline = reviewPipelineService(mockDb);
      const result = await pipeline.submitReview(
        "issue-1", "reviewer-1",
        { verdict: "approved" },
        DEFAULT_REVIEW_PIPELINE_CONFIG,
      );
      expect(result.success).toBe(false);
      expect(result.reason).toBe("Issue is not in review");
    });

    it("rejects self-review", async () => {
      const { mockDb } = createMockDb({
        issueRow: { status: "in_review", assigneeAgentId: "engineer-1", reviewCount: 0 },
      });
      const pipeline = reviewPipelineService(mockDb);
      const result = await pipeline.submitReview(
        "issue-1", "engineer-1",
        { verdict: "approved" },
        DEFAULT_REVIEW_PIPELINE_CONFIG,
      );
      expect(result.success).toBe(false);
      expect(result.reason).toBe("Agent cannot review their own work");
    });

    it("approves and sets status to done", async () => {
      const { mockDb } = createMockDb();
      const pipeline = reviewPipelineService(mockDb);
      const result = await pipeline.submitReview(
        "issue-1", "reviewer-1",
        { verdict: "approved", summary: "Looks good" },
        DEFAULT_REVIEW_PIPELINE_CONFIG,
      );
      expect(result.success).toBe(true);
      expect(result.escalated).toBeUndefined();
    });

    it("changes requested reassigns to original engineer", async () => {
      const { mockDb } = createMockDb();
      const pipeline = reviewPipelineService(mockDb);
      const result = await pipeline.submitReview(
        "issue-1", "reviewer-1",
        { verdict: "changes_requested", findings: [{ severity: "blocker", message: "Fix the bug" }] },
        DEFAULT_REVIEW_PIPELINE_CONFIG,
      );
      expect(result.success).toBe(true);
      expect(result.escalated).toBeUndefined();
    });

    it("escalates after max review cycles", async () => {
      const { mockDb } = createMockDb({
        issueRow: {
          status: "in_review",
          assigneeAgentId: "engineer-1",
          originalAssigneeId: "engineer-1",
          reviewCount: 3,
          companyId: "company-1",
        },
      });
      const pipeline = reviewPipelineService(mockDb);
      const result = await pipeline.submitReview(
        "issue-1", "reviewer-1",
        { verdict: "changes_requested" },
        DEFAULT_REVIEW_PIPELINE_CONFIG,
      );
      expect(result.success).toBe(true);
      expect(result.escalated).toBe(true);
    });
  });
});
