import { AccessUnavailable } from "../connections/limited-access.js";
import { KEY_MANAGER_PROVIDER_WORDS, plainRefusal, type EnvironmentView, type SetupStepView } from "@agent-harness/client-runtime";
import { KEY_MANAGER_PROVIDERS, managedTool, type KeyManagerProvider, type ManagedToolName } from "@agent-harness/contracts";
import { useId, useMemo, useState } from "react";
import { nameOf } from "../connections/words.js";
import { MANAGED_TOOLS_SENT } from "../managed-tools/managed-tools.js";
import { ToolTerminal, useToolTerminal } from "../managed-tools/tool-terminal.js";
import type { StepCardProps } from "../setup/cards.js";
import { useChecklist } from "../setup/checklist-window.js";
import { StepStatus } from "../setup/step-status.js";
import { RadioGroup, RadioGroupItem, Tooltip } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { SignInForm } from "./add-connection.js";
import { MoveSavedTokens } from "./move-card.js";
import { RefusalLine } from "./refusal-line.js";
import { ConnectionsMoreOptions, StepConnection } from "./step-connection.js";

/**
 * The Key manager step's card (setup-copy.md §5.7; the Set up
 * specification, "5. Key manager"; key-managers spec, "The Key manager
 * step"; ADR 0028; #590, #1851): where the step stands (`StepStatus`); each
 * connection with its health in one line and one button, and its switch;
 * their policy ticks and CLI rows under one More options; the question
 * "Which one do you use?", "I do not use one" chosen while none is
 * connected, the chosen one's connect form under it; and Move saved tokens
 * while agent-harness keeps some, which an opening at it (the Forges card's
 * Move to your key manager) focuses.
 */
export const KeyManagerCard = ({ environmentId, step }: StepCardProps) => {
  const runtime = useRuntime();
  const view = useObservable(runtime.projections.environments).find((environment) => environment.environmentId === environmentId);
  return view === undefined ? <StepStatus environmentId={environmentId} step={step} /> : <KeyManagerSetUp view={view} step={step} />;
};

/** What the question has chosen: a key manager, or none. */
type Choice = KeyManagerProvider | "none";

/**
 * The card under its step's status, on the environment the checklist
 * checks: `keyManagers.list` from the request cache, which every
 * key-manager event and `tools.updated` refresh. Without the `keyManagers`
 * flag it holds the flag's line alone; without `admin` it is read-only,
 * saying why once. A provider this computer cannot connect to yet
 * (`provider_unavailable`) is marked on the question while the card shows.
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
  const [chosen, choose] = useState<Choice>("none");
  const [unavailable, setUnavailable] = useState<ReadonlySet<KeyManagerProvider>>(new Set());
  const [said, say] = useState<string | undefined>(undefined);

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
  const held = connections ?? [];
  const connected = held.length > 0;
  return (
    <>
      <StepStatus environmentId={environmentId} step={step} toolStarted={terminal.started} />
      {ready && admin.status === "absent" && (
        <AccessUnavailable environmentId={view.environmentId} answer={admin}>
          <p className="text-sm text-amber">You can look but not change this. {admin.message}</p>
        </AccessUnavailable>
      )}
      {connections === null && ready && (listed.error === null
        ? <p className="text-sm text-ink-faint">Reading the key managers…</p>
        : <RefusalLine {...plainRefusal(listed.error, "Check again")} />)}
      {held.map((connection) => <StepConnection key={connection.id} view={view} connection={connection} writable={writable} />)}
      {connected && <ConnectionsMoreOptions environmentId={environmentId} environmentName={nameOf(view)} connections={held} writable={writable} tools={tools} />}
      <ProviderQuestion value={chosen === "none" && connected ? "" : chosen} connected={connected} unavailable={unavailable} writable={writable} choose={(next) => { say(undefined); choose(next); }} />
      {chosen !== "none" && (
        <SignInForm
          key={chosen}
          environmentId={environmentId}
          providers={[chosen]}
          writable={writable}
          saved={(line) => {
            choose("none");
            say(line);
          }}
          refused={(provider, code) => code === "provider_unavailable" && setUnavailable((marked) => new Set([...marked, provider]))}
        />
      )}
      {said !== undefined && <p role="status" className="text-sm text-ink">{said}</p>}
      {terminal.drawn !== null && (
        <ToolTerminal key={terminal.drawn.terminal.id} environmentId={environmentId} run={terminal.drawn} label={managedTool(terminal.drawn.tool).label} close={terminal.close} />
      )}
      {connected && <MoveSavedTokens environmentId={environmentId} connections={held} writable={writable} focused={part === "move-stored-tokens"} />}
    </>
  );
};

/**
 * The question "Which one do you use?" (setup-copy.md §5.7): "I do not use
 * one" while no key manager is connected, chosen at first, then each
 * provider, one this computer cannot connect to yet marked so in words.
 * With a key manager connected nothing is chosen at first: choosing one
 * connects another.
 */
const ProviderQuestion = ({
  value,
  connected,
  unavailable,
  writable,
  choose,
}: {
  readonly value: Choice | "";
  readonly connected: boolean;
  readonly unavailable: ReadonlySet<KeyManagerProvider>;
  readonly writable: boolean;
  readonly choose: (next: Choice) => void;
}) => {
  const id = useId();
  const choices: readonly (readonly [Choice, string])[] = [
    ...(connected ? [] : [["none", "I do not use one"] as const]),
    ...KEY_MANAGER_PROVIDERS.map((provider) => [provider, KEY_MANAGER_PROVIDER_WORDS[provider]] as const),
  ];
  return (
    <div className="flex flex-col gap-2">
      <h3 id={`${id}-question`} className="text-sm font-semibold text-ink">Which one do you use?</h3>
      <RadioGroup aria-labelledby={`${id}-question`} value={value} disabled={!writable} onValueChange={(next) => choose(next as Choice)} className="gap-0.5 rounded-lg border border-hairline bg-panel p-1.5">
        {choices.map(([choice, words]) => (
          <label key={choice} className={`flex items-start gap-2.5 rounded-md px-2.5 py-2 hover:bg-wash ${value === choice ? "bg-wash-strong" : ""}`}>
            <Tooltip content={words} keys="Arrow keys to choose">
              <RadioGroupItem value={choice} aria-label={words} aria-describedby={`${id}-${choice}`} className="mt-[3px]" />
            </Tooltip>
            <span className="flex min-w-0 flex-col">
              <span className="text-sm text-ink">{words}</span>
              <span id={`${id}-${choice}`} className="text-xs text-amber">{choice !== "none" && unavailable.has(choice) ? "Not available on this computer yet." : ""}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
    </div>
  );
};
