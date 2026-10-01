import type { SkillReadiness, SkillsView } from "@agent-harness/contracts";
import { oneLine, type EnvironmentView } from "@agent-harness/client-runtime";
import { useMemo, useState } from "react";
import { reachWords } from "../settings/generic-editor.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { focusedPane } from "../grid/layout.js";
import { MemberCard } from "./members.js";
import { Input } from "../ui/index.js";
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
        View skills for a session
        <select
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
        </select>
      </label>
      {sessionId === undefined && <p className="text-sm text-ink-faint">Choose a session to check readiness in its account and workspace.</p>}
      <AddSource environmentId={environmentId} say={say} />
      {read.result?.sources.map((source) => (
        <SourceCard key={source.id} environmentId={environmentId} source={source} say={say} />
      ))}
      <section aria-label="Own skills" className="flex flex-col gap-3">
        <h3 className="font-semibold text-ink">Own skills</h3>
        {read.result !== null && <p className="text-sm text-ink-muted">{read.result.ownDirectory}</p>}
        <Input aria-label="Skill name" value={name} onChange={(event) => setName(event.target.value)} />
        <Input aria-label="Skill description" value={description} onChange={(event) => setDescription(event.target.value)} />
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
      {read.result !== null &&
        (sessionId === undefined ? (
          <Members environmentId={environmentId} skills={read.result} say={say} />
        ) : (
          <SessionMembers environmentId={environmentId} sessionId={sessionId} skills={read.result} say={say} />
        ))}
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
    {skills.members.length === 0 && <p className="text-sm text-ink-muted">No skills are in this set.</p>}
    {skills.members.map((member) => (
      <MemberCard
        key={JSON.stringify([member.layer, member.path])}
        environmentId={environmentId}
        member={member}
        skills={skills}
        readiness={readiness.find((ready) => ready.name === member.name)}
        say={say}
      />
    ))}
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
