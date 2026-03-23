import type { UIAdapterModule } from "../types";
import { parseZeroClawStdoutLine } from "@zeroinc/adapter-zeroclaw/ui";
import { buildZeroClawConfig } from "@zeroinc/adapter-zeroclaw/ui";
import { ZeroClawConfigFields } from "./config-fields";

export const zeroclawUIAdapter: UIAdapterModule = {
  type: "zeroclaw",
  label: "ZeroClaw",
  parseStdoutLine: parseZeroClawStdoutLine,
  ConfigFields: ZeroClawConfigFields,
  buildAdapterConfig: buildZeroClawConfig,
};
