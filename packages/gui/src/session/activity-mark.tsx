import { activityOf, rowActivityWords, type RowActivity } from "@agent-harness/client-runtime";
import type { SessionSummary } from "@agent-harness/contracts";
import { useProviderProcess } from "../status/use-process.js";
import { classes } from "../ui/classes.js";

/** The same running dot on the sidebar, status line and header; amber names background waiting. */
export const ActivityMark = ({ activity }: { readonly activity: RowActivity }) => {
  const words = rowActivityWords(activity);
  if (words === undefined) return null;
  return <span role="img" aria-label={words} title={words} className={classes("size-1.5 shrink-0 rounded-full", activity.state === "parked" || activity.state === "background" ? "bg-amber" : "bg-cyan", (activity.state === "running" || activity.state === "background") && "motion-safe:animate-pulse")} />;
};

export const SessionActivityMark = ({ environmentId, sessionId, summary }: { readonly environmentId: string; readonly sessionId: string; readonly summary: SessionSummary | null }) => {
  const process = useProviderProcess(environmentId, sessionId);
  return summary === null ? null : <ActivityMark activity={activityOf(summary, process)} />;
};
