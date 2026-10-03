import type { DesktopBuildView } from "@agent-harness/client-runtime";
import { ArrowDown, CircleAlert, LoaderCircle } from "lucide-react";
import { classes } from "../ui/classes.js";
import { Button, Tooltip } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";

/** Whether a restart would update: a build is staged, ready, or left to apply after a failed step. */
const restartable = (build: DesktopBuildView): boolean => build.state === "ready" || (build.state === "failed" && build.staged !== null);

/**
 * "Restart to update" (launcher-update spec, "The desktop moves with its
 * local environment"; #424): once the runtime reports a desktop build its
 * local environment staged, a click applies it now through the shell
 * (`desktopUpdate.restart`). Nothing otherwise.
 */
export const RestartButton = () => {
  const runtime = useRuntime();
  const { build } = useObservable(runtime.desktopUpdate.view);
  if (!restartable(build)) return null;
  return (
    <Tooltip content={build.state === "failed" ? `Restart to update · ${build.message}` : "Restart to update"}>
      <Button size="xs" className={classes("h-[22px] max-w-36 gap-1.5 border font-mono", build.state === "failed" ? "border-signal/30 text-signal" : "border-beam/30 text-beam-text")} onClick={() => void runtime.desktopUpdate.restart()}>
        <ArrowDown aria-hidden="true" /><span className="truncate">Restart to update</span>
      </Button>
    </Tooltip>
  );
};

/** The header's "Restart to update": the button once a build is staged, and while it applies, that it restarts. */
export const RestartToUpdate = () => {
  const runtime = useRuntime();
  const { build } = useObservable(runtime.desktopUpdate.view);
  const pending = build.state === "checking" || build.state === "staging" || build.state === "applying";
  const failed = build.state === "failed" && build.staged === null;
  if (!pending && !failed) return <RestartButton />;
  const label = build.state === "applying" ? "Restarting to update…" : build.state === "staging" ? "Downloading update…" : failed ? "Update failed" : "Checking for an update…";
  const Icon = failed ? CircleAlert : LoaderCircle;
  return <Tooltip content={build.state === "failed" ? build.message : label}>
    <span role="status" tabIndex={0} className={classes("flex h-[22px] max-w-36 items-center gap-1.5 rounded-md border px-2 font-mono text-xs", failed ? "border-signal/30 text-signal" : "border-beam/30 text-beam-text opacity-60")}>
      <Icon aria-hidden="true" className={classes("size-3 shrink-0", pending && "animate-spin motion-reduce:animate-none")} /><span className="truncate">{label}</span>
    </span>
  </Tooltip>;
};
