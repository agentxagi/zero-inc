import { describe, expect, it } from "vitest";
import { quarterlyCycleKey } from "../services/goals.ts";

describe("goal programs helpers", () => {
  it("derives quarter cycle key in UTC", () => {
    expect(quarterlyCycleKey(new Date("2026-01-15T12:00:00.000Z"))).toBe("2026-Q1");
    expect(quarterlyCycleKey(new Date("2026-04-01T00:00:00.000Z"))).toBe("2026-Q2");
    expect(quarterlyCycleKey(new Date("2026-09-30T23:59:59.000Z"))).toBe("2026-Q3");
    expect(quarterlyCycleKey(new Date("2026-12-31T23:59:59.000Z"))).toBe("2026-Q4");
  });
});
