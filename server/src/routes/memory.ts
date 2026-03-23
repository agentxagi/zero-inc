import { Router } from "express";
import type { Db } from "@zeroinc/db";
import { memoryService } from "../services/memory.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function memoryRoutes(db: Db) {
  const router = Router();
  const svc = memoryService(db);

  /** Extract companyId: agent context first, then fallback */
  function resolveCompanyId(req: any, fallback: string | undefined): string | undefined {
    if (req.actor.type === "agent" && req.actor.companyId) return req.actor.companyId;
    return fallback;
  }

  /** Require companyId or 400 */
  function requireCompanyId(req: any, fallback: string | undefined): string {
    const cid = resolveCompanyId(req, fallback);
    if (!cid) throw new Error("companyId is required");
    return cid;
  }

  // --- Agent Memory ---

  // POST /api/agents/:agentId/memory — set a memory key
  router.post("/agents/:agentId/memory", async (req, res) => {
    try {
      const { key, value, sourceKind, sourceIssueId, sourceRunId } = req.body;
      const agentId = req.params.agentId as string;

      if (!key || typeof key !== "string") {
        res.status(400).json({ error: 'Missing or invalid "key"' });
        return;
      }
      if (value === undefined || value === null) {
        res.status(400).json({ error: 'Missing "value"' });
        return;
      }

      const companyId = requireCompanyId(req, req.body.companyId);
      assertCompanyAccess(req, companyId);

      const actor = getActorInfo(req);
      const result = await svc.writeAgentMemory(companyId, agentId, key, String(value), {
        sourceKind,
        sourceIssueId,
        sourceRunId,
        requestedByAgentId: actor.agentId ?? undefined,
      });
      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      const status = msg.includes("exceeds") ? 413 : msg.includes("maximum") ? 409 : msg === "companyId is required" ? 400 : 500;
      res.status(status).json({ error: msg });
    }
  });

  // GET /api/agents/:agentId/memory — get all agent memory keys
  router.get("/agents/:agentId/memory", async (req, res) => {
    try {
      const agentId = req.params.agentId as string;
      const key = req.query.key as string | undefined;
      const companyId = requireCompanyId(req, req.query.companyId as string | undefined);
      assertCompanyAccess(req, companyId);

      const results = await svc.getAgentMemory(companyId, agentId, key);
      if (key) {
        if (results.length === 0) {
          res.status(404).json({ error: "Key not found" });
          return;
        }
        res.json(results[0]);
        return;
      }
      res.json({ keys: results, count: results.length });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      res.status(msg === "companyId is required" ? 400 : 500).json({ error: msg });
    }
  });

  // GET /api/agents/:agentId/memory/search — keyword search (must come before :key route)
  router.get("/agents/:agentId/memory/search", async (req, res) => {
    try {
      const agentId = req.params.agentId as string;
      const query = req.query.q as string;
      const limit = Math.min(Number(req.query.limit) || 10, 50);

      if (!query) {
        res.status(400).json({ error: 'Query param "q" is required' });
        return;
      }

      const companyId = requireCompanyId(req, req.query.companyId as string | undefined);
      assertCompanyAccess(req, companyId);

      const results = await svc.searchAgentMemory(companyId, agentId, query, limit);
      res.json({ results, count: results.length });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      res.status(msg === "companyId is required" ? 400 : 500).json({ error: msg });
    }
  });

  // GET /api/agents/:agentId/memory/:key — get a specific key
  router.get("/agents/:agentId/memory/:key", async (req, res) => {
    try {
      const agentId = req.params.agentId as string;
      const key = req.params.key as string;
      const companyId = requireCompanyId(req, req.query.companyId as string | undefined);
      assertCompanyAccess(req, companyId);

      const results = await svc.getAgentMemory(companyId, agentId, key);
      if (results.length === 0) {
        res.status(404).json({ error: "Key not found" });
        return;
      }
      res.json(results[0]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      res.status(msg === "companyId is required" ? 400 : 500).json({ error: msg });
    }
  });

  // DELETE /api/agents/:agentId/memory/:key — delete a key
  router.delete("/agents/:agentId/memory/:key", async (req, res) => {
    try {
      const agentId = req.params.agentId as string;
      const key = req.params.key as string;
      const companyId = requireCompanyId(req, req.query.companyId as string | undefined);
      assertCompanyAccess(req, companyId);

      const result = await svc.deleteAgentMemory(companyId, agentId, key);
      if (!result) {
        res.status(404).json({ error: "Key not found" });
        return;
      }
      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      res.status(msg === "companyId is required" ? 400 : 500).json({ error: msg });
    }
  });

  // --- Shared Memory ---

  // POST /api/companies/:companyId/shared-memory — set a shared memory key
  router.post("/companies/:companyId/shared-memory", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      const { key, value, sourceKind, sourceIssueId } = req.body;

      assertCompanyAccess(req, companyId);

      if (!key || typeof key !== "string") {
        res.status(400).json({ error: 'Missing or invalid "key"' });
        return;
      }
      if (value === undefined || value === null) {
        res.status(400).json({ error: 'Missing "value"' });
        return;
      }

      const actor = getActorInfo(req);
      const result = await svc.writeSharedMemory(companyId, key, String(value), {
        writtenByAgentId: actor.agentId ?? undefined,
        sourceKind,
        sourceIssueId,
      });
      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      const status = msg.includes("exceeds") ? 413 : msg.includes("maximum") ? 409 : 500;
      res.status(status).json({ error: msg });
    }
  });

  // GET /api/companies/:companyId/shared-memory — get all shared keys
  router.get("/companies/:companyId/shared-memory", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      const key = req.query.key as string | undefined;

      assertCompanyAccess(req, companyId);

      const results = await svc.getSharedMemory(companyId, key);
      if (key) {
        if (results.length === 0) {
          res.status(404).json({ error: "Key not found" });
          return;
        }
        res.json(results[0]);
        return;
      }
      res.json({ keys: results, count: results.length });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/companies/:companyId/shared-memory/search — keyword search (must come before :key)
  router.get("/companies/:companyId/shared-memory/search", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      const query = req.query.q as string;
      const limit = Math.min(Number(req.query.limit) || 10, 50);

      assertCompanyAccess(req, companyId);

      if (!query) {
        res.status(400).json({ error: 'Query param "q" is required' });
        return;
      }

      const results = await svc.searchSharedMemory(companyId, query, limit);
      res.json({ results, count: results.length });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/companies/:companyId/shared-memory/:key — get a specific key
  router.get("/companies/:companyId/shared-memory/:key", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      const key = req.params.key as string;

      assertCompanyAccess(req, companyId);

      const results = await svc.getSharedMemory(companyId, key);
      if (results.length === 0) {
        res.status(404).json({ error: "Key not found" });
        return;
      }
      res.json(results[0]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: msg });
    }
  });

  // --- Heartbeat Context ---

  // GET /api/agents/:agentId/heartbeat-memory — get agent + shared memory for heartbeat
  router.get("/agents/:agentId/heartbeat-memory", async (req, res) => {
    try {
      const agentId = req.params.agentId as string;
      const companyId = requireCompanyId(req, req.query.companyId as string | undefined);
      assertCompanyAccess(req, companyId);

      const data = await svc.getHeartbeatMemory(companyId, agentId);
      res.json(data);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      res.status(msg === "companyId is required" ? 400 : 500).json({ error: msg });
    }
  });

  return router;
}
