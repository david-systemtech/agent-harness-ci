import { trustOfferEmpty, whenWords, type TrustRecord } from "@agent-harness/contracts";
import { useMemo, useState } from "react";
import { useClock, useObservable, useRuntime } from "../window-context.js";
import { SettingsCardGrid } from "../settings/part.js";
import { Fact, Fold } from "../ui/index.js";
import { reachWords } from "../settings/generic-editor.js";
import { SkillButton, useSkillVerb } from "./skill-verb.js";

/** The one-time question lives in the session; work continues while it is unanswered (ADR 0029). */
export const TrustQuestion = ({ environmentId, sessionId }: { readonly environmentId: string; readonly sessionId: string }) => {
  const runtime = useRuntime();
  const view = useObservable(runtime.projections.environments).find((view) => view.environmentId === environmentId);
  const params = useMemo(() => ({ sessionId }), [sessionId]);
  const read = useObservable(useMemo(() => runtime.requests.cached(environmentId, "trust.get", params), [runtime, environmentId, params]));
  const [line, say] = useState<string | undefined>(undefined);
  const { send, sending, commandId } = useSkillVerb(say);
  const trust = read.result;
  if (trust === null || trust.key === null || trust.decision !== "undecided" || trust.offer === null || trustOfferEmpty(trust.offer)) return null;
  const offer = trust.offer;
  return (
    <section
      aria-label="Trust this repository?"
      className="flex shrink-0 flex-col gap-2 overflow-y-auto border-b border-line bg-panel p-3 text-sm"
      style={{ maxHeight: "40vh" }}
    >
      <h3 className="font-semibold">Trust this repository?</h3>
      {view !== undefined && view.phase !== "ready" && (
        <p className="text-amber">Stale: {reachWords(runtime, view)}. The repository offer as this window last read it.</p>
      )}
      <p>{trust.key}</p>
      <p className="text-ink-muted">
        Trust admits the repository's instructions, skills, project settings, permission rules and hooks on the next run. Work continues without them until you
        decide; a live run keeps its starting decision. Local files and repository MCP servers are never loaded.
      </p>
      <ul className="text-ink-muted">
        {offer.instructionFiles.map((file) => (
          <li key={file}>{file}</li>
        ))}
        {offer.skillRoots.map((root) => (
          <li key={`${root.directory} ${root.root}`}>
            {root.directory}/{root.root}: {root.members} skills
          </li>
        ))}
        <li>
          {offer.commands} commands; {offer.subagents} subagents
        </li>
        {offer.hooks.map((hooks) => (
          <li key={hooks.event}>
            {hooks.event}: {hooks.hooks} hooks
          </li>
        ))}
        <li>
          Permission rules: {offer.permissionRules.allow} allow, {offer.permissionRules.ask} ask, {offer.permissionRules.deny} deny
        </li>
        {offer.mcpServers.map((server) => (
          <li key={server.name}>{server.name}: not loaded</li>
        ))}
      </ul>
      {read.error !== null && <p className="text-amber">Stale: {read.error.message}</p>}
      <div className="flex flex-wrap gap-2">
        <SkillButton
          environmentId={environmentId}
          method="trust.decide"
          busy={sending}
          onClick={() => {
            void send(
              () => runtime.requests.call(environmentId, "trust.decide", { commandId: commandId(), sessionId, decision: "trusted" }),
              "Repository trusted.",
            );
          }}
        >
          Trust repository
        </SkillButton>
        <SkillButton
          environmentId={environmentId}
          method="trust.decide"
          busy={sending}
          onClick={() => {
            void send(
              () => runtime.requests.call(environmentId, "trust.decide", { commandId: commandId(), sessionId, decision: "declined" }),
              "Repository trust declined.",
            );
          }}
        >
          Decline trust
        </SkillButton>
      </div>
      {line !== undefined && (
        <p role="status" className="text-ink-muted">
          {line}
        </p>
      )}
    </section>
  );
};

/** The trust list, with when and which client decided, is the runtime's cached query. */
export const TrustedRepositories = ({ environmentId, say }: { readonly environmentId: string; readonly say: (line: string) => void }) => {
  const runtime = useRuntime();
  const read = useObservable(useMemo(() => runtime.requests.cached(environmentId, "trust.list", {}), [runtime, environmentId]));
  return (
    <section aria-label="Repository trust" className="flex flex-col gap-3">
      <h3 className="font-semibold">Repository trust</h3>
      <p className="text-sm text-ink-muted">
        Trust also admits project settings, permission rules and hooks. Revoke takes effect on the next run; a live run keeps what it started with.
      </p>
      {read.error !== null && <p className="text-sm text-amber">{read.error.message}</p>}
      {read.result === null && read.error === null && <p className="text-sm text-ink-muted">Reading trust decisions…</p>}
      {read.result?.trusted.length === 0 && <p className="text-sm text-ink-muted">No repository is trusted on this environment.</p>}
      <SettingsCardGrid>
        {read.result?.trusted.map((record) => (
          <TrustRow key={record.key} environmentId={environmentId} record={record} say={say} />
        ))}
        {read.result?.declined.map((record) => (
          <TrustRow key={record.key} environmentId={environmentId} record={record} say={say} />
        ))}
      </SettingsCardGrid>
    </section>
  );
};

/** A decision's line reads its time where this client is, as Access does (#1797); the client session id, there for support, waits under Details, which keyboard and touch reach (#1800). */
const TrustRow = ({ environmentId, record, say }: { readonly environmentId: string; readonly record: TrustRecord; readonly say: (line: string) => void }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const { send, sending, commandId } = useSkillVerb(say);
  const [details, showDetails] = useState(false);
  const trusted = record.decision === "trusted";
  return (
    <section aria-label={`${trusted ? "Trusted" : "Declined"}: ${record.key}`} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <h4>{record.key}</h4>
      <p className="text-sm text-ink-muted">{`${trusted ? "Trusted" : "Declined"} ${whenWords(record.decidedAt, clock.now())} by ${record.clientLabel}`}</p>
      <Fold summary="Details" open={details} onOpenChange={showDetails} className="text-xs">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
          <Fact name="Client session">{record.clientSessionId}</Fact>
        </dl>
      </Fold>
      <SkillButton
        environmentId={environmentId}
        method={trusted ? "trust.revoke" : "trust.decide"}
        busy={sending}
        onClick={() => {
          void send(
            () =>
              trusted
                ? runtime.requests.call(environmentId, "trust.revoke", { commandId: commandId(), key: record.key })
                : runtime.requests.call(environmentId, "trust.decide", { commandId: commandId(), key: record.key, decision: "trusted" }),
            trusted ? "Trust revoked." : "Repository trusted.",
          );
        }}
      >
        {trusted ? "Revoke trust" : "Trust repository"}
      </SkillButton>
    </section>
  );
};
