import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Delegation rules for automatic task assignment and escalation.
 *
 * Rule types:
 * - "assign": On issue creation, match title/priority/status and set assignee
 * - "priority": On issue creation, match title/priority and set priority
 * - "escalate": On status transition, if status held > N minutes, take action
 */
export const delegationRules = pgTable(
  "delegation_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(true),
    /** "assign" | "priority" | "escalate" */
    ruleType: text("rule_type").notNull(),
    /** Trigger event: "create" | "status_change" */
    triggerOn: text("trigger_on").notNull().default("create"),
    /** Regex pattern to match against issue title */
    titlePattern: text("title_pattern"),
    /** Label names to match (any-match semantics; null = any) */
    matchLabels: jsonb("match_labels").$type<string[] | null>(),
    /** Exact priority to match (null = any) */
    matchPriority: text("match_priority"),
    /** Exact status to match (null = any; for escalate rules, the status to watch) */
    matchStatus: text("match_status"),
    /** Agent ID to assign the issue to */
    assignToAgentId: uuid("assign_to_agent_id"),
    /** User ID to assign the issue to */
    assignToUserId: text("assign_to_user_id"),
    /** Priority to set (for priority rules) */
    setPriority: text("set_priority"),
    /** Status to set (for escalate rules) */
    setStatus: text("set_status"),
    /** Comment to post when rule fires */
    commentBody: text("comment_body"),
    /** Minutes to wait before triggering (for escalate rules) */
    delayMinutes: integer("delay_minutes"),
    /** Sort order (lower = evaluated first) */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("delegation_rules_company_idx").on(table.companyId),
    companyEnabledIdx: index("delegation_rules_company_enabled_idx").on(table.companyId, table.enabled),
  }),
);
