import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const targetEngineerId = "11111111-1111-4111-8111-111111111111";
const targetCtoId = "33333333-3333-4333-8333-333333333333";
const actorEngineerId = "44444444-4444-4444-8444-444444444444";
const actorCtoId = "55555555-5555-4555-8555-555555555555";

function makeAgent(input: {
  id: string;
  role: string;
}) {
  return {
    id: input.id,
    companyId,
    name: `${input.role}-${input.id.slice(0, 6)}`,
    urlKey: `${input.role}-${input.id.slice(0, 6)}`,
    role: input.role,
    title: input.role.toUpperCase(),
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: input.role === "ceo" },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-03-19T00:00:00.000Z"),
    updatedAt: new Date("2026-03-19T00:00:00.000Z"),
  };
}

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({}));

const mockGovernanceSettingsService = vi.hoisted(() => ({
  getAgentSettings: vi.fn(),
  get: vi.fn(),
  getWipLimitForAgent: vi.fn(),
  updateAgentSettings: vi.fn(),
  update: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
  generateAgentProfile: vi.fn(),
  AgentProfileGeneratorError: class AgentProfileGeneratorError extends Error {},
}));

vi.mock("../services/governance-settings.js", () => ({
  governanceSettingsService: () => mockGovernanceSettingsService,
}));

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue([{
            id: companyId,
            name: "ZeroInc",
            requireBoardApprovalForNewAgents: false,
          }]),
        }),
      }),
    }),
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use(errorHandler);
  return app;
}

describe("agent governance settings authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const engineerTarget = makeAgent({ id: targetEngineerId, role: "engineer" });
    const ctoTarget = makeAgent({ id: targetCtoId, role: "cto" });
    const engineerActor = makeAgent({ id: actorEngineerId, role: "engineer" });
    const ctoActor = makeAgent({ id: actorCtoId, role: "cto" });

    const byId = new Map([
      [targetEngineerId, engineerTarget],
      [targetCtoId, ctoTarget],
      [actorEngineerId, engineerActor],
      [actorCtoId, ctoActor],
    ]);

    mockAgentService.getById.mockImplementation(async (id: string) => byId.get(id) ?? null);
    mockGovernanceSettingsService.updateAgentSettings.mockResolvedValue({
      wipLimit: 5,
      staleOverrides: null,
    });
    mockGovernanceSettingsService.get.mockResolvedValue({
      wipLimitDefault: 5,
      staleInProgressWarnMinutes: 240,
      staleInProgressBlockMinutes: 1440,
      staleBlockedEscalateMinutes: 240,
      staleInReviewPingMinutes: 120,
      staleDoneNoQualityMinutes: 60,
    });
    mockGovernanceSettingsService.update.mockResolvedValue({
      wipLimitDefault: 6,
      staleInProgressWarnMinutes: 180,
      staleInProgressBlockMinutes: 1440,
      staleBlockedEscalateMinutes: 240,
      staleInReviewPingMinutes: 120,
      staleDoneNoQualityMinutes: 60,
    });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("rejects engineer agent even when target agent is CTO", async () => {
    const app = createApp({
      type: "agent",
      agentId: actorEngineerId,
      companyId,
      source: "agent_key",
    });

    const res = await request(app)
      .patch(`/api/agents/${targetCtoId}/settings`)
      .send({ wipLimit: 5 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Only CTO or PM agents can modify governance settings",
    });
    expect(mockGovernanceSettingsService.updateAgentSettings).not.toHaveBeenCalled();
  });

  it("allows CTO agent to update engineer governance settings", async () => {
    const app = createApp({
      type: "agent",
      agentId: actorCtoId,
      companyId,
      source: "agent_key",
    });

    const res = await request(app)
      .patch(`/api/agents/${targetEngineerId}/settings`)
      .send({ wipLimit: 5 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ wipLimit: 5, staleOverrides: null });
    expect(mockGovernanceSettingsService.updateAgentSettings).toHaveBeenCalledWith(
      targetEngineerId,
      { wipLimit: 5 },
    );
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
  });

  it("rejects board governance settings read without companyId query", async () => {
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app).get("/api/governance-settings");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Cannot determine company context (provide ?companyId=...)",
    });
    expect(mockGovernanceSettingsService.get).not.toHaveBeenCalled();
  });

  it("allows board governance settings read/update with companyId query", async () => {
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const getRes = await request(app).get(`/api/governance-settings?companyId=${companyId}`);
    expect(getRes.status).toBe(200);
    expect(mockGovernanceSettingsService.get).toHaveBeenCalledTimes(1);

    const patchRes = await request(app)
      .patch(`/api/governance-settings?companyId=${companyId}`)
      .send({ wipLimitDefault: 6, staleInProgressWarnMinutes: 180 });

    expect(patchRes.status).toBe(200);
    expect(mockGovernanceSettingsService.update).toHaveBeenCalledWith({
      wipLimitDefault: 6,
      staleInProgressWarnMinutes: 180,
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
  });
});
