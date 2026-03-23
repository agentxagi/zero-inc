import { z } from "zod";

export const SPRINT_STATUSES = ["planning", "active", "completed", "cancelled"] as const;

export const createSprintSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  goal: z.string().optional().nullable(),
  startDate: z.string().date().optional().nullable(),
  endDate: z.string().date().optional().nullable(),
});

export const updateSprintSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  goal: z.string().optional().nullable(),
  status: z.enum(SPRINT_STATUSES).optional(),
  startDate: z.string().date().optional().nullable(),
  endDate: z.string().date().optional().nullable(),
});

export const linkIssueToSprintSchema = z.object({
  sprintId: z.string().uuid().nullable(),
});

export type CreateSprint = z.infer<typeof createSprintSchema>;
export type UpdateSprint = z.infer<typeof updateSprintSchema>;
export type LinkIssueToSprint = z.infer<typeof linkIssueToSprintSchema>;
