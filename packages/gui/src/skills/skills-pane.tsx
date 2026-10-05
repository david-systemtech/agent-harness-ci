import { SettingsCardGrid } from "../settings/part.js";
import type { SkillReadiness, SkillsView } from "@agent-harness/contracts";
import { oneLine, type EnvironmentView } from "@agent-harness/client-runtime";
import { Sparkles, Type, FileText, Layers } from "lucide-react";
import { useMemo, useState } from "react";
import { reachWords } from "../settings/generic-editor.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { focusedPane } from "../grid/layout.js";
import { MissingSkillChoices } from "./missing-choices.js";
import { MemberCard } from "./members.js";
import { Input, Tooltip } from "../ui/index.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";
import { TrustedRepositories } from "./trust.js";
import { AddSource, SourceCard } from "./sources.js";
import { SkillButton, useSkillVerb } from "./skill-verb.js";

/** Skills are read from the runtime cache; the renderer holds only form input and the last command's line (ADR 0003). */
export const SkillsPane = () => {
  const picked = usePickedEnvironment();
  return picked === undefined ? null : <SkillsOn key={picked.environmentId} view={picked} />;
};

const SkillsOn = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const sessions = useObservable(runtime.projections.sessionList).rows.filter((row) => row.environmentId === environmentId);
  const [layout] = usePresentation("paneLayout");
  const focused = focusedPane(layout).session;
  const [pickedSession, pickSession] = useState<string>(focused?.environmentId === environmentId ? focused.sessionId : "");
  const sessionId = sessions.some((row) => row.summary.id === pickedSession) ? pickedSession : undefined;
  const params = useMemo(() => (sessionId === undefined ? {} : { sessionId }), [sessionId]);
  const read = useObservable(useMemo(() => runtime.requests.cached(environmentId, "skills.get", params), [runtime, environmentId, params]));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [line, setLine] = useState<string | undefined>(undefined);
  const say = (message: string) => setLine(oneLine(message));
  const { send, sending, commandId } = useSkillVerb(say);
  return (
    <>
      {view.phase !== "ready" && <p className="text-sm text-amber">Stale: {reachWords(runtime, view)}. Skills as this window last read them, read-only.</p>}
      {read.error !== null && <p className="text-sm text-amber">{read.error.message}</p>}
      {line !== undefined && (
        <p role="status" className="text-sm text-ink-muted">
          {line}
        </p>
      )}
      <label className="flex flex-col gap-1 text-sm">
        <span className="flex items-center gap-1"><Layers aria-hidden="true" className="size-3.5" />View skills for a session</span>
        <Tooltip content="Skills session · Arrow keys"><select
          aria-label="Skills session"
          className="rounded-md border border-line bg-inset p-2 text-ink"
          value={sessionId ?? ""}
          onChange={(event) => pickSession(event.target.value)}
        >
          <option value="">Default account (no repository)</option>
          {sessions.map((row) => (
            <option key={row.summary.id} value={row.summary.id}>
              {row.summary.title ?? row.summary.id}
            </option>
          ))}
        </select></Tooltip>
      </label>
      {sessionId === undefined && <p className="text-sm text-ink-faint">Choose a session to check readiness in its account and workspace.</p>}
      {read.result !== null &&
        (sessionId === undefined ? (
          <Members environmentId={environmentId} skills={read.result} say={say} />
        ) : (
          <SessionMembers environmentId={environmentId} sessionId={sessionId} skills={read.result} say={say} />
        ))}
      <AddSource environmentId={environmentId} say={say} />
      <SettingsCardGrid>{read.result?.sources.map((source) => (
        <SourceCard key={source.id} environmentId={environmentId} source={source} say={say} />
      ))}</SettingsCardGrid>
      <section aria-label="Own skills" className="flex flex-col gap-3 rounded-lg border border-hairline p-3">
        <h3 className="text-xs font-semibold text-ink">Own skills</h3>
      {read.result !== null && <p className="text-sm text-ink-muted">{read.result.ownDirectory}</p>}
        <label className="flex flex-col gap-1 text-xs"><span className="flex items-center gap-1"><Type aria-hidden="true" className="size-3.5" />Skill name</span><Tooltip content="Skill name · Type to edit"><Input aria-label="Skill name" value={name} onChange={(event) => setName(event.target.value)} /></Tooltip></label>
        <label className="flex flex-col gap-1 text-xs"><span className="flex items-center gap-1"><FileText aria-hidden="true" className="size-3.5" />Description</span><Tooltip content="Description · Type to edit"><Input aria-label="Skill description" value={description} onChange={(event) => setDescription(event.target.value)} /></Tooltip></label>
        <SkillButton
          environmentId={environmentId}
          method="skills.own.create"
          busy={sending}
          onClick={() => {
            void send(() => runtime.requests.call(environmentId, "skills.own.create", { commandId: commandId(), name, description }), "Skill created.").then(
              (ok) => {
                if (ok) {
                  setName("");
                  setDescription("");
                }
              },
            );
          }}
        >
          Create skill
        </SkillButton>
      </section>
      <TrustedRepositories environmentId={environmentId} say={say} />

    </>
  );
};

const Members = ({
  environmentId,
  skills,
  readiness = [],
  say,
}: {
  readonly environmentId: string;
  readonly skills: SkillsView;
  readonly readiness?: readonly SkillReadiness[];
  readonly say: (line: string) => void;
}) => (
  <>
    {skills.members.length === 0 && <div className="flex flex-col items-center gap-2 rounded-lg border border-hairline bg-panel p-6 text-center"><Sparkles aria-hidden="true" className="size-6 text-ink-muted" /><h3 className="text-xs font-medium">No skills are in this set.</h3><p className="max-w-md text-2xs text-ink-muted">Add a repository of procedures, or create a skill in this environment. Each procedure holds a SKILL.md and is available on request.</p></div>}
    <MissingSkillChoices skills={skills} />
    <SettingsCardGrid>{skills.members.map((member) => (
      <MemberCard
        key={JSON.stringify([member.layer, member.path])}
        environmentId={environmentId}
        member={member}
        skills={skills}
        readiness={readiness.find((ready) => ready.name === member.name)}
        say={say}
      />
    ))}</SettingsCardGrid>
  </>
);

const SessionMembers = ({
  environmentId,
  sessionId,
  skills,
  say,
}: {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly skills: SkillsView;
  readonly say: (line: string) => void;
}) => {
  const runtime = useRuntime();
  const params = useMemo(() => ({ sessionId }), [sessionId]);
  const read = useObservable(useMemo(() => runtime.requests.cached(environmentId, "skills.readiness", params), [runtime, environmentId, params]));
  return (
    <>
      {read.error !== null && <p className="text-sm text-amber">Readiness: {read.error.message}</p>}
      <SkillButton
        environmentId={environmentId}
        method="skills.readiness"
        busy={read.loading}
        onClick={() => {
          void runtime.requests.call(environmentId, "skills.readiness", { sessionId, refresh: true }).then((answer) => {
            if (answer.ok) runtime.requests.refresh(environmentId, "skills.readiness", params);
            else say(answer.error.message);
          });
        }}
      >
        Check readiness again
      </SkillButton>
      <Members environmentId={environmentId} skills={skills} readiness={read.result?.skills ?? []} say={say} />
    </>
  );
};
