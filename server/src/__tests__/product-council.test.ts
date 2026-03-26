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

function workProduct(overrides?: Partial<{
  issueId: string;
  type: string;
  provider: string;
  title: string;
  summary: string | null;
  url: string | null;
  status: string;
  reviewState: string;
  isPrimary: boolean;
  updatedAt: Date;
}>) {
  return {
    issueId: overrides?.issueId ?? "issue-1",
    type: overrides?.type ?? "pull_request",
    provider: overrides?.provider ?? "github",
    title: overrides?.title ?? "PR #1",
    summary: overrides?.summary ?? "Implemented feature",
    url: overrides?.url ?? "https://example.com/pr/1",
    status: overrides?.status ?? "approved",
    reviewState: overrides?.reviewState ?? "approved",
    isPrimary: overrides?.isPrimary ?? true,
    updatedAt: overrides?.updatedAt ?? new Date("2026-03-25T12:00:00.000Z"),
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
    const activeOpenSource = issue({
      id: "open-1",
      identifier: "VAL-2",
      title: "[OPEN SOURCE] Refresh quickstart docs",
      status: "in_progress",
      updatedAt: new Date("2026-03-25T17:50:00.000Z"),
      completedAt: null,
    });
    const activeEnterprise = issue({
      id: "open-2",
      identifier: "VAL-3",
      title: "[ENTERPRISE] Build enterprise auth",
      status: "todo",
      updatedAt: new Date("2026-03-25T17:52:00.000Z"),
      completedAt: null,
    });
    const activeOps = issue({
      id: "open-3",
      identifier: "VAL-4",
      title: "[PRODUCT] Improve product council planning",
      status: "blocked",
      updatedAt: new Date("2026-03-25T17:55:00.000Z"),
      completedAt: null,
    });

    const report = buildProductCouncilReport({
      companyId: "company-1",
      goal: defaultGoal,
      goalDoneIssues: [],
      doneIssueWorkProducts: [],
      goalOpenIssues: [activeOpenSource, activeEnterprise, activeOps],
      companyOpenIssues: [activeOpenSource, activeEnterprise, activeOps],
      agentRows: defaultAgents,
      outputsLast7Days: 0,
      now: new Date("2026-03-25T18:00:00.000Z"),
      maxProposals: 5,
    });

    expect(report.gating.shouldGenerate).toBe(false);
    expect(report.gating.reason).toContain("tarefa(s)");
    expect(report.gating.reason).toContain("ativa(s)");
  });

  it("forces generation when active execution is stagnant and milestones are still missing", () => {
    const staleOpenSource = issue({
      id: "open-1",
      identifier: "VAL-9",
      title: "[OPEN SOURCE] Improve docs onboarding",
      status: "in_progress",
      updatedAt: new Date("2026-03-25T12:00:00.000Z"),
      completedAt: null,
    });
    const staleEnterprise = issue({
      id: "open-2",
      identifier: "VAL-10",
      title: "[ENTERPRISE] Harden auth boundaries",
      status: "blocked",
      updatedAt: new Date("2026-03-25T12:00:00.000Z"),
      completedAt: null,
    });
    const staleOperatingModel = issue({
      id: "open-3",
      identifier: "VAL-11",
      title: "[PRODUCT] Improve product council planning",
      status: "todo",
      updatedAt: new Date("2026-03-25T12:00:00.000Z"),
      completedAt: null,
    });

    const report = buildProductCouncilReport({
      companyId: "company-1",
      goal: defaultGoal,
      goalDoneIssues: [],
      doneIssueWorkProducts: [],
      goalOpenIssues: [staleOpenSource, staleEnterprise, staleOperatingModel],
      companyOpenIssues: [staleOpenSource, staleEnterprise, staleOperatingModel],
      agentRows: defaultAgents,
      outputsLast7Days: 0,
      now: new Date("2026-03-25T18:00:00.000Z"),
      maxProposals: 5,
    });

    expect(report.gating.shouldGenerate).toBe(true);
    expect(report.gating.forcedByAntiLoop).toBe(true);
    expect(report.gating.reason).toContain("estagnada");
  });

  it("allows generation to refill missing pillar stock", () => {
    const report = buildProductCouncilReport({
      companyId: "company-1",
      goal: defaultGoal,
      goalDoneIssues: [],
      doneIssueWorkProducts: [],
      goalOpenIssues: [
        issue({
          id: "open-1",
          identifier: "VAL-20",
          title: "[ENTERPRISE] Harden auth boundaries",
          status: "in_progress",
          completedAt: null,
        }),
      ],
      companyOpenIssues: [
        issue({
          id: "open-1",
          identifier: "VAL-20",
          title: "[ENTERPRISE] Harden auth boundaries",
          status: "in_progress",
          completedAt: null,
        }),
      ],
      agentRows: defaultAgents,
      outputsLast7Days: 0,
      now: new Date("2026-03-25T18:00:00.000Z"),
      maxProposals: 5,
    });

    expect(report.gating.shouldGenerate).toBe(true);
    expect(report.workload.missingExecutionStock).toContain("open_source");
    expect(report.workload.missingExecutionStock).toContain("operating_model");
  });

  it("generates proposals when pipeline is idle and milestones are missing", () => {
    const report = buildProductCouncilReport({
      companyId: "company-1",
      goal: defaultGoal,
      goalDoneIssues: [],
      doneIssueWorkProducts: [],
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
    expect(report.valueDelivery.score).toBe(0);
    expect(report.valueDelivery.status).toBe("critical");
  });

  it("limits operating-model proposals to reduce repeated OPS meta-task loops", () => {
    const report = buildProductCouncilReport({
      companyId: "company-1",
      goal: defaultGoal,
      goalDoneIssues: [],
      doneIssueWorkProducts: [],
      goalOpenIssues: [],
      companyOpenIssues: [],
      agentRows: defaultAgents,
      outputsLast7Days: 0,
      now: new Date("2026-03-25T18:00:00.000Z"),
      maxProposals: 8,
    });

    const opsProposals = report.proposals.filter((proposal) => proposal.pillar === "operating_model");
    expect(opsProposals.length).toBeLessThanOrEqual(1);
  });

  it("builds specialist debate output for proposals that require deeper review", () => {
    const report = buildProductCouncilReport({
      companyId: "company-1",
      goal: defaultGoal,
      goalDoneIssues: [],
      doneIssueWorkProducts: [],
      goalOpenIssues: [],
      companyOpenIssues: [],
      agentRows: defaultAgents,
      outputsLast7Days: 0,
      now: new Date("2026-03-25T18:00:00.000Z"),
      maxProposals: 5,
    });

    expect(report.proposalDebate.enabled).toBe(true);
    expect(report.proposalDebate.summary.reviewed).toBeGreaterThan(0);
    expect(report.proposalDebate.items.every((item) => item.requiresDebate)).toBe(true);
    expect(report.proposalDebate.items.some((item) => item.consensus === "revise" || item.consensus === "go")).toBe(true);
  });

  it("computes weekly delivered-value score with ops noise penalty", () => {
    const report = buildProductCouncilReport({
      companyId: "company-1",
      goal: defaultGoal,
      goalDoneIssues: [
        issue({
          id: "done-1",
          identifier: "VAL-60",
          title: "[OPEN SOURCE] Improve quickstart docs",
          reviewCount: 1,
          completedAt: new Date("2026-03-25T17:30:00.000Z"),
        }),
        issue({
          id: "done-2",
          identifier: "VAL-61",
          title: "[ENTERPRISE] Harden auth boundaries",
          reviewCount: 1,
          completedAt: new Date("2026-03-24T17:30:00.000Z"),
        }),
        issue({
          id: "done-3",
          identifier: "VAL-62",
          title: "[OPS] Reconcile stale review locks",
          reviewCount: 0,
          completedAt: new Date("2026-03-24T16:30:00.000Z"),
        }),
      ],
      doneIssueWorkProducts: [
        workProduct({ issueId: "done-1", status: "approved" }),
        workProduct({ issueId: "done-2", status: "approved" }),
        workProduct({ issueId: "done-3", status: "approved" }),
      ],
      goalOpenIssues: [],
      companyOpenIssues: [],
      agentRows: defaultAgents,
      outputsLast7Days: 3,
      now: new Date("2026-03-25T18:00:00.000Z"),
      maxProposals: 5,
    });

    expect(report.valueDelivery.score).toBeGreaterThan(0);
    expect(report.valueDelivery.status).toBe("moderate");
    expect(report.valueDelivery.opsSharePercent).toBeGreaterThan(0);
    expect(report.valueDelivery.components.opsPenalty).toBeGreaterThan(0);
    expect(report.progress.weeklyValueScore).toBe(report.valueDelivery.score);
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
      doneIssueWorkProducts: [
        workProduct({ issueId: "done-1", status: "approved" }),
        workProduct({ issueId: "done-2", status: "ready_for_review" }),
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
    expect(report.progress.doneIssues).toBe(1);
    expect(report.progress.unverifiedDoneIssues).toBe(1);
  });

  it("does not count done issues without work products as verified progress", () => {
    const report = buildProductCouncilReport({
      companyId: "company-1",
      goal: defaultGoal,
      goalDoneIssues: [
        issue({
          id: "done-1",
          identifier: "VAL-30",
          title: "[FEATURE] Ship landing improvements",
          reviewCount: 1,
        }),
      ],
      doneIssueWorkProducts: [],
      goalOpenIssues: [],
      companyOpenIssues: [],
      agentRows: defaultAgents,
      outputsLast7Days: 0,
      now: new Date("2026-03-25T18:00:00.000Z"),
      maxProposals: 5,
    });

    expect(report.progress.doneIssues).toBe(0);
    expect(report.progress.rawDoneIssues).toBe(1);
    expect(report.progress.unverifiedDoneIssues).toBe(1);
    expect(report.progress.issueBasedPercent).toBe(0);
  });
});
