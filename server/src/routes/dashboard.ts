import { Router } from "express";
import { and, eq, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
import { assertCompanyAccess } from "./authz.js";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Simple in-memory cache with TTL
const cache = new Map<string, { data: unknown; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache(key: string, data: unknown): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);

  // Existing route for company dashboard
  router.get("/companies/:companyId/dashboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const summary = await svc.summary(companyId);
    res.json(summary);
  });

  /**
   * GET /api/dashboard/human
   * Human dashboard endpoint - returns actionable information for Gustavo
   * Uses x-company-id header for company identification
   * Cached for 5 minutes to avoid overload
   */
  router.get("/human", async (req, res) => {
    try {
      const companyId = req.header("x-company-id") as string;
      
      if (!companyId) {
        res.status(400).json({ error: "x-company-id header is required" });
        return;
      }

      assertCompanyAccess(req, companyId);

      // Check cache first
      const cacheKey = `human-dashboard:${companyId}`;
      const cached = getCached(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      // Gustavo's agent ID (human agent in the system)
      const gustavoAgentId = "e1550682-66b8-4273-80fb-169cb6ba3a6d";

      // 1. URGENT - Tasks requiring human action
      // - Assigned to Gustavo
      // - Status: in_progress, todo, or blocked
      // - Or any blocked task (might need human intervention)
      
      const urgentTasks = await db
        .select({
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          createdAt: issues.createdAt,
          startedAt: issues.startedAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            or(
              // Tasks assigned to Gustavo that are not done
              and(
                eq(issues.assigneeAgentId, gustavoAgentId),
                or(
                  eq(issues.status, "in_progress"),
                  eq(issues.status, "todo"),
                  eq(issues.status, "blocked")
                )
              ),
              // Any blocked task (might need human intervention)
              eq(issues.status, "blocked")
            )
          )
        )
        .limit(20);

      const urgent = urgentTasks.map((task) => ({
        identifier: task.identifier,
        title: task.title,
        status: task.status,
        action: task.status === "blocked" ? "Desbloquear tarefa" : "Sua ação necessária",
        priority: task.priority,
      }));

      // 2. AUTOMATABLE - Outputs ready for automation
      const outputsDir = "/root/clawd/outputs";
      const automatable: Array<{ file: string; task: string; status: string; action: string }> = [];
      
      try {
        const today = new Date().toISOString().split("T")[0];
        const todayDir = join(outputsDir, today);
        
        if (existsSync(todayDir)) {
          const files = readdirSync(todayDir);
          for (const file of files) {
            if (file.endsWith(".md") || file.endsWith(".json") || file.endsWith(".csv")) {
              const match = file.match(/(VAL-\d+)/);
              automatable.push({
                file: join(today, file),
                task: match ? match[1] : "unknown",
                status: "ready",
                action: "Bot pode executar automaticamente",
              });
            }
          }
        }
      } catch {
        // Outputs directory doesn't exist or can't be read
      }

      // 3. RUNNING - Agent status
      const agentRows = await db
        .select({
          status: agents.status,
          count: sql<number>`count(*)`,
        })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      const agentCounts: Record<string, number> = {
        running: 0,
        idle: 0,
        paused: 0,
        error: 0,
      };
      
      for (const row of agentRows) {
        const count = Number(row.count);
        const status = row.status as string;
        if (status in agentCounts) {
          agentCounts[status] = count;
        }
      }

      // 4. METRICS - Tasks done today
      const doneToday = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.status, "done"),
            sql`${issues.completedAt}::date = CURRENT_DATE`
          )
        )
        .then((rows) => Number(rows[0]?.count ?? 0));

      // Calculate outputs size
      let outputsSize = 0;
      try {
        const today = new Date().toISOString().split("T")[0];
        const todayDir = join(outputsDir, today);
        if (existsSync(todayDir)) {
          const files = readdirSync(todayDir);
          for (const file of files) {
            const filePath = join(todayDir, file);
            const stats = statSync(filePath);
            if (stats.isFile()) {
              outputsSize += stats.size;
            }
          }
        }
      } catch {
        // Can't read outputs
      }

      const response = {
        timestamp: new Date().toISOString(),
        urgent,
        automatable,
        running: {
          agents_working: agentCounts.running,
          agents_idle: agentCounts.idle,
          agents_error: agentCounts.error,
          system_status: agentCounts.error > 0 ? "degraded" : "healthy",
        },
        metrics: {
          tasks_done_today: doneToday,
          outputs_generated: `${Math.round(outputsSize / 1024)}KB`,
          agents_active: agentCounts.running,
        },
      };

      // Cache the response
      setCache(cacheKey, response);

      res.json(response);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: errorMessage });
    }
  });

  return router;
}
