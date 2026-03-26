import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  listLabels: vi.fn(),
  createLabel: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
  taskAuditService: () => ({
    runCompanyAudit: vi.fn(async () => ({ auditedCount: 0, flaggedCount: 0, issueIds: [] })),
    runIssueAudit: vi.fn(async () => ({ issueId: "", status: "ok", reasons: [] })),
    markIssueReviewed: vi.fn(async () => ({ ok: true })),
  }),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status: "todo",
    priority: "high",
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    blockedByHuman: false,
    humanResolutionEvidence: null,
    identifier: "PAP-590",
    title: "Needs human action",
    labels: [],
    labelIds: [],
    ...overrides,
  };
}

describe("issue human handoff routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "ok",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
  });

  it("creates a structured human handoff block", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listLabels.mockResolvedValue([]);
    mockIssueService.createLabel.mockResolvedValue({
      id: "label-1",
      companyId: "company-1",
      name: "requires_human",
      color: "#ef4444",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockIssueService.update.mockResolvedValue({
      ...issue,
      status: "blocked",
      blockedByHuman: true,
      labelIds: ["label-1"],
      labels: [
        {
          id: "label-1",
          companyId: "company-1",
          name: "requires_human",
          color: "#ef4444",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/human-handoff")
      .send({
        action: "block",
        humanActionType: "approval",
        resolutionHint: "Need board approval for legal wording",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "blocked",
        assigneeUserId: "local-board",
        assigneeAgentId: null,
        blockedByHuman: true,
        humanActionType: "approval",
        humanResolutionHint: "Need board approval for legal wording",
      }),
    );
  });

  it("blocks done/cancel transitions without human resolution evidence", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        blockedByHuman: true,
        labels: [
          {
            id: "label-1",
            companyId: "company-1",
            name: "requires_human",
            color: "#ef4444",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      }),
    );

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(409);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows terminal transition after human evidence is present", async () => {
    const existing = makeIssue({
      blockedByHuman: false,
      humanResolutionEvidence: "Board approved in PRD-12",
      labels: [],
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing, status: "done" });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { status: "done" },
      { pendingCommentBody: null },
    );
  });
});
