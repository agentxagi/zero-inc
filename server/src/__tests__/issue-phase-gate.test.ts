import { describe, expect, it } from "vitest";
import { assertIssueStatusTransition, issueWorkflowPhaseForStatus } from "../services/issues.ts";

describe("issue phase gate", () => {
  it("allows valid status transitions", () => {
    expect(() => assertIssueStatusTransition("backlog", "todo")).not.toThrow();
    expect(() => assertIssueStatusTransition("todo", "in_progress")).not.toThrow();
    expect(() => assertIssueStatusTransition("in_progress", "in_review")).not.toThrow();
    expect(() => assertIssueStatusTransition("in_review", "done")).not.toThrow();
    expect(() => assertIssueStatusTransition("done", "todo")).not.toThrow();
  });

  it("rejects invalid status transitions", () => {
    expect(() => assertIssueStatusTransition("backlog", "done")).toThrow(/Invalid issue status transition/i);
    expect(() => assertIssueStatusTransition("todo", "done")).toThrow(/Invalid issue status transition/i);
    expect(() => assertIssueStatusTransition("cancelled", "in_progress")).toThrow(/Invalid issue status transition/i);
  });

  it("maps issue statuses to explicit workflow phases", () => {
    expect(issueWorkflowPhaseForStatus("backlog")).toBe("discovery");
    expect(issueWorkflowPhaseForStatus("todo")).toBe("planning");
    expect(issueWorkflowPhaseForStatus("in_progress")).toBe("implementation");
    expect(issueWorkflowPhaseForStatus("blocked")).toBe("implementation");
    expect(issueWorkflowPhaseForStatus("in_review")).toBe("review");
    expect(issueWorkflowPhaseForStatus("done")).toBe("release");
    expect(issueWorkflowPhaseForStatus("cancelled")).toBe("release");
  });
});
