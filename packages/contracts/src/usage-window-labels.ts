/** Plan-window names shared by clients, thresholds and environment notices. */
export const PLAN_USAGE_WINDOW_LABELS = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly, Opus",
  seven_day_sonnet: "Weekly, Sonnet",
  seven_day_oauth_apps: "Weekly, apps",
  extra_usage: "Extra usage",
} as const;

const modelName = (window: string): string | undefined => {
  if (!window.startsWith("model_scoped:")) return undefined;
  const name = window.slice("model_scoped:".length).trim();
  return name === "" ? undefined : name.charAt(0).toUpperCase() + name.slice(1);
};

/** Unknown identifiers remain data for diagnostics and pooling, never display text. */
export const isKnownUsageWindow = (window: string): boolean => Object.hasOwn(PLAN_USAGE_WINDOW_LABELS, window) || modelName(window) !== undefined;

/** A name for a person; the provider's display name identifies a model's weekly bucket. */
export const usageWindowLabel = (window: string): string => {
  if (Object.hasOwn(PLAN_USAGE_WINDOW_LABELS, window)) return PLAN_USAGE_WINDOW_LABELS[window as keyof typeof PLAN_USAGE_WINDOW_LABELS];
  const model = modelName(window);
  return model === undefined ? "Other limit" : `Weekly, ${model}`;
};
