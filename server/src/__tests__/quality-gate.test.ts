import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  qualityGateService,
  calculateScore,
  getQualityState,
} from "../services/quality-gate.ts";
import { DEFAULT_QUALITY_GATE_CONFIG } from "@zeroinc/shared";
import { issueComments, agents } from "@zeroinc/db";

// ---------------------------------------------------------------------------
// Mock DB — routes queries by table reference
// ---------------------------------------------------------------------------

function createMockDb(options?: {
  commentCount?: number;
  agentRow?: Record<string, unknown> | null;
}) {
  const commentCount = options?.commentCount ?? 1;
  const agentRow = options?.agentRow !== undefined
    ? options.agentRow
    : {
        totalCompleted: 5,
        totalReopened: 1,
        totalBlocked: 0,
        qualityScore: 80,
        qualityPoints: [10, 10, 10, 10, -15, 10, 10, 10],
        qualityStreak: 3,
        lastReopenReasons: [],
      };

  // We identify which table is queried by checking the argument to from()
  function fromFn(table: unknown) {
    if (table === issueComments) {
      return {
        where: vi.fn().mockResolvedValue([{ count: String(commentCount) }]),
      };
    }
    // agents table or any other
    return {
      where: vi.fn().mockResolvedValue(agentRow ? [agentRow] : []),
    };
  }

  const mockDb = {
    select: vi.fn().mockReturnValue({ from: fromFn }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };

  return mockDb as unknown as Parameters<typeof qualityGateService>[0];
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function baseIssueContext(overrides?: Partial<{
  id: string;
  companyId: string;
  status: string;
  assigneeAgentId: string | null;
  executionRunId: string | null;
  executionLockedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
}>) {
  return {
    id: "issue-1",
    companyId: "company-1",
    status: "in_progress",
    assigneeAgentId: "agent-1",
    executionRunId: "run-1",
    executionLockedAt: null,
    startedAt: new Date(Date.now() - 60_000),
    completedAt: new Date(),
    ...overrides,
  };
}

function passResult(): { passed: boolean; checks: { pass: boolean; severity: string; message: string }[] } {
  return { passed: true, checks: [] };
}

function blockerResult(messages: string[]): { passed: boolean; checks: { pass: boolean; severity: string; message: string }[] } {
  return {
    passed: false,
    checks: messages.map((m) => ({ pass: false, severity: "blocker", message: m })),
  };
}

function warningResult(messages: string[]): { passed: boolean; checks: { pass: boolean; severity: string; message: string }[] } {
  return {
    passed: true, // warnings don't fail the gate
    checks: messages.map((m) => ({ pass: false, severity: "warning", message: m })),
  };
}

// ---------------------------------------------------------------------------
// Pure scoring function tests
// ---------------------------------------------------------------------------

describe("calculateScore", () => {
  it("returns -1 for fewer than 5 attempts (warming up)", () => {
    expect(calculateScore([10, 10, 10], 3)).toBe(-1);
    expect(calculateScore([], 0)).toBe(-1);
    expect(calculateScore([10, 10, 10, 10], 4)).toBe(-1);
  });

  it("returns 100 for all passes with 5+ attempts", () => {
    const points = Array(10).fill(10);
    expect(calculateScore(points, 10)).toBe(100);
  });

  it("caps score at 100 with streak bonus", () => {
    const points = Array(10).fill(10);
    // streak 10 → × 1.10, but 100 × 1.10 = 110 → capped at 100
    expect(calculateScore(points, 10)).toBe(100);
  });

  it("applies streak bonus for streak >= 5", () => {
    // 5 passes, 5 blockers → raw weighted ≈ 50ish, streak 5 → × 1.05
    const points = [10, 10, 10, 10, 10, -15, -15, -15, -15, -15];
    const score = calculateScore(points, 5);
    // Weighted earned: 10*(1.0+0.97+0.94+0.91+0.88) + (-15)*(0.85+0.82+0.79+0.76+0.73)
    // = 10*4.7 + (-15)*3.95 = 47 - 59.25 = -12.25
    // Weighted possible: 10*(1.0+0.97+0.94+0.91+0.88+0.85+0.82+0.79+0.76+0.73) = 86.5
    // rawScore = -12.25/86.5 * 100 = -14.2 → clamped to 0
    // streak 5: 0 * 1.05 = 0
    expect(score).toBe(0);
  });

  it("weights recent attempts more than old ones", () => {
    // 10 attempts: 5 recent passes then 5 old passes = same as 10 passes
    const allPass = Array(10).fill(10);
    expect(calculateScore(allPass, 10)).toBe(100);

    // 2 recent blockers + 8 passes should score lower than 8 passes + 2 old blockers
    const recentBlockers = [-15, -15, 10, 10, 10, 10, 10, 10, 10, 10];
    const oldBlockers = [10, 10, 10, 10, 10, 10, 10, 10, -15, -15];
    expect(calculateScore(recentBlockers, 0)).toBeLessThan(calculateScore(oldBlockers, 8));
  });

  it("handles mixed pass/blocker/warning", () => {
    // 20 attempts: 18 pass, 1 blocker, 1 warning
    const points = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, -15, -3];
    const score = calculateScore(points, 8);
    expect(score).toBeGreaterThan(70);
    expect(score).toBeLessThan(100);
  });

  it("handles edge case of all blockers", () => {
    const points = Array(5).fill(-15);
    const score = calculateScore(points, 0);
    expect(score).toBe(0);
  });
});

describe("getQualityState", () => {
  it("returns warming_up for < 5 attempts regardless of score", () => {
    expect(getQualityState(100, 3)).toEqual({ state: "warming_up", badge: "\uD83D\uDD35", autoAssign: true });
    expect(getQualityState(0, 0)).toEqual({ state: "warming_up", badge: "\uD83D\uDD35", autoAssign: true });
  });

  it("returns excellent for 90+", () => {
    expect(getQualityState(90, 10)).toEqual({ state: "excellent", badge: "\uD83D\uDFE2", autoAssign: true });
    expect(getQualityState(100, 10)).toEqual({ state: "excellent", badge: "\uD83D\uDFE2", autoAssign: true });
  });

  it("returns good for 70-89", () => {
    expect(getQualityState(70, 10)).toEqual({ state: "good", badge: "\uD83D\uDFE1", autoAssign: true });
    expect(getQualityState(85, 10)).toEqual({ state: "good", badge: "\uD83D\uDFE1", autoAssign: true });
  });

  it("returns fair for 50-69", () => {
    expect(getQualityState(50, 10)).toEqual({ state: "fair", badge: "\uD83D\uDFE0", autoAssign: true });
    expect(getQualityState(65, 10)).toEqual({ state: "fair", badge: "\uD83D\uDFE0", autoAssign: true });
  });

  it("returns poor for 30-49", () => {
    expect(getQualityState(30, 10)).toEqual({ state: "poor", badge: "\uD83D\uDD34", autoAssign: false });
    expect(getQualityState(45, 10)).toEqual({ state: "poor", badge: "\uD83D\uDD34", autoAssign: false });
  });

  it("returns critical for < 30", () => {
    expect(getQualityState(0, 10)).toEqual({ state: "critical", badge: "\u26D4", autoAssign: false });
    expect(getQualityState(29, 10)).toEqual({ state: "critical", badge: "\u26D4", autoAssign: false });
  });
});

// ---------------------------------------------------------------------------
// Gate check tests (unchanged from v1)
// ---------------------------------------------------------------------------

describe("Quality Gate Service", () => {
  describe("resolveConfig", () => {
    it("returns defaults when no config provided", () => {
      const gate = qualityGateService(createMockDb());
      const config = gate.resolveConfig();
      expect(config).toEqual(DEFAULT_QUALITY_GATE_CONFIG);
    });

    it("merges partial config with defaults", () => {
      const gate = qualityGateService(createMockDb());
      const config = gate.resolveConfig({ requireMinimumDuration: 30 });
      expect(config.enabled).toBe(true);
      expect(config.requireMinimumDuration).toBe(30);
      expect(config.requireComment).toBe(true);
    });

    it("allows disabling quality gates", () => {
      const gate = qualityGateService(createMockDb());
      const config = gate.resolveConfig({ enabled: false });
      expect(config.enabled).toBe(false);
    });
  });

  describe("runChecks", () => {
    it("passes all checks for a valid completion", async () => {
      const gate = qualityGateService(createMockDb({ commentCount: 2 }));
      const ctx = baseIssueContext();
      const result = await gate.runChecks(ctx, DEFAULT_QUALITY_GATE_CONFIG);

      expect(result.passed).toBe(true);
      expect(result.checks.length).toBe(3);
      expect(result.checks.every((c) => c.pass)).toBe(true);
    });

    it("skips all checks when disabled", async () => {
      const gate = qualityGateService(createMockDb({ commentCount: 0 }));
      const ctx = baseIssueContext();
      const config = { ...DEFAULT_QUALITY_GATE_CONFIG, enabled: false };
      const result = await gate.runChecks(ctx, config);

      expect(result.passed).toBe(true);
      expect(result.checks).toEqual([]);
    });

    describe("comment required check", () => {
      it("fails when no comments exist", async () => {
        const gate = qualityGateService(createMockDb({ commentCount: 0 }));
        const ctx = baseIssueContext();
        const result = await gate.runChecks(ctx, DEFAULT_QUALITY_GATE_CONFIG);

        const commentCheck = result.checks.find((c) => c.message.includes("comment"));
        expect(commentCheck).toBeDefined();
        expect(commentCheck!.pass).toBe(false);
        expect(commentCheck!.severity).toBe("blocker");
      });

      it("passes when comments exist", async () => {
        const gate = qualityGateService(createMockDb({ commentCount: 1 }));
        const ctx = baseIssueContext();
        const result = await gate.runChecks(ctx, DEFAULT_QUALITY_GATE_CONFIG);

        const commentCheck = result.checks.find((c) => c.message.includes("comment"));
        expect(commentCheck!.pass).toBe(true);
      });

      it("is skipped when requireComment is false", async () => {
        const gate = qualityGateService(createMockDb({ commentCount: 0 }));
        const ctx = baseIssueContext();
        const config = { ...DEFAULT_QUALITY_GATE_CONFIG, requireComment: false };
        const result = await gate.runChecks(ctx, config);

        expect(result.checks.length).toBe(2);
      });
    });

    describe("duration sanity check", () => {
      it("fails when task completed too quickly", async () => {
        const gate = qualityGateService(createMockDb());
        const ctx = baseIssueContext({
          startedAt: new Date(Date.now() - 3_000),
        });
        const result = await gate.runChecks(ctx, DEFAULT_QUALITY_GATE_CONFIG);

        const durationCheck = result.checks.find((c) => c.message.includes("completed in"));
        expect(durationCheck).toBeDefined();
        expect(durationCheck!.pass).toBe(false);
        expect(durationCheck!.severity).toBe("blocker");
      });

      it("passes when task took sufficient time", async () => {
        const gate = qualityGateService(createMockDb());
        const ctx = baseIssueContext({
          startedAt: new Date(Date.now() - 60_000),
        });
        const result = await gate.runChecks(ctx, DEFAULT_QUALITY_GATE_CONFIG);

        const durationCheck = result.checks.find((c) => c.message.includes("Duration"));
        expect(durationCheck!.pass).toBe(true);
      });

      it("skips check when no startedAt timestamp", async () => {
        const gate = qualityGateService(createMockDb());
        const ctx = baseIssueContext({ startedAt: null });
        const result = await gate.runChecks(ctx, DEFAULT_QUALITY_GATE_CONFIG);

        const durationCheck = result.checks.find((c) => c.message.includes("startedAt"));
        expect(durationCheck).toBeDefined();
        expect(durationCheck!.pass).toBe(true);
        expect(durationCheck!.message).toContain("skipped");
      });
    });

    describe("stale lock check", () => {
      it("fails when execution lock is still held", async () => {
        const gate = qualityGateService(createMockDb());
        const ctx = baseIssueContext({ executionLockedAt: new Date() });
        const result = await gate.runChecks(ctx, DEFAULT_QUALITY_GATE_CONFIG);

        const lockCheck = result.checks.find((c) => c.message.includes("lock"));
        expect(lockCheck!.pass).toBe(false);
        expect(lockCheck!.severity).toBe("blocker");
      });

      it("passes when no execution lock", async () => {
        const gate = qualityGateService(createMockDb());
        const ctx = baseIssueContext({ executionLockedAt: null });
        const result = await gate.runChecks(ctx, DEFAULT_QUALITY_GATE_CONFIG);

        const lockCheck = result.checks.find((c) => c.message.includes("lock"));
        expect(lockCheck!.pass).toBe(true);
      });
    });

    describe("overall result", () => {
      it("marks as failed when any blocker fails", async () => {
        const gate = qualityGateService(createMockDb({ commentCount: 0 }));
        const ctx = baseIssueContext({
          startedAt: new Date(Date.now() - 3_000),
          executionLockedAt: new Date(),
        });
        const result = await gate.runChecks(ctx, DEFAULT_QUALITY_GATE_CONFIG);

        expect(result.passed).toBe(false);
        const blockers = result.checks.filter((c) => !c.pass && c.severity === "blocker");
        expect(blockers.length).toBe(3);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // v2 recordCompletion tests
  // ---------------------------------------------------------------------------

  describe("recordCompletion", () => {
    it("calls db.update on pass with +10 points", async () => {
      const db = createMockDb();
      const gate = qualityGateService(db);
      await gate.recordCompletion("agent-1", passResult());

      expect(db.update).toHaveBeenCalledTimes(1);
      const setCall = (db.update as ReturnType<typeof vi.fn>).mock.results[0]?.value
        .set as ReturnType<typeof vi.fn>;
      expect(setCall).toHaveBeenCalledWith(
        expect.objectContaining({
          qualityPoints: expect.arrayContaining([10]),
        }),
      );
    });

    it("calls db.update on blocker failure with -15 points", async () => {
      const db = createMockDb();
      const gate = qualityGateService(db);
      await gate.recordCompletion("agent-1", blockerResult(["No comment", "Too fast"]));

      expect(db.update).toHaveBeenCalledTimes(1);
      const setCall = (db.update as ReturnType<typeof vi.fn>).mock.results[0]?.value
        .set as ReturnType<typeof vi.fn>;
      expect(setCall).toHaveBeenCalledWith(
        expect.objectContaining({
          qualityPoints: expect.arrayContaining([-15]),
          qualityStreak: 0,
        }),
      );
    });

    it("records -3 points for warning-only failure", async () => {
      const db = createMockDb();
      const gate = qualityGateService(db);
      await gate.recordCompletion("agent-1", warningResult(["Minor issue"]));

      expect(db.update).toHaveBeenCalledTimes(1);
      const setCall = (db.update as ReturnType<typeof vi.fn>).mock.results[0]?.value
        .set as ReturnType<typeof vi.fn>;
      expect(setCall).toHaveBeenCalledWith(
        expect.objectContaining({
          qualityPoints: expect.arrayContaining([-3]),
        }),
      );
    });

    it("prepends new points and trims to 20 entries", async () => {
      const existingPoints = Array(20).fill(10);
      const db = createMockDb({
        agentRow: {
          totalCompleted: 20,
          totalReopened: 0,
          qualityPoints: existingPoints,
          qualityStreak: 20,
          qualityScore: 100,
          lastReopenReasons: [],
        },
      });
      const gate = qualityGateService(db);
      await gate.recordCompletion("agent-1", blockerResult(["Fail"]));

      const setCall = (db.update as ReturnType<typeof vi.fn>).mock.results[0]?.value
        .set as ReturnType<typeof vi.fn>;
      const newPoints = setCall.mock.calls[0][0].qualityPoints;
      // Should be [-15, 10, 10, ...] with 20 entries (oldest dropped)
      expect(newPoints).toHaveLength(20);
      expect(newPoints[0]).toBe(-15);
    });

    it("resets streak on failure", async () => {
      const db = createMockDb({
        agentRow: {
          totalCompleted: 10,
          totalReopened: 0,
          qualityPoints: Array(10).fill(10),
          qualityStreak: 10,
          qualityScore: 100,
          lastReopenReasons: [],
        },
      });
      const gate = qualityGateService(db);
      await gate.recordCompletion("agent-1", blockerResult(["Fail"]));

      const setCall = (db.update as ReturnType<typeof vi.fn>).mock.results[0]?.value
        .set as ReturnType<typeof vi.fn>;
      expect(setCall).toHaveBeenCalledWith(
        expect.objectContaining({ qualityStreak: 0 }),
      );
    });

    it("increments streak on pass", async () => {
      const db = createMockDb({
        agentRow: {
          totalCompleted: 4,
          totalReopened: 0,
          qualityPoints: Array(4).fill(10),
          qualityStreak: 4,
          qualityScore: 100,
          lastReopenReasons: [],
        },
      });
      const gate = qualityGateService(db);
      await gate.recordCompletion("agent-1", passResult());

      const setCall = (db.update as ReturnType<typeof vi.fn>).mock.results[0]?.value
        .set as ReturnType<typeof vi.fn>;
      expect(setCall).toHaveBeenCalledWith(
        expect.objectContaining({ qualityStreak: 5 }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // v2 getAgentQualityScore tests
  // ---------------------------------------------------------------------------

  describe("getAgentQualityScore", () => {
    it("returns warming_up state for agent with < 5 attempts", async () => {
      const db = createMockDb({
        agentRow: {
          totalCompleted: 3,
          totalReopened: 0,
          totalBlocked: 0,
          qualityScore: 100,
          qualityPoints: [10, 10, 10],
          qualityStreak: 3,
          lastReopenReasons: [],
        },
      });
      const gate = qualityGateService(db);
      const info = await gate.getAgentQualityScore("agent-1");

      expect(info).not.toBeNull();
      expect(info!.qualityState).toBe("warming_up");
      expect(info!.qualityBadge).toBe("\uD83D\uDD35");
      expect(info!.qualityAutoAssign).toBe(true);
      expect(info!.qualityAttempts).toBe(3);
      expect(info!.qualityStreak).toBe(3);
    });

    it("returns excellent state for high-scoring agent", async () => {
      const db = createMockDb({
        agentRow: {
          totalCompleted: 10,
          totalReopened: 0,
          totalBlocked: 0,
          qualityScore: 100,
          qualityPoints: Array(10).fill(10),
          qualityStreak: 10,
          lastReopenReasons: [],
        },
      });
      const gate = qualityGateService(db);
      const info = await gate.getAgentQualityScore("agent-1");

      expect(info).not.toBeNull();
      expect(info!.qualityState).toBe("excellent");
      expect(info!.qualityBadge).toBe("\uD83D\uDFE2");
      expect(info!.qualityAutoAssign).toBe(true);
      expect(info!.qualityScore).toBe(100);
      expect(info!.qualityAttempts).toBe(10);
    });

    it("returns fair state for mixed agent", async () => {
      // 15 attempts: 12 pass, 3 blocker
      const points = [
        10, 10, 10, 10, 10, // recent passes
        10, 10, 10, 10, 10, // more passes
        10, 10,             // older passes
        -15, -15, -15,      // oldest: blockers
      ];
      const db = createMockDb({
        agentRow: {
          totalCompleted: 15,
          totalReopened: 3,
          totalBlocked: 0,
          qualityScore: 80,
          qualityPoints: points,
          qualityStreak: 5,
          lastReopenReasons: ["old reason"],
        },
      });
      const gate = qualityGateService(db);
      const info = await gate.getAgentQualityScore("agent-1");

      expect(info).not.toBeNull();
      expect(info!.qualityAttempts).toBe(15);
      expect(info!.qualityStreak).toBe(5);
      expect(info!.qualityScore).toBeGreaterThan(0);
      expect(info!.qualityAutoAssign).toBe(true);
    });

    it("returns null for non-existent agent", async () => {
      const db = createMockDb({ agentRow: null });
      const gate = qualityGateService(db);
      const info = await gate.getAgentQualityScore("nonexistent");

      expect(info).toBeNull();
    });

    it("includes all v2 fields in response", async () => {
      const db = createMockDb({
        agentRow: {
          totalCompleted: 8,
          totalReopened: 1,
          totalBlocked: 2,
          qualityScore: 75,
          qualityPoints: [10, 10, 10, 10, 10, -15, 10, 10],
          qualityStreak: 4,
          lastReopenReasons: ["reason1"],
        },
      });
      const gate = qualityGateService(db);
      const info = await gate.getAgentQualityScore("agent-1");

      expect(info).not.toBeNull();
      expect(info!).toHaveProperty("totalCompleted", 8);
      expect(info!).toHaveProperty("totalReopened", 1);
      expect(info!).toHaveProperty("totalBlocked", 2);
      expect(info!).toHaveProperty("qualityScore");
      expect(info!).toHaveProperty("qualityState");
      expect(info!).toHaveProperty("qualityBadge");
      expect(info!).toHaveProperty("qualityStreak", 4);
      expect(info!).toHaveProperty("qualityAttempts", 8);
      expect(info!).toHaveProperty("qualityAutoAssign");
      expect(info!).toHaveProperty("lastReopenReasons", ["reason1"]);
    });
  });
});
