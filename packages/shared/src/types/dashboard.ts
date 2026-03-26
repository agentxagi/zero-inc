export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  pendingApprovals: number;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  operationalReadiness?: OperationalReadinessSummary;
}

export type OperationalReadinessStatus = "healthy" | "warning" | "critical";
export type OperationalReadinessCheckStatus = "pass" | "warning" | "fail";

export interface OperationalReadinessCheck {
  status: OperationalReadinessCheckStatus;
  pass: boolean;
  title: string;
  description: string;
  details: Record<string, unknown>;
}

export interface OperationalReadinessWeeklySignal {
  label: string;
  outputs: number;
  workProducts: number;
  total: number;
}

export interface OperationalReadinessSummary {
  generatedAt: string;
  windowDays: number;
  status: OperationalReadinessStatus;
  score: number;
  checks: {
    deliverablesGrowth: OperationalReadinessCheck & {
      details: {
        transitionsNonDecreasing: number;
        latestWeeklyTotal: number;
        series: OperationalReadinessWeeklySignal[];
      };
    };
    executionContinuity: OperationalReadinessCheck & {
      details: {
        daysWithExecutionProxy: number;
        daysWithoutExecutionProxy: number;
        totalDays: number;
        currentTodoOrInProgressProduct: number;
      };
    };
    opsNoiseShare: OperationalReadinessCheck & {
      details: {
        opsSharePercent: number;
        thresholdPercent: number;
        totalDoneLast30Days: number;
        opsDoneLast30Days: number;
      };
    };
    cancellationRate: OperationalReadinessCheck & {
      details: {
        cancellationRatePercent: number;
        thresholdPercent: number;
        doneLast30Days: number;
        cancelledLast30Days: number;
      };
    };
    localProcessHealth: OperationalReadinessCheck & {
      details: {
        runningLocalProcesses: number;
        detachedTimeoutRunsLast7Days: number;
        processLossRetriesLast7Days: number;
        localRunsLast7Days: number;
      };
    };
  };
  summary: {
    passedChecks: number;
    warningChecks: number;
    failedChecks: number;
    totalChecks: number;
  };
}

export type ProductCouncilPillar = "open_source" | "enterprise" | "operating_model";
export type ProductCouncilProposalPriority = "critical" | "high" | "medium" | "low";
export type ProductCouncilDebateConsensus = "go" | "revise" | "hold";
export type ProductCouncilDebateStance = "support" | "support_with_changes" | "block";
export type ProductCouncilValueDeliveryStatus = "critical" | "weak" | "moderate" | "strong";

export interface ProductCouncilMacroProgram {
  key: ProductCouncilPillar;
  title: string;
  goalId: string | null;
  goalStatus: string | null;
  cycleKey: string;
  cycleGoalId: string | null;
  cycleGoalStatus: string | null;
}

export interface ProductCouncilMacroProgramsSummary {
  cycleKey: string;
  rootGoalId: string | null;
  rootCreated?: boolean;
  createdProgramKeys?: ProductCouncilPillar[];
  createdCycleKeys?: ProductCouncilPillar[];
  programs: ProductCouncilMacroProgram[];
}

export interface ProductCouncilGoalSummary {
  id: string;
  title: string;
  status: string;
  level: string;
}

export interface ProductCouncilMilestone {
  id: string;
  pillar: ProductCouncilPillar;
  title: string;
  status: "done" | "partial" | "missing";
  evidenceCount: number;
  evidenceIssueIds: string[];
}

export interface ProductCouncilDiscussionEntry {
  role: "pm" | "cto" | "reviewer";
  speaker: string;
  summary: string;
  concerns: string[];
  recommendation: string;
}

export interface ProductCouncilProposal {
  id: string;
  sourceMilestoneId: string;
  pillar: ProductCouncilPillar;
  title: string;
  description: string;
  priority: ProductCouncilProposalPriority;
  suggestedOwnerRole: string | null;
  suggestedAssigneeAgentId: string | null;
  suggestedAssigneeName: string | null;
  definitionOfDone: string[];
}

export interface ProductCouncilProposalDebateSpeaker {
  role: "pm" | "cto" | "qa" | "researcher";
  speaker: string;
  stance: ProductCouncilDebateStance;
  rationale: string;
  mustHave: string[];
}

export interface ProductCouncilProposalDebateItem {
  proposalId: string;
  requiresDebate: boolean;
  consensus: ProductCouncilDebateConsensus;
  confidence: number;
  summary: string;
  speakers: ProductCouncilProposalDebateSpeaker[];
}

export interface ProductCouncilValueDelivery {
  windowDays: number;
  score: number;
  status: ProductCouncilValueDeliveryStatus;
  totalDoneLast7Days: number;
  verifiedDoneLast7Days: number;
  opsDoneLast7Days: number;
  opsSharePercent: number;
  outputsLast7Days: number;
  pillarCoveragePercent: number;
  pillarsWithVerifiedDelivery: Record<ProductCouncilPillar, number>;
  components: {
    throughputScore: number;
    verificationScore: number;
    coverageScore: number;
    reviewScore: number;
    evidenceScore: number;
    opsPenalty: number;
  };
}

export interface ProductCouncilReport {
  timestamp: string;
  companyId: string;
  macroPrograms: ProductCouncilMacroProgramsSummary | null;
  teamModel: {
    source: string;
    principles: string[];
  };
  goal: ProductCouncilGoalSummary | null;
  workload: {
    companyOpenIssues: number;
    executionActive: number;
    staleExecutionActive: number;
    executionBacklog: number;
    staleExecutionBacklog: number;
    executionStockByPillar: Record<ProductCouncilPillar, number>;
    executionMinStockByPillar: Record<ProductCouncilPillar, number>;
    missingExecutionStock: ProductCouncilPillar[];
    goalOpenByStatus: {
      backlog: number;
      todo: number;
      in_progress: number;
      in_review: number;
      blocked: number;
    };
  };
  progress: {
    issueBasedPercent: number;
    rawIssueBasedPercent: number;
    outcomeBasedPercent: number;
    weeklyValueScore: number;
    doneIssues: number;
    rawDoneIssues: number;
    unverifiedDoneIssues: number;
    openIssues: number;
    doneLast24h: number;
    verifiedDoneLast24h: number;
    reviewCoveragePercent: number | null;
    outputsLast7Days: number;
  };
  valueDelivery: ProductCouncilValueDelivery;
  milestones: ProductCouncilMilestone[];
  councilDiscussion: ProductCouncilDiscussionEntry[];
  gating: {
    shouldGenerate: boolean;
    reason: string;
    forcedByAntiLoop: boolean;
    opsProposalsSkipped: number;
  };
  antiLoop: {
    stagnationWindowMinutes: number;
    staleExecutionActive: number;
    forcedByAntiLoop: boolean;
    opsProposalsSkipped: number;
  };
  proposalDebate: {
    enabled: boolean;
    summary: {
      reviewed: number;
      go: number;
      revise: number;
      hold: number;
    };
    items: ProductCouncilProposalDebateItem[];
  };
  proposals: ProductCouncilProposal[];
}

export interface HumanQueueItem {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  humanActionType: string | null;
  humanResolutionHint: string | null;
  humanBlockedAt: Date | null;
  humanSlaDueAt: Date | null;
  slaState: "overdue" | "due_soon" | "on_track" | "no_sla";
  slaMinutesRemaining: number | null;
  requiresHumanLabel: boolean;
}

export interface HumanQueueSummary {
  companyId: string;
  generatedAt: Date;
  total: number;
  overdue: number;
  dueSoon: number;
  items: HumanQueueItem[];
}
