import type { Db } from "@zeroinc/db";
import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "./instance-settings.js";

export function humanNotificationService(db: Db) {
  const settings = instanceSettingsService(db);

  async function notifyHumanTask(data: {
    companyId: string;
    issueId: string;
    identifier: string;
    title: string;
    description: string | null;
    priority: string;
    labelNames: string[];
    createdByAgent: string | null;
  }) {
    try {
      const general = await settings.getGeneral();
      const webhookUrl = (general as any).humanTaskWebhookUrl;
      const webhookEnabled = (general as any).humanTaskWebhookEnabled !== false;

      if (!webhookUrl || !webhookEnabled) {
        logger.info(`[human-notification] Webhook not configured, skipping notification for ${data.identifier}`);
        return;
      }

      const excerpt = data.description
        ? data.description.length > 200
          ? data.description.slice(0, 200) + "..."
          : data.description
        : null;

      const payload = {
        event: "human_task_assigned",
        timestamp: new Date().toISOString(),
        issue: {
          id: data.issueId,
          identifier: data.identifier,
          title: data.title,
          description: excerpt,
          priority: data.priority,
          labels: data.labelNames,
          url: `${process.env.PAPERCLIP_APP_URL ?? "https://app.zeroinc.dev"}/issues/${data.issueId}`,
        },
        assignedTo: "board",
        createdByAgent: data.createdByAgent,
      };

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        logger.warn(`[human-notification] Webhook returned ${response.status} for ${data.identifier}`);
      } else {
        logger.info(`[human-notification] Notified webhook for ${data.identifier}`);
      }
    } catch (err) {
      logger.warn(`[human-notification] Failed to send notification for ${data.identifier}: ${err}`);
    }
  }

  return { notifyHumanTask };
}

export type HumanNotificationService = ReturnType<typeof humanNotificationService>;
