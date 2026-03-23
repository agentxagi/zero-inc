import type { ProviderQuotaResult } from "@zeroinc/shared";

const SHORT_WINDOW_MAX_HORIZON_MS = 12 * 60 * 60 * 1000;

export interface PreventiveQuotaThrottleWindowMatch {
  provider: string;
  source: string | null;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface PreventiveQuotaThrottleDecision {
  active: boolean;
  thresholdPercent: number;
  maxUsedPercent: number | null;
  matches: PreventiveQuotaThrottleWindowMatch[];
}

function isLikelyShortWindowLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("current session")) return true;
  if (normalized.includes("5h")) return true;
  if (normalized.includes("5-hour")) return true;
  if (normalized.includes("5 hour")) return true;
  if (normalized.includes("primary window")) return true;
  return false;
}

function hasShortHorizonReset(resetsAt: string | null, nowMs: number): boolean {
  if (!resetsAt) return false;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return false;
  const horizonMs = resetMs - nowMs;
  return horizonMs > 0 && horizonMs <= SHORT_WINDOW_MAX_HORIZON_MS;
}

export function normalizePreventiveQuotaThresholdPercent(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
  if (!Number.isFinite(value)) return 85;
  return Math.min(99, Math.max(50, Math.round(value)));
}

export function evaluatePreventiveQuotaThrottle(
  quotaResults: ProviderQuotaResult[],
  thresholdPercent: number,
  now = new Date(),
): PreventiveQuotaThrottleDecision {
  const normalizedThreshold = normalizePreventiveQuotaThresholdPercent(thresholdPercent);
  const nowMs = now.getTime();

  const candidates: PreventiveQuotaThrottleWindowMatch[] = [];
  for (const result of quotaResults) {
    if (!result.ok) continue;
    for (const window of result.windows) {
      if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) continue;
      if (!isLikelyShortWindowLabel(window.label) && !hasShortHorizonReset(window.resetsAt, nowMs)) continue;
      candidates.push({
        provider: result.provider,
        source: result.source ?? null,
        label: window.label,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt ?? null,
      });
    }
  }

  const matches = candidates
    .filter((window) => window.usedPercent >= normalizedThreshold)
    .sort((left, right) => right.usedPercent - left.usedPercent);
  const maxUsedPercent =
    candidates.length > 0
      ? candidates.reduce((max, window) => Math.max(max, window.usedPercent), 0)
      : null;

  return {
    active: matches.length > 0,
    thresholdPercent: normalizedThreshold,
    maxUsedPercent,
    matches,
  };
}
