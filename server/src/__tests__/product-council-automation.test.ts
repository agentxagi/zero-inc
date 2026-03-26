import { describe, expect, it, vi } from "vitest";
import { productCouncilAutomationService } from "../services/product-council-automation.ts";

function createDbStub(companyIds: string[]) {
  const rows = companyIds.map((id) => ({ id }));
  const selectLimit = vi.fn(async () => rows);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));
  return {
    db: {
      select,
    },
    selectLimit,
  };
}

describe("productCouncilAutomationService", () => {
  it("applies per-company cooldown between ticks", async () => {
    const dbStub = createDbStub(["company-a", "company-b"]);
    const materialize = vi
      .fn()
      .mockResolvedValueOnce({
        generated: 1,
        skipped: 0,
        dryRun: false,
        reason: "ok",
        report: { gating: { reason: "ok" } },
        createdIssues: [{ id: "i1", identifier: "VAL-1", title: "Issue 1" }],
        skippedProposals: [],
      })
      .mockResolvedValueOnce({
        generated: 0,
        skipped: 1,
        dryRun: false,
        reason: "active work",
        report: { gating: { reason: "active work" } },
        createdIssues: [],
        skippedProposals: [{ proposalId: "p1", title: "x", reason: "duplicate_open_title" }],
      })
      .mockResolvedValue({
        generated: 0,
        skipped: 0,
        dryRun: false,
        reason: "noop",
        report: { gating: { reason: "noop" } },
        createdIssues: [],
        skippedProposals: [],
      });

    const service = productCouncilAutomationService(dbStub.db as any, {
      cooldownMs: 30 * 60 * 1000,
      materialize: materialize as any,
    });

    const t1 = new Date("2026-03-26T12:00:00.000Z");
    const first = await service.tick(t1);
    expect(first.evaluatedCompanies).toBe(2);
    expect(first.generatedIssues).toBe(1);
    expect(first.companiesWithNewIssues).toBe(1);
    expect(first.skippedCooldown).toBe(0);
    expect(first.errors).toBe(0);
    expect(materialize).toHaveBeenCalledTimes(2);

    const t2 = new Date("2026-03-26T12:10:00.000Z");
    const second = await service.tick(t2);
    expect(second.evaluatedCompanies).toBe(0);
    expect(second.skippedCooldown).toBe(2);
    expect(materialize).toHaveBeenCalledTimes(2);

    const t3 = new Date("2026-03-26T12:40:00.000Z");
    const third = await service.tick(t3);
    expect(third.evaluatedCompanies).toBe(2);
    expect(materialize).toHaveBeenCalledTimes(4);
  });

  it("continues other companies when one automation run fails", async () => {
    const dbStub = createDbStub(["company-a", "company-b"]);
    const materialize = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        generated: 2,
        skipped: 0,
        dryRun: false,
        reason: "ok",
        report: { gating: { reason: "ok" } },
        createdIssues: [
          { id: "i1", identifier: "VAL-1", title: "Issue 1" },
          { id: "i2", identifier: "VAL-2", title: "Issue 2" },
        ],
        skippedProposals: [],
      });

    const service = productCouncilAutomationService(dbStub.db as any, {
      cooldownMs: 1,
      materialize: materialize as any,
    });

    const result = await service.tick(new Date("2026-03-26T13:00:00.000Z"));
    expect(result.evaluatedCompanies).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.generatedIssues).toBe(2);
    expect(result.companiesWithNewIssues).toBe(1);
    expect(result.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ companyId: "company-a", reason: "automation_error" }),
        expect.objectContaining({ companyId: "company-b", generated: 2, reason: "ok" }),
      ]),
    );
  });
});
