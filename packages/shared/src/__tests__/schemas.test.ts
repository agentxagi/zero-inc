import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  createIssueSchema,
  updateIssueSchema,
  checkoutIssueSchema,
  addIssueCommentSchema,
  createIssueLabelSchema,
  linkIssueApprovalSchema,
} from "../validators/issue.js";
import {
  createAgentSchema,
  updateAgentSchema,
  createAgentKeySchema,
  wakeAgentSchema,
  updateAgentPermissionsSchema,
  updateAgentInstructionsPathSchema,
} from "../validators/agent.js";
import {
  createProjectSchema,
  updateProjectSchema,
  createProjectWorkspaceSchema,
} from "../validators/project.js";
import {
  createGoalSchema,
  updateGoalSchema,
} from "../validators/goal.js";
import {
  createApprovalSchema,
  resolveApprovalSchema,
  addApprovalCommentSchema,
} from "../validators/approval.js";
import {
  createSecretSchema,
  updateSecretSchema,
} from "../validators/secret.js";

describe("Issue Schemas", () => {
  describe("createIssueSchema", () => {
    it("should validate a minimal valid issue", () => {
      const result = createIssueSchema.safeParse({
        title: "Test Issue",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBe("Test Issue");
        expect(result.data.status).toBe("backlog");
        expect(result.data.priority).toBe("medium");
      }
    });

    it("should validate a complete valid issue", () => {
      const result = createIssueSchema.safeParse({
        title: "Test Issue",
        description: "Test description",
        status: "todo",
        priority: "high",
        projectId: "123e4567-e89b-12d3-a456-426614174000",
        assigneeAgentId: "123e4567-e89b-12d3-a456-426614174001",
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty title", () => {
      const result = createIssueSchema.safeParse({
        title: "",
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid status", () => {
      const result = createIssueSchema.safeParse({
        title: "Test",
        status: "invalid_status",
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid priority", () => {
      const result = createIssueSchema.safeParse({
        title: "Test",
        priority: "urgent",
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid UUID for projectId", () => {
      const result = createIssueSchema.safeParse({
        title: "Test",
        projectId: "not-a-uuid",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("updateIssueSchema", () => {
    it("should allow partial updates", () => {
      const result = updateIssueSchema.safeParse({
        title: "Updated Title",
      });
      expect(result.success).toBe(true);
    });

    it("should allow comment in update", () => {
      const result = updateIssueSchema.safeParse({
        status: "done",
        comment: "Completed the task",
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty comment", () => {
      const result = updateIssueSchema.safeParse({
        comment: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("checkoutIssueSchema", () => {
    it("should validate valid checkout request", () => {
      const result = checkoutIssueSchema.safeParse({
        agentId: "123e4567-e89b-12d3-a456-426614174000",
        expectedStatuses: ["todo", "backlog"],
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty expectedStatuses", () => {
      const result = checkoutIssueSchema.safeParse({
        agentId: "123e4567-e89b-12d3-a456-426614174000",
        expectedStatuses: [],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("addIssueCommentSchema", () => {
    it("should validate comment with body", () => {
      const result = addIssueCommentSchema.safeParse({
        body: "This is a comment",
      });
      expect(result.success).toBe(true);
    });

    it("should allow reopen flag", () => {
      const result = addIssueCommentSchema.safeParse({
        body: "Reopening this",
        reopen: true,
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty body", () => {
      const result = addIssueCommentSchema.safeParse({
        body: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("createIssueLabelSchema", () => {
    it("should validate valid label", () => {
      const result = createIssueLabelSchema.safeParse({
        name: "Bug",
        color: "#ff0000",
      });
      expect(result.success).toBe(true);
    });

    it("should reject invalid color format", () => {
      const result = createIssueLabelSchema.safeParse({
        name: "Bug",
        color: "red",
      });
      expect(result.success).toBe(false);
    });

    it("should reject color without #", () => {
      const result = createIssueLabelSchema.safeParse({
        name: "Bug",
        color: "ff0000",
      });
      expect(result.success).toBe(false);
    });

    it("should trim name", () => {
      const result = createIssueLabelSchema.safeParse({
        name: "  Bug  ",
        color: "#ff0000",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("Bug");
      }
    });
  });

  describe("linkIssueApprovalSchema", () => {
    it("should validate valid approval link", () => {
      const result = linkIssueApprovalSchema.safeParse({
        approvalId: "123e4567-e89b-12d3-a456-426614174000",
      });
      expect(result.success).toBe(true);
    });

    it("should reject invalid UUID", () => {
      const result = linkIssueApprovalSchema.safeParse({
        approvalId: "not-a-uuid",
      });
      expect(result.success).toBe(false);
    });
  });
});

describe("Agent Schemas", () => {
  describe("createAgentSchema", () => {
    it("should validate minimal agent", () => {
      const result = createAgentSchema.safeParse({
        name: "Test Agent",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.role).toBe("general");
        expect(result.data.adapterType).toBe("process");
      }
    });

    it("should validate complete agent", () => {
      const result = createAgentSchema.safeParse({
        name: "Backend Engineer",
        role: "engineer",
        title: "Senior Backend Engineer",
        icon: "database",
        adapterType: "claude_local",
        budgetMonthlyCents: 10000,
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty name", () => {
      const result = createAgentSchema.safeParse({
        name: "",
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid role", () => {
      const result = createAgentSchema.safeParse({
        name: "Test",
        role: "super_admin",
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid adapterType", () => {
      const result = createAgentSchema.safeParse({
        name: "Test",
        adapterType: "unknown",
      });
      expect(result.success).toBe(false);
    });

    it("should reject negative budget", () => {
      const result = createAgentSchema.safeParse({
        name: "Test",
        budgetMonthlyCents: -100,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("updateAgentSchema", () => {
    it("should allow partial updates", () => {
      const result = updateAgentSchema.safeParse({
        name: "Updated Name",
      });
      expect(result.success).toBe(true);
    });

    it("should allow status update", () => {
      const result = updateAgentSchema.safeParse({
        status: "paused",
      });
      expect(result.success).toBe(true);
    });

    it("should reject permissions in update", () => {
      const result = updateAgentSchema.safeParse({
        permissions: { canCreateAgents: true },
      });
      expect(result.success).toBe(false);
    });
  });

  describe("createAgentKeySchema", () => {
    it("should use default name", () => {
      const result = createAgentKeySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("default");
      }
    });

    it("should allow custom name", () => {
      const result = createAgentKeySchema.safeParse({
        name: "production",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("wakeAgentSchema", () => {
    it("should use defaults", () => {
      const result = wakeAgentSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.source).toBe("on_demand");
      }
    });

    it("should validate valid source", () => {
      const result = wakeAgentSchema.safeParse({
        source: "timer",
      });
      expect(result.success).toBe(true);
    });

    it("should reject invalid source", () => {
      const result = wakeAgentSchema.safeParse({
        source: "invalid",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("updateAgentPermissionsSchema", () => {
    it("should require canCreateAgents", () => {
      const result = updateAgentPermissionsSchema.safeParse({
        canCreateAgents: true,
      });
      expect(result.success).toBe(true);
    });

    it("should reject missing canCreateAgents", () => {
      const result = updateAgentPermissionsSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe("updateAgentInstructionsPathSchema", () => {
    it("should validate valid path", () => {
      const result = updateAgentInstructionsPathSchema.safeParse({
        path: "/path/to/AGENTS.md",
      });
      expect(result.success).toBe(true);
    });

    it("should allow null path", () => {
      const result = updateAgentInstructionsPathSchema.safeParse({
        path: null,
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty path", () => {
      const result = updateAgentInstructionsPathSchema.safeParse({
        path: "",
      });
      expect(result.success).toBe(false);
    });
  });
});

describe("Project Schemas", () => {
  describe("createProjectSchema", () => {
    it("should validate minimal project", () => {
      const result = createProjectSchema.safeParse({
        name: "Test Project",
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty name", () => {
      const result = createProjectSchema.safeParse({
        name: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("createProjectWorkspaceSchema", () => {
    it("should validate with cwd only", () => {
      const result = createProjectWorkspaceSchema.safeParse({
        name: "main",
        cwd: "/path/to/project",
      });
      expect(result.success).toBe(true);
    });

    it("should validate with repoUrl only", () => {
      const result = createProjectWorkspaceSchema.safeParse({
        name: "main",
        repoUrl: "https://github.com/org/repo",
      });
      expect(result.success).toBe(true);
    });

    it("should require at least cwd or repoUrl", () => {
      const result = createProjectWorkspaceSchema.safeParse({
        name: "main",
      });
      expect(result.success).toBe(false);
    });
  });
});

describe("Goal Schemas", () => {
  describe("createGoalSchema", () => {
    it("should validate minimal goal", () => {
      const result = createGoalSchema.safeParse({
        title: "Test Goal",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("updateGoalSchema", () => {
    it("should allow partial updates", () => {
      const result = updateGoalSchema.safeParse({
        title: "Updated Goal",
      });
      expect(result.success).toBe(true);
    });
  });
});

describe("Approval Schemas", () => {
  describe("createApprovalSchema", () => {
    it("should validate valid approval", () => {
      const result = createApprovalSchema.safeParse({
        type: "hire_agent",
        payload: { agentName: "Test Agent" },
      });
      expect(result.success).toBe(true);
    });

    it("should validate with optional fields", () => {
      const result = createApprovalSchema.safeParse({
        type: "hire_agent",
        payload: { agentName: "Test" },
        requestedByAgentId: "123e4567-e89b-12d3-a456-426614174000",
        issueIds: ["123e4567-e89b-12d3-a456-426614174001"],
      });
      expect(result.success).toBe(true);
    });

    it("should reject invalid type", () => {
      const result = createApprovalSchema.safeParse({
        type: "unknown",
        payload: {},
      });
      expect(result.success).toBe(false);
    });

    it("should require payload", () => {
      const result = createApprovalSchema.safeParse({
        type: "hire_agent",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("resolveApprovalSchema", () => {
    it("should validate with decisionNote", () => {
      const result = resolveApprovalSchema.safeParse({
        decisionNote: "Approved!",
      });
      expect(result.success).toBe(true);
    });

    it("should validate without decisionNote", () => {
      const result = resolveApprovalSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });

  describe("addApprovalCommentSchema", () => {
    it("should require body", () => {
      const result = addApprovalCommentSchema.safeParse({
        body: "This is a comment",
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty body", () => {
      const result = addApprovalCommentSchema.safeParse({
        body: "",
      });
      expect(result.success).toBe(false);
    });
  });
});

describe("Secret Schemas", () => {
  describe("createSecretSchema", () => {
    it("should validate valid secret", () => {
      const result = createSecretSchema.safeParse({
        name: "API_KEY",
        value: "secret-value",
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty name", () => {
      const result = createSecretSchema.safeParse({
        name: "",
        value: "secret",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("updateSecretSchema", () => {
    it("should allow partial updates", () => {
      const result = updateSecretSchema.safeParse({
        name: "UPDATED_KEY",
      });
      expect(result.success).toBe(true);
    });
  });
});
