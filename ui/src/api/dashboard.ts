import type { DashboardSummary, HumanQueueSummary } from "@zeroinc/shared";
import { api } from "./client";

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  humanQueue: (companyId: string) => api.get<HumanQueueSummary>(`/dashboard/companies/${companyId}/human-queue`),
};
