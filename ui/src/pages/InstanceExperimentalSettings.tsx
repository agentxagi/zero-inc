import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import type { PatchInstanceExperimentalSettings } from "@zeroinc/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

export function InstanceExperimentalSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "Experimental" },
    ]);
  }, [setBreadcrumbs]);

  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  const toggleMutation = useMutation({
    mutationFn: async (patch: PatchInstanceExperimentalSettings) =>
      instanceSettingsApi.updateExperimental(patch),
    onSuccess: async () => {
      setActionError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.experimentalSettings }),
        queryClient.invalidateQueries({ queryKey: queryKeys.health }),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update experimental settings.");
    },
  });

  if (experimentalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading experimental settings...</div>;
  }

  if (experimentalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {experimentalQuery.error instanceof Error
          ? experimentalQuery.error.message
          : "Failed to load experimental settings."}
      </div>
    );
  }

  const enableIsolatedWorkspaces = experimentalQuery.data?.enableIsolatedWorkspaces === true;
  const autoRestartDevServerWhenIdle = experimentalQuery.data?.autoRestartDevServerWhenIdle === true;
  const preventiveQuotaThrottleEnabled = experimentalQuery.data?.preventiveQuotaThrottleEnabled === true;
  const preventiveQuotaThrottleThresholdPercent = experimentalQuery.data?.preventiveQuotaThrottleThresholdPercent ?? 85;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Experimental</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Opt into features that are still being evaluated before they become default behavior.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Enable Isolated Workspaces</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show execution workspace controls in project configuration and allow isolated workspace behavior for new
              and existing issue runs.
            </p>
          </div>
          <button
            type="button"
            data-slot="toggle"
            aria-label="Toggle isolated workspaces experimental setting"
            disabled={toggleMutation.isPending}
            className={cn(
              "relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              enableIsolatedWorkspaces ? "bg-green-600" : "bg-muted",
            )}
            onClick={() => toggleMutation.mutate({ enableIsolatedWorkspaces: !enableIsolatedWorkspaces })}
          >
            <span
              className={cn(
                "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                enableIsolatedWorkspaces ? "translate-x-4.5" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Auto-Restart Dev Server When Idle</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              In `pnpm dev:once`, wait for all queued and running local agent runs to finish, then restart the server
              automatically when backend changes or migrations make the current boot stale.
            </p>
          </div>
          <button
            type="button"
            data-slot="toggle"
            aria-label="Toggle guarded dev-server auto-restart"
            disabled={toggleMutation.isPending}
            className={cn(
              "relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              autoRestartDevServerWhenIdle ? "bg-green-600" : "bg-muted",
            )}
            onClick={() =>
              toggleMutation.mutate({ autoRestartDevServerWhenIdle: !autoRestartDevServerWhenIdle })
            }
          >
            <span
              className={cn(
                "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                autoRestartDevServerWhenIdle ? "translate-x-4.5" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <h2 className="text-sm font-semibold">Preventive Quota Throttle (Timer Heartbeats)</h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                When short-window provider quota reaches the configured percentage, scheduled timer wakes are skipped
                to reduce unnecessary token burn. Disabled by default. Manual/assignment wakeups remain available.
              </p>
            </div>
            <button
              type="button"
              aria-label="Toggle preventive quota throttle"
              disabled={toggleMutation.isPending}
              className={cn(
                "relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                preventiveQuotaThrottleEnabled ? "bg-amber-600" : "bg-muted",
              )}
              onClick={() =>
                toggleMutation.mutate({ preventiveQuotaThrottleEnabled: !preventiveQuotaThrottleEnabled })
              }
            >
              <span
                className={cn(
                  "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                  preventiveQuotaThrottleEnabled ? "translate-x-4.5" : "translate-x-0.5",
                )}
              />
            </button>
          </div>

          <div className="flex items-center gap-3">
            <label htmlFor="preventive-quota-threshold" className="text-sm text-muted-foreground">
              Trigger threshold
            </label>
            <select
              id="preventive-quota-threshold"
              value={preventiveQuotaThrottleThresholdPercent}
              onChange={(event) =>
                toggleMutation.mutate({
                  preventiveQuotaThrottleThresholdPercent: Number.parseInt(event.target.value, 10),
                })
              }
              disabled={toggleMutation.isPending}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
            >
              {[80, 85, 90, 95, 98, 99].map((value) => (
                <option key={value} value={value}>
                  {value}%
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>
    </div>
  );
}
