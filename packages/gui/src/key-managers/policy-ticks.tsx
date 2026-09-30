import { POLICY_WRITES_WORDS, policyWarning, setPolicies, ticksWith } from "@agent-harness/client-runtime";
import type { KeyManagerConnectionRecord } from "@agent-harness/contracts";
import { useClock, useRuntime } from "../window-context.js";

export interface PolicyTicksProps {
  readonly environmentId: string;
  readonly connection: KeyManagerConnectionRecord;
  readonly writable: boolean;
  readonly say: (line: string) => void;
}

/**
 * The login's policies with their write flags, ticked as the connection's
 * ticks say (key-managers spec, "Providers" and "Run tokens"; ADR 0028):
 * ticking or unticking one sends `keyManagers.connections.setPolicies` with
 * the ticks in the login's order, and a ticked policy that writes, or may,
 * carries ADR 0028's warning. Nothing until a verification has read them.
 */
export const PolicyTicks = ({ environmentId, connection, writable, say }: PolicyTicksProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  if (connection.policies === null) return null;
  const ticks = new Set(connection.ticks ?? []);
  const tick = (policy: string, ticked: boolean) =>
    void setPolicies({ runtime, clock }, environmentId, connection, ticksWith(connection, policy, ticked)).then((set) => !set.ok && say(set.line));
  return (
    <fieldset className="flex flex-col gap-1 text-sm">
      <legend className="mb-1 text-ink-muted">Policies runs receive</legend>
      {connection.policies.map((policy) => {
        const ticked = ticks.has(policy.name);
        const warning = ticked ? policyWarning(policy.writes) : null;
        return (
          <div key={policy.name} className="flex flex-col">
            <label className="flex items-center gap-2 text-ink">
              <input type="checkbox" name={policy.name} className="accent-beam" checked={ticked} disabled={!writable} onChange={(event) => tick(policy.name, event.target.checked)} />
              <span>
                {policy.name}, <span className="text-ink-muted">{POLICY_WRITES_WORDS[policy.writes]}</span>
              </span>
            </label>
            {warning !== null && <p className="pl-6 text-xs text-amber">{warning}</p>}
          </div>
        );
      })}
    </fieldset>
  );
};
