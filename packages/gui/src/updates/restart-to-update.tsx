import type { DesktopBuildView, ShellStagedBuild } from "@agent-harness/client-runtime";
import { ArrowDown, CircleAlert, ExternalLink, LoaderCircle, RotateCw } from "lucide-react";
import { useState } from "react";
import { CopyLine } from "../settings/copy-line.js";
import { classes } from "../ui/classes.js";
import { Button, Popover, PopoverContent, PopoverTrigger, Tooltip } from "../ui/index.js";
import { useObservable, useRuntime, useShell } from "../window-context.js";

/** A staged build that failed to install, or to clean up after: it stays to try again, or to install by hand. */
export type ApplyFailed = Extract<DesktopBuildView, { readonly state: "failed" }> & { readonly staged: ShellStagedBuild };

export const applyFailed = (build: DesktopBuildView): build is ApplyFailed =>
  build.state === "failed" && build.staged !== null && (build.failure === "install" || build.failure === "cleanup");

/** Whether a restart would update: a build is staged and ready, or left to apply after a failed check or stage. */
const restartable = (build: DesktopBuildView): boolean => build.state === "ready" || (build.state === "failed" && build.staged !== null && !applyFailed(build));

/**
 * "Restart to update" (launcher-update spec, "The desktop moves with its
 * local environment"; #424): once the runtime reports a desktop build its
 * local environment staged, a click applies it now through the shell
 * (`desktopUpdate.restart`), and `onFailed` is called when that install
 * fails. Nothing otherwise.
 */
export const RestartButton = ({ onFailed }: { readonly onFailed?: () => void }) => {
  const runtime = useRuntime();
  const { build } = useObservable(runtime.desktopUpdate.view);
  if (!restartable(build)) return null;
  const restart = () => void runtime.desktopUpdate.restart().then((after) => { if (applyFailed(after)) onFailed?.(); });
  return (
    <Tooltip content={build.state === "failed" ? `Restart to update · ${build.message}` : "Restart to update"}>
      <Button aria-label="Restart to update" size="xs" className={classes("h-[22px] max-w-36 gap-1.5 border font-mono", build.state === "failed" ? "border-signal/30 text-signal" : "border-beam/30 text-beam-text")} onClick={restart}>
        <ArrowDown aria-hidden="true" /><span className="truncate">Restart to update</span>
      </Button>
    </Tooltip>
  );
};

/**
 * What a person can do once the staged build failed to install (#1692):
 * run the command that installs it by hand, where the install has one,
 * download it from the release page, or try again.
 */
export const ApplyFailureActions = ({ build }: { readonly build: ApplyFailed }) => {
  const runtime = useRuntime();
  const shell = useShell();
  const { releasePage } = build;
  return (
    <div className="flex flex-col gap-2.5">
      {build.byHand !== undefined && <CopyLine label="Or install it by hand, in a terminal" text={build.byHand} copyLabel="Copy the install command" />}
      <div className="flex flex-wrap gap-2">
        <Button variant="default" size="xs" onClick={() => void runtime.desktopUpdate.restart()}><RotateCw aria-hidden="true" />Try again</Button>
        {releasePage !== undefined && (
          <Button variant="outline" size="xs" disabled={shell?.openExternal === undefined} onClick={() => void shell?.openExternal?.(releasePage)}>
            <ExternalLink aria-hidden="true" />Open the release page
          </Button>
        )}
      </div>
    </div>
  );
};

/**
 * The header's "Restart to update": the button once a build is staged, and
 * while it applies, that it restarts. Once the install fails, "Update
 * failed", whose details open by themselves when a click here failed: why,
 * and what to do about it.
 */
export const RestartToUpdate = () => {
  const runtime = useRuntime();
  const { build } = useObservable(runtime.desktopUpdate.view);
  const [details, setDetails] = useState(false);
  if (applyFailed(build)) {
    return (
      <Popover open={details} onOpenChange={setDetails}>
        <Tooltip content="Update failed · Enter for the details">
          <PopoverTrigger asChild>
            <Button aria-label="Update failed" size="xs" className="h-[22px] max-w-36 gap-1.5 border border-signal/30 font-mono text-signal">
              <CircleAlert aria-hidden="true" /><span className="truncate">Update failed</span>
            </Button>
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent aria-label="Update failed" className="w-96 text-xs">
          <p className="text-signal">{build.message}</p>
          <ApplyFailureActions build={build} />
        </PopoverContent>
      </Popover>
    );
  }
  const pending = build.state === "checking" || build.state === "staging" || build.state === "applying";
  const failed = build.state === "failed" && build.staged === null;
  if (!pending && !failed) return <RestartButton onFailed={() => setDetails(true)} />;
  const label = build.state === "applying" ? "Restarting to update…" : build.state === "staging" ? "Downloading update…" : failed ? "Update failed" : "Checking for an update…";
  const Icon = failed ? CircleAlert : LoaderCircle;
  return <Tooltip content={build.state === "failed" ? build.message : label}>
    <span role="status" tabIndex={0} className={classes("flex h-[22px] max-w-36 items-center gap-1.5 rounded-md border px-2 font-mono text-xs", failed ? "border-signal/30 text-signal" : "border-beam/30 text-beam-text opacity-60")}>
      <Icon aria-hidden="true" className={classes("size-3 shrink-0", pending && "animate-spin motion-reduce:animate-none")} /><span className="truncate">{label}</span>
    </span>
  </Tooltip>;
};
