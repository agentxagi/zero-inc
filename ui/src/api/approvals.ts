import type { Approval, ApprovalComment, Issue } from "@zeroinc/shared";
import { api } from "./client";

export const approvalsApi = {
  list: (companyId: string, status?: string) =>
    api.get<Approval[]>(
      `/companies/${companyId}/approvals${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Approval>(`/companies/${companyId}/approvals`, data),
  get: (id: string) => api.get<Approval>(`/approvals/${id}`),
  approve: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/approve`, { decisionNote }),
  reject: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/reject`, { decisionNote }),
  requestRevision: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/request-revision`, { decisionNote }),
  resubmit: (id: string, payload?: Record<string, unknown>) =>
    api.post<Approval>(`/approvals/${id}/resubmit`, { payload }),
  listComments: (id: string) => api.get<ApprovalComment[]>(`/approvals/${id}/comments`),
  addComment: (id: string, body: string) =>
    api.post<ApprovalComment>(`/approvals/${id}/comments`, { body }),
  listIssues: (id: string) => api.get<Issue[]>(`/approvals/${id}/issues`),
  /** Fetch all issue IDs linked to pending approvals in a company. */
  pendingApprovalIssueIds: async (companyId: string): Promise<string[]> => {
    const approvals = await api.get<Approval[]>(
      `/companies/${companyId}/approvals?status=pending`,
    );
    if (approvals.length === 0) return [];
    const results = await Promise.all(
      approvals.map((a) => api.get<Issue[]>(`/approvals/${a.id}/issues`)),
    );
    const ids: string[] = [];
    for (const issues of results) {
      for (const issue of issues) {
        ids.push(issue.id);
      }
    }
    return [...new Set(ids)];
  },
};
