import { describe, expect, it, vi, beforeEach } from "vitest";

// --- Mock DB ---
// Drizzle chain: db.select().from(table).where(cond) → Promise<rows>
// db.update(table).set({...}).where(cond) → Promise<result>
// db.insert(table).values({...}).onConflictDoUpdate({...}).returning() → Promise<rows>

const selectResults: unknown[] = [];
const mockSelect = vi.fn();
const mockInsertValues = vi.fn();
const mockOnConflictDoUpdate = vi.fn();
const mockReturning = vi.fn();
const mockInsert = vi.fn();
const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn();
const mockUpdate = vi.fn();

function setupMockSelect(result: unknown) {
  // .select() returns { from: () => ({ where: () => Promise<result> }) }
  const from = vi.fn(() => ({
    where: vi.fn().mockResolvedValue(result),
  }));
  mockSelect.mockReturnValueOnce({ from });
}

function setupMockUpdate() {
  mockUpdate.mockReturnValueOnce({
    set: mockUpdateSet.mockReturnThis(),
    where: mockUpdateWhere.mockResolvedValue(undefined),
  });
}

const db = {
  select: mockSelect,
  update: mockUpdate,
  insert: mockInsert,
} as unknown as import("@zeroinc/db").Db;

// Mock logger
vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { governanceSettingsService, DEFAULT_GOVERNANCE_SETTINGS } from "../services/governance-settings.ts";

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateWhere.mockResolvedValue(undefined);
});

describe("governanceSettingsService", () => {
  describe("get", () => {
    it("returns default settings when no row exists", async () => {
      // select() returns no existing row
      setupMockSelect([]);
      // insert() creates a new row
      mockInsert.mockReturnValueOnce({
        values: mockInsertValues.mockReturnThis(),
        onConflictDoUpdate: mockOnConflictDoUpdate.mockReturnThis(),
        returning: mockReturning.mockResolvedValue([{ id: "s1", general: {} }]),
      });

      const svc = governanceSettingsService(db);
      const settings = await svc.get();

      expect(settings.wipLimitDefault).toBe(DEFAULT_GOVERNANCE_SETTINGS.wipLimitDefault);
      expect(settings.staleInProgressWarnMinutes).toBe(DEFAULT_GOVERNANCE_SETTINGS.staleInProgressWarnMinutes);
      expect(settings.staleDoneNoQualityMinutes).toBe(DEFAULT_GOVERNANCE_SETTINGS.staleDoneNoQualityMinutes);
    });

    it("returns stored settings when row exists", async () => {
      const storedSettings = { wipLimitDefault: 10, staleInProgressWarnMinutes: 60 };
      setupMockSelect([{ id: "s1", general: storedSettings }]);

      const svc = governanceSettingsService(db);
      const settings = await svc.get();

      expect(settings.wipLimitDefault).toBe(10);
      expect(settings.staleInProgressWarnMinutes).toBe(60);
      // Unchanged fields should fall back to defaults
      expect(settings.staleInProgressBlockMinutes).toBe(DEFAULT_GOVERNANCE_SETTINGS.staleInProgressBlockMinutes);
    });
  });

  describe("update", () => {
    it("merges partial update with existing settings", async () => {
      const existing = {
        wipLimitDefault: 5,
        staleInProgressWarnMinutes: 240,
        staleInProgressBlockMinutes: 1440,
        staleBlockedEscalateMinutes: 240,
        staleInReviewPingMinutes: 120,
        staleDoneNoQualityMinutes: 60,
      };
      setupMockSelect([{ id: "s1", general: existing }]);
      setupMockUpdate();

      const svc = governanceSettingsService(db);
      const updated = await svc.update({ wipLimitDefault: 10 });

      expect(updated.wipLimitDefault).toBe(10);
      expect(updated.staleInProgressWarnMinutes).toBe(240);
      expect(updated.staleDoneNoQualityMinutes).toBe(60);
      expect(mockUpdate).toHaveBeenCalled();
      expect(mockUpdateSet).toHaveBeenCalled();
    });
  });

  describe("getWipLimitForAgent", () => {
    it("returns agent-specific WIP limit when set", async () => {
      setupMockSelect([{ metadata: { governance: { wipLimit: 3 } } }]);

      const svc = governanceSettingsService(db);
      const limit = await svc.getWipLimitForAgent("agent-1");
      expect(limit).toBe(3);
    });

    it("falls back to global default when agent has no override", async () => {
      // First select: agent metadata (no wipLimit)
      setupMockSelect([{ metadata: { governance: {} } }]);
      // Second select: global settings row (for get())
      setupMockSelect([{ id: "s1", general: { ...DEFAULT_GOVERNANCE_SETTINGS } }]);

      const svc = governanceSettingsService(db);
      const limit = await svc.getWipLimitForAgent("agent-1");
      expect(limit).toBe(DEFAULT_GOVERNANCE_SETTINGS.wipLimitDefault);
    });
  });

  describe("countInProgressForAgent", () => {
    it("returns the count of in_progress issues for an agent", async () => {
      setupMockSelect([{ count: "7" }]);

      const svc = governanceSettingsService(db);
      const count = await svc.countInProgressForAgent("agent-1");
      // SQL count(*) returns a string
      expect(count).toBe("7");
    });
  });

  describe("DEFAULT_GOVERNANCE_SETTINGS", () => {
    it("has all required fields with positive values", () => {
      expect(DEFAULT_GOVERNANCE_SETTINGS.wipLimitDefault).toBeGreaterThan(0);
      expect(DEFAULT_GOVERNANCE_SETTINGS.staleInProgressWarnMinutes).toBeGreaterThan(0);
      expect(DEFAULT_GOVERNANCE_SETTINGS.staleInProgressBlockMinutes).toBeGreaterThan(0);
      expect(DEFAULT_GOVERNANCE_SETTINGS.staleBlockedEscalateMinutes).toBeGreaterThan(0);
      expect(DEFAULT_GOVERNANCE_SETTINGS.staleInReviewPingMinutes).toBeGreaterThan(0);
      expect(DEFAULT_GOVERNANCE_SETTINGS.staleDoneNoQualityMinutes).toBeGreaterThan(0);
    });
  });
});
