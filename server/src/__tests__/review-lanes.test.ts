import { describe, expect, it } from "vitest";
import {
  inferReviewLaneForIssue,
  reviewSlaHoursForLane,
  reviewSlaDueAtForLane,
  reviewSlaStateForDueAt,
} from "../services/review-pipeline.ts";

describe("review lanes", () => {
  it("infers security lane from auth/security topics", () => {
    const lane = inferReviewLaneForIssue({
      title: "[BUG] Harden auth token validation",
      description: "Close security gap in JWT permission checks.",
    });
    expect(lane).toBe("security");
  });

  it("infers ux lane from UX/UI topics", () => {
    const lane = inferReviewLaneForIssue({
      title: "[UX] Improve onboarding empty state",
      description: "Refine UI copy and accessibility semantics.",
    });
    expect(lane).toBe("ux");
  });

  it("infers ops lane from infra/deploy topics", () => {
    const lane = inferReviewLaneForIssue({
      title: "[INFRA] Stabilize watchdog deploy flow",
      description: "Tune monitoring and systemd restart policy.",
    });
    expect(lane).toBe("ops");
  });

  it("defaults to code lane when no specific signal exists", () => {
    const lane = inferReviewLaneForIssue({
      title: "[FEATURE] Add issue filter",
      description: "Implement API endpoint and pagination logic.",
    });
    expect(lane).toBe("code");
  });

  it("calculates SLA hours with optional override", () => {
    expect(reviewSlaHoursForLane("security")).toBe(4);
    expect(reviewSlaHoursForLane("security", { security: 2 })).toBe(2);
  });

  it("computes due date and state from lane SLA", () => {
    const now = new Date("2026-03-26T18:00:00.000Z");
    const reviewRequestedAt = new Date("2026-03-26T17:00:00.000Z");
    const dueAt = reviewSlaDueAtForLane("code", reviewRequestedAt, { code: 2 });
    expect(dueAt?.toISOString()).toBe("2026-03-26T19:00:00.000Z");
    expect(reviewSlaStateForDueAt(dueAt, now)).toBe("due_soon");
    expect(reviewSlaStateForDueAt(new Date("2026-03-26T16:00:00.000Z"), now)).toBe("overdue");
    expect(reviewSlaStateForDueAt(null, now)).toBe("no_sla");
  });
});
