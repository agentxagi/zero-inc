import { useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime } from "../lib/utils";
import { StatusBadge } from "./StatusBadge";
import { ApprovalPayloadRenderer, typeIcon } from "./ApprovalPayload";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CheckCircle2,
  XCircle,
  MessageSquare,
  Clock,
  ChevronRight,
} from "lucide-react";
import type { Approval } from "@zeroinc/shared";

interface HumanApprovalWidgetProps {
  approvals: Approval[];
  companyId: string;
}

export function HumanApprovalWidget({ approvals, companyId }: HumanApprovalWidgetProps) {
  const queryClient = useQueryClient();
  const [rejectTarget, setRejectTarget] = useState<Approval | null>(null);
  const [revisionTarget, setRevisionTarget] = useState<Approval | null>(null);
  const [decisionNote, setDecisionNote] = useState("");

  const actionableApprovals = approvals.filter(
    (a) => a.status === "pending" || a.status === "revision_requested",
  );
  const resolvedApprovals = approvals.filter(
    (a) => a.status === "approved" || a.status === "rejected",
  );

  const refreshApprovals = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
    queryClient.invalidateQueries({
      queryKey: queryKeys.approvals.list(companyId, "pending"),
    });
  };

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: () => refreshApprovals(),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      approvalsApi.reject(id, note || undefined),
    onSuccess: () => {
      setRejectTarget(null);
      setDecisionNote("");
      refreshApprovals();
    },
  });

  const revisionMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      approvalsApi.requestRevision(id, note || undefined),
    onSuccess: () => {
      setRevisionTarget(null);
      setDecisionNote("");
      refreshApprovals();
    },
  });

  if (approvals.length === 0) return null;

  return (
    <div className="space-y-3" role="region" aria-label="Approvals">
      {/* Actionable approvals — prominent CTA */}
      {actionableApprovals.length > 0 && (
        <div className="rounded-lg border-2 border-amber-300 dark:border-amber-600/50 bg-amber-50 dark:bg-amber-900/15 divide-y divide-amber-200 dark:divide-amber-800/40">
          <div className="flex items-center gap-2 px-3 py-2">
            <Clock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            <span className="text-sm font-semibold text-amber-800 dark:text-amber-200">
              Awaiting your approval
            </span>
            <span className="ml-auto text-xs font-medium text-amber-600 dark:text-amber-300">
              {actionableApprovals.length} pending
            </span>
          </div>

          {actionableApprovals.map((approval) => {
            const Icon = typeIcon[approval.type] ?? typeIcon["human_decision"];
            const payload = approval.payload as Record<string, unknown>;

            return (
              <div key={approval.id} className="px-3 py-3 space-y-3">
                <div className="flex items-start gap-2">
                  <Icon className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <StatusBadge status={approval.status} />
                      <span className="text-sm font-medium">
                        {approval.type.replace(/_/g, " ")}
                      </span>
                      <span className="text-xs text-muted-foreground ml-auto">
                        {relativeTime(approval.createdAt)}
                      </span>
                    </div>
                    <ApprovalPayloadRenderer type={approval.type} payload={payload} />
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap pl-6">
                  <Button
                    size="sm"
                    className="bg-green-700 hover:bg-green-600 text-white shadow-none"
                    onClick={() => approveMutation.mutate(approval.id)}
                    disabled={approveMutation.isPending}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Approve
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      setDecisionNote("");
                      setRejectTarget(approval);
                    }}
                    disabled={rejectMutation.isPending}
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    Reject
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setDecisionNote("");
                      setRevisionTarget(approval);
                    }}
                    disabled={revisionMutation.isPending}
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    Request Changes
                  </Button>
                  <Link
                    to={`/approvals/${approval.id}`}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors ml-auto"
                  >
                    View details
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Resolved approvals — collapsible timeline */}
      {resolvedApprovals.length > 0 && (
        <details className="group rounded-lg border border-border">
          <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none hover:bg-accent/20 transition-colors rounded-lg">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
            <span className="text-sm font-medium text-muted-foreground">
              Approval history
            </span>
            <span className="text-xs text-muted-foreground/60 ml-auto">
              {resolvedApprovals.length} resolved
            </span>
          </summary>
          <div className="border-t border-border divide-y divide-border">
            {resolvedApprovals.map((approval) => {
              const Icon = typeIcon[approval.type] ?? typeIcon["human_decision"];
              const isApproved = approval.status === "approved";

              return (
                <div
                  key={approval.id}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={approval.status} />
                      <span className="text-xs truncate">
                        {approval.type.replace(/_/g, " ")}
                      </span>
                    </div>
                    {approval.decisionNote && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {approval.decisionNote}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {isApproved ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 text-destructive" />
                    )}
                    <Link
                      to={`/approvals/${approval.id}`}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {relativeTime(approval.updatedAt)}
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}

      {/* Reject justification dialog */}
      <Dialog
        open={rejectTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRejectTarget(null);
            setDecisionNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this request?</DialogTitle>
            <DialogDescription>
              Please explain why you are rejecting this so the agent can adjust.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={decisionNote}
            onChange={(e) => setDecisionNote(e.target.value)}
            placeholder="Reason for rejection (required)..."
            rows={3}
            autoFocus
            aria-label="Rejection reason"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRejectTarget(null);
                setDecisionNote("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!rejectTarget) return;
                rejectMutation.mutate({
                  id: rejectTarget.id,
                  note: decisionNote.trim(),
                });
              }}
              disabled={!decisionNote.trim() || rejectMutation.isPending}
            >
              {rejectMutation.isPending ? "Rejecting..." : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Request revision dialog */}
      <Dialog
        open={revisionTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevisionTarget(null);
            setDecisionNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request changes</DialogTitle>
            <DialogDescription>
              Describe what needs to be revised so the agent can improve the work.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={decisionNote}
            onChange={(e) => setDecisionNote(e.target.value)}
            placeholder="What should be changed? (required)..."
            rows={3}
            autoFocus
            aria-label="Revision request details"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRevisionTarget(null);
                setDecisionNote("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!revisionTarget) return;
                revisionMutation.mutate({
                  id: revisionTarget.id,
                  note: decisionNote.trim(),
                });
              }}
              disabled={!decisionNote.trim() || revisionMutation.isPending}
            >
              {revisionMutation.isPending ? "Sending..." : "Send Revision Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
