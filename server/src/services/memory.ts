import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@zeroinc/db";
import { agentMemory, sharedMemory } from "@zeroinc/db";

const MAX_VALUE_BYTES = 10_240; // 10KB
const MAX_KEYS_PER_AGENT = 100;
const MAX_KEYS_SHARED = 200;

type MemorySourceKind =
  | "manual_note"
  | "issue_comment"
  | "run"
  | "system"
  | "external_document";

interface MemoryWriteResult {
  ok: true;
  id: string;
  key: string;
  created: boolean;
}

interface MemoryQueryResult {
  key: string;
  value: string;
  updatedAt: string;
  sourceKind: string;
}

export function memoryService(db: Db) {
  return {
    // --- Agent Memory ---

    writeAgentMemory: async (
      companyId: string,
      agentId: string,
      key: string,
      value: string,
      opts?: {
        sourceKind?: MemorySourceKind;
        sourceIssueId?: string;
        sourceRunId?: string;
        requestedByAgentId?: string;
      },
    ): Promise<MemoryWriteResult> => {
      if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
        throw new Error(`Value exceeds ${MAX_VALUE_BYTES} bytes limit`);
      }

      const [countRow] = await db
        .select({ count: sql<number>`count(*)` })
        .from(agentMemory)
        .where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.companyId, companyId)));

      if (Number(countRow.count) >= MAX_KEYS_PER_AGENT) {
        throw new Error(`Agent has reached maximum of ${MAX_KEYS_PER_AGENT} keys`);
      }

      const existing = await db
        .select({ id: agentMemory.id })
        .from(agentMemory)
        .where(
          and(
            eq(agentMemory.agentId, agentId),
            eq(agentMemory.companyId, companyId),
            eq(agentMemory.key, key),
          ),
        )
        .then((rows) => rows[0] ?? null);

      let memoryId: string;
      let created: boolean;

      if (existing) {
        await db
          .update(agentMemory)
          .set({
            value,
            sourceKind: opts?.sourceKind ?? "manual_note",
            sourceIssueId: opts?.sourceIssueId ?? null,
            sourceRunId: opts?.sourceRunId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(agentMemory.id, existing.id));
        memoryId = existing.id;
        created = false;
      } else {
        const [row] = await db
          .insert(agentMemory)
          .values({
            companyId,
            agentId,
            key,
            value,
            sourceKind: opts?.sourceKind ?? "manual_note",
            sourceIssueId: opts?.sourceIssueId ?? null,
            sourceRunId: opts?.sourceRunId ?? null,
          })
          .returning({ id: agentMemory.id });
        memoryId = row.id;
        created = true;
      }

      return { ok: true, id: memoryId, key, created };
    },

    getAgentMemory: async (
      companyId: string,
      agentId: string,
      key?: string,
    ): Promise<MemoryQueryResult[]> => {
      let rows;
      if (key) {
        rows = await db
          .select({
            key: agentMemory.key,
            value: agentMemory.value,
            updatedAt: agentMemory.updatedAt,
            sourceKind: agentMemory.sourceKind,
          })
          .from(agentMemory)
          .where(
            and(
              eq(agentMemory.agentId, agentId),
              eq(agentMemory.companyId, companyId),
              eq(agentMemory.key, key),
            ),
          );
      } else {
        rows = await db
          .select({
            key: agentMemory.key,
            value: agentMemory.value,
            updatedAt: agentMemory.updatedAt,
            sourceKind: agentMemory.sourceKind,
          })
          .from(agentMemory)
          .where(
            and(eq(agentMemory.agentId, agentId), eq(agentMemory.companyId, companyId)),
          )
          .orderBy(desc(agentMemory.updatedAt));
      }

      return rows.map((r) => ({
        key: r.key,
        value: r.value,
        updatedAt: r.updatedAt.toISOString(),
        sourceKind: r.sourceKind,
      }));
    },

    deleteAgentMemory: async (
      companyId: string,
      agentId: string,
      key: string,
    ): Promise<{ ok: true; deleted: string } | null> => {
      const existing = await db
        .select({ id: agentMemory.id })
        .from(agentMemory)
        .where(
          and(
            eq(agentMemory.agentId, agentId),
            eq(agentMemory.companyId, companyId),
            eq(agentMemory.key, key),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!existing) return null;

      await db
        .delete(agentMemory)
        .where(eq(agentMemory.id, existing.id));

      return { ok: true, deleted: key };
    },

    // --- Shared Memory ---

    writeSharedMemory: async (
      companyId: string,
      key: string,
      value: string,
      opts?: {
        writtenByAgentId?: string;
        sourceKind?: MemorySourceKind;
        sourceIssueId?: string;
      },
    ): Promise<MemoryWriteResult> => {
      if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
        throw new Error(`Value exceeds ${MAX_VALUE_BYTES} bytes limit`);
      }

      const existing = await db
        .select({ id: sharedMemory.id })
        .from(sharedMemory)
        .where(and(eq(sharedMemory.companyId, companyId), eq(sharedMemory.key, key)))
        .then((rows) => rows[0] ?? null);

      let memoryId: string;
      let created: boolean;

      if (existing) {
        await db
          .update(sharedMemory)
          .set({
            value,
            writtenByAgentId: opts?.writtenByAgentId ?? null,
            sourceKind: opts?.sourceKind ?? "manual_note",
            sourceIssueId: opts?.sourceIssueId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(sharedMemory.id, existing.id));
        memoryId = existing.id;
        created = false;
      } else {
        const [countRow] = await db
          .select({ count: sql<number>`count(*)` })
          .from(sharedMemory)
          .where(eq(sharedMemory.companyId, companyId));

        if (Number(countRow.count) >= MAX_KEYS_SHARED) {
          throw new Error(`Company has reached maximum of ${MAX_KEYS_SHARED} shared keys`);
        }

        const [row] = await db
          .insert(sharedMemory)
          .values({
            companyId,
            key,
            value,
            writtenByAgentId: opts?.writtenByAgentId ?? null,
            sourceKind: opts?.sourceKind ?? "manual_note",
            sourceIssueId: opts?.sourceIssueId ?? null,
          })
          .returning({ id: sharedMemory.id });
        memoryId = row.id;
        created = true;
      }

      return { ok: true, id: memoryId, key, created };
    },

    getSharedMemory: async (
      companyId: string,
      key?: string,
    ): Promise<MemoryQueryResult[]> => {
      let rows;
      if (key) {
        rows = await db
          .select({
            key: sharedMemory.key,
            value: sharedMemory.value,
            updatedAt: sharedMemory.updatedAt,
            sourceKind: sharedMemory.sourceKind,
          })
          .from(sharedMemory)
          .where(and(eq(sharedMemory.companyId, companyId), eq(sharedMemory.key, key)));
      } else {
        rows = await db
          .select({
            key: sharedMemory.key,
            value: sharedMemory.value,
            updatedAt: sharedMemory.updatedAt,
            sourceKind: sharedMemory.sourceKind,
          })
          .from(sharedMemory)
          .where(eq(sharedMemory.companyId, companyId))
          .orderBy(desc(sharedMemory.updatedAt));
      }

      return rows.map((r) => ({
        key: r.key,
        value: r.value,
        updatedAt: r.updatedAt.toISOString(),
        sourceKind: r.sourceKind,
      }));
    },

    // --- Heartbeat Context ---

    getHeartbeatMemory: async (companyId: string, agentId: string) => {
      const [agentRows, sharedRows] = await Promise.all([
        db
          .select({
            key: agentMemory.key,
            value: agentMemory.value,
          })
          .from(agentMemory)
          .where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.companyId, companyId)))
          .orderBy(asc(agentMemory.key)),
        db
          .select({
            key: sharedMemory.key,
            value: sharedMemory.value,
            writtenByAgentId: sharedMemory.writtenByAgentId,
          })
          .from(sharedMemory)
          .where(eq(sharedMemory.companyId, companyId))
          .orderBy(asc(sharedMemory.key)),
      ]);

      return {
        agentMemory: agentRows,
        sharedMemory: sharedRows,
      };
    },

    // --- Search (keyword-based for built-in provider) ---

    searchAgentMemory: async (companyId: string, agentId: string, query: string, limit = 10) => {
      const rows = await db
        .select({
          key: agentMemory.key,
          value: agentMemory.value,
          updatedAt: agentMemory.updatedAt,
        })
        .from(agentMemory)
        .where(
          and(
            eq(agentMemory.agentId, agentId),
            eq(agentMemory.companyId, companyId),
            sql`(${agentMemory.key} ILIKE ${`%${query}%`} OR ${agentMemory.value} ILIKE ${`%${query}%`})`,
          ),
        )
        .limit(limit);

      return rows.map((r) => ({
        key: r.key,
        value: r.value,
        updatedAt: r.updatedAt.toISOString(),
      }));
    },

    searchSharedMemory: async (companyId: string, query: string, limit = 10) => {
      const rows = await db
        .select({
          key: sharedMemory.key,
          value: sharedMemory.value,
          updatedAt: sharedMemory.updatedAt,
        })
        .from(sharedMemory)
        .where(
          and(
            eq(sharedMemory.companyId, companyId),
            sql`(${sharedMemory.key} ILIKE ${`%${query}%`} OR ${sharedMemory.value} ILIKE ${`%${query}%`})`,
          ),
        )
        .limit(limit);

      return rows.map((r) => ({
        key: r.key,
        value: r.value,
        updatedAt: r.updatedAt.toISOString(),
      }));
    },
  };
}
