export interface Sprint {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  goal: string | null;
  status: SprintStatus;
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SprintStatus = "planning" | "active" | "completed" | "cancelled";

export interface BurndownPoint {
  date: string;
  created: number;
  completed: number;
  remaining: number;
}

export interface VelocityEntry {
  agentId: string;
  agentName: string;
  completedCount: number;
  avgCycleTimeHours: number | null;
}

export interface SprintDashboard {
  sprint: Sprint;
  totalIssues: number;
  completedIssues: number;
  burndown: BurndownPoint[];
  velocity: VelocityEntry[];
}
