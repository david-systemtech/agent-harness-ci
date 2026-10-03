import { adminCall, uuidv7, LOCAL_PLACEHOLDER_ID } from "@agent-harness/client-runtime";
import type { PairedChrome, SetupTarget } from "@agent-harness/contracts";
import { CheckCircle2, Circle, FolderOpen, KeyRound, Square } from "lucide-react";
import { Button, CopyButton } from "../ui/index.js";
import { useMemo, useState } from "react";
import { BrowserDone } from "./done.js";
import { DevelopmentSites } from "./development-sites.js";
import { BrowserPairingCode, BrowserProblem } from "./pairing-code.js";
import type { StepCardProps } from "../setup/cards.js";
import { StepStatus } from "../setup/step-status.js";
import { useClock, useObservable, useRuntime, useShell } from "../window-context.js";

/** The Browser card pairs Chrome with the environment on this client's machine (ADR 0024; #593). */
export const BrowserCard = (props: StepCardProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [another, pairAnother] = useState(0);
  const [line, say] = useState<string | null>(null);
  const local = useObservable(runtime.projections.environments).find((view) => view.kind === "local" && view.environmentId !== LOCAL_PLACEHOLDER_ID);
  const writable = runtime.capability(props.environmentId, "browser.chromes.unpair").status === "present";
  const unpair = async (targets: readonly SetupTarget[]) => {
    let named = targets.filter((target) => target.kind === "chrome").map((target) => ({ id: target.id, label: target.label }));
    if (named.length === 0) {
      const listed = await runtime.requests.call(props.environmentId, "browser.chromes.list", {});
      if (!listed.ok) return say(`Not unpaired: ${listed.error.message}`);
      named = listed.result.chromes.map((chrome) => ({ id: chrome.id, label: chrome.name }));
    }
    for (const chrome of named) {
      const answer = await adminCall(() => runtime.requests.call(props.environmentId, "browser.chromes.unpair", { commandId: uuidv7(clock.now()), chromeId: chrome.id }));
      say(answer.ok ? `Unpaired ${chrome.label}.` : `Not unpaired: ${answer.line}`);
    }
  };
  const actions = {
    unpair: { disabled: !writable, run: (targets: readonly SetupTarget[]) => void unpair(targets) },
    "pair-another": { disabled: local === undefined || runtime.capability(local.environmentId, "browser.pairing.code").status !== "present", run: () => pairAnother((n) => n + 1) },
    reload: { disabled: false, run: (targets: readonly SetupTarget[]) => say(`${targets.map((target) => target.label + ": ").join("")}Open chrome://extensions and click Reload.`) },
  };
  return (
    <div className="flex min-w-0 flex-col gap-3.5 text-xs">
      <StepStatus {...props} actions={actions} />
      {line !== null && <p role="status">{line}</p>}
      {local === undefined ? (
        <p>Install agent-harness on this machine to pair your Chrome.</p>
      ) : (
        <BrowserPairing key={local.environmentId} another={another} environmentId={local.environmentId} accountsEnvironmentId={props.environmentId} />
      )}
    </div>
  );
};

export const BrowserPairing = ({ environmentId, accountsEnvironmentId, another, showSites = true }: { readonly environmentId: string; readonly accountsEnvironmentId: string; readonly another: number; readonly showSites?: boolean }) => {
  const runtime = useRuntime();
  const status = useObservable(useMemo(() => runtime.requests.cached(environmentId, "browser.status", {}), [runtime, environmentId]));
  const listed = useObservable(useMemo(() => runtime.requests.cached(environmentId, "browser.chromes.list", {}), [runtime, environmentId]));
  const chromes = listed.result?.chromes ?? [];
  const paired = chromes.length > 0;
  const shell = useShell();
  const clipboard = runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.clipboard").status === "present" ? shell?.clipboard : undefined;
  const loaded = paired || (status.result?.unpairedConnected ?? false);
  return (
    <div className="flex min-w-0 flex-col gap-3.5 text-xs">
      <section aria-label="Load the extension" className="flex flex-col gap-2 rounded-lg border border-hairline p-3">
        <h4 className="flex items-center gap-2 text-xs font-medium"><span className="flex size-5 items-center justify-center rounded-full bg-wash-strong font-mono text-2xs">1</span>{" "}<FolderOpen aria-hidden="true" className="size-4" />Load the extension</h4>
        <p role="status" aria-label="Extension installation" className="flex items-center gap-1.5 text-2xs text-ink-muted">{loaded ? <CheckCircle2 aria-hidden="true" className="size-4 text-mint" /> : <Circle aria-hidden="true" className="size-4" />}{loaded ? "Extension connected" : "Waiting for the extension"}</p>
        {status.result !== null && <div className="flex flex-col gap-1"><span className="text-2xs text-ink-faint">Extension folder</span><div className="flex items-start gap-2"><pre className="min-w-0 flex-1 bg-inset p-2 font-mono text-xs break-all whitespace-pre-wrap select-all">{status.result.folder.path}</pre>{clipboard !== undefined && <CopyButton label="Copy extension folder (Enter or Space)" text={status.result.folder.path} copy={(text) => clipboard.writeText(text)} />}</div></div>}
        {status.result?.folder.problem !== null && status.result?.folder.problem !== undefined && <BrowserProblem line={status.result.folder.problem} />}
        {status.error !== null && <BrowserProblem line={status.error.message} code={status.error.code} />}
        <p>Open chrome://extensions. Turn on Developer mode. Click Load unpacked and choose this folder.</p>
      </section>
      <section aria-label="Pair" className="flex flex-col gap-2 rounded-lg border border-hairline p-3">
        <h4 className="flex items-center gap-2 text-xs font-medium"><span className="flex size-5 items-center justify-center rounded-full bg-wash-strong font-mono text-2xs">2</span>{" "}<KeyRound aria-hidden="true" className="size-4" />Pair</h4>
        {listed.result !== null && <Pair key={another} environmentId={environmentId} chromes={chromes} />}
        {listed.error !== null && <BrowserProblem line={listed.error.message} code={listed.error.code} />}
        {status.result?.listener.state === "listening" && <p>Listening on 127.0.0.1:{status.result.listener.port}.</p>}
        {status.result?.listener.state === "not-listening" && <BrowserProblem line={status.result.listener.message} />}
      </section>
      {showSites && <DevelopmentSites environmentId={environmentId} />}
      <BrowserDone environmentId={accountsEnvironmentId} chromeEnvironmentId={environmentId} paired={paired} />
    </div>
  );
};

/** A newly paired Chrome completes this attempt; Pair another starts a fresh attempt without discarding the sites field. */
const Pair = ({ environmentId, chromes }: { readonly environmentId: string; readonly chromes: readonly PairedChrome[] }) => {
  const [before] = useState(() => new Set(chromes.map((chrome) => chrome.id)));
  const completed = chromes.some((chrome) => !before.has(chrome.id));
  const [showing, show] = useState(true);
  return (
    <>
      <p role="status" aria-label="Chrome pairing" className="flex items-center gap-1.5 text-2xs text-ink-muted">{chromes.length > 0 ? <CheckCircle2 aria-hidden="true" className="size-4 text-mint" /> : <Circle aria-hidden="true" className="size-4" />}{chromes.length > 0 ? "Chrome paired" : "Waiting for pairing"}</p>
      {!completed && <p>Type this code on the extension's options page.</p>}
      {chromes.length > 0 && <p>Paired: {chromes.map((chrome) => chrome.name).join(", ")}.</p>}
      {!completed && <><Button title={`${showing ? "Stop" : "Show code"} (Enter or Space)`} onClick={() => show(!showing)} className="self-start">{showing ? <Square aria-hidden="true" data-icon="inline-start" /> : <KeyRound aria-hidden="true" data-icon="inline-start" />}{showing ? "Stop" : "Show code"}</Button>{showing && <BrowserPairingCode environmentId={environmentId} />}</>}
    </>
  );
};
