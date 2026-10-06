import { ShieldCheck } from "lucide-react";
import { Tooltip } from "../ui/index.js";
import { POLICY_WRITES_WORDS, policyWarning, setPolicies, ticksWith } from "@agent-harness/client-runtime";
import type { KeyManagerConnectionRecord } from "@agent-harness/contracts";
import { useEffect, useRef, useState } from "react";
import { useClock, useRuntime } from "../window-context.js";

export interface PolicyTicksProps {
  readonly environmentId: string;
  readonly connection: KeyManagerConnectionRecord;
  readonly writable: boolean;
  readonly say: (line: string) => void;
}

/** Two tick lists alike, in order. */
const alike = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((name, at) => name === b[at]);

/**
 * The login's policies with their write flags, ticked as the connection's
 * ticks say (key-managers spec, "Providers" and "Run tokens"; ADR 0028):
 * ticking or unticking one sends `keyManagers.connections.setPolicies` with
 * the ticks in the login's order, and a ticked policy that writes, or may,
 * carries ADR 0028's warning. Nothing until a verification has read them.
 *
 * The ticks sent are shown until the cached record says them, so a tick made
 * before the list is read again builds on the one before it rather than on
 * the record as it stood; a refusal puts the record's back, with its line.
 */
export const PolicyTicks = ({ environmentId, connection, writable, say }: PolicyTicksProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [sent, setSent] = useState<readonly string[] | undefined>(undefined);
  const sending = useRef(0);
  /** The last send made, by its number, and the ticks the environment answered it with (undefined while none, or refused). */
  const latest = useRef<{ readonly send: number; answered: readonly string[] | undefined }>({ send: 0, answered: undefined });
  const recorded = connection.ticks ?? [];
  const shown = sent ?? recorded;
  // Once every send has settled and the record says what was sent, the record is shown again.
  useEffect(() => {
    if (sent !== undefined && sending.current === 0 && alike(sent, recorded)) setSent(undefined);
  }, [sent, recorded]);
  if (connection.policies === null || connection.policies.length === 0) return null;

  const tick = (policy: string, ticked: boolean) => {
    const next = ticksWith({ policies: connection.policies, ticks: shown }, policy, ticked);
    setSent(next);
    sending.current += 1;
    const send = latest.current.send + 1;
    latest.current = { send, answered: undefined };
    void setPolicies({ runtime, clock }, environmentId, connection, next).then((set) => {
      sending.current -= 1;
      if (!set.ok) say(set.line);
      // Whatever order the answers come in, the last send's answer is what the environment holds once all have settled.
      if (latest.current.send === send) latest.current.answered = set.ok ? (set.connection?.ticks ?? next) : undefined;
      if (sending.current === 0) setSent(latest.current.answered === undefined ? undefined : [...latest.current.answered]);
    });
  };
  const ticks = new Set(shown);
  return (
    <fieldset className="flex flex-col gap-1 text-sm">
      <legend className="mb-1 text-ink-muted">Policies runs receive</legend>
      {connection.policies.map((policy) => {
        const ticked = ticks.has(policy.name);
        const warning = ticked ? policyWarning(policy.writes) : null;
        return (
          <div key={policy.name} className="flex flex-col">
            <Tooltip content={policy.name} keys="Space to toggle">
            <label className="flex items-center gap-2 text-ink">
              <input type="checkbox" name={policy.name} className="accent-beam" checked={ticked} disabled={!writable} onChange={(event) => tick(policy.name, event.target.checked)} />
              <ShieldCheck aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
              <span>
                {policy.name}, <span className="text-ink-muted">{POLICY_WRITES_WORDS[policy.writes]}</span>
              </span>
            </label>
            </Tooltip>
            {warning !== null && <p className="pl-6 text-xs text-amber">{warning}</p>}
          </div>
        );
      })}
    </fieldset>
  );
};
