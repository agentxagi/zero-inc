import { describe, expect, it } from "vitest";
import { buildProductCouncilReport, isOperationalNoiseIssue } from "../services/product-council.ts";

function issue(overrides?: Partial<{
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  originKind: string;
  goalId: string | null;
  updatedAt: Date;
  completedAt: Date | null;
  reviewCount: number;
}>) {
  return {
    id: overrides?.id ?? "issue-1",
    identifier: overrides?.identifier ?? "VAL-1",
    title: overrides?.title ?? "[FEATURE] Deliver feature",
    description: overrides?.description ?? "desc",
    status: overrides?.status ?? "done",
    priority: overrides?.priority ?? "high",
    originKind: overrides?.originKind ?? "manual",
    goalId: overrides?.goalId ?? "goal-1",
    updatedAt: overrides?.updatedAt ?? new Date("2026-03-25T12:00:00.000Z"),
    completedAt: overrides?.completedAt ?? new Date("2026-03-25T12:00:00.000Z"),
    reviewCount: overrides?.reviewCount ?? 1,
  };
}

const defaultGoal = {
  id: "goal-1",
  title: "ZeroInc Open Source and Enterprise",
  description: null,
  status: "active",
  level: "company",
};

const defaultAgents = [
  { id: "agent-pm", name: "PM", role: "pm", status: "running" },
  { id: "agent-cto", name: "CTO", role: "cto", status: "running" },
  { id: "agent-qa", name: "QA", role: "qa", status: "running" },
];

describe("product-council", () => {
  it("classifies ops noise issue patterns", () => {
    expect(isOperationalNoiseIssue({ title: "[OPS] Restart watcher", originKind: "manual" })).toBe(true);
    expect(isOperationalNoiseIssue({ title: "Regular product task", originKind: "routine_execution" })).toBe(true);
    expect(isOperationalNoiseIssue({ title: "[FEATURE] Build docs site", originKind: "manual" })).toBe(false);
  });

  it("blocks generation while there is active execution work", () => {
    const report = buildProductCouncilReport({
      companyId: "company-1",
      goal: defaultGoal,
      goalDoneIssues: [],
      goalOpenIssues: [
        issue({
          id: "open-1",
          identifier: "VAL-2",
          title: "[FEATURE] Build enterprise auth",
          status: "in_progress",
          completedAt: null,
        }),
      ],
      companyOpenIssues: [
        issue({
          id: "open-1",
          identifier: "VAL-2",
          title: "[FEATURE] Build enterprise auth",
          status: "in_progress",
          completedAt: null,
        }),
      ],
      agentRows: defaultAgents,
      outputsLast7Days: 0,
      now: new Date("2026-03-25T18:00:00.000Z"),
      maxProposals: 5,
    });

    expect(report.gating.shouldGenerate).toBe(false);
    expect(report.gating.reason).toContain("tarefa(s)");
    expect(report.gating.reason).toContain("ativa(s)");
  });

  it("generates proposals when pipeline is idle and milestones are missing", () => {
    const report = buildProductCouncilReport({
      companyId: "company-1",
      goal: defaultGoal,
      goalDoneIssues: [],
      goalOpenIssues: [],
      companyOpenIssues: [],
      agentRows: defaultAgents,
      outputsLast7Days: 0,
      now: new Date("2026-03-25T18:00:00.000Z"),
      maxProposals: 3,
    });

    expect(report.gating.shouldGenerate).toBe(true);
    expect(report.proposals.length).toBeGreaterThan(0);
    expect(report.proposals.length).toBeLessThanOrEqual(3);
    expect(report.progress.outcomeBasedPercent).toBe(0);
  });

  it("computes engineering review coverage", () => {
    const report = buildProductCouncilReport({
      companyId: "company-1",
      goal: defaultGoal,
      goalDoneIssues: [
        issue({
          id: "done-1",
          identifier: "VAL-10",
          title: "[BUG] Fix auth isolation",
          reviewCount: 1,
          completedAt: new Date("2026-03-25T17:30:00.000Z"),
        }),
        issue({
          id: "done-2",
          identifier: "VAL-11",
          title: "[FEATURE] Improve queue cleanup",
          reviewCount: 0,
          completedAt: new Date("2026-03-25T16:30:00.000Z"),
        }),
      ],
      goalOpenIssues: [],
      companyOpenIssues: [],
      agentRows: defaultAgents,
      outputsLast7Days: 5,
      now: new Date("2026-03-25T18:00:00.000Z"),
      maxProposals: 5,
    });

    expect(report.progress.reviewCoveragePercent).toBe(50);
    expect(report.progress.doneLast24h).toBe(2);
  });
});
