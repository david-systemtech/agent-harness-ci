import { Download, KeyRound, LogIn } from "lucide-react";
import { ActionButton as Button } from "../key-managers/action-button.js";
import { addFromGh, addFromMachineGh, ghRoute, runTool, type ForgeOutcome, type ForgeRefused, type GhRoute } from "@agent-harness/client-runtime";
import { managedTool, type GhProbe } from "@agent-harness/contracts";
import { useMemo, useState } from "react";
import { ToolTerminal, type ShownRun } from "../managed-tools/tool-terminal.js";
import { CopyLine } from "../settings/copy-line.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";
import type { AddForgeGh } from "./add-forge.js";
import { ForgeDetails, RefusalLine } from "./refusal-line.js";

/** The site this computer's `gh` hands a token over for: GitHub's own. */
const GITHUB = "https://github.com";

export interface GhRoutesProps {
  readonly environmentId: string;
  readonly environmentName: string;
  /** Where the environment's own gh runs, as a line names it. */
  readonly computer: string;
  readonly paths: AddForgeGh;
  /** Whether this client may add a forge account there. */
  readonly writable: boolean;
  /** Says one line in the pane: where the forge account added stands. */
  readonly say: (line: string) => void;
  /** Opens Add a forge, for a gh signed in nowhere. */
  readonly addToken: () => void;
}

/**
 * The fastest paths, first on the Forges list (setup-copy.md §5.6; ADR 0032;
 * #589, #1849): Use gh, the environment's own `gh` signed in as the login
 * `forge.gh.probe` names, read on every use; where it is missing or out of
 * date, Install gh or Update gh in place, its run in a tool terminal here;
 * where it is signed in nowhere, how to sign it in or Add a token instead;
 * and Use the gh sign-in from this computer, its token handed over once. A
 * refusal is one plain line with Details.
 */
export const GhRoutes = ({ environmentId, environmentName, computer, paths, writable, say, addToken }: GhRoutesProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const gh = runtime.capability(environmentId, "shell.gh");
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<ForgeRefused | undefined>(undefined);
  const add = (adding: () => Promise<ForgeOutcome>) => {
    setRefused(undefined);
    setSending(true);
    void adding().then((added) => {
      setSending(false);
      if (!added.ok) return setRefused(added);
      say(added.line);
    });
  };
  return (
    <div className="flex flex-col gap-2">
      {paths.machine && (
        <MachineGh
          environmentId={environmentId}
          computer={computer}
          disabled={!writable || sending}
          onUse={(probe, host) => add(() => addFromMachineGh({ runtime, clock }, environmentId, environmentName, probe, `https://${host}`))}
          addToken={addToken}
        />
      )}
      {paths.computer &&
        (gh.status === "present" ? (
          <div className="flex flex-wrap gap-2">
            <Button icon={LogIn} label="Use the gh sign-in from this computer" disabled={!writable || sending} onClick={() => add(() => addFromGh(runtime, environmentId, GITHUB))}>
              Use the gh sign-in from this computer
            </Button>
          </div>
        ) : (
          <p className="text-xs text-ink-muted">{gh.message}</p>
        ))}
      {refused !== undefined && <RefusalLine refused={refused} computer={environmentName} />}
    </div>
  );
};

/** What each fix of the environment's own gh runs, and its button. */
const FIXES = { install: { words: "Install gh", icon: Download }, update: { words: "Update gh", icon: Download } } as const;

/**
 * The environment's own `gh` as `forge.gh.probe`, from the request cache,
 * finds it: Use gh with its login; Install gh or Update gh, run on the
 * environment in a tool terminal drawn here (the probe is read again once
 * the managed tools change); or signed in nowhere. Nothing until it answers.
 */
const MachineGh = ({
  environmentId,
  computer,
  disabled,
  onUse,
  addToken,
}: {
  readonly environmentId: string;
  readonly computer: string;
  readonly disabled: boolean;
  readonly onUse: (probe: GhProbe, host: string) => void;
  readonly addToken: () => void;
}) => {
  const runtime = useRuntime();
  const clock = useClock();
  const probed = useObservable(useMemo(() => runtime.requests.cached(environmentId, "forge.gh.probe", {}), [runtime, environmentId]));
  const [running, setRunning] = useState<ShownRun | null>(null);
  const [notRun, setNotRun] = useState<{ readonly line: string; readonly command: string | null } | undefined>(undefined);
  const tools = runtime.capability(environmentId, "tools.run");
  const probe = probed.result;
  if (probe === null) return null;
  const route: GhRoute = ghRoute(probe, computer);
  if (route.kind === "use") {
    return (
      <div data-gh-route="use" className="flex flex-col gap-1.5">
        <p className="text-sm text-ink">{route.line}</p>
        <div className="flex flex-wrap gap-2">
          <Button icon={LogIn} label="Use gh" variant="default" disabled={disabled} onClick={() => onUse(probe, route.host)}>
            Use gh
          </Button>
        </div>
      </div>
    );
  }
  const fix = async (action: "install" | "update") => {
    setNotRun(undefined);
    const outcome = await runTool(runtime, environmentId, "gh", action, clock.now());
    if (outcome.ok) return setRunning(outcome.run);
    setNotRun(outcome);
  };
  return (
    <div data-gh-route={route.kind} className="flex flex-col gap-1.5">
      <p className="text-sm text-ink">{route.line}</p>
      <div className="flex flex-wrap items-center gap-2">
        {route.kind === "signed-out" ? (
          <Button icon={KeyRound} label="Add a token instead" disabled={disabled} onClick={addToken}>
            Add a token instead
          </Button>
        ) : (
          <Button icon={FIXES[route.kind].icon} label={FIXES[route.kind].words} disabled={disabled || tools.status === "absent" || running !== null} onClick={() => void fix(route.kind as "install" | "update")}>
            {FIXES[route.kind].words}
          </Button>
        )}
        {route.kind !== "signed-out" && tools.status === "absent" && <span className="text-xs text-ink-muted">{tools.message}</span>}
      </div>
      {route.kind === "signed-out" ? <CopyLine label="The command to run there" text={route.details[0] ?? ""} /> : <ForgeDetails line={route.line} details={route.details} computer={computer} />}
      {notRun !== undefined && (
        <>
          <p role="alert" className="text-sm text-signal">
            <span className="sr-only">Error: </span>
            <span>{notRun.line}</span>
          </p>
          {notRun.command !== null && <CopyLine label="The vendor's command, to run yourself" text={notRun.command} />}
        </>
      )}
      {running !== null && <ToolTerminal key={running.terminal.id} environmentId={environmentId} run={running} label={managedTool(running.tool).label} close={() => setRunning(null)} />}
    </div>
  );
};
