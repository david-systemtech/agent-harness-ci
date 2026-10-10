import { accountStatusWords, directoryWords, gaugeOf, nameProblem, planWords, meterReadingsOf, relabelAccount, uuidv7, type AccountOutcome, type UsageGauge } from "@agent-harness/client-runtime";
import { KeyRound, Pencil, Trash2 } from "lucide-react";
import type { AccountRecord } from "@agent-harness/contracts";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Fold, Input } from "../ui/index.js";
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

/** A fold a card holds, shut until chosen. */
const CardFold = ({ summary, children }: { readonly summary: string; readonly children: ReactNode }) => {
  const [open, setOpen] = useState(false);
  return (
    <Fold summary={summary} open={open} onOpenChange={setOpen}>
      <div className="flex min-w-0 flex-col gap-2 pt-1">{children}</div>
    </Fold>
  );
};

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
  /** Why Sign in again waits, while another sign-in card is open in the pane: the button is disabled, with this line under it. */
  readonly signInHeld?: string;
  /** Asks to remove it. */
  readonly remove: () => void;
  /** Says one line in the pane: what a command did, or why it did not. */
  readonly say: (outcome: AccountOutcome) => void;
}

/**
 * An account's row (setup-copy.md §5.1; claude-adapter spec, "The account
 * store"; ADR 0018; #414, #1842), drawn from `accounts.list`'s record as the
 * request cache holds it: its label, its email and its state in words; Sign
 * in again, which opens the sign-in card on it, disabled with why while
 * another sign-in card is open (#1738); in its More options, its name typed
 * then Rename (`accounts.relabel`), and Remove…; and in Details its folder,
 * its plan reading pooled across environments and an unreadable read's error.
 */
export const AccountCard = ({ environmentId, account, gauges, writable, signIn, signInHeld, remove, say, selected = false }: AccountCardProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const heading = useId();
  const held = useId();
  const relabel = (label: string) => void relabelAccount(runtime, environmentId, account, label, uuidv7(clock.now())).then(say);
  const gauge = gaugeOf(gauges, environmentId, account.id);
  const readings = gauge === undefined ? [] : meterReadingsOf(gauge);
  const signedIn = account.status.state === "signed-in";
  return (
    <section aria-labelledby={heading} data-account-card data-default-account={selected || undefined} className={classes("flex flex-col gap-3 rounded-lg border border-hairline bg-panel p-3", selected && "bg-wash-strong")}>
      <header className="flex items-center justify-between gap-3">
        <h3 id={heading} className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink">
          <span aria-hidden="true" className={classes("size-2 shrink-0 rounded-[3px]", accountSwatch(account.id))} />
          <span className="truncate">{account.label}</span>
        </h3>
        {selected && <span className="rounded-md border border-hairline px-1.5 py-0.5 text-2xs text-ink-muted">Default</span>}
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-2xs">
        <Fact name="Email">{account.identity?.email ?? "Not known until it signs in"}</Fact>
        <Fact name="Status"><span className={signedIn ? undefined : "text-amber"}>{accountStatusWords(account.status)}</span></Fact>
      </dl>
      <div className="flex flex-wrap gap-2">
        <AccountAction icon={KeyRound} size="sm" variant="outline" disabled={!writable || account.status.state === "unavailable" || signInHeld !== undefined} {...(signInHeld === undefined ? {} : { "aria-describedby": held })} onClick={signIn}>
          Sign in again
        </AccountAction>
      </div>
      {account.status.state === "unavailable" && <p className="text-2xs text-ink-muted">{account.status.detail}</p>}
      {signInHeld !== undefined && <p id={held} className="text-2xs text-ink-muted">{signInHeld}</p>}
      <CardFold summary="More options">
        {/* Keyed by the label, so a label set anywhere, here or by another client, is the field's again. */}
        <LabelField key={account.label} label={account.label} writable={writable} relabel={relabel} />
        <AccountAction icon={Trash2} size="sm" variant="ghost" className="self-start" disabled={!writable} onClick={remove}>
          Remove…
        </AccountAction>
      </CardFold>
      <CardFold summary="Details">
        <div className="flex flex-col gap-1 font-mono text-2xs break-all text-ink select-text">
          <p>{directoryWords(account)}</p>
          <p>Plan: {planWords(gauge)}</p>
          {account.status.state === "unreadable" && account.status.detail !== null && <p>Sign-in read: {account.status.detail}</p>}
        </div>
        {readings.length > 0 && <div className="flex items-center gap-2">{readings.map((reading) => <UsageRing key={reading.window} reading={reading} />)}</div>}
      </CardFold>
    </section>
  );
};

/** The name typed, sent with Rename; a name the account cannot have is said beside the field and not sent. */
const LabelField = ({ label, writable, relabel }: { readonly label: string; readonly writable: boolean; readonly relabel: (label: string) => void }) => {
  const [typed, setTyped] = useState(label);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const said = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = nameProblem(typed);
    setProblem(found);
    if (found === undefined) relabel(typed);
  };
  return (
    <form className="flex flex-col gap-1" onSubmit={submit}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          Name
          <Input value={typed} disabled={!writable} aria-invalid={problem !== undefined || undefined} {...(problem === undefined ? {} : { "aria-describedby": said })} onChange={(event) => setTyped(event.target.value)} className="w-64 max-w-full" />
        </label>
        <AccountAction icon={Pencil} size="sm" variant="outline" type="submit" disabled={!writable}>
          Rename
        </AccountAction>
      </div>
      {problem !== undefined && <p id={said} role="alert" className="text-xs text-signal"><span className="sr-only">Error: </span>{problem}</p>}
    </form>
  );
};
