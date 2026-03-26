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
