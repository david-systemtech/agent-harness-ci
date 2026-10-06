import { CredentialNoticeHost } from "../notices/credential-notice.js";
import { LOCAL_PLACEHOLDER_ID, type EnvironmentView } from "@agent-harness/client-runtime";
import { ArrowRight, Check, CircleAlert, KeyRound, Link, LoaderCircle, LogOut, Monitor, RotateCw, SlidersHorizontal, Sparkles } from "lucide-react";
import { useId, useState } from "react";
import { useLocalService } from "../connections/local-service.js";
import { useOpenPairing } from "../connections/pairing.js";
import { RunHereSwitch } from "../connections/run-here.js";
import { phaseSentence } from "../connections/words.js";
import { nativeFrame, useWindowFrame, WindowControls } from "../frame/window-controls.js";
import { Button, Fold, Tooltip } from "../ui/index.js";
import { useClock, useObservable, usePresentation, useRuntime } from "../window-context.js";

/** First-run introduction (look.md §13.1), kept visible throughout local startup and retries. */
export const Introduction = ({ home, onBegin, onLater }: {
  readonly home: EnvironmentView | undefined;
  readonly onBegin: () => void;
  readonly onLater: () => void;
}) => {
  const clock = useClock();
  const heading = useId();
  const service = useLocalService();
  const openPairing = useOpenPairing();
  const views = useObservable(useRuntime().projections.environments);
  const local = views.find((view) => view.kind === "local");
  const [runHere] = usePresentation("runLocalEnvironment");
  const [details, showDetails] = useState(false);
  const frame = useWindowFrame();
  const ready = home?.phase === "ready";
  const localReady = local?.phase === "ready";
  const failed = !localReady && !service.starting && service.failure !== undefined;
  const off = !runHere && !localReady;
  const unavailable = service.available.status !== "present" && !localReady;
  const stopped = !localReady && !service.starting && local?.phase === "service-down";
  const starting = !localReady && !failed && !off && !unavailable && (service.starting || local === undefined || ["starting", "connecting", "syncing", "draining", "updating"].includes(local.phase));
  const StateIcon = localReady ? Check : failed ? CircleAlert : starting ? LoaderCircle : Monitor;
  const status = localReady ? "The environment on this machine is ready" : failed ? "The environment could not start on this machine." : off ? "This machine’s environment is turned off" : unavailable ? "This machine cannot start an environment" : stopped ? "The environment on this machine is not running" : local === undefined || service.starting || local.phase === "starting" ? "Starting the environment on this machine" : phaseSentence(local, false, false, clock.now());
  const description = localReady ? "You can sign in and start a session here." : failed ? "Try again to get this machine ready for your first session." : off ? "Turn on this machine’s environment to run sessions here, or use another machine’s environment." : unavailable ? "You can pair with an environment on another machine." : stopped ? "Start it again to get this machine ready for your first session." : starting ? "This background service runs your agents and keeps your sessions available. This usually takes a few seconds." : "You can pair with another environment or set up later.";
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
        <div data-setup-service className="flex items-start gap-3 rounded-lg border border-hairline bg-inset p-4">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-raised"><StateIcon aria-hidden="true" className={localReady ? "size-4 text-mint" : failed ? "size-4 text-amber" : starting ? "size-4 animate-spin text-cyan" : "size-4 text-ink-muted"} /></div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <p role="status" className="text-sm font-medium">{status}</p>
            <p className="text-sm text-ink-muted">{description}</p>
            {service.installing && <p className="text-xs text-ink-muted">Installing the environment (first start only)…</p>}
            {!runHere && <RunHereSwitch />}
            {service.available.status !== "present" && <p className="text-xs text-ink-muted">{service.available.reason}</p>}
            {failed && <Tooltip content="Start details" keys="Tab, Enter"><div><Fold summary="Start details" open={details} onOpenChange={showDetails}><p className="break-words text-xs text-ink-muted">{service.failure}</p></Fold></div></Tooltip>}
            {(failed || stopped) && runHere && service.available.status === "present" && <Tooltip content="Try again" keys="Tab, Enter"><Button variant="outline" className="self-start" disabled={service.starting || service.available.status !== "present"} onClick={() => service.start(local?.environmentId ?? LOCAL_PLACEHOLDER_ID)}><RotateCw aria-hidden="true" />Try again</Button></Tooltip>}
            {ready && !localReady && <p className="text-sm text-mint">Your home environment is ready. You can begin set up.</p>}
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Tooltip content={ready ? "Begin set up" : "Waiting for this machine · Begin set up becomes available when an environment is ready"} keys={ready ? "Tab, Enter" : "Tab"}><span tabIndex={ready ? undefined : 0}><Button data-setup-begin variant="default" disabled={!ready} onClick={onBegin}>{ready ? <ArrowRight aria-hidden="true" /> : <Monitor aria-hidden="true" />}{ready ? "Begin set up" : "Waiting for this machine…"}</Button></span></Tooltip>
            <Tooltip content="I’ll set up later" keys="Tab, Enter"><Button variant="outline" onClick={onLater}><LogOut aria-hidden="true" />I’ll set up later</Button></Tooltip>
            <Tooltip content="Pair instead" keys="Tab, Enter"><Button onClick={() => openPairing()}><Link aria-hidden="true" />Pair instead</Button></Tooltip>
          </div>
          <p className="text-xs text-ink-muted">Only Account is required. The rest can wait until you need it.</p>
        </div>
      </div>
    </div>
  </section>;
};
