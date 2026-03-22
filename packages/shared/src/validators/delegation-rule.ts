import { z } from "zod";

export const ISSUE_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export const ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"] as const;

export const createDelegationRuleSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  ruleType: z.enum(["assign", "priority", "escalate"]),
  triggerOn: z.enum(["create", "status_change"]).optional().default("create"),
  titlePattern: z.string().max(500).optional().nullable(),
  matchPriority: z.enum(ISSUE_PRIORITIES).optional().nullable(),
  matchStatus: z.enum(ISSUE_STATUSES).optional().nullable(),
  assignToAgentId: z.string().uuid().optional().nullable(),
  assignToUserId: z.string().max(200).optional().nullable(),
  setPriority: z.enum(ISSUE_PRIORITIES).optional().nullable(),
  setStatus: z.enum(ISSUE_STATUSES).optional().nullable(),
  commentBody: z.string().max(5000).optional().nullable(),
  delayMinutes: z.number().int().min(0).max(10080).optional().nullable(), // max 7 days
  sortOrder: z.number().int().min(0).max(9999).optional().default(0),
});

export type CreateDelegationRule = z.infer<typeof createDelegationRuleSchema>;

export const updateDelegationRuleSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  enabled: z.boolean().optional(),
  ruleType: z.enum(["assign", "priority", "escalate"]).optional(),
  triggerOn: z.enum(["create", "status_change"]).optional(),
  titlePattern: z.string().max(500).optional().nullable(),
  matchPriority: z.enum(ISSUE_PRIORITIES).optional().nullable(),
  matchStatus: z.enum(ISSUE_STATUSES).optional().nullable(),
  assignToAgentId: z.string().uuid().optional().nullable(),
  assignToUserId: z.string().max(200).optional().nullable(),
  setPriority: z.enum(ISSUE_PRIORITIES).optional().nullable(),
  setStatus: z.enum(ISSUE_STATUSES).optional().nullable(),
  commentBody: z.string().max(5000).optional().nullable(),
  delayMinutes: z.number().int().min(0).max(10080).optional().nullable(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

export type UpdateDelegationRule = z.infer<typeof updateDelegationRuleSchema>;
