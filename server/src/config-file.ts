import fs from "node:fs";
import { zeroincConfigSchema, type ZeroIncConfig } from "@zeroinc/shared";
import { resolveZeroIncConfigPath } from "./paths.js";

export function readConfigFile(): ZeroIncConfig | null {
  const configPath = resolveZeroIncConfigPath();

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return zeroincConfigSchema.parse(raw);
  } catch {
    return null;
  }
}
