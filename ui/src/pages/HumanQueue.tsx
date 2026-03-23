import { useMemo } from "react";
import { useLocation } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { UserCircle } from "lucide-react";

const REQUIRES_HUMAN_LABEL = "requires_human";

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

  // Look up the requires_human label
  const { data: labels } = useQuery({
    queryKey: queryKeys.issues.labels(selectedCompanyId!),
    queryFn: () => issuesApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const requiresHumanLabelId = useMemo(
    () => labels?.find((l) => l.name === REQUIRES_HUMAN_LABEL)?.id,
    [labels],
  );

  // Fetch human tasks (requires_human label, not done/cancelled)
  const { data: allHumanIssues, isLoading, error } = useQuery({
    queryKey: ["human-queue-issues", selectedCompanyId, requiresHumanLabelId],
    queryFn: () => issuesApi.list(selectedCompanyId!, { labelId: requiresHumanLabelId }),
    enabled: !!selectedCompanyId && !!requiresHumanLabelId,
  });

  // Filter out done/cancelled client-side (the label filter returns all)
  const humanIssues = useMemo(
    () => (allHumanIssues ?? []).filter((i) => i.status !== "done" && i.status !== "cancelled"),
    [allHumanIssues],
  );

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
      queryClient.invalidateQueries({ queryKey: ["human-queue-issues"] });
    },
  });

  useMemo(() => {
    setBreadcrumbs([{ label: "Human Queue" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={UserCircle} message="Select a company to view human tasks." />;
  }

  if (!requiresHumanLabelId) {
    return <EmptyState icon={UserCircle} message="The 'requires_human' label has not been created yet." />;
  }

  return (
    <IssuesList
      issues={humanIssues}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      liveIssueIds={liveIssueIds}
      viewStateKey="zeroinc:human-queue-view"
      issueLinkState={issueLinkState}
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
    />
  );
}
