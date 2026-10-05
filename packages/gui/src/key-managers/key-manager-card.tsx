import { AccessUnavailable } from "../connections/limited-access.js";
import type { EnvironmentView, SetupStepView } from "@agent-harness/client-runtime";
import { KEY_MANAGER_PROVIDERS, managedTool, type ManagedToolName } from "@agent-harness/contracts";
import { useEffect, useMemo, useRef } from "react";
import { nameOf } from "../connections/words.js";
import { MANAGED_TOOLS_SENT } from "../managed-tools/managed-tools.js";
import { ToolTerminal, useToolTerminal } from "../managed-tools/tool-terminal.js";
import type { StepCardProps } from "../setup/cards.js";
import { useChecklist } from "../setup/checklist-window.js";
import { StepStatus } from "../setup/step-status.js";
import { useObservable, useRuntime } from "../window-context.js";
import { InjectionSwitch } from "./injection-setting.js";
import { MoveCard } from "./move-card.js";
import { ProviderTile } from "./provider-tile.js";

/**
 * The Key manager step's card (the Set up specification, "5. Key manager";
 * key-managers spec, "The Key manager step"; ADR 0028; #590): where the
 * step stands (`StepStatus`), then the Key managers row's pieces (#425) laid
 * out as the step's: a tile per provider with its sign-in form and its
 * connections, each with its health line, policy ticks and CLI row; once a
 * connection is here, the injection switch; and Move stored tokens, which an
 * opening at it (the Forges card's Move to your key manager) focuses.
 */
export const KeyManagerCard = ({ environmentId, step }: StepCardProps) => {
  const runtime = useRuntime();
  const view = useObservable(runtime.projections.environments).find((environment) => environment.environmentId === environmentId);
  return view === undefined ? <StepStatus environmentId={environmentId} step={step} /> : <KeyManagerSetUp view={view} step={step} />;
};

/**
 * The card under its step's status, on the environment the checklist
 * checks: `keyManagers.list` from the request cache, which every
 * key-manager event and `tools.updated` refresh. Without the `keyManagers`
 * flag it holds the flag's line alone; without `admin` it is read-only with
 * the capability's line, said once.
 */
const KeyManagerSetUp = ({ view, step }: { readonly view: EnvironmentView; readonly step: SetupStepView }) => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const { part } = useChecklist();
  const flagged = runtime.capability(environmentId, "keyManagers");
  const listed = useObservable(useMemo(() => runtime.requests.cached(environmentId, "keyManagers.list", {}), [runtime, environmentId]));
  const connections = listed.result?.connections ?? null;
  const clis = new Set<ManagedToolName>((connections ?? []).map((connection) => connection.cli.tool));
  const terminal = useToolTerminal(environmentId, (tool) => clis.has(tool));
  const move = useRef<HTMLElement>(null);
  const read = connections !== null;
  // Opened at Move stored tokens, the card takes it to the focus once the connections are read and it is drawn.
  useEffect(() => {
    if (part === "move-stored-tokens" && read) move.current?.focus();
  }, [part, read]);

  if (flagged.status === "absent" && flagged.reason === "unsupported") return (
    <>
      <StepStatus environmentId={environmentId} step={step} />
      <p className="text-sm text-amber">{flagged.message}</p>
    </>
  );
  const ready = view.phase === "ready";
  const admin = runtime.capability(environmentId, "keyManagers.connections.add");
  const writable = ready && admin.status === "present";
  const tools = { writable: ready && MANAGED_TOOLS_SENT.every((method) => runtime.capability(environmentId, method).status === "present"), readable: ready, terminal };
  return (
    <>
      <StepStatus environmentId={environmentId} step={step} toolStarted={terminal.started} />
      {ready && admin.status === "absent" && <AccessUnavailable environmentId={view.environmentId} answer={admin}><p className="text-sm text-amber">Read-only: {admin.message}</p></AccessUnavailable>}
      {connections === null && ready && (
        <p className="text-sm text-ink-faint">{listed.error === null ? "Reading the key managers…" : `The key managers could not be read: ${listed.error.message}`}</p>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {KEY_MANAGER_PROVIDERS.map((provider) => (
          <ProviderTile
            key={provider}
            environmentId={environmentId}
            environmentName={nameOf(view)}
            provider={provider}
            connections={(connections ?? []).filter((connection) => connection.provider === provider)}
            writable={writable}
            tools={tools}
          />
        ))}
      </div>
      {terminal.drawn !== null && (
        <ToolTerminal key={terminal.drawn.terminal.id} environmentId={environmentId} run={terminal.drawn} label={managedTool(terminal.drawn.tool).label} close={terminal.close} />
      )}
      {connections !== null && connections.length > 0 && (
        <>
          <InjectionSwitch view={view} />
          <MoveCard ref={move} environmentId={environmentId} connections={connections} writable={writable} />
        </>
      )}
      {connections !== null && connections.length === 0 && (
        <section ref={move} tabIndex={-1} aria-label="Move stored tokens" className="outline-none">
          <p className="text-sm text-ink-muted">Sign in to a key manager above to move your stored tokens into it.</p>
        </section>
      )}
    </>
  );
};
