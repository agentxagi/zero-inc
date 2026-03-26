import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardService } from "../services/dashboard.ts";

const mockBudgetOverview = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn(() => false));
const mockReadDirSync = vi.hoisted(() => vi.fn(() => []));

vi.mock("../services/budgets.ts", () => ({
  budgetService: () => ({
    overview: mockBudgetOverview,
  }),
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readdirSync: mockReadDirSync,
}));

function createDbStub(selectResults: unknown[]) {
  const queue = [...selectResults];
  const take = () => queue.shift() ?? [];

  const cursor = () => ({
    where: vi.fn(() => cursor()),
    then: vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(take() as unknown[]))),
    groupBy: vi.fn(async () => take()),
    orderBy: vi.fn(async () => take()),
    limit: vi.fn(async () => take()),
  });

  const from = vi.fn(() => cursor());
  const select = vi.fn(() => ({ from }));

  return {
    db: {
      select,
    },
  };
}

describe("dashboardService.summary operational readiness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-26T12:00:00.000Z"));
    mockBudgetOverview.mockResolvedValue({
      activeIncidents: [],
      pendingApprovalCount: 0,
      pausedAgentCount: 0,
      pausedProjectCount: 0,
    });
    mockExistsSync.mockReturnValue(false);
    mockReadDirSync.mockReturnValue([]);
  });

  it("returns operationalReadiness checks and score in summary payload", async () => {
    const now = new Date("2026-03-26T12:00:00.000Z");
    const windowStart = new Date("2026-02-25T00:00:00.000Z");

    const dbStub = createDbStub([
      [
        {
          id: "company-1",
          budgetMonthlyCents: 100_000,
        },
      ],
      [{ status: "running", count: 2 }],
      [{ status: "done", count: 2 }, { status: "in_progress", count: 1 }],
      [{ count: 1 }],
      [{ monthSpend: 25_000 }],
      [
        {
          title: "[FEATURE] Ship enterprise auth",
          originKind: "manual",
          status: "done",
          createdAt: windowStart,
          startedAt: new Date("2026-02-26T00:00:00.000Z"),
          completedAt: new Date("2026-03-25T10:00:00.000Z"),
          cancelledAt: null,
        },
        {
          title: "[FEATURE] Cut unreliable path",
          originKind: "manual",
          status: "cancelled",
          createdAt: new Date("2026-03-20T00:00:00.000Z"),
          startedAt: new Date("2026-03-20T02:00:00.000Z"),
          completedAt: null,
          cancelledAt: now,
        },
        {
          title: "[ENTERPRISE] Continue reliability hardening",
          originKind: "manual",
          status: "todo",
          createdAt: now,
          startedAt: null,
          completedAt: null,
          cancelledAt: null,
        },
      ],
      [{ createdAt: new Date("2026-03-24T12:00:00.000Z") }],
      [
        {
          processPid: 1234,
          processLossRetryCount: 0,
          errorCode: null,
        },
      ],
      [{ count: 3 }],
    ]);

    const summary = await dashboardService(dbStub.db as any).summary("company-1");

    expect(summary.operationalReadiness).toBeDefined();
    expect(summary.operationalReadiness?.windowDays).toBe(30);
    expect(summary.operationalReadiness?.checks.deliverablesGrowth.status).toBe("pass");
    expect(summary.operationalReadiness?.checks.executionContinuity.status).toBe("warning");
    expect(summary.operationalReadiness?.checks.cancellationRate.status).toBe("fail");
    expect(summary.operationalReadiness?.checks.localProcessHealth.status).toBe("pass");
    expect(summary.operationalReadiness?.summary.totalChecks).toBe(5);
    expect(summary.operationalReadiness?.summary.failedChecks).toBe(1);
    expect(summary.operationalReadiness?.status).toBe("critical");
  });
});
