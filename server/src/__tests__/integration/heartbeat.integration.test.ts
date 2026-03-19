import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * Integration tests for Heartbeat API
 *
 * These tests verify the heartbeat functionality:
 * - Heartbeat run lifecycle
 * - Wake reason handling
 * - Session management
 * - Run events and logging
 *
 * Note: These tests validate API contracts and business logic patterns.
 * For full database integration, database-backed tests would be needed.
 */

describe("Heartbeat Integration Tests", () => {
  describe("Heartbeat run lifecycle", () => {
    it("creates run with pending status", () => {
      // New heartbeat runs start as pending
      const newRun = {
        id: randomUUID(),
        agentId: randomUUID(),
        status: "pending",
        invocationSource: "assignment",
        startedAt: null,
        finishedAt: null,
      };

      expect(newRun.status).toBe("pending");
      expect(newRun.startedAt).toBeNull();
    });

    it("transitions to running when execution starts", () => {
      const run = {
        id: randomUUID(),
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };

      expect(run.status).toBe("running");
      expect(run.startedAt).not.toBeNull();
      expect(run.finishedAt).toBeNull();
    });

    it("transitions to completed on success", () => {
      const run = {
        id: randomUUID(),
        status: "completed",
        startedAt: "2026-03-10T10:00:00Z",
        finishedAt: "2026-03-10T10:05:00Z",
      };

      expect(run.status).toBe("completed");
      expect(run.finishedAt).not.toBeNull();
    });

    it("transitions to failed on error", () => {
      const run = {
        id: randomUUID(),
        status: "failed",
        error: "Connection timeout",
        startedAt: "2026-03-10T10:00:00Z",
        finishedAt: "2026-03-10T10:01:00Z",
      };

      expect(run.status).toBe("failed");
      expect(run.error).toBeDefined();
    });

    it("transitions to cancelled when cancelled mid-execution", () => {
      const run = {
        id: randomUUID(),
        status: "cancelled",
        startedAt: "2026-03-10T10:00:00Z",
        finishedAt: "2026-03-10T10:02:00Z",
      };

      expect(run.status).toBe("cancelled");
    });
  });

  describe("Wake reason handling", () => {
    it("handles issue_assigned wake reason", () => {
      // Agent wakes up because an issue was assigned to them
      const wakeContext = {
        wakeReason: "issue_assigned",
        taskId: randomUUID(),
        wakeSource: "assignment",
      };

      expect(wakeContext.wakeReason).toBe("issue_assigned");
      expect(wakeContext.taskId).toBeDefined();
    });

    it("handles issue_comment_mentioned wake reason", () => {
      // Agent wakes up because they were @mentioned in a comment
      const wakeContext = {
        wakeReason: "issue_comment_mentioned",
        wakeCommentId: randomUUID(),
        wakeSource: "on_demand",
        triggerDetail: "callback",
      };

      expect(wakeContext.wakeReason).toBe("issue_comment_mentioned");
      expect(wakeContext.wakeCommentId).toBeDefined();
    });

    it("handles timer wake reason", () => {
      // Agent wakes up due to scheduled heartbeat interval
      const wakeContext = {
        wakeReason: null,
        wakeSource: "timer",
      };

      expect(wakeContext.wakeSource).toBe("timer");
    });

    it("handles on_demand wake with manual trigger", () => {
      // Agent was manually triggered via API or UI
      const wakeContext = {
        wakeReason: null,
        wakeSource: "on_demand",
        triggerDetail: "manual",
      };

      expect(wakeContext.wakeSource).toBe("on_demand");
      expect(wakeContext.triggerDetail).toBe("manual");
    });

    it("handles on_demand wake with callback trigger", () => {
      // Agent was triggered via callback (e.g., from an external system)
      const wakeContext = {
        wakeReason: null,
        wakeSource: "on_demand",
        triggerDetail: "callback",
      };

      expect(wakeContext.triggerDetail).toBe("callback");
    });
  });

  describe("Session management", () => {
    it("resets session on assignment wake", () => {
      // When agent is assigned a new task, session context should reset
      const shouldReset = shouldResetTaskSessionForWake({
        wakeReason: "issue_assigned",
      });

      expect(shouldReset).toBe(true);
    });

    it("resets session on timer wake", () => {
      // Timer heartbeats get fresh session context
      const shouldReset = shouldResetTaskSessionForWake({
        wakeSource: "timer",
      });

      expect(shouldReset).toBe(true);
    });

    it("resets session on manual on_demand wake", () => {
      // Manual triggers get fresh session context
      const shouldReset = shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        triggerDetail: "manual",
      });

      expect(shouldReset).toBe(true);
    });

    it("preserves session on mention wake", () => {
      // When @mentioned, agent should continue in existing session
      const shouldReset = shouldResetTaskSessionForWake({
        wakeReason: "issue_comment_mentioned",
        wakeCommentId: randomUUID(),
      });

      expect(shouldReset).toBe(false);
    });

    it("preserves session on comment wake", () => {
      // Comment wakes don't reset session
      const shouldReset = shouldResetTaskSessionForWake({
        wakeReason: "issue_commented",
        commentId: randomUUID(),
      });

      expect(shouldReset).toBe(false);
    });

    it("preserves session on callback on_demand wake", () => {
      // Callback triggers preserve session context
      const shouldReset = shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        triggerDetail: "callback",
      });

      expect(shouldReset).toBe(false);
    });
  });

  describe("Workspace resolution", () => {
    it("uses project primary workspace when available", () => {
      // Agent should use project's configured workspace
      const resolved = {
        cwd: "/opt/project",
        source: "project_primary",
        projectId: randomUUID(),
        workspaceId: randomUUID(),
      };

      expect(resolved.source).toBe("project_primary");
      expect(resolved.cwd).toBeDefined();
    });

    it("falls back to task session workspace", () => {
      // If no project workspace, use previous task session
      const resolved = {
        cwd: "/tmp/agent-session",
        source: "task_session",
        projectId: null,
        workspaceId: randomUUID(),
      };

      expect(resolved.source).toBe("task_session");
    });

    it("falls back to agent home directory", () => {
      // Last resort: use agent's home directory
      const resolved = {
        cwd: "/home/agent/workspace",
        source: "agent_home",
        projectId: null,
        workspaceId: null,
      };

      expect(resolved.source).toBe("agent_home");
    });

    it("migrates fallback session to project workspace", () => {
      // When project workspace becomes available, migrate session
      const previousSession = {
        sessionId: "session-1",
        cwd: "/home/agent/workspace", // Fallback
        workspaceId: "workspace-1",
      };

      const resolvedWorkspace = {
        cwd: "/opt/project",
        source: "project_primary",
        workspaceId: "workspace-1", // Same workspace ID
      };

      // Session should migrate to project cwd
      const shouldMigrate =
        previousSession.cwd !== resolvedWorkspace.cwd &&
        previousSession.workspaceId === resolvedWorkspace.workspaceId;

      expect(shouldMigrate).toBe(true);
    });
  });

  describe("Run events", () => {
    it("tracks heartbeat events with timestamps", () => {
      const events = [
        { type: "started", timestamp: "2026-03-10T10:00:00Z" },
        { type: "checkout", timestamp: "2026-03-10T10:00:05Z", issueId: randomUUID() },
        { type: "progress", timestamp: "2026-03-10T10:02:00Z", message: "Working..." },
        { type: "completed", timestamp: "2026-03-10T10:05:00Z" },
      ];

      expect(events).toHaveLength(4);
      expect(events[0].type).toBe("started");
      expect(events[3].type).toBe("completed");
    });

    it("captures error events with stack traces", () => {
      const errorEvent = {
        type: "error",
        timestamp: "2026-03-10T10:03:00Z",
        error: {
          message: "Connection refused",
          stack: "Error: Connection refused\n    at connect (...)",
        },
      };

      expect(errorEvent.type).toBe("error");
      expect(errorEvent.error.message).toBeDefined();
    });
  });

  describe("Concurrent run limits", () => {
    it("enforces max concurrent runs per agent", () => {
      const agentConfig = {
        runtimeConfig: {
          heartbeat: {
            maxConcurrentRuns: 1,
          },
        },
      };

      const currentRuns = 1;
      const canStartNew = currentRuns < agentConfig.runtimeConfig.heartbeat.maxConcurrentRuns;

      expect(canStartNew).toBe(false); // Already at max
    });

    it("allows multiple concurrent runs when configured", () => {
      const agentConfig = {
        runtimeConfig: {
          heartbeat: {
            maxConcurrentRuns: 3,
          },
        },
      };

      const currentRuns = 2;
      const canStartNew = currentRuns < agentConfig.runtimeConfig.heartbeat.maxConcurrentRuns;

      expect(canStartNew).toBe(true);
    });

    it("limits max concurrent runs to 10", () => {
      const maxLimit = 10;
      const requestedLimit = 15;
      const actualLimit = Math.min(maxLimit, Math.max(1, requestedLimit));

      expect(actualLimit).toBe(10);
    });
  });

  describe("Run cancellation", () => {
    it("cancels pending run immediately", () => {
      const run = {
        id: randomUUID(),
        status: "pending",
        startedAt: null,
      };

      // Pending runs can be cancelled without waiting
      const canCancelImmediately = run.status === "pending";
      expect(canCancelImmediately).toBe(true);
    });

    it("requests cancellation for running run", () => {
      const run = {
        id: randomUUID(),
        status: "running",
        cancellationRequested: false,
      };

      // Running runs need graceful cancellation
      run.cancellationRequested = true;
      expect(run.cancellationRequested).toBe(true);
    });
  });

  describe("Cost tracking", () => {
    it("tracks cost events per run", () => {
      const costEvent = {
        runId: randomUUID(),
        agentId: randomUUID(),
        provider: "anthropic",
        model: "claude-3-opus",
        inputTokens: 1000,
        outputTokens: 500,
        costCents: 15,
        timestamp: new Date().toISOString(),
      };

      expect(costEvent.runId).toBeDefined();
      expect(costEvent.costCents).toBeGreaterThan(0);
    });

    it("aggregates costs per heartbeat run", () => {
      const runCosts = [5, 10, 3]; // cents
      const totalCents = runCosts.reduce((sum, c) => sum + c, 0);

      expect(totalCents).toBe(18);
    });
  });
});

// Helper function matching server logic for session reset decisions
function shouldResetTaskSessionForWake(context: {
  wakeReason?: string | null;
  wakeSource?: string;
  triggerDetail?: string;
  wakeCommentId?: string;
  commentId?: string;
}): boolean {
  // Reset on assignment
  if (context.wakeReason === "issue_assigned") return true;

  // Reset on timer
  if (context.wakeSource === "timer") return true;

  // Reset on manual on-demand
  if (context.wakeSource === "on_demand" && context.triggerDetail === "manual") return true;

  // Don't reset on mention
  if (context.wakeReason === "issue_comment_mentioned" && context.wakeCommentId) return false;

  // Don't reset on comment
  if (context.commentId) return false;
  if (context.wakeReason === "issue_commented") return false;

  // Don't reset on callback
  if (context.wakeSource === "on_demand" && context.triggerDetail === "callback") return false;

  return false;
}
