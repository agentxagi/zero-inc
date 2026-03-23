import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentMemory = pgTable(
  "agent_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    key: text("key").notNull(),
    value: text("value").notNull(),
    sourceKind: text("source_kind").notNull().default("manual_note"),
    sourceIssueId: uuid("source_issue_id"),
    sourceRunId: uuid("source_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentCompanyKeyIdx: uniqueIndex("agent_memory_agent_company_key_idx").on(
      table.agentId,
      table.companyId,
      table.key,
    ),
    companyIdx: index("agent_memory_company_idx").on(table.companyId),
    agentIdx: index("agent_memory_agent_idx").on(table.agentId),
  }),
);

export const sharedMemory = pgTable(
  "shared_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    key: text("key").notNull(),
    value: text("value").notNull(),
    writtenByAgentId: uuid("written_by_agent_id").references(() => agents.id),
    sourceKind: text("source_kind").notNull().default("manual_note"),
    sourceIssueId: uuid("source_issue_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyIdx: uniqueIndex("shared_memory_company_key_idx").on(
      table.companyId,
      table.key,
    ),
    companyIdx: index("shared_memory_company_idx").on(table.companyId),
  }),
);

export const memoryOperations = pgTable(
  "memory_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    agentId: uuid("agent_id"),
    operationType: text("operation_type").notNull(),
    scopeType: text("scope_type").notNull(),
    memoryId: uuid("memory_id"),
    memoryKey: text("memory_key"),
    sourceKind: text("source_kind"),
    success: integer("success").notNull().default(1),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("memory_operations_company_idx").on(table.companyId),
    agentIdx: index("memory_operations_agent_idx").on(table.agentId),
    createdIdx: index("memory_operations_created_idx").on(table.createdAt),
  }),
);
