import { AccessUnavailable } from "../connections/limited-access.js";
import { ConnectionGrant } from "../connections/connection-grant.js";
import { revokeSession, setSessionCeiling, setSessionAccess, uuidv7, type AccessOutcome, type ClientSessionSummary, type EnvironmentView } from "@agent-harness/client-runtime";
import { settingsRow, type Scope, type Ceiling } from "@agent-harness/contracts";
import { useMemo, useState } from "react";
import { nameOf } from "../connections/words.js";
import { readOnlyLine } from "../settings/generic-editor.js";
import { Part } from "../settings/part.js";
import { useWrittenOver } from "../settings/settings-values.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";
import { ChangeAccess } from "./change-access.js";
import { AccessLog } from "./access-log.js";
import { ConfirmRevoke } from "./confirm-revoke.js";
import { ProgramPairing } from "./program-pairing.js";
import { SessionList } from "./session-list.js";

/**
 * The Access row, `environments.access` (env spec, "Pairing and access";
 * permissions spec, "Ceilings"; ADR 0006, ADR 0027; docs/specs/gui.md,
 * "Settings"; #417), on the environment its picker names: the client
 * sessions that reach it from `access.sessions.list` (live ones), this
 * client's own marked, each with its ceiling (`access.sessions.setCeiling`)
 * and Revoke… (`access.sessions.revoke`, asked once); programs' client
 * sessions beside them under Program pairings. Every one of them is read
 * and sent at `admin`, so without it the pane says the capability's line
 * once and shows nothing; while the environment cannot be reached it shows
 * what this window last read, read-only. What a verb did is one line over
 * the parts.
 */
export const AccessPane = () => {
  const picked = usePickedEnvironment();
  return picked === undefined ? null : <AccessOn key={picked.environmentId} view={picked} />;
};

const AccessOn = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const { environmentId } = view;
  const answer = useObservable(useMemo(() => runtime.requests.cached(environmentId, "access.sessions.list", { live: true }), [runtime, environmentId]));
  const [reread, write] = useWrittenOver<readonly ClientSessionSummary[]>(answer.fetchedAt);
  const connection = useObservable(runtime.connections.list).find((record) => record.environmentId === environmentId);
  const [said, setSaid] = useState<AccessOutcome | undefined>(undefined);
  const [revoking, setRevoking] = useState<ClientSessionSummary | undefined>(undefined);
  const [changing, setChanging] = useState<ClientSessionSummary | undefined>(undefined);
  const [verbs, setVerbs] = useState(0);

  const ready = view.phase === "ready";
  const admin = runtime.capability(environmentId, "access.sessions.list");
  const writable = ready && admin.status === "present";
  const sessions = reread ?? answer.result?.sessions ?? null;
  const programs = sessions?.filter((session) => session.kind === "program") ?? [];
  const own = connection?.clientSessionId ?? null;

  /** Says what a verb did and, once it did something, reads the client sessions again, shown over the cached ones. */
  const done = async (outcome: AccessOutcome) => {
    setSaid(outcome);
    if (!outcome.ok) return;
    setVerbs((now) => now + 1);
    const again = await runtime.requests.call(environmentId, "access.sessions.list", { live: true });
    if (again.ok) write(() => again.result.sessions);
  };
  const setCeiling = (session: ClientSessionSummary, ceiling: Ceiling) => {
    setSaid(undefined);
    void setSessionCeiling(runtime, environmentId, session, ceiling, uuidv7(clock.now())).then(done);
  };
  const revoke = (session: ClientSessionSummary) => {
    setRevoking(undefined);
    void revokeSession(runtime, environmentId, session, uuidv7(clock.now())).then(done);
  };
  const ask = (session: ClientSessionSummary) => {
    setSaid(undefined);
    setRevoking(session);
  };
  const changeAccess = async (grant: { readonly scopes: readonly Scope[]; readonly ceiling: Ceiling }) => {
    if (!changing) return;
    const outcome = await setSessionAccess(runtime, environmentId, changing, grant, uuidv7(clock.now()));
    if (outcome.ok) setChanging(undefined);
    await done(outcome);
    return outcome;
  };
  const lists = { own, writable, setCeiling, revoke: ask, changeAccess: setChanging };

  return (
    <>
      <ConnectionGrant view={view} />
      <p className="text-sm text-ink-muted">{settingsRow("environments.access").hint}</p>
      {!ready && <p className="text-sm text-amber">{readOnlyLine(runtime, view, sessions !== null)}</p>}
      {ready && admin.status === "absent" && <AccessUnavailable environmentId={view.environmentId} answer={admin}><p className="text-sm text-amber">Read-only: {admin.message}</p></AccessUnavailable>}
      {ready && admin.status === "present" && sessions === null && (
        <p className="text-sm text-ink-faint">{answer.error === null ? "Reading the client sessions…" : `The client sessions could not be read: ${answer.error.message}`}</p>
      )}
      {said !== undefined && <p className={`text-sm ${said.ok ? "text-ink-muted" : "text-signal"}`}>{said.line}</p>}
      {sessions !== null && (
        <>
          <Part title="Client sessions">
            <SessionList name="Client sessions" sessions={sessions.filter((session) => session.kind !== "program")} {...lists} />
          </Part>
          <Part title="Program pairings">
            <p className="text-sm text-ink-muted">Scripts and bots paired with {nameOf(view)}, each with the scopes its pairing code granted.</p>
            {programs.length > 0 ? (
              <SessionList name="Programs" sessions={programs} {...lists} />
            ) : (
              <p className="text-sm text-ink-faint">No program is paired.</p>
            )}
            <ProgramPairing view={view} writable={writable} />
          </Part>
          <AccessLog view={view} sessions={sessions} after={verbs} />
        </>
      )}
      {changing !== undefined && <ChangeAccess session={changing} view={view} writable={writable} save={changeAccess} close={() => setChanging(undefined)} />}
      {revoking !== undefined && (
        <ConfirmRevoke environment={nameOf(view)} session={revoking} own={revoking.id === own} close={() => setRevoking(undefined)} revoke={() => revoke(revoking)} />
      )}
    </>
  );
};
