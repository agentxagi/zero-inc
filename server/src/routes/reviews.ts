import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { submitReviewSchema } from "@paperclipai/shared";
import { reviewPipelineService } from "../services/review-pipeline.js";
import { validate } from "../middleware/validate.js";
import { issueService } from "../services/index.js";
import { forbidden, notFound } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function reviewRoutes(db: Db) {
  const router = Router();
  const svc = issueService(db);
  const reviewPipeline = reviewPipelineService(db);

  // POST /issues/:id/review — submit a review verdict
  router.post(
    "/issues/:id/review",
    validate(submitReviewSchema),
    async (req: Request, res: Response) => {
      const actor = getActorInfo(req);
      if (!actor.agentId) {
        throw forbidden("Only agents can submit reviews");
      }

      const issueId = req.params.id as string;
      const issue = await svc.getById(issueId);
      if (!issue) throw notFound("Issue not found");

      await assertCompanyAccess(req, issue.companyId);

      const config = reviewPipeline.resolveConfig();
      const result = await reviewPipeline.submitReview(
        issue.id,
        actor.agentId,
        req.body,
        config,
      );

      if (!result.success) {
        throw forbidden(result.reason ?? "Review submission failed");
      }

      const updated = await svc.getById(issue.id);
      res.json(updated);
    },
  );

  return router;
}
