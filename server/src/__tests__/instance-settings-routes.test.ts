import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  getExperimental: vi.fn(),
  updateGeneral: vi.fn(),
  updateExperimental: vi.fn(),
  listCompanyIds: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  cancelQueuedForOperationsPause: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  logActivity: mockLogActivity,
}));

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", instanceSettingsRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("instance settings routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      operationsPaused: false,
    });
    mockInstanceSettingsService.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: false,
      preventiveQuotaThrottleEnabled: false,
      preventiveQuotaThrottleThresholdPercent: 85,
    });
    mockInstanceSettingsService.updateGeneral.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: true,
        operationsPaused: false,
      },
    });
    mockInstanceSettingsService.updateExperimental.mockResolvedValue({
      id: "instance-settings-1",
      experimental: {
        enableIsolatedWorkspaces: true,
        autoRestartDevServerWhenIdle: false,
        preventiveQuotaThrottleEnabled: false,
        preventiveQuotaThrottleThresholdPercent: 85,
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1", "company-2"]);
    mockHeartbeatService.cancelQueuedForOperationsPause.mockResolvedValue({
      cancelledQueuedRuns: 0,
      cancelledPendingWakeups: 0,
    });
  });

  it("allows local board users to read and update experimental settings", async () => {
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const getRes = await request(app).get("/api/instance/settings/experimental");
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: false,
      preventiveQuotaThrottleEnabled: false,
      preventiveQuotaThrottleThresholdPercent: 85,
    });

    const patchRes = await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ enableIsolatedWorkspaces: true });

    expect(patchRes.status).toBe(200);
    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableIsolatedWorkspaces: true,
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it("allows local board users to update guarded dev-server auto-restart", async () => {
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ autoRestartDevServerWhenIdle: true })
      .expect(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      autoRestartDevServerWhenIdle: true,
    });
  });

  it("allows local board users to update preventive quota throttle settings", async () => {
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({
        preventiveQuotaThrottleEnabled: true,
        preventiveQuotaThrottleThresholdPercent: 88,
      })
      .expect(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      preventiveQuotaThrottleEnabled: true,
      preventiveQuotaThrottleThresholdPercent: 88,
    });
  });

  it("allows local board users to read and update general settings", async () => {
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const getRes = await request(app).get("/api/instance/settings/general");
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({ censorUsernameInLogs: false, operationsPaused: false });

    const patchRes = await request(app)
      .patch("/api/instance/settings/general")
      .send({ censorUsernameInLogs: true });

    expect(patchRes.status).toBe(200);
    expect(mockInstanceSettingsService.updateGeneral).toHaveBeenCalledWith({
      censorUsernameInLogs: true,
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it("cancels queued runs and pending wakeups when operations pause transitions to true", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValueOnce({
      censorUsernameInLogs: false,
      operationsPaused: false,
    });
    mockInstanceSettingsService.updateGeneral.mockResolvedValueOnce({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        operationsPaused: true,
      },
    });
    mockHeartbeatService.cancelQueuedForOperationsPause
      .mockResolvedValueOnce({ cancelledQueuedRuns: 2, cancelledPendingWakeups: 3 })
      .mockResolvedValueOnce({ cancelledQueuedRuns: 1, cancelledPendingWakeups: 4 });
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/general")
      .send({ operationsPaused: true })
      .expect(200);

    expect(mockHeartbeatService.cancelQueuedForOperationsPause).toHaveBeenCalledTimes(2);
    expect(mockHeartbeatService.cancelQueuedForOperationsPause).toHaveBeenNthCalledWith(
      1,
      "company-1",
      "Cancelled because instance operations were paused by operator",
    );
    expect(mockHeartbeatService.cancelQueuedForOperationsPause).toHaveBeenNthCalledWith(
      2,
      "company-2",
      "Cancelled because instance operations were paused by operator",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          cancelledQueuedRuns: 3,
          cancelledPendingWakeups: 7,
        }),
      }),
    );
  });

  it("does not cancel queued work when operations paused was already true", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValueOnce({
      censorUsernameInLogs: false,
      operationsPaused: true,
    });
    mockInstanceSettingsService.updateGeneral.mockResolvedValueOnce({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        operationsPaused: true,
      },
    });
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/general")
      .send({ operationsPaused: true })
      .expect(200);

    expect(mockHeartbeatService.cancelQueuedForOperationsPause).not.toHaveBeenCalled();
  });

  it("rejects non-admin board users", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/instance/settings/general");

    expect(res.status).toBe(403);
    expect(mockInstanceSettingsService.getGeneral).not.toHaveBeenCalled();
  });

  it("rejects agent callers", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app)
      .patch("/api/instance/settings/general")
      .send({ censorUsernameInLogs: true });

    expect(res.status).toBe(403);
    expect(mockInstanceSettingsService.updateGeneral).not.toHaveBeenCalled();
  });
});
