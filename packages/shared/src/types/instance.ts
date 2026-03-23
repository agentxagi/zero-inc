export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  operationsPaused: boolean;
  responseLanguage?: string;
}

export interface InstanceExperimentalSettings {
  enableIsolatedWorkspaces: boolean;
  autoRestartDevServerWhenIdle: boolean;
  preventiveQuotaThrottleEnabled: boolean;
  preventiveQuotaThrottleThresholdPercent: number;
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}
