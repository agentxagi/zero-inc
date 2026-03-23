import { describe, expect, it } from "vitest";
import type { ProviderQuotaResult } from "@zeroinc/shared";
import {
  evaluatePreventiveQuotaThrottle,
  normalizePreventiveQuotaThresholdPercent,
} from "../services/preventive-quota-throttle.ts";

function makeProvider(
  provider: string,
  windows: ProviderQuotaResult["windows"],
): ProviderQuotaResult {
  return {
    provider,
    ok: true,
    windows,
  };
}

describe("normalizePreventiveQuotaThresholdPercent", () => {
  it("clamps invalid and out-of-range values", () => {
    expect(normalizePreventiveQuotaThresholdPercent(undefined)).toBe(85);
    expect(normalizePreventiveQuotaThresholdPercent(12)).toBe(50);
    expect(normalizePreventiveQuotaThresholdPercent(120)).toBe(99);
    expect(normalizePreventiveQuotaThresholdPercent(88.4)).toBe(88);
  });
});

describe("evaluatePreventiveQuotaThrottle", () => {
  it("activates for 5h windows above threshold", () => {
    const decision = evaluatePreventiveQuotaThrottle(
      [
        makeProvider("openai", [
          { label: "5h limit", usedPercent: 93, resetsAt: null, valueLabel: null },
          { label: "Weekly limit", usedPercent: 10, resetsAt: null, valueLabel: null },
        ]),
      ],
      90,
      new Date("2026-03-23T12:00:00.000Z"),
    );

    expect(decision.active).toBe(true);
    expect(decision.maxUsedPercent).toBe(93);
    expect(decision.matches).toEqual([
      expect.objectContaining({ provider: "openai", label: "5h limit", usedPercent: 93 }),
    ]);
  });

  it("ignores long-horizon weekly windows when short windows are not near limit", () => {
    const decision = evaluatePreventiveQuotaThrottle(
      [
        makeProvider("openai", [
          { label: "5h limit", usedPercent: 74, resetsAt: null, valueLabel: null },
          { label: "Weekly limit", usedPercent: 99, resetsAt: null, valueLabel: null },
        ]),
      ],
      90,
      new Date("2026-03-23T12:00:00.000Z"),
    );

    expect(decision.active).toBe(false);
    expect(decision.maxUsedPercent).toBe(74);
    expect(decision.matches).toEqual([]);
  });

  it("activates when a reset is near even if label is custom", () => {
    const decision = evaluatePreventiveQuotaThrottle(
      [
        makeProvider("custom", [
          {
            label: "Burst window",
            usedPercent: 91,
            resetsAt: "2026-03-23T18:00:00.000Z",
            valueLabel: null,
          },
        ]),
      ],
      90,
      new Date("2026-03-23T12:00:00.000Z"),
    );

    expect(decision.active).toBe(true);
    expect(decision.matches).toEqual([
      expect.objectContaining({ provider: "custom", label: "Burst window", usedPercent: 91 }),
    ]);
  });
});
