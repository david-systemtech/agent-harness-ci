import { desktopBuildWords, LOCAL_PLACEHOLDER_ID, type ShellSystem } from "@agent-harness/client-runtime";
import { ExternalLink, Monitor } from "lucide-react";
import { useEffect, useState } from "react";
import { SettingsGroup } from "../settings/part.js";
import { Button, Tooltip } from "../ui/index.js";
import { useClientVersion, useObservable, useRuntime, useShell } from "../window-context.js";
import { WebRegisteredSurfaces } from "../platform/web-registrations.js";
import { ApplyFailureActions, applyFailed, RestartButton } from "./restart-to-update.js";

/**
 * This client's version, which About pins above its picker as the one line
 * that belongs to no environment (ADR 0027), with the desktop's own update
 * as the runtime has it (launcher-update spec, "The desktop moves with its
 * local environment"; #424): where it is, "Restart to update" once a build
 * is staged, for an install that cannot update itself, the release page
 * to download one from, and once an install failed, what to do about it.
 */
export const ClientBuild = () => {
  const runtime = useRuntime();
  const shell = useShell();
  const version = useClientVersion();
  const [system, setSystem] = useState<ShellSystem>();
  useEffect(() => {
    let active = true;
    if (runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.system").status === "present") {
      void shell?.system?.().then((value) => { if (active) setSystem(value); }, () => undefined);
    }
    return () => { active = false; };
  }, [runtime, shell]);
  const { build } = useObservable(runtime.desktopUpdate.view);
  const words = desktopBuildWords(build);
  return (
    <SettingsGroup title="This client">
      <div className="flex flex-col gap-3 text-xs">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
        <dt className="flex items-center gap-2 text-ink-muted"><Monitor aria-hidden="true" className="size-4" />Version</dt>
        <dd className="font-mono text-ink">This client: {version}</dd>
        <dt className="text-ink-muted">Platform</dt>
        <dd className="font-mono text-ink">{system === undefined ? shell === undefined ? "Browser" : "Not read" : `${system.platform} · ${system.architecture}`}</dd>
      </dl>
      {words !== null && <p className={build.state === "failed" ? "text-signal" : "text-ink-muted"}>{words}</p>}
      {build.state === "unsupported" && (
        <>
          <p className="break-all font-mono text-xs text-beam-text">{build.releasePage}</p>
          <Tooltip content="Open the release page" keys="Enter / Space"><Button variant="default" disabled={shell?.openExternal === undefined} onClick={() => void shell?.openExternal?.(build.releasePage)}>
            <ExternalLink aria-hidden="true" />Open the release page
          </Button></Tooltip>
        </>
      )}
      {applyFailed(build) && <ApplyFailureActions build={build} />}
      <RestartButton />
      <WebRegisteredSurfaces location="settings-client" />
      </div>
    </SettingsGroup>
  );
};
