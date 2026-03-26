import type { DashboardSummary, HumanQueueSummary, ProductCouncilReport } from "@zeroinc/shared";
import { api } from "./client";

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  humanQueue: (companyId: string) => api.get<HumanQueueSummary>(`/dashboard/companies/${companyId}/human-queue`),
  productCouncil: (
    companyId: string,
    opts?: { goalId?: string; maxProposals?: number; ensurePrograms?: boolean },
  ) => {
    const params = new URLSearchParams();
    if (opts?.goalId) params.set("goalId", opts.goalId);
    if (typeof opts?.maxProposals === "number" && Number.isFinite(opts.maxProposals)) {
      params.set("maxProposals", String(opts.maxProposals));
    }
    if (opts?.ensurePrograms) params.set("ensurePrograms", "true");
    const query = params.toString();
    const suffix = query.length > 0 ? `?${query}` : "";
    return api.get<ProductCouncilReport>(`/companies/${companyId}/product-council${suffix}`);
  },
};
