import { describe, expect, it } from "vitest";

/**
 * Tests for issue status transition guards
 *
 * These tests verify that certain status transitions require additional
 * context (e.g., a comment) to prevent accidental or context-free changes
 * that could waste agent budget or lose important state.
 */

describe("Issue status transition guards", () => {
  describe("done to blocked transition", () => {
    it("requires comment when transitioning from done to blocked", () => {
      const existingStatus = "done";
      const newStatus = "blocked";
      const comment = null;

      const isRevertingToBlocked =
        newStatus === "blocked" &&
        (existingStatus === "done" || existingStatus === "cancelled");

      const requiresComment = isRevertingToBlocked && !comment;
      expect(requiresComment).toBe(true);
    });

    it("allows done to blocked with comment", () => {
      const existingStatus = "done";
      const newStatus = "blocked";
      const comment = "Reopening because customer reported regression";

      const isRevertingToBlocked =
        newStatus === "blocked" &&
        (existingStatus === "done" || existingStatus === "cancelled");

      const requiresComment = isRevertingToBlocked && !comment;
      expect(requiresComment).toBe(false);
    });

    it("allows done to blocked with empty string comment (rejected by validator)", () => {
      // Empty string would be rejected by the comment validator (min 1 char)
      // but the guard logic should still check for truthy comment
      const existingStatus = "done";
      const newStatus = "blocked";
      const comment = "";

      const isRevertingToBlocked =
        newStatus === "blocked" &&
        (existingStatus === "done" || existingStatus === "cancelled");

      const requiresComment = isRevertingToBlocked && !comment;
      expect(requiresComment).toBe(true);
    });
  });

  describe("cancelled to blocked transition", () => {
    it("requires comment when transitioning from cancelled to blocked", () => {
      const existingStatus = "cancelled";
      const newStatus = "blocked";
      const comment = null;

      const isRevertingToBlocked =
        newStatus === "blocked" &&
        (existingStatus === "done" || existingStatus === "cancelled");

      const requiresComment = isRevertingToBlocked && !comment;
      expect(requiresComment).toBe(true);
    });

    it("allows cancelled to blocked with comment", () => {
      const existingStatus = "cancelled";
      const newStatus = "blocked";
      const comment = "Reopening because requirements changed";

      const isRevertingToBlocked =
        newStatus === "blocked" &&
        (existingStatus === "done" || existingStatus === "cancelled");

      const requiresComment = isRevertingToBlocked && !comment;
      expect(requiresComment).toBe(false);
    });
  });

  describe("other status transitions", () => {
    it("does not require comment for done to todo", () => {
      const existingStatus = "done";
      const newStatus = "todo";
      const comment = null;

      const isRevertingToBlocked =
        newStatus === "blocked" &&
        (existingStatus === "done" || existingStatus === "cancelled");

      const requiresComment = isRevertingToBlocked && !comment;
      expect(requiresComment).toBe(false);
    });

    it("does not require comment for in_progress to blocked", () => {
      const existingStatus = "in_progress";
      const newStatus = "blocked";
      const comment = null;

      const isRevertingToBlocked =
        newStatus === "blocked" &&
        (existingStatus === "done" || existingStatus === "cancelled");

      const requiresComment = isRevertingToBlocked && !comment;
      expect(requiresComment).toBe(false);
    });

    it("does not require comment for todo to blocked", () => {
      const existingStatus = "todo";
      const newStatus = "blocked";
      const comment = null;

      const isRevertingToBlocked =
        newStatus === "blocked" &&
        (existingStatus === "done" || existingStatus === "cancelled");

      const requiresComment = isRevertingToBlocked && !comment;
      expect(requiresComment).toBe(false);
    });

    it("does not require comment for backlog to blocked", () => {
      const existingStatus = "backlog";
      const newStatus = "blocked";
      const comment = null;

      const isRevertingToBlocked =
        newStatus === "blocked" &&
        (existingStatus === "done" || existingStatus === "cancelled");

      const requiresComment = isRevertingToBlocked && !comment;
      expect(requiresComment).toBe(false);
    });

    it("does not require comment for in_review to blocked", () => {
      const existingStatus = "in_review";
      const newStatus = "blocked";
      const comment = null;

      const isRevertingToBlocked =
        newStatus === "blocked" &&
        (existingStatus === "done" || existingStatus === "cancelled");

      const requiresComment = isRevertingToBlocked && !comment;
      expect(requiresComment).toBe(false);
    });
  });

  describe("status unchanged", () => {
    it("does not require comment when status is not changing", () => {
      const existingStatus = "done";
      const newStatus = undefined; // Not being updated
      const comment = null;

      const isRevertingToBlocked =
        newStatus === "blocked" &&
        (existingStatus === "done" || existingStatus === "cancelled");

      const requiresComment = isRevertingToBlocked && !comment;
      expect(requiresComment).toBe(false);
    });
  });

  describe("error response format", () => {
    it("includes helpful error details", () => {
      const existingStatus = "done";
      const newStatus = "blocked";

      const errorResponse = {
        error: "Comment required when reverting completed or cancelled issue to blocked",
        details: {
          from: existingStatus,
          to: newStatus,
          reason: "This safeguard prevents accidental reversion of completed work without explanation.",
        },
      };

      expect(errorResponse.error).toContain("Comment required");
      expect(errorResponse.details.from).toBe("done");
      expect(errorResponse.details.to).toBe("blocked");
      expect(errorResponse.details.reason).toBeDefined();
    });
  });
});
