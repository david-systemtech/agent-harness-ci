import { CredentialNoticeHost } from "../notices/credential-notice.js";
import { blockWords, LOCAL_PLACEHOLDER_ID, type EnvironmentView, type ServiceFailureKind } from "@agent-harness/client-runtime";
import { ArrowRight, Check, CircleAlert, KeyRound, Link, LoaderCircle, LogOut, Monitor, Power, RotateCw, SlidersHorizontal, Sparkles } from "lucide-react";
import { useId } from "react";
import { useLocalService, type LocalService } from "../connections/local-service.js";
import { useOpenPairing } from "../connections/pairing.js";
import { Remedy } from "../connections/remedy.js";
import { RunHereSwitch } from "../connections/run-here.js";
import { nameOf, phaseSentence } from "../connections/words.js";
import { nativeFrame, useWindowFrame, WindowControls } from "../frame/window-controls.js";
import { Button, Tooltip } from "../ui/index.js";
import { useClientVersion, useClock, useObservable, usePresentation, useRuntime, useShell } from "../window-context.js";
import { TechnicalDetails } from "./details.js";

/**
 * This computer's service as the introduction says it (setup-copy.md §4.1):
 * `waiting` is a drain or an update the runtime knows of, or macOS's prompt
 * for the stored key, said in the connection's own sentence; `blocked` is a
 * block or a disabled connection, said in the block's plain line.
 */
type ServiceState = "ready" | "installing" | "starting" | "failed" | "off" | "unavailable" | "stopped" | "reconnecting" | "halting" | "waiting" | "blocked";

const WORDS: { readonly [State in Exclude<ServiceState, "failed" | "waiting" | "blocked">]: readonly [status: string, description: string] } = {
  ready: ["agent-harness is ready on this computer.", "Choose Begin set up."],
  installing: ["Installing agent-harness on this computer…", "This happens once and takes about a minute."],
  starting: ["Starting agent-harness on this computer…", "This takes a few seconds."],
  off: ["agent-harness is turned off on this computer.", "Turn it on to run agents here, or connect to another computer."],
  unavailable: ["This app cannot run agent-harness itself.", "Connect it to a computer that runs agent-harness."],
  stopped: ["agent-harness is not running on this computer.", "Choose Start."],
  reconnecting: ["Reconnecting to agent-harness on this computer…", "This happens by itself."],
  halting: ["agent-harness is stopping on this computer…", "Choose Start once it has stopped."],
};

const FAILED = "agent-harness cannot start on this computer.";

const FAILURE_WORDS: { readonly [Kind in ServiceFailureKind]: string } = {
  "no-artefact": "This copy of the app is missing a part. Reinstall agent-harness.",
  unrunnable: "This copy of the app has a part that will not run. Reinstall agent-harness.",
  install: "Installing the background service did not work. Choose Try again.",
  start: "The background service did not start. Choose Try again.",
  "no-answer": "The background service started but did not answer. Choose Try again.",
  status: "agent-harness could not check the background service. Choose Try again.",
};

/** A failure another start cannot mend: the app's own copy needs installing again. */
const reinstall = (kind: ServiceFailureKind): boolean => kind === "no-artefact" || kind === "unrunnable";

const stateOf = (local: EnvironmentView | undefined, service: LocalService, runHere: boolean): ServiceState => {
  if (local?.phase === "ready") return "ready";
  if (service.installing) return "installing";
  if (service.starting) return "starting";
  if (service.failure !== undefined) return "failed";
  if (!runHere) return "off";
  if (service.available.status !== "present") return "unavailable";
  if (local === undefined) return "starting";
  if (local.credentialPrompt !== undefined) return "waiting";
  switch (local.phase) {
    case "service-down":
      return "stopped";
    case "starting":
    case "syncing":
      return "starting";
    case "connecting":
      return local.unreachableSince === null ? "starting" : "reconnecting";
    case "backoff":
      return "reconnecting";
    case "draining":
    case "updating":
      return local.update === undefined ? "halting" : "waiting";
    case "blocked":
    case "disabled":
      return "blocked";
  }
};

const BUSY: ReadonlySet<ServiceState> = new Set(["installing", "starting", "reconnecting", "halting", "waiting"]);

/** First-run introduction (look.md §13.1), kept visible throughout local startup and retries. */
export const Introduction = ({ home, onBegin, onLater }: {
  readonly home: EnvironmentView | undefined;
  readonly onBegin: () => void;
  readonly onLater: () => void;
}) => {
  const clock = useClock();
  const heading = useId();
  const unavailableLine = useId();
  const service = useLocalService();
  const openPairing = useOpenPairing();
  const shell = useShell();
  const version = useClientVersion();
  const views = useObservable(useRuntime().projections.environments);
  const local = views.find((view) => view.kind === "local");
  const [runHere] = usePresentation("runLocalEnvironment");
  const frame = useWindowFrame();
  const ready = home?.phase === "ready";
  const state = stateOf(local, service, runHere);
  const failure = state === "failed" ? service.failure : undefined;
  const [status, description] = failure !== undefined ? [FAILED, FAILURE_WORDS[failure.kind]]
    : state === "waiting" ? [phaseSentence(local!, false, false, clock.now()), undefined]
    : state === "blocked" ? [blockWords({ ...local!, name: null }), undefined]
    : WORDS[state as keyof typeof WORDS];
  const StateIcon = state === "ready" ? Check : failure !== undefined ? CircleAlert : BUSY.has(state) ? LoaderCircle : Monitor;
  const start = () => service.start(local?.environmentId ?? LOCAL_PLACEHOLDER_ID);
  return <section aria-labelledby={heading} className="flex h-dvh min-h-0 flex-col overflow-hidden bg-abyss text-ink">
    <header data-setup-frame {...nativeFrame(frame)} className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline bg-panel px-4">
      <Sparkles aria-hidden="true" className="size-4 text-beam-text" /><span className="min-w-0 flex-1 truncate text-sm font-semibold">agent-harness</span>
      <WindowControls state={frame} />
    </header>
    <CredentialNoticeHost />
    <div className="flex min-h-0 flex-1 overflow-y-auto p-[7px]">
      <div data-setup-introduction className="m-auto flex w-[720px] max-w-full flex-col gap-6 rounded-lg border border-hairline bg-panel p-7">
        <div className="flex flex-col gap-3">
          <div data-setup-tile className="flex size-11 items-center justify-center rounded-lg bg-beam text-beam-ink"><Sparkles aria-hidden="true" className="size-6" /></div>
          <h1 id={heading} className="text-[1.75rem] leading-9 font-semibold tracking-[-0.025em]">Welcome to agent-harness</h1>
          <p className="max-w-[60ch] text-lg leading-6">A place to work with coding agents.</p>
          <p className="max-w-[60ch] text-sm leading-6 text-ink-muted">Give an agent a task, follow its work, and keep the conversation with your project. agent-harness brings your accounts, sessions and tools into one window, on this machine or across your machines.</p>
        </div>
        <div className="grid gap-2.5 sm:grid-cols-2">
          <div className="flex flex-col gap-3 rounded-lg border border-hairline bg-raised p-[18px]">
            <KeyRound aria-hidden="true" className="size-5 text-beam-text" />
            <h2 className="text-sm font-semibold">First, connect your account</h2>
            <p className="text-sm text-ink-muted">Your agent needs a signed-in coding account to start a session. We will help you connect it.</p>
            <span className="mt-auto self-start rounded-full bg-wash px-2 py-0.5 text-xs text-beam-text">Required to start</span>
          </div>
          <div className="flex flex-col gap-3 rounded-lg border border-hairline bg-raised p-[18px]">
            <SlidersHorizontal aria-hidden="true" className="size-5 text-ink-muted" />
            <h2 className="text-sm font-semibold">Then, make it yours</h2>
            <p className="text-sm text-ink-muted">Bring over past work, connect tools and choose how agents work. Every step after Account is optional.</p>
            <span className="mt-auto self-start rounded-full bg-wash px-2 py-0.5 text-xs text-ink-muted">Skip now, return in Settings</span>
          </div>
        </div>
        <p className="text-sm text-ink-muted">Set up takes about 5 minutes. Have your Claude login ready.</p>
        <div data-setup-service className="flex items-start gap-3 rounded-lg border border-hairline bg-inset p-4">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-raised"><StateIcon aria-hidden="true" className={state === "ready" ? "size-4 text-mint" : failure !== undefined ? "size-4 text-amber" : BUSY.has(state) ? "size-4 animate-spin text-cyan" : "size-4 text-ink-muted"} /></div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {failure !== undefined
              ? <p role="alert" className="text-sm font-medium text-signal"><span className="sr-only">Error: </span>{status}</p>
              : <p role="status" className="text-sm font-medium">{status}</p>}
            {description !== undefined && <p className="text-sm text-ink-muted">{description}</p>}
            {!runHere && <RunHereSwitch />}
            {failure !== undefined && !reinstall(failure.kind) && runHere && service.available.status === "present" && <Tooltip content="Try again" keys="Tab, Enter"><Button variant="outline" className="self-start" onClick={start}><RotateCw aria-hidden="true" />Try again</Button></Tooltip>}
            {state === "stopped" && <Tooltip content="Start" keys="Tab, Enter"><Button variant="outline" className="self-start" onClick={start}><Power aria-hidden="true" />Start</Button></Tooltip>}
            {state === "blocked" && <div className="self-start"><Remedy view={local!} /></div>}
            {failure !== undefined && <TechnicalDetails
              report={{ app: { version, platform: frame?.platform ?? "unknown" }, ...(local?.name != null && { computer: { name: local.name } }), line: FAILURE_WORDS[failure.kind], details: [failure.text] }}
              copy={(text) => shell?.clipboard === undefined ? Promise.reject(new Error("This app has no clipboard.")) : shell.clipboard.writeText(text)}
            />}
            {home?.phase === "ready" && state !== "ready" && <p className="text-sm text-mint">{nameOf(home)} is ready. Choose Begin set up.</p>}
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Tooltip content="Begin set up" keys={ready ? "Tab, Enter" : "Tab"}><span tabIndex={ready ? undefined : 0}><Button data-setup-begin variant="default" disabled={!ready} aria-describedby={ready ? undefined : unavailableLine} onClick={onBegin}><ArrowRight aria-hidden="true" />Begin set up</Button></span></Tooltip>
            <Tooltip content="I’ll set up later" keys="Tab, Enter"><Button variant="outline" onClick={onLater}><LogOut aria-hidden="true" />I’ll set up later</Button></Tooltip>
            <Tooltip content="Connect to another computer" keys="Tab, Enter"><Button onClick={() => openPairing()}><Link aria-hidden="true" />Connect to another computer</Button></Tooltip>
          </div>
          {!ready && <p id={unavailableLine} className="text-xs text-ink-muted">Available once agent-harness is ready.</p>}
          <p className="text-xs text-ink-muted">Only Account is required. The rest can wait until you need it.</p>
        </div>
      </div>
    </div>
  </section>;
};
