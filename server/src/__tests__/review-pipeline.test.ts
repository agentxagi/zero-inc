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
  const defaultIssueRow = {
    companyId: "company-1",
    assigneeAgentId: "engineer-1",
    status: "in_review",
    title: "[CODE] Implement API endpoint",
    originKind: "manual",
    originalAssigneeId: "engineer-1",
    reviewCount: 0,
  };
  const issueRow =
    overrides && Object.prototype.hasOwnProperty.call(overrides, "issueRow")
      ? (overrides.issueRow ?? null)
      : defaultIssueRow;

  const reviewerRows = overrides?.reviewerRows ?? [
    { id: "reviewer-1" },
  ];

  let lastUpdateSet: Record<string, unknown> | null = null;
  let lastInsertValues: Record<string, unknown> | null = null;
  let reviewerQueryCount = 0;

  function makeWhereResult(rows: Record<string, unknown>[]) {
    const direct = Promise.resolve(rows) as Promise<Record<string, unknown>[]> & {
      limit: ReturnType<typeof vi.fn>;
      orderBy: ReturnType<typeof vi.fn>;
    };
    direct.limit = vi.fn().mockResolvedValue(rows);
    direct.orderBy = vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(rows),
    });
    return direct;
  }

  function fromFn(table: unknown) {
    if (table === agents) {
      reviewerQueryCount += 1;
      const firstPassRows = reviewerQueryCount === 1 ? reviewerRows : [];
      const fallbackRows = reviewerRows.length > 0 ? [reviewerRows[0]!] : [];
      return {
        where: vi.fn().mockReturnValue(makeWhereResult(firstPassRows.length > 0 ? firstPassRows : fallbackRows)),
      };
    }
    return {
      where: vi.fn().mockReturnValue(makeWhereResult(issueRow ? [issueRow] : [])),
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
        return Promise.resolve([{ id: "comment-1" }]);
      }),
    }),
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockImplementation((set: Record<string, unknown>) => {
            lastUpdateSet = set;
            return {
              where: vi.fn().mockResolvedValue(undefined),
            };
          }),
        }),
      };
      await fn(tx);
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

    it("skips review for routine_execution tasks", async () => {
      const { mockDb } = createMockDb({
        issueRow: {
          companyId: "company-1",
          assigneeAgentId: "engineer-1",
          title: "[SYSTEM] Goal Breakdown",
          originKind: "routine_execution",
          reviewVerdict: null,
        },
      });
      const pipeline = reviewPipelineService(mockDb);
      const sentToReview = await pipeline.transitionToReview(
        "issue-1",
        "engineer-1",
        { passed: true, checks: [] },
        DEFAULT_REVIEW_PIPELINE_CONFIG,
      );
      expect(sentToReview).toBe(false);
    });

    it("skips review for non BUG/FEATURE/CODE tasks", async () => {
      const { mockDb } = createMockDb({
        issueRow: {
          companyId: "company-1",
          assigneeAgentId: "engineer-1",
          title: "Content: publish engagement report",
          originKind: "manual",
          reviewVerdict: null,
        },
      });
      const pipeline = reviewPipelineService(mockDb);
      const sentToReview = await pipeline.transitionToReview(
        "issue-1",
        "engineer-1",
        { passed: true, checks: [] },
        DEFAULT_REVIEW_PIPELINE_CONFIG,
      );
      expect(sentToReview).toBe(false);
    });

    it("skips review and posts warning when no reviewer available", async () => {
      const { mockDb, getLastInsertValues } = createMockDb({ reviewerRows: [] });
      const pipeline = reviewPipelineService(mockDb);
      const sentToReview = await pipeline.transitionToReview(
        "issue-1",
        "engineer-1",
        { passed: true, checks: [] },
        DEFAULT_REVIEW_PIPELINE_CONFIG,
      );
      expect(sentToReview).toBe(false);
      const comment = getLastInsertValues();
      expect(comment?.body).toContain("Review Skipped");
      expect(comment?.body).toContain("No available reviewer found");
    });

    it("recovers stuck task with approved verdict back to done", async () => {
      // Simulate a task that has reviewVerdict=approved but is stuck in_review
      // The transitionToReview function first checks existing reviewVerdict
      let selectCallCount = 0;

      function makeWhereResultWithLimit(rows: Record<string, unknown>[]) {
        const direct = Promise.resolve(rows) as Promise<Record<string, unknown>[]> & {
          limit: ReturnType<typeof vi.fn>;
          orderBy: ReturnType<typeof vi.fn>;
        };
        direct.limit = vi.fn().mockResolvedValue(rows);
        direct.orderBy = vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        });
        return direct;
      }

      const mockDbCustom = {
        select: vi.fn().mockImplementation(() => {
          selectCallCount += 1;
          return {
            from: (table: unknown) => {
              if (table === agents) {
                return {
                  where: () => makeWhereResultWithLimit([]),
                };
              }
              // issues table: first call returns approved verdict (recovery check)
              // subsequent calls return companyId for comment insertion
              if (selectCallCount === 1) {
                return {
                  where: vi.fn().mockReturnValue(makeWhereResultWithLimit([{ reviewVerdict: "approved" }])),
                };
              }
              return {
                where: vi.fn().mockReturnValue(makeWhereResultWithLimit([{ companyId: "company-1" }])),
              };
            },
          };
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockResolvedValue(undefined),
          })),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue([{ id: "comment-1" }]),
        }),
        transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
          await fn({
            update: vi.fn().mockReturnValue({
              set: vi.fn().mockImplementation(() => ({
                where: vi.fn().mockResolvedValue(undefined),
              })),
            }),
          });
        }),
      };

      const pipeline = reviewPipelineService(mockDbCustom as any);
      const sentToReview = await pipeline.transitionToReview(
        "issue-1",
        "engineer-1",
        { passed: true, checks: [] },
        DEFAULT_REVIEW_PIPELINE_CONFIG,
      );
      // Should skip review since verdict is already approved
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

    it("changes requested before max cycles reassigns to original engineer", async () => {
      const { mockDb, getLastUpdateSet } = createMockDb({
        issueRow: {
          status: "in_review",
          assigneeAgentId: "engineer-1",
          originalAssigneeId: "original-engineer",
          reviewCount: 1,
          companyId: "company-1",
        },
      });
      const pipeline = reviewPipelineService(mockDb);
      const result = await pipeline.submitReview(
        "issue-1", "reviewer-1",
        { verdict: "changes_requested", summary: "Fix imports" },
        DEFAULT_REVIEW_PIPELINE_CONFIG,
      );
      expect(result.success).toBe(true);
      expect(result.escalated).toBeUndefined();
      const set = getLastUpdateSet();
      expect(set?.status).toBe("in_progress");
      expect(set?.assigneeAgentId).toBe("original-engineer");
      expect(set?.reviewerAgentId).toBeNull();
    });

    it("posts review comment with findings and questions", async () => {
      const { mockDb, getLastInsertValues } = createMockDb();
      const pipeline = reviewPipelineService(mockDb);
      await pipeline.submitReview(
        "issue-1", "reviewer-1",
        {
          verdict: "changes_requested",
          summary: "Needs work",
          findings: [
            { severity: "blocker", message: "Missing error handling", file: "src/index.ts", line: 42 },
            { severity: "suggestion", message: "Use const instead of let" },
          ],
          questions: ["Why was this approach chosen?"],
        },
        DEFAULT_REVIEW_PIPELINE_CONFIG,
      );
      const comment = getLastInsertValues();
      expect(comment?.body).toContain("Changes Requested");
      expect(comment?.body).toContain("Needs work");
      expect(comment?.body).toContain("[blocker]");
      expect(comment?.body).toContain("src/index.ts:42");
      expect(comment?.body).toContain("Missing error handling");
      expect(comment?.body).toContain("[suggestion]");
      expect(comment?.body).toContain("Why was this approach chosen?");
    });
  });
});
