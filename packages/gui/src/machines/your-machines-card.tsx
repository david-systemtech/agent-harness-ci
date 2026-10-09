import { drainEnvironment, uuidv7, type EnvironmentView } from "@agent-harness/client-runtime";
import { RELEASE_CHANNELS, type MethodName, type SettingsKey } from "@agent-harness/contracts";
import { ExternalLink, Radio, RefreshCw } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { LimitedGrant } from "../connections/connection-grant.js";
import { useLocalService } from "../connections/local-service.js";
import { nameOf } from "../connections/words.js";
import { useWindowFrame } from "../frame/window-controls.js";
import { useSettingsValues } from "../settings/settings-values.js";
import type { StepCardProps } from "../setup/cards.js";
import { useChecklist } from "../setup/checklist-window.js";
import { MoreOptions } from "../setup/more-options.js";
import { SetupNotice } from "../setup/notice.js";
import { StepStatus } from "../setup/step-status.js";
import { Button, RadioGroup, RadioGroupItem, Select, Tooltip } from "../ui/index.js";
import { CHANNEL_WORDS } from "../updates/update-controls.js";
import { useClientVersion, useClock, useFollowed, useObservable, useRuntime, useShell } from "../window-context.js";
import { AddAMachine } from "./add-a-machine.js";
import { LOOK_COMMANDS, LookEditor } from "./look-editor.js";
import { Part } from "./machine-card.js";
import { PresetPairing } from "./preset-pairing.js";
import { ReachVerdictLine, SetupNetworkSwitches, SwitchRow, type Restart } from "./reachability.js";
import { SetUpOffer } from "./set-up-offer.js";

/**
 * The Your machines step's card (setup-copy.md §5.4; ADR 0025; #576, #1846):
 * where the step stands (`StepStatus`), then the question for the computer
 * Set up checks, whether it is used from other devices too. Settings › Your
 * machines keeps the full card of every machine.
 */
export const YourMachinesCard = ({ environmentId, step }: StepCardProps) => {
  const view = useObservable(useRuntime().projections.environments).find((candidate) => candidate.environmentId === environmentId);
  return (
    <>
      <StepStatus environmentId={environmentId} step={step} />
      {view !== undefined && <ThisComputer key={environmentId} view={view} />}
    </>
  );
};

type Answer = "only" | "also";

const ANSWERS: readonly { readonly value: Answer; readonly words: string }[] = [
  { value: "only", words: "Only on this computer" },
  { value: "also", words: "Also from my other devices" },
];

/**
 * Whether another device is paired with the computer: this app reaching it
 * from elsewhere, or a client session of another computer on its live access
 * list, read where this app may read it (`admin`).
 */
const usePairedElsewhere = (view: EnvironmentView): boolean => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const readable = view.phase === "ready" && runtime.capability(environmentId, "access.sessions.list").status === "present";
  const sessions = useFollowed(useMemo(() => (readable ? runtime.requests.cached(environmentId, "access.sessions.list", { live: true }) : undefined), [runtime, environmentId, readable]));
  const own = useObservable(runtime.connections.list).find((record) => record.environmentId === environmentId)?.clientSessionId;
  if (view.kind === "paired") return true;
  return (sessions?.result?.sessions ?? []).some((session) => !session.local && session.id !== own && session.revokedAt === null);
};

/**
 * The step's question for one computer (setup-copy.md §5.4): `Only on this
 * computer`, chosen at first while nothing else is paired with it, or `Also
 * from my other devices`, under which the reach verdict and Add a device
 * show; a limited pairing in one line; and More options. The answer chooses
 * what the card shows; what the computer binds is More options' switches'.
 */
const ThisComputer = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const pairedElsewhere = usePairedElsewhere(view);
  const [chosen, choose] = useState<Answer | undefined>(undefined);
  const [added, setAdded] = useState<readonly string[]>([]);
  const restart = useRestart(view);
  const environments = useObservable(runtime.projections.environments);
  const answer = chosen ?? (pairedElsewhere ? "also" : "only");
  const admits = (method: MethodName) => view.phase === "ready" && runtime.capability(view.environmentId, method).status === "present";
  const addedViews = environments.filter((candidate) => added.includes(candidate.environmentId));
  return (
    <div data-this-computer className="flex min-w-0 flex-col gap-3.5">
      <LimitedGrant view={view} />
      <RadioGroup aria-label="Use agent-harness from other devices?" value={answer} onValueChange={(next) => (next === "only" || next === "also") && choose(next)} className="gap-0.5 rounded-lg border border-hairline bg-panel p-1.5">
        {ANSWERS.map(({ value, words }) => (
          <label key={value} className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-ink hover:bg-wash ${answer === value ? "bg-wash-strong" : ""}`}>
            <Tooltip content={words} keys="Arrow keys, Space"><RadioGroupItem value={value} aria-label={words} /></Tooltip>
            {words}
          </label>
        ))}
      </RadioGroup>
      {answer === "also" && (
        <>
          <ReachVerdictLine view={view} restart={restart} />
          <Part title="Add a device">
            <PresetPairing view={view} writable={admits("access.pairings.create")} />
          </Part>
          {addedViews.map((other) => (
            <SetUpOffer key={other.environmentId} view={other} decline={() => setAdded((now) => now.filter((id) => id !== other.environmentId))} />
          ))}
          <AddAMachine added={(environmentId) => setAdded((now) => (now.includes(environmentId) ? now : [...now, environmentId]))} />
        </>
      )}
      <MoreOptions step="your-machines">
        <LookEditor view={view} writable={LOOK_COMMANDS.every(admits)} />
        <SetupNetworkSwitches view={view} writable={admits("settings.update")} />
        <UpdateChoices view={view} writable={admits("updates.settings.set")} />
        <AllSettings view={view} />
      </MoreOptions>
    </div>
  );
};

/** `Update automatically` (`updates.autoUpdate`) and the channel, each written through the settings' writer (setup-copy.md §5.4). */
const UpdateChoices = ({ view, writable }: { readonly view: EnvironmentView; readonly writable: boolean }) => {
  const settings = useSettingsValues(view.environmentId);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const channel = useId();
  const values = settings.values;
  if (values === null) return null;
  const save = (key: SettingsKey, value: unknown) => {
    setRefused(undefined);
    void settings.save(key, value).then((saved) => !saved.ok && setRefused(saved.line));
  };
  return (
    <div className="flex flex-col gap-2 text-sm">
      <SwitchRow icon={RefreshCw} words="Update automatically" title="Update automatically (Space)" checked={values["updates.autoUpdate"] === true} disabled={!writable} onCheckedChange={(on) => save("updates.autoUpdate", on)} />
      <span className="flex flex-wrap items-center gap-2">
        <label htmlFor={channel} className="flex items-center gap-2 text-xs text-ink-muted"><Radio aria-hidden="true" className="size-4 shrink-0" />Channel</label>
        <Select id={channel} title="Channel (Arrow keys)" value={String(values["updates.channel"])} disabled={!writable} onChange={(event) => save("updates.channel", event.target.value)}>
          {RELEASE_CHANNELS.map((choice) => (
            <option key={choice} value={choice}>{CHANNEL_WORDS[choice]}</option>
          ))}
        </Select>
      </span>
      {refused !== undefined && <p role="alert" className="text-signal"><span className="sr-only">Error: </span>{refused}</p>}
    </div>
  );
};

/** All settings for this computer: Settings › Your machines on it, which leaves Set up (setup-copy.md §3, §5.4). */
const AllSettings = ({ view }: { readonly view: EnvironmentView }) => {
  const checklist = useChecklist();
  const hint = useId();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button aria-describedby={hint} onClick={() => checklist.leave("environments.machines", view.environmentId)} title="All settings for this computer (Enter or Space)">
        <ExternalLink aria-hidden="true" data-icon="inline-start" />All settings for this computer
      </Button>
      <span id={hint} className="text-xs text-ink-muted">Leaves Set up</span>
    </div>
  );
};

/** Where a restart from this app stands: the drain asked, then the start once the service stopped. */
type RestartProgress = "idle" | "draining" | "starting";

/** What stopped a restart: the drain, refused while the computer still runs, or the start once it had stopped. */
interface RestartRefusal {
  readonly step: "drain" | "start";
  readonly text: string;
}

/**
 * Restart agent-harness (setup-copy.md §5.4), where the computer's service
 * can restart from this app: this computer's own, with a shell that starts
 * its service, and `environment.drain` admitted. It drains the environment,
 * which stops once its running work finishes, then starts the service as
 * Start does once nothing answers, and reads how it is reached again at its
 * start. Undefined for any other computer, whose next start uses what it found.
 */
const useRestart = (view: EnvironmentView): Restart | undefined => {
  const runtime = useRuntime();
  const clock = useClock();
  const service = useLocalService();
  const shell = useShell();
  const version = useClientVersion();
  const frame = useWindowFrame();
  const [progress, setProgress] = useState<RestartProgress>("idle");
  const [refusal, setRefusal] = useState<RestartRefusal | undefined>(undefined);
  const { environmentId, phase } = view;
  const name = nameOf(view);
  useEffect(() => {
    if (progress === "draining" && phase === "service-down") {
      setProgress("starting");
      service.start(environmentId);
    }
    if (progress === "starting" && phase === "ready") {
      setProgress("idle");
      runtime.requests.refresh(environmentId, "environment.status", {});
    }
  }, [progress, phase, environmentId, service, runtime]);
  // The start clears the last failure as it sets starting, in the render that sets starting here, so a failure
  // once it is no longer starting is this start's, however soon it fails.
  useEffect(() => {
    if (progress === "starting" && !service.starting && service.failure !== undefined) {
      setProgress("idle");
      setRefusal({ step: "start", text: service.failure.text });
    }
  }, [progress, service.starting, service.failure]);
  // A failed start is over once the computer runs again, however it was started.
  useEffect(() => {
    if (phase === "ready") setRefusal((last) => (last?.step === "start" ? undefined : last));
  }, [phase]);
  const can = view.kind === "local" && service.available.status === "present" && runtime.capability(environmentId, "environment.drain").status === "present";
  // A restart under way, or its refusal, outlasts the drain that makes the computer stop answering.
  if (!can && progress === "idle" && refusal === undefined) return undefined;
  const start = () => {
    setRefusal(undefined);
    setProgress("draining");
    void drainEnvironment(runtime, environmentId, name, uuidv7(clock.now())).then((outcome) => {
      if (outcome.ok) return;
      setProgress("idle");
      setRefusal({ step: "drain", text: outcome.line });
    });
  };
  const title = `agent-harness did not restart on ${name}.`;
  // Stopped and not started again, nothing answers to drain: Start, which the checklist offers then, starts it.
  const retry = refusal?.step === "start" ? "Choose Start to try again." : "Choose Restart agent-harness to try again.";
  const failure = refusal === undefined ? undefined : (
    <SetupNotice
      tone="error"
      title={title}
      description={retry}
      details={{
        report: { app: { version, platform: frame?.platform ?? "unknown" }, computer: { name }, line: `${title} ${retry}`, details: [refusal.text] },
        copy: (text) => (shell?.clipboard === undefined ? Promise.reject(new Error("This app has no clipboard.")) : shell.clipboard.writeText(text)),
      }}
    />
  );
  return { restarting: progress !== "idle", start, failure };
};
