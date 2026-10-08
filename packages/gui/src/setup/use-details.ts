import { LOCAL_PLACEHOLDER_ID } from "@agent-harness/client-runtime";
import { systemOf } from "../platform/browser-name.js";
import { useClientVersion, useRuntime, useShell } from "../window-context.js";
import type { DetailsReport, TechnicalDetailsProps } from "./details.js";

/**
 * Details of a problem as this window says it (setup-copy.md §3, "Details
 * and Copy details"): the report given, with this app's version and the
 * system it runs on first, and Copy details through the shell's clipboard,
 * else the browser's; with neither the copy is refused, and the lines stay
 * to select.
 */
export const useDetails = (): ((report: Omit<DetailsReport, "app">) => TechnicalDetailsProps) => {
  const runtime = useRuntime();
  const shell = useShell();
  const version = useClientVersion();
  const clipboard = runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.clipboard").status === "present" ? shell?.clipboard : globalThis.navigator?.clipboard;
  const platform = systemOf(globalThis.navigator?.userAgent ?? "", globalThis.navigator?.maxTouchPoints ?? 0) ?? "an unknown system";
  return (report) => ({
    report: { app: { version, platform }, ...report },
    copy: async (text) => {
      if (clipboard === undefined) throw new Error("This app has no clipboard here.");
      await clipboard.writeText(text);
    },
  });
};
