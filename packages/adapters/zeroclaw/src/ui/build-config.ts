import type { CreateConfigValues } from "@zeroinc/adapter-utils";

export function buildZeroClawConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  if (v.url) ac.gatewayUrl = v.url;
  ac.timeoutSec = 600;

  if (v.model) ac.model = v.model;
  if (v.promptTemplate) ac.bootstrapPrompt = v.promptTemplate;

  return ac;
}
