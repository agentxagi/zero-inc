import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { goalService } from "../services/goals.ts";

type SelectRows = unknown[];

function createDbStub(selectRows: SelectRows[]) {
  const queue = [...selectRows];
  const where = vi.fn(() => {
    const rows = queue.shift() ?? [];
    return {
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(rows)),
      groupBy: async () => rows,
      orderBy: async () => rows,
    };
  });
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    db: {
      select,
    },
    where,
  };
}

describe("goalService.getProgress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-26T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses only verified done issues for completion and velocity", async () => {
    const dbStub = createDbStub([
      [{ id: "goal-1", title: "Goal", level: "company", status: "active" }],
      [],
      [
        { status: "done", count: 3 },
        { status: "todo", count: 1 },
      ],
      [
        {
          id: "done-1",
          title: "[FEATURE] Ship enterprise auth",
          reviewCount: 1,
          completedAt: new Date("2026-03-25T12:00:00.000Z"),
        },
        {
          id: "done-2",
          title: "[FEATURE] Refactor queue",
          reviewCount: 0,
          completedAt: new Date("2026-03-24T12:00:00.000Z"),
        },
        {
          id: "done-3",
          title: "[DOCS] Publish deployment guide",
          reviewCount: 0,
          completedAt: new Date("2026-03-23T12:00:00.000Z"),
        },
      ],
      [
        { issueId: "done-1" },
        { issueId: "done-3" },
      ],
    ]);

    const progress = await goalService(dbStub.db as any).getProgress("goal-1");
    expect(progress).not.toBeNull();
    expect(progress?.totalIssues).toBe(4);
    expect(progress?.rawDone).toBe(3);
    expect(progress?.done).toBe(2);
    expect(progress?.unverifiedDone).toBe(1);
    expect(progress?.rawCompletionPercent).toBe(75);
    expect(progress?.completionPercent).toBe(50);
    expect(progress?.rawCompletedLast7Days).toBe(3);
    expect(progress?.completedLast7Days).toBe(2);
    expect(progress?.estimatedDaysToComplete).toBe(7);
  });

  it("keeps completion at zero when done issues lack qualifying evidence", async () => {
    const dbStub = createDbStub([
      [{ id: "goal-1", title: "Goal", level: "company", status: "active" }],
      [],
      [
        { status: "done", count: 1 },
        { status: "backlog", count: 1 },
      ],
      [
        {
          id: "done-1",
          title: "[BUG] Fix flaky routine",
          reviewCount: 0,
          completedAt: new Date("2026-03-25T12:00:00.000Z"),
        },
      ],
      [],
    ]);

    const progress = await goalService(dbStub.db as any).getProgress("goal-1");
    expect(progress).not.toBeNull();
    expect(progress?.totalIssues).toBe(2);
    expect(progress?.rawDone).toBe(1);
    expect(progress?.done).toBe(0);
    expect(progress?.completionPercent).toBe(0);
    expect(progress?.rawCompletionPercent).toBe(50);
    expect(progress?.completedLast7Days).toBe(0);
    expect(progress?.estimatedDaysToComplete).toBeNull();
  });
});
