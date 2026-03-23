import { pgTable, uuid, text, timestamp, date, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const sprints = pgTable(
  "sprints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    description: text("description"),
    goal: text("goal"),
    status: text("status").notNull().default("planning"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("sprints_company_idx").on(table.companyId),
    statusIdx: index("sprints_company_status_idx").on(table.companyId, table.status),
  }),
);
