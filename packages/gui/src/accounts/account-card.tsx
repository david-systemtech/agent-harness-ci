import { accountStatusWords, directoryWords, gaugeOf, identityWords, planWords, relabelAccount, uuidv7, type UsageGauge } from "@agent-harness/client-runtime";
import type { AccountRecord } from "@agent-harness/contracts";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Button, Input } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";

/** One fact of a card: its name and what the account holds of it. */
const Fact = ({ name, children }: { readonly name: string; readonly children: ReactNode }) => (
  <>
    <dt className="text-ink-muted">{name}</dt>
    <dd className="min-w-0 break-words text-ink">{children}</dd>
  </>
);

export interface AccountCardProps {
  readonly environmentId: string;
  readonly account: AccountRecord;
  /** Every gauge `projections.usage` pools, the account's among them. */
  readonly gauges: readonly UsageGauge[];
  /** Whether this client may change it: the environment reached, with `admin`. */
  readonly writable: boolean;
  /** Opens the sign-in card on it. */
  readonly signIn: () => void;
  /** Asks to remove it. */
  readonly remove: () => void;
  /** Says one line in the pane: what a command did, or why it did not. */
  readonly say: (line: string) => void;
}

/**
 * An account's card (claude-adapter spec, "The account store"; ADR 0018;
 * #414), drawn from `accounts.list`'s record as the request cache holds it:
 * its label, who it signs in as, its status, the plan reading of its
 * identity pooled across environments, and its directory; its label typed,
 * then Relabel (`accounts.relabel`); Sign in again, which opens the sign-in
 * card on it, as for an account whose sign-in lapsed; and Remove….
 */
export const AccountCard = ({ environmentId, account, gauges, writable, signIn, remove, say }: AccountCardProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const heading = useId();
  const relabel = (label: string) => void relabelAccount(runtime, environmentId, account, label, uuidv7(clock.now())).then((relabelled) => say(relabelled.line));
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3 rounded-md border border-line p-4">
      <h3 id={heading} className="text-base font-semibold text-ink">
        {account.label}
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <Fact name="Identity">{identityWords(account)}</Fact>
        <Fact name="Status">{accountStatusWords(account.status)}</Fact>
        <Fact name="Plan">{planWords(gaugeOf(gauges, environmentId, account.id))}</Fact>
        <Fact name="Directory">{directoryWords(account)}</Fact>
      </dl>
      {/* Keyed by the label, so a label set anywhere, here or by another client, is the field's again. */}
      <LabelField key={account.label} label={account.label} writable={writable} relabel={relabel} />
      <div className="flex flex-wrap gap-2">
        <Button tone={account.status.state === "signed-in" ? "quiet" : "primary"} disabled={!writable} onClick={signIn}>
          Sign in again
        </Button>
        <Button disabled={!writable} onClick={remove}>
          Remove…
        </Button>
      </div>
    </section>
  );
};

/** The label typed, sent with Relabel once it differs from the account's. */
const LabelField = ({ label, writable, relabel }: { readonly label: string; readonly writable: boolean; readonly relabel: (label: string) => void }) => {
  const [typed, setTyped] = useState(label);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    relabel(typed);
  };
  const unchanged = typed.trim() === "" || typed.trim() === label;
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
      <label className="flex flex-col gap-1 text-sm text-ink-muted">
        Label
        <Input value={typed} disabled={!writable} onChange={(event) => setTyped(event.target.value)} className="w-64" />
      </label>
      <Button type="submit" disabled={!writable || unchanged}>
        Relabel
      </Button>
    </form>
  );
};
