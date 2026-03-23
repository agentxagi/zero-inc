import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@zeroinc/adapter-utils";
import { asString, asNumber } from "@zeroinc/adapter-utils/server-utils";

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { config, runId, context } = ctx;
  const gatewayUrl = asString(config.gatewayUrl, "http://localhost:42617");
  const apiKey = asString(config.apiKey, "");
  const timeoutSec = asNumber(config.timeoutSec, 600);

  // 1. Health check
  let healthOk = false;
  try {
    const healthRes = await fetch(`${gatewayUrl}/api/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    healthOk = healthRes.ok;
  } catch {
    // fall through to submit — the error will be caught there
  }

  if (!healthOk) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `ZeroClaw gateway at ${gatewayUrl} is not healthy`,
    };
  }

  // 2. Submit task
  const payload: Record<string, unknown> = {
    prompt: context.prompt ?? "",
    timeout_secs: timeoutSec,
  };

  if (context.taskId) payload.task_id = context.taskId;
  if (context.sessionId) payload.session_id = context.sessionId;

  let res: Response;
  try {
    res = await fetch(`${gatewayUrl}/api/worker`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `ZeroClaw worker submit failed: ${(e as Error).message}`,
    };
  }

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `ZeroClaw worker submit failed (${res.status}): ${errorBody}`,
    };
  }

  const submitJson = (await res.json()) as { work_id?: string };
  const workId = submitJson.work_id;
  if (!workId) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "ZeroClaw worker response missing work_id",
    };
  }

  // 3. Poll for completion
  const startTime = Date.now();
  const pollIntervalMs = 3000;
  const maxPollMs = (timeoutSec + 30) * 1000;

  while (Date.now() - startTime < maxPollMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    let statusRes: Response;
    try {
      statusRes = await fetch(`${gatewayUrl}/api/worker/${workId}/status`, {
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      continue;
    }

    if (!statusRes.ok) continue;

    const status = (await statusRes.json()) as {
      status?: string;
      result?: string;
      error?: string;
    };

    if (status.result) {
      await ctx.onLog("stdout", status.result);
    }

    if (status.status === "completed") {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: status.result,
        resultJson: { work_id: workId },
      };
    }

    if (status.status === "failed") {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: status.error ?? "Task failed",
      };
    }

    if (status.status === "timeout") {
      return {
        exitCode: 1,
        signal: null,
        timedOut: true,
        errorMessage: `Task timed out after ${timeoutSec}s`,
      };
    }
  }

  return {
    exitCode: 1,
    signal: null,
    timedOut: true,
    errorMessage: `Polling timeout exceeded (${maxPollMs / 1000}s)`,
  };
}
