import { oneLine, outcomeWords, pullSetupSources } from "@agent-harness/client-runtime";
import { CATALOGUE, catalogueTickStates, SKILL_SOURCE_LIMIT, type CatalogueSkillEntry, type CatalogueTickState } from "@agent-harness/contracts";
import { TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import type { StepCardProps } from "../setup/cards.js";
import { StepStatus } from "../setup/step-status.js";
import { Button, Dialog, DialogContent } from "../ui/index.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";
import { reachWords } from "../settings/generic-editor.js";
import { MemberCard } from "./members.js";
import { SkillButton, useSkillVerb } from "./skill-verb.js";
import { AddSource, SourceCard } from "./sources.js";
import { TrustedRepositories } from "./trust.js";

/**
 * The Skills step (Set up specification, "7. Skills"; ADR 0029; #591):
 * honest catalogue cards, ticked only by the sources skills.get holds
 * (#508), followed by the home row's source, account-choice and trust
 * controls (#517). The catalogue ships with this client build; every
 * environment fact stays in the runtime cache, refreshed on skills.updated.
 */
export const SkillsCard = ({ environmentId, step }: StepCardProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const view = useObservable(runtime.projections.environments).find((view) => view.environmentId === environmentId);
  const read = useObservable(useMemo(() => runtime.requests.cached(environmentId, "skills.get", {}), [runtime, environmentId]));
  const [line, setLine] = useState<string | undefined>(undefined);
  const say = (message: string) => setLine(oneLine(message));
  const [pulling, setPulling] = useState(false);
  const skills = read.result;
  const ticks = catalogueTickStates(CATALOGUE.skills, skills?.sources ?? []);
  const pull = runtime.capability(environmentId, "skills.sources.pull");
  const namedPull = step.result?.targets?.some((target) => target.action === "pull-now" && target.kind === "skill-source") ?? false;
  return (
    <>
      <StepStatus
        environmentId={environmentId}
        step={step}
        actions={namedPull ? undefined : {
          "pull-now": {
            disabled: pulling || skills === null || read.error !== null || pull.status === "absent",
            run: () => {
              const sources = (skills?.sources ?? []).filter((source) => source.follow.kind === "branch");
              void (async () => {
                setPulling(true);
                try {
                  const outcome = await pullSetupSources(runtime, environmentId, sources.map((source) => ({ id: source.id, label: `${source.identity} — ${source.folder}` })), () => clock.now());
                  say(sources.length === 0 ? "No unpinned source to pull." : outcomeWords(outcome));
                } finally {
                  setPulling(false);
                }
              })();
            },
          },
        }}
      />
      {view !== undefined && view.phase !== "ready" && <p className="text-sm text-amber">Stale: {reachWords(runtime, view)}. Skills as this window last read them, read-only.</p>}
      {!namedPull && pull.status === "absent" && step.result?.actions.includes("pull-now") && <p className="text-sm text-ink-faint">{pull.message}</p>}
      {read.error !== null && <p className="text-sm text-amber">{oneLine(read.error.message)}</p>}
      {line !== undefined && <p role="status" className="text-sm text-ink-muted">{line}</p>}
      <section aria-label="Skills catalogue" className="flex flex-col gap-3">
        <h3 className="font-semibold">Skills catalogue</h3>
        {CATALOGUE.skills.map((entry) => (
          <CatalogueCard
            key={entry.id}
            entry={entry}
            environmentId={environmentId}
            tick={ticks.find((tick) => tick.entryId === entry.id)}
            readable={skills !== null && read.error === null}
            say={say}
          />
        ))}
      </section>
      <AddSource environmentId={environmentId} say={say} title="Add by URL" />
      {skills?.sources.map((source) => (
        <div key={source.id} id={`skill-source-${source.id}`}>
          <SourceCard environmentId={environmentId} source={source} say={say} />
        </div>
      ))}
      {skills?.members.map((member) => (
        <MemberCard key={`${member.layer.kind} ${member.path}`} environmentId={environmentId} member={member} skills={skills} readiness={undefined} say={say} />
      ))}
      <TrustedRepositories environmentId={environmentId} say={say} />
    </>
  );
};

/** Tracking never changes always-on choices; unticking asks once before the source leaves every account. */
const CatalogueCard = ({ entry, environmentId, tick, readable, say }: {
  readonly entry: CatalogueSkillEntry;
  readonly environmentId: string;
  readonly tick: CatalogueTickState | undefined;
  readonly readable: boolean;
  readonly say: (line: string) => void;
}) => {
  const runtime = useRuntime();
  const { send, sending, commandId, refusal, clearRefusal } = useSkillVerb(say);
  const [removing, setRemoving] = useState(false);
  const tracked = tick?.state === "tracked";
  const capability = runtime.capability(environmentId, tracked ? "skills.sources.remove" : "skills.sources.add");
  const { licence } = entry;
  const declaration = licence.where.kind === "file"
    ? licence.where.path
    : licence.where.kind === "frontmatter"
      ? "declared in SKILL.md frontmatter"
      : licence.where.kind === "readme"
        ? "declared in README"
        : "no declaration";
  return (
    <section aria-label={entry.title} className="flex flex-col gap-2 rounded-md border border-line p-4">
      <h4 className="font-semibold">{entry.title}</h4>
      <p className="text-sm text-ink-muted">{entry.pitch}</p>
      <p className="text-sm">{entry.skillCount} skill(s)</p>
      <p className="text-sm">
        {(licence.where.kind !== "file" || licence.holder === null) && <TriangleAlert aria-label="Licence caution" className="mr-1 inline size-3.5 text-amber" />}
        <a href={licence.link} target="_blank" rel="noreferrer">{licence.spdx ?? "No licence"} — {declaration}</a>
        {licence.holder !== null && ` · ${licence.holder}`}
      </p>
      {licence.note !== null && <p className="text-sm text-amber">{licence.note}</p>}
      {entry.alwaysOnHints.map((hint) => (
        <p key={hint.name} className="text-sm text-ink-muted">
          Suggested always-on: {hint.name} — {hint.characters} characters, about {Math.ceil(hint.characters / 4)} tokens on every run. Choose it per account after tracking.
        </p>
      ))}
      {entry.fastMoving && <p className="text-sm text-ink-muted">Changes often.</p>}
      <p className="text-sm text-ink-muted">At most {SKILL_SOURCE_LIMIT} sources.</p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className="accent-beam focus-visible:outline-beam"
          checked={tracked}
          disabled={!readable || sending || capability.status === "absent"}
          onChange={() => {
            if (tracked) {
              clearRefusal();
              setRemoving(true);
            } else {
              void send(
                () => runtime.requests.call(environmentId, "skills.sources.add", {
                  commandId: commandId(), url: entry.url, folder: entry.folder, follow: { kind: "branch", branch: null },
                }),
                `Tracking ${entry.title}.`,
              );
            }
          }}
        />
        Track {entry.title}
      </label>
      {tick?.state === "tracked" && <a className="text-sm text-beam" href={`#skill-source-${tick.sourceId}`}>Open source row</a>}
      {capability.status === "absent" && <p className="text-sm text-ink-faint">{capability.message}</p>}
      <Dialog open={removing} onOpenChange={setRemoving}>
        <DialogContent title={`Stop tracking ${entry.title}`} description="Its skills leave every account on the next run; a live run keeps its snapshot.">
          {refusal !== undefined && <p role="status" className="text-sm text-amber">{refusal}</p>}
          <SkillButton
            environmentId={environmentId}
            method="skills.sources.remove"
            busy={sending}
            onClick={() => {
              if (tick?.state === "tracked") {
                void send(
                  () => runtime.requests.call(environmentId, "skills.sources.remove", { commandId: commandId(), sourceId: tick.sourceId }),
                  "Source removed.",
                ).then((ok) => { if (ok) setRemoving(false); });
              }
            }}
          >
            Confirm remove source
          </SkillButton>
          <Button onClick={() => setRemoving(false)}>Cancel</Button>
        </DialogContent>
      </Dialog>
      <details>
        <summary className="cursor-pointer">Show skills</summary>
        {entry.members.map((member) => (
          <p key={member.name} className="text-sm text-ink-muted">{member.name}: {member.description} ({member.invocation})</p>
        ))}
      </details>
    </section>
  );
};
