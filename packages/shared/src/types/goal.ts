import type { GoalLevel, GoalStatus } from "../constants.js";

export interface Goal {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  level: GoalLevel;
  status: GoalStatus;
  parentId: string | null;
  ownerAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GoalProgress {
  goalId: string;
  goalTitle: string;
  goalLevel: GoalLevel;
  goalStatus: GoalStatus;
  totalIssues: number;
  byStatus: Record<string, number>;
  done: number;
  rawDone: number;
  unverifiedDone: number;
  remaining: number;
  completionPercent: number;
  rawCompletionPercent: number;
  velocityPerDay: number;
  completedLast7Days: number;
  rawCompletedLast7Days: number;
  estimatedDaysToComplete: number | null;
}
