import { eq } from "drizzle-orm";
import type { Db } from "@zeroinc/db";
import { companies } from "@zeroinc/db";
import { logger } from "../middleware/logger.js";
import {
  materializeProductCouncilProposals,
  type MaterializeProductCouncilResult,
} from "./product-council-materializer.js";

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PROPOSALS_PER_TICK = 2;
const DEFAULT_MAX_COMPANIES_PER_TICK = 100;

export type ProductCouncilAutomationTickResult = {
  evaluatedCompanies: number;
  generatedIssues: number;
  companiesWithNewIssues: number;
  skippedCooldown: number;
  errors: number;
  details: Array<{
    companyId: string;
    generated: number;
    reason: string;
  }>;
};

type ProductCouncilAutomationOptions = {
  cooldownMs?: number;
  maxProposalsPerTick?: number;
  maxCompaniesPerTick?: number;
  targetStatus?: "backlog" | "todo";
  actorId?: string;
  materialize?: (
    db: Db,
    companyId: string,
    opts: {
      maxProposals?: number;
      targetStatus?: "backlog" | "todo";
      actor: { actorType: "system"; actorId: string };
      ensureMacroPrograms?: boolean;
    },
  ) => Promise<MaterializeProductCouncilResult>;
};

export function productCouncilAutomationService(db: Db, options?: ProductCouncilAutomationOptions) {
  const cooldownMs = Math.max(1, options?.cooldownMs ?? DEFAULT_COOLDOWN_MS);
  const maxProposalsPerTick = Math.max(1, options?.maxProposalsPerTick ?? DEFAULT_MAX_PROPOSALS_PER_TICK);
  const maxCompaniesPerTick = Math.max(1, options?.maxCompaniesPerTick ?? DEFAULT_MAX_COMPANIES_PER_TICK);
  const targetStatus = options?.targetStatus === "backlog" ? "backlog" : "todo";
  const actorId = options?.actorId ?? "system.product_council_automation";
  const materialize = options?.materialize ?? materializeProductCouncilProposals;
  const lastAttemptByCompany = new Map<string, number>();

  return {
    tick: async (now = new Date()): Promise<ProductCouncilAutomationTickResult> => {
      const companyRows = await db
        .select({
          id: companies.id,
        })
        .from(companies)
        .where(eq(companies.status, "active"))
        .limit(maxCompaniesPerTick);

      let evaluatedCompanies = 0;
      let generatedIssues = 0;
      let companiesWithNewIssues = 0;
      let skippedCooldown = 0;
      let errors = 0;
      const details: ProductCouncilAutomationTickResult["details"] = [];
      const nowMs = now.getTime();

      for (const company of companyRows) {
        const lastAttemptMs = lastAttemptByCompany.get(company.id);
        if (typeof lastAttemptMs === "number" && nowMs - lastAttemptMs < cooldownMs) {
          skippedCooldown += 1;
          continue;
        }

        evaluatedCompanies += 1;
        try {
          const result = await materialize(db, company.id, {
            maxProposals: maxProposalsPerTick,
            targetStatus,
            actor: {
              actorType: "system",
              actorId,
            },
            ensureMacroPrograms: true,
          });

          lastAttemptByCompany.set(company.id, nowMs);
          generatedIssues += result.generated;
          if (result.generated > 0) companiesWithNewIssues += 1;
          details.push({
            companyId: company.id,
            generated: result.generated,
            reason: result.reason,
          });
        } catch (err) {
          errors += 1;
          details.push({
            companyId: company.id,
            generated: 0,
            reason: "automation_error",
          });
          logger.error({ err, companyId: company.id }, "product council automation tick failed for company");
        }
      }

      return {
        evaluatedCompanies,
        generatedIssues,
        companiesWithNewIssues,
        skippedCooldown,
        errors,
        details,
      };
    },
  };
}
