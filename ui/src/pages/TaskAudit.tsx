import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { api } from "../api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ShieldAlert, AlertTriangle, CheckCircle, Clock, Eye, XCircle } from "lucide-react";
import { Link } from "@/lib/router";

interface AuditResult {
  total: number;
  reviewed: number;
  unreviewed: number;
  flagged: number;
  details: Array<{
    issueId: string;
    identifier: string | null;
    title: string;
    assigneeAgentId: string | null;
    assigneeAgentName: string | null;
    qualityScore: number | null;
    durationMinutes: number | null;
    commentCount: number;
    flagged: boolean;
    flagReasons: string[];
  }>;
}

export function TaskAudit() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [hasRun, setHasRun] = useState(false);

  const { data: audit, isLoading } = useQuery<AuditResult>({
    queryKey: ["task-audit", selectedCompanyId],
    queryFn: () => api.post<AuditResult>(`/companies/${selectedCompanyId}/issues/audit`, null),
    enabled: !!selectedCompanyId && hasRun,
  });

  const flagIssue = useMutation({
    mutationFn: (issueId: string) =>
      api.post(`/companies/${selectedCompanyId}/issues/${issueId}/flag`, null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["task-audit"] }),
  });

  const unflagIssue = useMutation({
    mutationFn: (issueId: string) =>
      api.post(`/companies/${selectedCompanyId}/issues/${issueId}/unflag`, null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["task-audit"] }),
  });

  const reopenIssue = useMutation({
    mutationFn: (issueId: string) =>
      api.patch(`/issues/${issueId}`, { status: "todo" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["task-audit"] }),
  });

  setBreadcrumbs([{ label: "Task Audit" }]);

  if (!selectedCompanyId) {
    return <div className="p-6 text-muted-foreground">Select a company to run task audit.</div>;
  }

  const summaryCards = [
    { label: "Total Done", value: audit?.total ?? "-", icon: CheckCircle, color: "text-green-600" },
    { label: "Reviewed", value: audit?.reviewed ?? "-", icon: Eye, color: "text-blue-600" },
    { label: "Unreviewed", value: audit?.unreviewed ?? "-", icon: Clock, color: "text-amber-600" },
    { label: "Flagged", value: audit?.flagged ?? "-", icon: AlertTriangle, color: "text-red-600" },
  ];

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldAlert className="h-6 w-6" />
            Task Audit
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Review completed tasks that were never formally reviewed. Flag issues for follow-up.
          </p>
        </div>
        <Button
          onClick={() => setHasRun(true)}
          disabled={isLoading}
        >
          {isLoading ? "Running..." : hasRun ? "Re-run Audit" : "Run Audit"}
        </Button>
      </div>

      {audit && (
        <>
          <div className="grid grid-cols-4 gap-4">
            {summaryCards.map((card) => (
              <Card key={card.label}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">{card.label}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold ${card.color}`}>
                    {card.value}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {audit.flagged > 0 && (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold">Flagged Issues</h2>
              {audit.details
                .filter((d) => d.flagged)
                .map((issue) => (
                  <Card key={issue.issueId}>
                    <CardContent className="py-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <Link
                              to={`/issues/${issue.issueId}`}
                              className="text-sm font-medium text-blue-600 hover:underline"
                            >
                              {issue.identifier ?? "—"}
                            </Link>
                            <Badge variant={issue.qualityScore && issue.qualityScore < 50 ? "destructive" : "secondary"}>
                              Score: {issue.qualityScore ?? "N/A"}
                            </Badge>
                            {issue.durationMinutes !== null && (
                              <span className="text-xs text-muted-foreground">
                                {issue.durationMinutes}min
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground mt-1 truncate">{issue.title}</p>
                          <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                            <span>Assignee: {issue.assigneeAgentName ?? "N/A"}</span>
                            <span>Comments: {issue.commentCount}</span>
                          </div>
                          <div className="flex gap-2 mt-2">
                            {issue.flagReasons.map((reason) => (
                              <Badge key={reason} variant="outline" className="text-xs">
                                {reason}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        <div className="flex gap-2 shrink-0 ml-4">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => reopenIssue.mutate(issue.issueId)}
                          >
                            Reopen
                          </Button>
                          {issue.flagReasons.length > 0 ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => unflagIssue.mutate(issue.issueId)}
                            >
                              <XCircle className="h-3 w-3" />
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => flagIssue.mutate(issue.issueId)}
                            >
                              <AlertTriangle className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
            </div>
          )}

          {audit.flagged === 0 && (
            <div className="text-center py-10 text-muted-foreground">
              <CheckCircle className="h-8 w-8 mx-auto mb-2 text-green-600" />
              <p>No flagged issues found. All unreviewed tasks look healthy.</p>
            </div>
          )}
        </>
      )}

      {!hasRun && (
        <div className="text-center py-16 text-muted-foreground">
          <ShieldAlert className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p>Click "Run Audit" to scan completed tasks for quality issues.</p>
        </div>
      )}
    </div>
  );
}
