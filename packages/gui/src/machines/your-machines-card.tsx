import type { EnvironmentView } from "@agent-harness/client-runtime";
import { RELEASE_CHANNELS, type MethodName, type SettingsKey } from "@agent-harness/contracts";
import { ExternalLink, Radio, RefreshCw } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { LimitedGrant } from "../connections/connection-grant.js";
import { useServiceRestart } from "../connections/service-restart.js";
import { useSettingsValues } from "../settings/settings-values.js";
import type { StepCardProps } from "../setup/cards.js";
import { useChecklist } from "../setup/checklist-window.js";
import { MoreOptions } from "../setup/more-options.js";
import { StepStatus } from "../setup/step-status.js";
import { Button, RadioGroup, RadioGroupItem, Select, Tooltip } from "../ui/index.js";
import { CHANNEL_WORDS } from "../updates/update-controls.js";
import { useFollowed, useObservable, useRuntime } from "../window-context.js";
import { AddAMachine } from "./add-a-machine.js";
import { LOOK_COMMANDS, LookEditor } from "./look-editor.js";
import { Part } from "./machine-card.js";
import { PresetPairing } from "./preset-pairing.js";
import { ReachVerdictLine, SetupNetworkSwitches, SwitchRow } from "./reachability.js";
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
  const restart = useServiceRestart(view);
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
