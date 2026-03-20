import type {
  InstanceExperimentalSettings,
  PatchInstanceExperimentalSettings,
} from "@zeroinc/shared";
import { api } from "./client";

export const instanceSettingsApi = {
  getExperimental: () =>
    api.get<InstanceExperimentalSettings>("/instance/settings/experimental"),
  updateExperimental: (patch: PatchInstanceExperimentalSettings) =>
    api.patch<InstanceExperimentalSettings>("/instance/settings/experimental", patch),
};
