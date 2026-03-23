import { Router } from "express";
import type { Db } from "@zeroinc/db";
import {
  createSprintSchema,
  updateSprintSchema,
  linkIssueToSprintSchema,
} from "@zeroinc/shared";
import { validate } from "../middleware/validate.js";
import { sprintService, issueService, logActivity, heartbeatService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function sprintRoutes(db: Db) {
  const router = Router();
  const svc = sprintService(db);
  const issues = issueService(db, { wakeup: heartbeatService(db).wakeup });

  // List sprints for a company
  router.get("/companies/:companyId/sprints", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  // Get single sprint
  router.get("/sprints/:id", async (req, res) => {
    const id = req.params.id as string;
    const sprint = await svc.getById(id);
    if (!sprint) {
      res.status(404).json({ error: "Sprint not found" });
      return;
    }
    assertCompanyAccess(req, sprint.companyId);
    res.json(sprint);
  });

  // Create sprint
  router.post("/companies/:companyId/sprints", validate(createSprintSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const sprint = await svc.create(companyId, req.body);

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "sprint.created",
      entityType: "sprint",
      entityId: sprint.id,
      details: { name: sprint.name },
    });

    res.status(201).json(sprint);
  });

  // Update sprint
  router.patch("/sprints/:id", validate(updateSprintSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Sprint not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);
    const sprint = await svc.update(id, req.body);

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "sprint.updated",
      entityType: "sprint",
      entityId: existing.id,
      details: { changed: Object.keys(req.body) },
    });

    res.json(sprint);
  });

  // Delete sprint
  router.delete("/sprints/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Sprint not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);
    const removed = await svc.remove(id);

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "sprint.deleted",
      entityType: "sprint",
      entityId: existing.id,
    });

    res.json(removed);
  });

  // Get sprint dashboard (burndown + velocity)
  router.get("/sprints/:id/dashboard", async (req, res) => {
    const id = req.params.id as string;
    const sprint = await svc.getById(id);
    if (!sprint) {
      res.status(404).json({ error: "Sprint not found" });
      return;
    }
    assertCompanyAccess(req, sprint.companyId);

    const [sprintIssues, burndown, velocity] = await Promise.all([
      svc.getIssues(id),
      svc.getBurndown(id),
      svc.getVelocity(id),
    ]);

    res.json({
      sprint,
      totalIssues: sprintIssues.length,
      completedIssues: sprintIssues.filter((i) => i.status === "done").length,
      burndown,
      velocity,
    });
  });

  // Get issues linked to a sprint
  router.get("/sprints/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const sprint = await svc.getById(id);
    if (!sprint) {
      res.status(404).json({ error: "Sprint not found" });
      return;
    }
    assertCompanyAccess(req, sprint.companyId);
    const result = await svc.getIssues(id);
    res.json(result);
  });

  // Link/unlink issue to sprint
  router.patch("/issues/:id/sprint", validate(linkIssueToSprintSchema), async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await issues.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const updated = await issues.update(issueId, { sprintId: req.body.sprintId });
    res.json(updated);
  });

  return router;
}
