import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.ts";

describe("queueIssueAssignmentWakeup", () => {
  it("wakes the latest assignee when assignment changed before enqueue", async () => {
    const wakeup = vi.fn(async () => ({ id: "wake-1" }));
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-old", status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      resolveCurrentIssue: async () => ({ assigneeAgentId: "agent-new", status: "todo" }),
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(
      "agent-new",
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
      }),
    );
  });

  it("skips wakeup when issue becomes unassigned before enqueue", async () => {
    const wakeup = vi.fn(async () => ({ id: "wake-1" }));
    const result = await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-old", status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      resolveCurrentIssue: async () => ({ assigneeAgentId: null, status: "todo" }),
    });

    expect(result).toBeNull();
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("uses the provided assignee when no resolver is supplied", async () => {
    const wakeup = vi.fn(async () => ({ id: "wake-1" }));
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        payload: { issueId: "issue-1", mutation: "create" },
      }),
    );
  });
});

