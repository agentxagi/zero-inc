import { Router } from "express";
import type { Db } from "@zeroinc/db";
import {
  createDelegationRuleSchema,
  updateDelegationRuleSchema,
} from "@zeroinc/shared";
import { validate } from "../middleware/validate.js";
import { delegationRulesService } from "../services/delegation-rules.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity } from "../services/activity-log.js";

export function delegationRuleRoutes(db: Db) {
  const router = Router();
  const svc = delegationRulesService(db);

  // GET /api/companies/:companyId/delegation-rules
  router.get("/companies/:companyId/delegation-rules", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rules = await svc.list(companyId);
    res.json(rules);
  });

  // POST /api/companies/:companyId/delegation-rules
  router.post("/companies/:companyId/delegation-rules", validate(createDelegationRuleSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rule = await svc.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "delegation_rule.created",
      entityType: "delegation_rule",
      entityId: rule.id,
      details: { name: rule.name, ruleType: rule.ruleType },
    });
    res.status(201).json(rule);
  });

  // PATCH /api/delegation-rules/:id
  router.patch("/delegation-rules/:id", validate(updateDelegationRuleSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Delegation rule not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const updated = await svc.update(id, existing.companyId, req.body);
    if (!updated) {
      res.status(404).json({ error: "Delegation rule not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "delegation_rule.updated",
      entityType: "delegation_rule",
      entityId: id,
      details: { name: updated.name },
    });
    res.json(updated);
  });

  // DELETE /api/delegation-rules/:id
  router.delete("/delegation-rules/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Delegation rule not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const removed = await svc.remove(id, existing.companyId);
    if (!removed) {
      res.status(404).json({ error: "Delegation rule not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "delegation_rule.deleted",
      entityType: "delegation_rule",
      entityId: id,
      details: { name: existing.name },
    });
    res.json({ deleted: true });
  });

  return router;
}
