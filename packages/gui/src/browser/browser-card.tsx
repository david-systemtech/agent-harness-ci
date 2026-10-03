import { adminCall, uuidv7, LOCAL_PLACEHOLDER_ID } from "@agent-harness/client-runtime";
import type { PairedChrome, SetupTarget } from "@agent-harness/contracts";
import { Save } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { BrowserSubstep } from "./setup-substep.js";
import { BrowserDone } from "./done.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { Button } from "../ui/index.js";
import { BrowserPairingCode } from "./pairing-code.js";
import { CopyLine } from "../settings/copy-line.js";
import type { StepCardProps } from "../setup/cards.js";
import { StepStatus } from "../setup/step-status.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";

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
    <>
      <StepStatus {...props} actions={actions} />
      {line !== null && <p role="status">{line}</p>}
      {local === undefined ? (
        <p>Install agent-harness on this machine to pair your Chrome.</p>
      ) : (
        <BrowserPairing key={local.environmentId} another={another} environmentId={local.environmentId} accountsEnvironmentId={props.environmentId} />
      )}
    </>
  );
};

export const BrowserPairing = ({ environmentId, accountsEnvironmentId, another }: { readonly environmentId: string; readonly accountsEnvironmentId: string; readonly another: number }) => {
  const runtime = useRuntime();
  const status = useObservable(useMemo(() => runtime.requests.cached(environmentId, "browser.status", {}), [runtime, environmentId]));
  const listed = useObservable(useMemo(() => runtime.requests.cached(environmentId, "browser.chromes.list", {}), [runtime, environmentId]));
  const chromes = listed.result?.chromes ?? [];
  const paired = chromes.length > 0;
  return (
    <>
      <section aria-label="Load the extension" className="flex flex-col gap-2 rounded-lg border border-hairline bg-panel p-3 text-xs">
        <BrowserSubstep number={1} label="Load the extension" complete={paired || (status.result?.unpairedConnected ?? false)} />
        {status.result !== null && <CopyLine label="Extension folder" text={status.result.folder.path} />}
        {status.result?.folder.problem !== null && status.result?.folder.problem !== undefined && <p role="alert">{status.result.folder.problem}</p>}
        {status.error !== null && <p role="alert">{status.error.message}</p>}
        <p>Open chrome://extensions. Turn on Developer mode. Click Load unpacked and choose this folder.</p>
      </section>
      <section aria-label="Pair" className="flex flex-col gap-2 rounded-lg border border-hairline bg-panel p-3 text-xs">
        <BrowserSubstep number={2} label="Pair" complete={paired} />
        {listed.result !== null && <Pair key={another} environmentId={environmentId} chromes={chromes} />}
        {listed.error !== null && <p role="alert">{listed.error.message}</p>}
        {status.result?.listener.state === "listening" && <p>Listening on 127.0.0.1:{status.result.listener.port}.</p>}
        {status.result?.listener.state === "not-listening" && <p role="alert">{status.result.listener.message}</p>}
      </section>
      <BrowserSites environmentId={environmentId} />
      <BrowserDone environmentId={accountsEnvironmentId} chromeEnvironmentId={environmentId} paired={paired} />
    </>
  );
};

/** A newly paired Chrome completes this attempt; Pair another starts a fresh attempt without discarding the sites field. */
const Pair = ({ environmentId, chromes }: { readonly environmentId: string; readonly chromes: readonly PairedChrome[] }) => {
  const [before] = useState(() => new Set(chromes.map((chrome) => chrome.id)));
  const completed = chromes.some((chrome) => !before.has(chrome.id));
  return (
    <>
      {!completed && <p>Type this code on the extension's options page.</p>}
      {chromes.length > 0 && <p>Paired: {chromes.map((chrome) => chrome.name).join(", ")}.</p>}
      {!completed && <BrowserPairingCode environmentId={environmentId} />}
    </>
  );
};

/** The walkthrough owns this visit's third tick; the persisted policy uses the shared settings hook. */
const BrowserSites = ({ environmentId }: { readonly environmentId: string }) => {
  const runtime = useRuntime();
  const settings = useSettingsValues(environmentId);
  const id = useId();
  const [typed, setTyped] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [line, say] = useState<string>();
  const writable = runtime.capability(environmentId, "settings.update").status === "present" && settings.values !== null;
  const text = typed ?? (settings.values?.["browser.devSites"] as string[] | undefined)?.join("\n") ?? "";
  const save = async () => {
    setBusy(true);
    const result = await settings.save("browser.devSites", text.split(/\r?\n/).map((host) => host.trim()).filter(Boolean));
    say(result.ok ? "Development sites saved." : `Sites not saved: ${result.line}`);
    if (result.ok) setSaved(true);
    setBusy(false);
  };
  return <section aria-label="Sites you are developing" data-browser-sites className="flex flex-col gap-2 rounded-lg border border-hairline bg-panel p-3 text-xs">
    <BrowserSubstep number={3} label="Sites you are developing" complete={saved} />
    <label htmlFor={id} className="text-2xs text-ink-muted">Sites you are developing</label>
    <textarea id={id} rows={4} title="Sites you are developing · Tab, Enter for a new host" value={text} disabled={!writable || busy}
      onChange={(event) => { setTyped(event.target.value); setSaved(false); }}
      className="min-h-32 w-full rounded-lg border border-hairline-strong bg-inset px-3 py-2.5 font-mono text-xs text-ink focus-visible:border-beam focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-beam/50 disabled:opacity-50" />
    <p className="text-2xs text-ink-muted">One host per line. Optional.</p>
    <p className="text-2xs text-ink-muted">Loopback and private addresses count without being listed.</p>
    <Button variant="outline" title="Save sites · Tab, Enter or Space" className="self-start" disabled={!writable || busy} onClick={() => void save()}><Save aria-hidden="true" />Save sites</Button>
    {line !== undefined && <p role="status">{line}</p>}
  </section>;
};
