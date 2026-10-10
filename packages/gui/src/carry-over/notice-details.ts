import { LOCAL_PLACEHOLDER_ID, type SetupStepView } from "@agent-harness/client-runtime";
import { nameOf } from "../connections/words.js";
import type { TechnicalDetailsProps } from "../setup/details.js";
import { useClientVersion, useObservable, useRuntime, useShell } from "../window-context.js";

/**
 * Details for a notice on the Carry over card (setup-copy.md §3): this app,
 * the computer, the step, the plain line and the raw facts behind it, with
 * Copy details through the shell's clipboard where it has one.
 */
export const useNoticeDetails = (environmentId: string, step: SetupStepView): ((line: string, details: readonly string[]) => TechnicalDetailsProps) => {
  const runtime = useRuntime();
  const shell = useShell();
  const version = useClientVersion();
  const environment = useObservable(runtime.projections.environments).find((view) => view.environmentId === environmentId);
  const clipboard = runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.clipboard").status === "present" ? shell?.clipboard : undefined;
  return (line, details) => ({
    report: {
      app: { version, platform: shell === undefined ? "web" : "desktop" },
      ...(environment !== undefined && { computer: { name: nameOf(environment) } }),
      ...(step.result !== null && { step: { label: step.label, id: step.id, state: step.result.state }, checkedAt: step.result.checkedAt }),
      line,
      details,
    },
    copy: async (text) => {
      if (clipboard === undefined) throw new Error("This app has no clipboard here.");
      await clipboard.writeText(text);
    },
  });
};
