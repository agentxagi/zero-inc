import { describe, expect, it, vi, beforeEach } from "vitest";

// --- Mock setup ---
// The Drizzle query chain: db.select({...}).from(t).where(c).limit(n)
// or with innerJoin: db.select({...}).from(t).innerJoin(t2, c).where(c).limit(n)
// We build a simple mock db that allows configuring results per select() call.

function makeChain(result: unknown) {
  const limit = vi.fn().mockResolvedValue(result);
  const where = vi.fn(() => ({ limit }));
  const innerJoin = vi.fn(() => ({ where, limit }));
  const from = vi.fn(() => ({ where, innerJoin, limit }));
  return { from, where, innerJoin, limit };
}

const selectResults: ReturnType<typeof makeChain>[] = [];
const mockSelect = vi.fn();

const mockInsertValues = vi.fn().mockResolvedValue([]);
const mockInsert = vi.fn(() => ({ values: mockInsertValues }));

const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn().mockResolvedValue([]);
const mockUpdate = vi.fn(() => ({ set: mockUpdateSet, where: mockUpdateWhere }));

const db = {
  select: mockSelect,
  insert: mockInsert,
  update: mockUpdate,
} as unknown as import("@zeroinc/db").Db;

function setupSelects(results: unknown[]) {
  selectResults.length = 0;
  mockSelect.mockReset();
  for (const r of results) {
    selectResults.push(makeChain(r));
    mockSelect.mockReturnValueOnce({ from: selectResults[selectResults.length - 1].from });
  }
  // Pad with empty results for any extra select calls
  for (let i = 0; i < 20; i++) {
    const extra = makeChain([]);
    selectResults.push(extra);
    mockSelect.mockReturnValueOnce({ from: extra.from });
  }
}

// Mock governance settings
vi.mock("../services/governance-settings.js", () => ({
  governanceSettingsService: () => ({
    get: async () => ({
      wipLimitDefault: 5,
      staleInProgressWarnMinutes: 240,
      staleInProgressBlockMinutes: 1440,
      staleBlockedEscalateMinutes: 240,
      staleInReviewPingMinutes: 120,
      staleDoneNoQualityMinutes: 60,
    }),
  }),
  DEFAULT_GOVERNANCE_SETTINGS: {
    wipLimitDefault: 5,
    staleInProgressWarnMinutes: 240,
    staleInProgressBlockMinutes: 1440,
    staleBlockedEscalateMinutes: 240,
    staleInReviewPingMinutes: 120,
    staleDoneNoQualityMinutes: 60,
  },
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { staleDetectionService } from "../services/stale-detection.ts";

function makeIssue(overrides: Partial<{
  id: string;
  companyId: string;
  identifier: string;
  title: string;
  status: string;
  assigneeAgentId: string;
  updatedAt: Date;
  startedAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? "issue-1",
    companyId: overrides.companyId ?? "company-1",
    identifier: overrides.identifier ?? "ISSUE-1",
    title: overrides.title ?? "Test issue",
    status: overrides.status ?? "in_progress",
    assigneeAgentId: overrides.assigneeAgentId ?? "agent-1",
    updatedAt: overrides.updatedAt ?? new Date(Date.now() - 300 * 60 * 1000),
    startedAt: overrides.startedAt ?? new Date(Date.now() - 300 * 60 * 1000),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInsertValues.mockResolvedValue([]);
  mockUpdateSet.mockReturnThis();
  mockUpdateWhere.mockResolvedValue([]);
});

describe("staleDetectionService", () => {
  describe("detect", () => {
    it("returns empty actions when no stale issues exist", async () => {
      // 5 base queries, all empty
      setupSelects([[], [], [], [], []]);
      const svc = staleDetectionService(db);
      const actions = await svc.detect();
      expect(actions).toHaveLength(0);
    });

    it("detects stale in_progress issues past warn threshold", async () => {
      const staleIssue = makeIssue({
        updatedAt: new Date(Date.now() - 250 * 60 * 1000), // past 240min warn
      });
      // Query order in detect():
      // 1. findStaleIssues("in_progress", warnThreshold)
      // 2. hasRecentStaleComment (for each warn issue)
      // 3. findStaleIssues("in_progress", blockThreshold)
      // 4. findStaleIssues("blocked", escalateThreshold)
      // 5. findStaleIssues("in_review", reviewThreshold)
      // 6. findDoneIssuesNoQuality(qaThreshold)
      setupSelects([
        [staleIssue], // 1. findStaleIssues for warn
        [],           // 2. hasRecentStaleComment → no recent comment
        [staleIssue], // 3. findStaleIssues for block
        [],           // 4. findStaleIssues for escalate
        [],           // 5. findStaleIssues for review
        [],           // 6. findDoneIssuesNoQuality
      ]);

      const svc = staleDetectionService(db);
      const actions = await svc.detect();
      expect(actions.some(a => a.action === "warn" && a.issueId === "issue-1")).toBe(true);
    });

    it("detects stale in_progress issues past block threshold", async () => {
      const staleIssue = makeIssue({
        updatedAt: new Date(Date.now() - 1500 * 60 * 1000), // past 1440min block
      });
      // Issue past block threshold is also past warn, but the warn check skips it
      // because it's also past block. Block query still finds it.
      setupSelects([
        [staleIssue], // 1. findStaleIssues for warn
        // hasRecentStaleComment not called (warn check skips due to block threshold)
        [staleIssue], // 2. findStaleIssues for block
        [],           // 3. findStaleIssues for escalate
        [],           // 4. findStaleIssues for review
        [],           // 5. findDoneIssuesNoQuality
      ]);

      const svc = staleDetectionService(db);
      const actions = await svc.detect();
      const blockAction = actions.find(a => a.action === "block");
      expect(blockAction).toBeDefined();
      expect(blockAction!.newStatus).toBe("blocked");
    });

    it("detects stale blocked issues for escalation", async () => {
      const staleIssue = makeIssue({
        status: "blocked",
        updatedAt: new Date(Date.now() - 250 * 60 * 1000), // past 240min escalate
      });
      setupSelects([
        [],           // 1. findStaleIssues for warn (no in_progress stale)
        [],           // 2. findStaleIssues for block (no in_progress stale)
        [staleIssue], // 3. findStaleIssues for escalate
        [],           // 4. hasRecentStaleComment → no recent
        [],           // 5. findCompanyCTO → no CTO
        [],           // 6. findStaleIssues for review
        [],           // 7. findDoneIssuesNoQuality
      ]);

      const svc = staleDetectionService(db);
      const actions = await svc.detect();
      expect(actions.some(a => a.action === "escalate")).toBe(true);
    });

    it("detects stale in_review issues for reviewer ping", async () => {
      const staleIssue = makeIssue({
        status: "in_review",
        updatedAt: new Date(Date.now() - 130 * 60 * 1000), // past 120min ping
      });
      setupSelects([
        [],           // 1. findStaleIssues for warn
        [],           // 2. findStaleIssues for block
        [],           // 3. findStaleIssues for escalate
        [staleIssue], // 4. findStaleIssues for review
        [{ reviewerAgentId: "reviewer-1" }], // 5. findReviewerEligibility: get reviewerAgentId from issue
        [{ status: "active", qualityAutoAssign: true }], // 6. findReviewerEligibility: get reviewer agent details
        [],           // 7. hasRecentStaleComment → no recent
        [],           // 8. findDoneIssuesNoQuality
      ]);

      const svc = staleDetectionService(db);
      const actions = await svc.detect();
      expect(actions.some(a => a.action === "ping_reviewer")).toBe(true);
    });

    it("auto-approves orphaned in_review when reviewer has qualityAutoAssign disabled", async () => {
      const staleIssue = makeIssue({
        status: "in_review",
        updatedAt: new Date(Date.now() - 130 * 60 * 1000), // past 120min ping
      });
      setupSelects([
        [],           // 1. findStaleIssues for warn
        [],           // 2. findStaleIssues for block
        [],           // 3. findStaleIssues for escalate
        [staleIssue], // 4. findStaleIssues for review
        [{ reviewerAgentId: "reviewer-1" }], // 5. findReviewerEligibility: get reviewerAgentId
        [{ status: "active", qualityAutoAssign: false }], // 6. findReviewerEligibility: autoAssign disabled
        [],           // 7. hasRecentStaleComment → no recent
        [],           // 8. findDoneIssuesNoQuality
      ]);

      const svc = staleDetectionService(db);
      const actions = await svc.detect();
      expect(actions.some(a => a.action === "auto_approve_orphan")).toBe(true);
      expect(actions.some(a => a.action === "ping_reviewer")).toBe(false);
    });

    it("auto-approves orphaned in_review when reviewer is terminated", async () => {
      const staleIssue = makeIssue({
        status: "in_review",
        updatedAt: new Date(Date.now() - 130 * 60 * 1000),
      });
      setupSelects([
        [],           // 1. findStaleIssues for warn
        [],           // 2. findStaleIssues for block
        [],           // 3. findStaleIssues for escalate
        [staleIssue], // 4. findStaleIssues for review
        [{ reviewerAgentId: "reviewer-1" }], // 5. findReviewerEligibility: get reviewerAgentId
        [{ status: "terminated", qualityAutoAssign: true }], // 6. findReviewerEligibility: terminated
        [],           // 7. hasRecentStaleComment → no recent
        [],           // 8. findDoneIssuesNoQuality
      ]);

      const svc = staleDetectionService(db);
      const actions = await svc.detect();
      expect(actions.some(a => a.action === "auto_approve_orphan")).toBe(true);
    });

    it("auto-approves orphaned in_review when no reviewer assigned", async () => {
      const staleIssue = makeIssue({
        status: "in_review",
        updatedAt: new Date(Date.now() - 130 * 60 * 1000),
      });
      setupSelects([
        [],           // 1. findStaleIssues for warn
        [],           // 2. findStaleIssues for block
        [],           // 3. findStaleIssues for escalate
        [staleIssue], // 4. findStaleIssues for review
        [{ reviewerAgentId: null }], // 5. findReviewerEligibility: no reviewer
        [],           // 6. hasRecentStaleComment → no recent
        [],           // 7. findDoneIssuesNoQuality
      ]);

      const svc = staleDetectionService(db);
      const actions = await svc.detect();
      expect(actions.some(a => a.action === "auto_approve_orphan")).toBe(true);
    });

    it("skips issues with recent stale comments (dedup)", async () => {
      const staleIssue = makeIssue({
        updatedAt: new Date(Date.now() - 250 * 60 * 1000),
      });
      setupSelects([
        [staleIssue],     // 1. findStaleIssues for warn
        [{ id: "c1" }],   // 2. hasRecentStaleComment → found (skip warn)
        [staleIssue],     // 3. findStaleIssues for block
        [],               // 4. findStaleIssues for escalate
        [],               // 5. findStaleIssues for review
        [],               // 6. findDoneIssuesNoQuality
      ]);

      const svc = staleDetectionService(db);
      const actions = await svc.detect();
      // Warn is skipped due to recent comment, block still fires
      expect(actions.some(a => a.action === "warn")).toBe(false);
    });
  });

  describe("run", () => {
    it("inserts comments for detected stale issues", async () => {
      const staleIssue = makeIssue({
        updatedAt: new Date(Date.now() - 250 * 60 * 1000),
      });
      setupSelects([
        [staleIssue], // 1. findStaleIssues for warn
        [],           // 2. hasRecentStaleComment → no recent
        [staleIssue], // 3. findStaleIssues for block
        [],           // 4. findStaleIssues for escalate
        [],           // 5. findStaleIssues for review
        [],           // 6. findDoneIssuesNoQuality
      ]);

      const svc = staleDetectionService(db);
      await svc.run();

      expect(mockInsert).toHaveBeenCalled();
      const callBody = mockInsertValues.mock.calls[0][0].body as string;
      expect(callBody).toContain("[stale:");
    });
  });
});
