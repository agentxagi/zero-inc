import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@zeroinc/adapter-utils";
import { asString } from "@zeroinc/adapter-utils/server-utils";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const gatewayUrl = asString(ctx.config.gatewayUrl, "http://localhost:42617");
  const apiKey = asString(ctx.config.apiKey, "");
  const checks: AdapterEnvironmentCheck[] = [];

  // 1. Gateway reachable
  try {
    const res = await fetch(`${gatewayUrl}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      checks.push({
        code: "gateway_reachable",
        level: "info",
        message: `Gateway at ${gatewayUrl} is healthy`,
      });
    } else {
      checks.push({
        code: "gateway_unhealthy",
        level: "error",
        message: `Gateway returned status ${res.status}`,
        hint: "Ensure the ZeroClaw gateway is running: zeroclaw gateway start",
      });
    }
  } catch (e) {
    checks.push({
      code: "gateway_unreachable",
      level: "error",
      message: `Cannot reach gateway at ${gatewayUrl}: ${(e as Error).message}`,
      hint: "Start the ZeroClaw gateway: zeroclaw gateway start",
    });
  }

  // 2. Auth valid (if apiKey provided)
  if (apiKey) {
    try {
      const res = await fetch(`${gatewayUrl}/api/health`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        checks.push({
          code: "auth_ok",
          level: "info",
          message: "Authentication accepted",
        });
      } else if (res.status === 401 || res.status === 403) {
        checks.push({
          code: "auth_failed",
          level: "error",
          message: `Authentication rejected (${res.status})`,
          hint: "Check your API key or pair the device: zeroclaw gateway get-paircode",
        });
      } else {
        checks.push({
          code: "auth_unknown",
          level: "warn",
          message: `Auth check returned status ${res.status}`,
        });
      }
    } catch (e) {
      checks.push({
        code: "auth_error",
        level: "warn",
        message: `Auth check failed: ${(e as Error).message}`,
      });
    }
  } else {
    checks.push({
      code: "auth_skipped",
      level: "warn",
      message: "No API key configured — pairing may be required",
      hint: "Set apiKey in adapter config or disable gateway pairing",
    });
  }

  // 3. Worker endpoint available
  try {
    const res = await fetch(`${gatewayUrl}/api/worker`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ prompt: "health ping", timeout_secs: 10 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      checks.push({
        code: "worker_ok",
        level: "info",
        message: "Worker endpoint is available",
      });
    } else {
      checks.push({
        code: "worker_failed",
        level: "error",
        message: `Worker endpoint returned status ${res.status}`,
        hint: "Ensure the ZeroClaw daemon is running with worker support enabled",
      });
    }
  } catch (e) {
    checks.push({
      code: "worker_error",
      level: "error",
      message: `Worker check failed: ${(e as Error).message}`,
    });
  }

  const hasErrors = checks.some((c) => c.level === "error");
  const hasWarnings = checks.some((c) => c.level === "warn");

  let status: AdapterEnvironmentTestResult["status"] = "pass";
  if (hasErrors) status = "fail";
  else if (hasWarnings) status = "warn";

  return {
    adapterType: "zeroclaw",
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}
