import { accountStatusWords, directoryWords, gaugeOf, identityWords, planWords, meterReadingsOf, relabelAccount, uuidv7, type UsageGauge } from "@agent-harness/client-runtime";
import { KeyRound, Pencil, Trash2 } from "lucide-react";
import type { AccountRecord } from "@agent-harness/contracts";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Input } from "../ui/index.js";
import { UsageRing } from "../status/window-reading.js";
import { accountSwatch } from "../sidebar/session-tooltip.js";
import { classes } from "../ui/classes.js";
import { AccountAction } from "./action.js";
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
  readonly selected?: boolean;
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
export const AccountCard = ({ environmentId, account, gauges, writable, signIn, remove, say, selected = false }: AccountCardProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const heading = useId();
  const relabel = (label: string) => void relabelAccount(runtime, environmentId, account, label, uuidv7(clock.now())).then((relabelled) => say(relabelled.line));
  const gauge = gaugeOf(gauges, environmentId, account.id);
  const readings = gauge === undefined ? [] : meterReadingsOf(gauge);
  return (
    <section aria-labelledby={heading} data-account-card data-default-account={selected || undefined} className={classes("flex flex-col gap-3 rounded-lg border border-hairline bg-panel p-3", selected && "bg-wash-strong")}>
      <header className="flex items-center justify-between gap-3">
        <h3 id={heading} className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink">
          <span aria-hidden="true" className={classes("size-2 shrink-0 rounded-[3px]", accountSwatch(account.id))} />
          <span className="truncate">{account.label}</span>
        </h3>
        <div className="flex items-center gap-2">
          {selected && <span className="rounded-md border border-hairline px-1.5 py-0.5 text-2xs text-ink-muted">Default</span>}
          {account.status.state !== "signed-in" && <span className="rounded-md border border-amber/30 px-1.5 py-0.5 text-2xs text-amber">{accountStatusWords(account.status)}</span>}
          {readings.map((reading) => <UsageRing key={reading.window} reading={reading} />)}
        </div>
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-2xs">
        <Fact name="Identity">{identityWords(account)}</Fact>
        <dt className="sr-only">Status</dt><dd className="sr-only">{accountStatusWords(account.status)}</dd>
        <Fact name="Plan">{planWords(gaugeOf(gauges, environmentId, account.id))}</Fact>
        <Fact name="Directory">{directoryWords(account)}</Fact>
      </dl>
      {/* Keyed by the label, so a label set anywhere, here or by another client, is the field's again. */}
      <LabelField key={account.label} label={account.label} writable={writable} relabel={relabel} />
      <div className="flex flex-wrap gap-2">
        <AccountAction icon={KeyRound} size="sm" variant="outline" disabled={!writable} onClick={signIn}>
          Sign in again
        </AccountAction>
        <AccountAction icon={Trash2} size="sm" variant="ghost" disabled={!writable} onClick={remove}>
          Remove…
        </AccountAction>
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
      <label className="flex flex-col gap-1 text-xs text-ink-muted">
        Label
        <Input value={typed} disabled={!writable} onChange={(event) => setTyped(event.target.value)} className="w-64 max-w-full" />
      </label>
      <AccountAction icon={Pencil} size="sm" variant="outline" type="submit" disabled={!writable || unchanged}>
        Relabel
      </AccountAction>
    </form>
  );
};
