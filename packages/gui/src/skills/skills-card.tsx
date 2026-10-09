import { plainRefusal, pullSetupSources, type ActionOutcome } from "@agent-harness/client-runtime";
import { CATALOGUE, catalogueTickStates, skillCollectionName, SKILL_SOURCE_LIMIT, type CatalogueSkillEntry, type CatalogueTickState, type SkillsViewSource } from "@agent-harness/contracts";
import { ExternalLink, Minus, Plus, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import type { StepCardProps } from "../setup/cards.js";
import { useChecklist } from "../setup/checklist-window.js";
import { MoreOptions } from "../setup/more-options.js";
import { Outcome } from "../setup/outcome.js";
import { StepStatus } from "../setup/step-status.js";
import { Button, Fold, Tooltip } from "../ui/index.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";
import { AddFromLink, FoundFolders, RefusedLine, useCollectionVerb } from "./sources.js";

/** How many collections a person follows before the card says the limit (setup-copy.md §5.9). */
const LIMIT_SHOWN_FROM = 15;

/** What the card last said an action did: its line, and its raw words for Details. */
type Said = Pick<ActionOutcome, "line" | "details">;

/**
 * The Skills step (setup-copy.md §5.9; Set up specification, "7. Skills";
 * ADR 0029; #591, #1855): the catalogue's collections, each added with one
 * button and removed with one more, honest about which are added by the
 * sources skills.get holds (#508); Add from a link in More options; and
 * Choose folders for a collection whose folders moved. Members, always-on
 * choices and repository trust are Settings › Skills' (All skill settings).
 * The catalogue ships with this client build; every environment fact stays
 * in the runtime cache, refreshed on skills.updated.
 */
export const SkillsCard = ({ environmentId, step }: StepCardProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const { leave } = useChecklist();
  const read = useObservable(useMemo(() => runtime.requests.cached(environmentId, "skills.get", {}), [runtime, environmentId]));
  const [said, setSaid] = useState<Said | undefined>(undefined);
  const [pulling, setPulling] = useState(false);
  const [choosing, setChoosing] = useState<SkillsViewSource | undefined>(undefined);
  const skills = read.result;
  const sources = skills?.sources ?? [];
  const ticks = catalogueTickStates(CATALOGUE.skills, sources);
  const pull = runtime.capability(environmentId, "skills.sources.pull");
  const namedPull = step.result?.targets?.some((target) => target.action === "pull-now" && target.kind === "skill-source") ?? false;
  const readable = skills !== null && read.error === null;
  return (
    <>
      <StepStatus
        environmentId={environmentId}
        step={step}
        actions={{
          ...(!namedPull && { "pull-now": {
            disabled: pulling || !readable || pull.status === "absent",
            run: () => {
              const following = sources.filter((source) => source.follow.kind === "branch");
              void (async () => {
                setPulling(true);
                try {
                  const outcome = await pullSetupSources(runtime, environmentId, following.map((source) => ({ id: source.id, label: skillCollectionName(source, CATALOGUE.skills) })), () => clock.now());
                  setSaid(following.length === 0 ? { line: "There is no collection to update." } : outcome);
                } finally {
                  setPulling(false);
                }
              })();
            },
          } }),
          "choose-folders": {
            disabled: !readable,
            run: (targets) => setChoosing(sources.find((source) => targets.some((target) => target.id === source.id))),
          },
        }}
      />
      {!namedPull && pull.status === "absent" && step.result?.actions.includes("pull-now") && <p className="text-sm text-ink-faint">{pull.message}</p>}
      {read.error !== null && <Outcome outcome={plainRefusal(read.error, "Check again")} className="text-sm text-amber" />}
      {said !== undefined && <Outcome outcome={said} role="status" className="text-sm text-ink-muted" />}
      {choosing !== undefined && (
        <section aria-label={`Choose folders for ${skillCollectionName(choosing, CATALOGUE.skills)}`} className="flex flex-col gap-3 rounded-md border border-line p-4">
          <FoundFolders key={choosing.id} environmentId={environmentId} url={choosing.url} replacing={{ source: choosing, followed: sources.length }} done={(line) => { setSaid({ line }); setChoosing(undefined); }} partly={(line) => setSaid({ line })} />
          <Button variant="outline" className="self-start" onClick={() => setChoosing(undefined)}>Cancel</Button>
        </section>
      )}
      <section aria-label="Skills catalogue" className="flex flex-col gap-3">
        {sources.length >= LIMIT_SHOWN_FROM && <p className="text-sm text-ink-muted">You can follow up to {SKILL_SOURCE_LIMIT} collections.</p>}
        {CATALOGUE.skills.map((entry) => (
          <CatalogueCard key={entry.id} entry={entry} environmentId={environmentId} tick={ticks.find((tick) => tick.entryId === entry.id)} readable={readable} />
        ))}
      </section>
      <MoreOptions step="skills">
        <AddFromLink environmentId={environmentId} say={(line) => setSaid({ line })} />
      </MoreOptions>
      <span className="flex flex-wrap items-center gap-2">
        <Tooltip content="All skill settings" keys="Tab, Enter"><Button variant="outline" onClick={() => leave("knowledge.skills", environmentId)}><ExternalLink aria-hidden="true" />All skill settings</Button></Tooltip>
        <span className="text-xs text-ink-muted">Leaves Set up</span>
      </span>
    </>
  );
};

/** A catalogue licence's declaration, as Details says it. */
const declarationOf = ({ where }: CatalogueSkillEntry["licence"]): string =>
  where.kind === "file" ? `${where.path} file` : where.kind === "frontmatter" ? "said in the skill's SKILL.md" : where.kind === "readme" ? "said in the README" : "not stated";

/** One collection of the catalogue: Add, or Added with Remove; its licence, size and skills under Details. Adding never changes always-on choices. */
const CatalogueCard = ({ entry, environmentId, tick, readable }: {
  readonly entry: CatalogueSkillEntry;
  readonly environmentId: string;
  readonly tick: CatalogueTickState | undefined;
  readonly readable: boolean;
}) => {
  const runtime = useRuntime();
  const { send, sending, refusal, commandId } = useCollectionVerb();
  const [open, setOpen] = useState(false);
  const added = tick?.state === "tracked";
  const capability = runtime.capability(environmentId, added ? "skills.sources.remove" : "skills.sources.add");
  const { licence } = entry;
  return (
    <section aria-label={entry.title} className="flex flex-col gap-2 rounded-md border border-line p-4">
      <h4 className="font-semibold">{entry.title}</h4>
      <p className="text-sm text-ink-muted">{entry.pitch}</p>
      <p className="text-sm">{entry.skillCount === 1 ? "1 skill" : `${entry.skillCount} skills`}</p>
      <span className="flex flex-wrap items-center gap-2">
        {tick?.state === "tracked" ? (
          <>
            <span className="text-sm text-mint">Added</span>
            <Button
              variant="outline"
              size="sm"
              disabled={!readable || sending || capability.status === "absent"}
              onClick={() => void send(() => runtime.requests.call(environmentId, "skills.sources.remove", { commandId: commandId(), sourceId: tick.sourceId }), "Remove")}
            >
              <Minus aria-hidden="true" />Remove
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={!readable || sending || capability.status === "absent"}
            onClick={() => void send(() => runtime.requests.call(environmentId, "skills.sources.add", { commandId: commandId(), url: entry.url, folder: entry.folder, follow: { kind: "branch", branch: null } }), "Add")}
          >
            <Plus aria-hidden="true" />Add
          </Button>
        )}
        {capability.status === "absent" && <span className="text-xs text-ink-faint">{capability.message}</span>}
      </span>
      {refusal !== undefined && <RefusedLine environmentId={environmentId} refusal={refusal} />}
      <Fold summary="Details" open={open} onOpenChange={setOpen}>
        <div className="flex flex-col gap-1 text-sm text-ink-muted">
          <p>
            {(licence.where.kind !== "file" || licence.holder === null) && <TriangleAlert aria-label="Licence caution" className="mr-1 inline size-3.5 text-amber" />}
            <a href={licence.link} target="_blank" rel="noreferrer">Licence: {licence.spdx ?? "none"}, {declarationOf(licence)}</a>
            {licence.holder !== null && ` · ${licence.holder}`}
          </p>
          {licence.note !== null && <p className="text-amber">{licence.note}</p>}
          {entry.fastMoving && <p>Changes often.</p>}
          {entry.alwaysOnHints.map((hint) => (
            <p key={hint.name}>{hint.name} can be always on: about {Math.ceil(hint.characters / 4)} tokens on every run. Choose it in Settings › Skills.</p>
          ))}
          {entry.members.map((member) => <p key={member.name}>{member.name}: {member.description}</p>)}
        </div>
      </Fold>
    </section>
  );
};
