import { desktopBuildWords } from "@agent-harness/client-runtime";
import { Button } from "../ui/index.js";
import { useClientVersion, useObservable, useRuntime, useShell } from "../window-context.js";
import { RestartButton } from "./restart-to-update.js";

/**
 * This client's version, which About pins above its picker as the one line
 * that belongs to no environment (ADR 0027), with the desktop's own update
 * as the runtime has it (launcher-update spec, "The desktop moves with its
 * local environment"; #424): where it is, "Restart to update" once a build
 * is staged, and for an install that cannot update itself, the release
 * page to download one from.
 */
export const ClientBuild = () => {
  const runtime = useRuntime();
  const shell = useShell();
  const version = useClientVersion();
  const { build } = useObservable(runtime.desktopUpdate.view);
  const words = desktopBuildWords(build);
  return (
    <div className="flex flex-col items-start gap-1 text-sm">
      <p className="text-ink">This client: {version}</p>
      {words !== null && <p className={build.state === "failed" ? "text-signal" : "text-ink-muted"}>{words}</p>}
      {build.state === "unsupported" && (
        <>
          <p className="break-all font-mono text-xs text-beam-text">{build.releasePage}</p>
          <Button disabled={shell?.openExternal === undefined} onClick={() => void shell?.openExternal?.(build.releasePage)}>
            Open the release page
          </Button>
        </>
      )}
      <RestartButton />
    </div>
  );
};
