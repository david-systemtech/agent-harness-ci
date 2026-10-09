import { adminCall, plainRefusal, uuidv7, LOCAL_PLACEHOLDER_ID } from "@agent-harness/client-runtime";
import type { BrowserStatus, PairedChrome } from "@agent-harness/contracts";
import { Plus, Save, Unplug } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { BrowserSubstep } from "./setup-substep.js";
import { BrowserDone } from "./done.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { MoreOptions } from "../setup/more-options.js";
import { Button } from "../ui/index.js";
import { BrowserPairingCode, BrowserProblem, CopyText, useBrowserDetails } from "./pairing-code.js";
import type { StepCardProps } from "../setup/cards.js";
import { StepStatus } from "../setup/step-status.js";
import { useClock, useFollowed, useObservable, useRuntime, useShell } from "../window-context.js";

/** The Browser card's lines (setup-copy.md §5.11). */
const DESKTOP_ONLY = "Connecting Chrome works only in the desktop app.";
const NOT_RUNNING = "agent-harness is not running on this computer, so Chrome cannot connect to it.";
const PORTS_BUSY = "Chrome cannot reach agent-harness because the ports it needs are busy. Close other apps, then restart agent-harness.";
const NOT_LISTENING = "Chrome cannot reach agent-harness. Restart agent-harness.";
const FILES_MISSING = "The extension's files are missing from this install. Reinstall agent-harness.";
const EXTENSIONS_PAGE = "chrome://extensions";
const COPY_EXTENSIONS_PAGE = `Copy ${EXTENSIONS_PAGE}`;

/** The step's sentences, numbered as the card shows them. */
const STEPS = {
  folder: "Copy this folder location.",
  page: `In Chrome, open ${EXTENSIONS_PAGE}.`,
  developer: "Turn on Developer mode, at the top of that page.",
  load: "Choose Load unpacked, paste the folder location and confirm.",
  code: "Choose the agent-harness extension's icon, then Options, and type this code:",
  sites: "Sites you are building",
} as const;

/** What the listener's state means for a person, and its raw words for Details. */
const listenerLines = (listener: BrowserStatus["listener"]): readonly string[] =>
  listener.state === "listening" ? [`Listening on 127.0.0.1:${listener.port}`] : [`Not listening (${listener.reason}): ${listener.message}`];

/**
 * The Browser card (ADR 0024; setup-copy.md §5.11) pairs Chrome with
 * agent-harness on this computer: six numbered steps that tick themselves,
 * Use my Chrome for agents, and in More options each paired Chrome's Unpair
 * and Pair another. The card draws the step's own verbs itself: Reload as
 * Copy chrome://extensions beside the out-of-date line, and never Unpair
 * as the fix for a closed Chrome. The listening address is in Details.
 */
export const BrowserCard = (props: StepCardProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const shell = useShell();
  const [another, pairAnother] = useState<number | null>(null);
  const [said, say] = useState<{ readonly line: string; readonly details?: readonly string[] } | null>(null);
  const local = useObservable(runtime.projections.environments).find((view) => view.kind === "local" && view.environmentId !== LOCAL_PLACEHOLDER_ID);
  const localId = local?.environmentId;
  // The step's Details add the extension's folder and listening address, read only from agent-harness on this computer.
  const status = useFollowed(useMemo(() => localId === undefined ? undefined : runtime.requests.cached(localId, "browser.status", {}), [runtime, localId]))?.result ?? null;
  const facts = status === null ? [] : [`Extension folder: ${status.folder.path}`, ...listenerLines(status.listener), `Extension shipped: ${status.shippedVersion ?? "none"}`];
  const listed = useObservable(useMemo(() => runtime.requests.cached(props.environmentId, "browser.chromes.list", {}), [runtime, props.environmentId]));
  const chromes = listed.result?.chromes ?? [];
  const details = useBrowserDetails(props.environmentId);
  const unpairable = runtime.capability(props.environmentId, "browser.chromes.unpair").status === "present";
  const pairing = local === undefined ? undefined : runtime.capability(local.environmentId, "browser.pairing.code");
  const pairable = pairing?.status === "present";
  const unpair = async (chrome: PairedChrome) => {
    const answer = await adminCall(() => runtime.requests.call(props.environmentId, "browser.chromes.unpair", { commandId: uuidv7(clock.now()), chromeId: chrome.id }));
    if (!answer.ok) return say(plainRefusal(answer.refusal, "Unpair"));
    say({ line: `Unpaired ${chrome.name}.` });
    runtime.requests.refresh(props.environmentId, "browser.chromes.list", {});
  };
  const admin = runtime.capability(props.environmentId, "settings.update");
  const { result } = props.step;
  return (
    <div className="flex min-w-0 flex-col gap-3.5 text-xs">
      <StepStatus {...props} handledActions={["unpair", "pair-another", "reload"]} facts={facts} />
      {/* Why pairing, the sites and Use my Chrome for agents are held on a limited connection, said once for all of them. */}
      {admin.status === "absent" && <p className="text-ink-muted">{admin.message}</p>}
      {result?.actions.includes("reload") && <CopyText text={EXTENSIONS_PAGE} words={COPY_EXTENSIONS_PAGE} />}
      {local === undefined ? (
        <p>{shell === undefined ? DESKTOP_ONLY : NOT_RUNNING}</p>
      ) : (
        <BrowserPairing key={local.environmentId} another={another} environmentId={local.environmentId} accountsEnvironmentId={props.environmentId} />
      )}
      <MoreOptions step="browser">
        {chromes.map((chrome) => (
          <div key={chrome.id} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1">{chrome.name}</span>
            <Button variant="outline" aria-label={`Unpair ${chrome.name}`} disabled={!unpairable} onClick={() => void unpair(chrome)}><Unplug aria-hidden="true" />Unpair</Button>
          </div>
        ))}
        <Button variant="outline" className="self-start" disabled={!pairable} onClick={() => pairAnother((n) => (n ?? -1) + 1)}><Plus aria-hidden="true" />Pair another</Button>
        {said !== null && (said.details === undefined ? <p role="status">{said.line}</p> : <BrowserProblem line={said.line} details={details(said.line, said.details)} />)}
      </MoreOptions>
    </div>
  );
};

/**
 * The numbered steps (setup-copy.md §5.11), shared with Settings' Pair another
 * Chrome: 1 and 2 tick on their Copy, and 1 to 4 once Chrome found the
 * extension, which shows step 5; its code is minted only then, and only while
 * no Chrome is paired or a new pairing was asked for (`another`, null for
 * none), and 5 ticks once the pairing it waits for is made. 6, the sites, ticks
 * on this visit's save. A pairing asked for waits for its own Chrome: a Chrome
 * already paired ticks nothing, an unpaired extension seen since the ask does,
 * and the ticks stay once that extension pairs. `again` names the button that
 * asks for another pairing, for a code that could not be made.
 */
export const BrowserPairing = ({ environmentId, accountsEnvironmentId, another, again = "Pair another", showSites = true }: { readonly environmentId: string; readonly accountsEnvironmentId: string; readonly another: number | null; readonly again?: string; readonly showSites?: boolean }) => {
  const runtime = useRuntime();
  const details = useBrowserDetails(environmentId);
  const status = useObservable(useMemo(() => runtime.requests.cached(environmentId, "browser.status", {}), [runtime, environmentId]));
  const listed = useObservable(useMemo(() => runtime.requests.cached(environmentId, "browser.chromes.list", {}), [runtime, environmentId]));
  const [copiedFolder, copyFolder] = useState(false);
  const [copiedPage, copyPage] = useState(false);
  const chromes = listed.result?.chromes ?? [];
  const seen = status.result?.unpairedConnected ?? false;
  const [found, setFound] = useState({ another, seen });
  if (found.another !== another || (seen && !found.seen)) setFound({ another, seen });
  const loaded = seen || (another === null ? chromes.length > 0 : found.another === another && found.seen);
  const folder = status.result?.folder;
  const listener = status.result?.listener;
  const problem = (line: string, raw: readonly string[]) => <BrowserProblem line={line} details={details(line, raw)} />;
  const refusal = (refused: Parameters<typeof plainRefusal>[0]) => {
    const plain = plainRefusal(refused, "Check again");
    return problem(plain.line, plain.details);
  };
  return (
    <div className="flex min-w-0 flex-col gap-3.5 text-xs">
      <ol aria-label="Connect Chrome" className="flex flex-col gap-3.5 rounded-lg border border-hairline bg-panel p-3">
        <BrowserSubstep number={1} label={STEPS.folder} complete={loaded || copiedFolder}>
          {folder !== undefined && <div className="flex items-start gap-2">
            <pre className="min-w-0 flex-1 bg-inset p-2 font-mono text-xs break-all whitespace-pre-wrap select-all">{folder.path}</pre>
            <CopyText text={folder.path} label="Copy folder location" copied={() => copyFolder(true)} />
          </div>}
          {folder?.problem != null && problem(FILES_MISSING, [folder.problem])}
          {status.error !== null && refusal(status.error)}
        </BrowserSubstep>
        <BrowserSubstep number={2} label={STEPS.page} complete={loaded || copiedPage}>
          <div><CopyText text={EXTENSIONS_PAGE} words={COPY_EXTENSIONS_PAGE} copied={() => copyPage(true)} /></div>
          <p>Paste it in the address bar and press Enter.</p>
        </BrowserSubstep>
        <BrowserSubstep number={3} label={STEPS.developer} complete={loaded} />
        <BrowserSubstep number={4} label={STEPS.load} complete={loaded}>
          {loaded && <p>Chrome found the extension.</p>}
          {listener?.state === "not-listening" && problem(listener.reason === "port-in-use" ? PORTS_BUSY : NOT_LISTENING, listenerLines(listener))}
        </BrowserSubstep>
        {loaded && listed.result !== null && <Pair key={another ?? -1} environmentId={environmentId} chromes={chromes} asked={another !== null} again={again} />}
        {listed.error !== null && refusal(listed.error)}
        {showSites && <BrowserSites environmentId={environmentId} />}
      </ol>
      <BrowserDone environmentId={accountsEnvironmentId} chromeEnvironmentId={environmentId} chromes={chromes} />
    </div>
  );
};

/** Step 5: a code while it waits for a pairing, the first or one asked for; each Pair another starts a fresh wait. */
const Pair = ({ environmentId, chromes, asked, again }: { readonly environmentId: string; readonly chromes: readonly PairedChrome[]; readonly asked: boolean; readonly again: string }) => {
  const [before] = useState(() => new Set(chromes.map((chrome) => chrome.id)));
  const completed = chromes.some((chrome) => !before.has(chrome.id));
  const waiting = (asked || chromes.length === 0) && !completed;
  return <BrowserSubstep number={5} label={STEPS.code} complete={!waiting}>
    {waiting && <BrowserPairingCode environmentId={environmentId} again={again} />}
  </BrowserSubstep>;
};

/** Step 6: the sites typed this visit, else the saved ones; it ticks on this visit's save. */
const BrowserSites = ({ environmentId }: { readonly environmentId: string }) => {
  const runtime = useRuntime();
  const settings = useSettingsValues(environmentId);
  const id = useId();
  const hint = useId();
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
  return <BrowserSubstep number={6} label={STEPS.sites} aside="Optional" complete={saved}>
    <label htmlFor={id} className="sr-only">{STEPS.sites}</label>
    <textarea id={id} rows={4} aria-describedby={hint} value={text} disabled={!writable || busy}
      onChange={(event) => { setTyped(event.target.value); setSaved(false); }}
      className="min-h-32 w-full rounded-lg border border-hairline-strong bg-inset px-3 py-2.5 font-mono text-xs text-ink focus-visible:border-beam focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-beam/50 disabled:opacity-50" />
    <p id={hint} className="text-2xs text-ink-muted">One site per line, like localhost:3000. Agents may run scripts on these sites.</p>
    <Button variant="outline" className="self-start" disabled={!writable || busy} onClick={() => void save()}><Save aria-hidden="true" />Save sites</Button>
    {line !== undefined && <p role="status">{line}</p>}
  </BrowserSubstep>;
};
