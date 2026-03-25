import { beforeEach, describe, expect, it, vi } from "vitest";
import { staleDetectionService } from "../services/stale-detection.ts";

function makeChain(result: unknown) {
  const limit = vi.fn().mockResolvedValue(result);
  const where = vi.fn(() => ({ limit }));
  const innerJoin = vi.fn(() => ({ where, limit }));
  const from = vi.fn(() => ({ where, innerJoin, limit }));
  return { from };
}

const selectChains: ReturnType<typeof makeChain>[] = [];
const mockSelect = vi.fn();
const mockInsertValues = vi.fn().mockResolvedValue([]);
const mockInsert = vi.fn(() => ({ values: mockInsertValues }));
const mockUpdateSet = vi.fn().mockReturnThis();
const mockUpdateWhere = vi.fn().mockResolvedValue([]);
const mockUpdate = vi.fn(() => ({ set: mockUpdateSet, where: mockUpdateWhere }));

const db = {
  select: mockSelect,
  insert: mockInsert,
  update: mockUpdate,
} as unknown as import("@zeroinc/db").Db;

function setupSelects(results: unknown[]) {
  selectChains.length = 0;
  mockSelect.mockReset();
  for (const r of results) {
    const chain = makeChain(r);
    selectChains.push(chain);
    mockSelect.mockReturnValueOnce({ from: chain.from });
  }
  for (let i = 0; i < 20; i += 1) {
    const chain = makeChain([]);
    selectChains.push(chain);
    mockSelect.mockReturnValueOnce({ from: chain.from });
  }
}

vi.mock("../services/governance-settings.js", () => ({
  governanceSettingsService: () => ({
    get: async () => ({
      wipLimitDefault: 3,
      staleInProgressWarnMinutes: 120,
      staleInProgressBlockMinutes: 480,
      staleBlockedEscalateMinutes: 120,
      staleInReviewPingMinutes: 60,
      staleDoneNoQualityMinutes: 60,
    }),
  }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function issue(overrides?: Partial<{
  id: string;
  companyId: string;
  status: string;
  updatedAt: Date;
  startedAt: Date;
}>) {
  return {
    id: overrides?.id ?? "issue-1",
    companyId: overrides?.companyId ?? "company-1",
    identifier: "VAL-1",
    title: "Test",
    status: overrides?.status ?? "in_progress",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    updatedAt: overrides?.updatedAt ?? new Date(Date.now() - 7 * 60 * 60 * 1000),
    startedAt: overrides?.startedAt ?? new Date(Date.now() - 7 * 60 * 60 * 1000),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("staleDetectionService", () => {
  it("flags only stale in_progress tasks (>6h)", async () => {
    const stale = issue({ status: "in_progress", updatedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) });
    setupSelects([
      [stale], // find stale in_progress
      [], // no recent stale comment
    ]);

    const svc = staleDetectionService(db);
    const actions = await svc.detect();

    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe("warn");
    expect(actions[0]?.reason).toContain("6 hours");
  });

  it("does not create actions for blocked/in_review/done tasks", async () => {
    setupSelects([
      [], // find stale in_progress
    ]);

    const svc = staleDetectionService(db);
    const actions = await svc.detect();

    expect(actions).toEqual([]);
  });

  it("deduplicates when recent stale comment exists", async () => {
    const stale = issue({ status: "in_progress", updatedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) });
    setupSelects([
      [stale], // find stale in_progress
      [{ id: "comment-1" }], // has recent stale comment
    ]);

    const svc = staleDetectionService(db);
    const actions = await svc.detect();

    expect(actions).toEqual([]);
  });

  it("run writes stale comment without mutating issue status", async () => {
    const stale = issue({ status: "in_progress", updatedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) });
    setupSelects([
      [stale], // find stale in_progress
      [], // no recent stale comment
    ]);

    const svc = staleDetectionService(db);
    await svc.run();

    expect(mockInsert).toHaveBeenCalled();
    const body = mockInsertValues.mock.calls[0]?.[0]?.body as string;
    expect(body).toContain("[stale:stale-in-progress]");
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

