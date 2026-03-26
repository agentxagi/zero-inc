import { useEffect, useMemo } from "react";
import { useLocation } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { dashboardApi } from "../api/dashboard";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { UserCircle } from "lucide-react";

export function HumanQueue() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const queryClient = useQueryClient();

  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        "Human Queue",
        `${location.pathname}${location.search}${location.hash}`,
      ),
    [location.pathname, location.search, location.hash],
  );

  const { data: humanQueue, isLoading: isQueueLoading, error: queueError } = useQuery({
    queryKey: queryKeys.dashboardHumanQueue(selectedCompanyId!),
    queryFn: () => dashboardApi.humanQueue(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const { data: openIssues, isLoading: isIssuesLoading, error: issuesError } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        status: "backlog,todo,in_progress,in_review,blocked",
      }),
    enabled: !!selectedCompanyId,
  });

  const humanIssues = useMemo(() => {
    const orderedIds = (humanQueue?.items ?? []).map((item) => item.issueId);
    if (orderedIds.length === 0) return [];
    const byId = new Map((openIssues ?? []).map((issue) => [issue.id, issue]));
    return orderedIds
      .map((id) => byId.get(id))
      .filter((issue): issue is NonNullable<typeof issue> => Boolean(issue));
  }, [humanQueue, openIssues]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 5000,
  });

  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboardHumanQueue(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
    },
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Human Queue" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={UserCircle} message="Select a company to view human tasks." />;
  }

  const isLoading = isQueueLoading || isIssuesLoading;
  const error = (queueError ?? issuesError) as Error | null;

  return (
    <IssuesList
      issues={humanIssues}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      liveIssueIds={liveIssueIds}
      viewStateKey="zeroinc:human-queue-view"
      issueLinkState={issueLinkState}
      preserveInputOrder
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
    />
  );
}
