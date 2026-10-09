import { SettingsCardGrid } from "../settings/part.js";
import { AccessUnavailable } from "../connections/limited-access.js";
import { clockTime, emailLabel, nameProblem, newAccountLabel, relabelAccount, uuidv7, type AccountOutcome, type EnvironmentView, type Runtime } from "@agent-harness/client-runtime";
import { settingsRow, type AccountIdentity, type AccountRecord } from "@agent-harness/contracts";
import { Plus, RotateCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { nameOf } from "../connections/words.js";
import { StepLinks } from "../settings/step-links.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { CopyLine } from "../settings/copy-line.js";
import { AccountAction } from "./action.js";
import { useClock, useObservable, useRuntime, useShell } from "../window-context.js";
import { AccountCard } from "./account-card.js";
import { SignInQuestion } from "./adopt-offer.js";
import { ConfirmRemove } from "./confirm-remove.js";
import { SignInCard } from "./sign-in-card.js";

/** The step homed on this row beside Account whose card is not drawn here: its link opens it in Set up. */
const CARRY_OVER = ["carry-over"] as const;

/** Why an account's Sign in again waits while a sign-in card is open: the environment runs one sign-in at a time (ADR 0018). */
const SIGN_IN_HELD = "Finish or cancel the open sign-in first.";

/** A sign-in card to open: on an account, or adding one (`null`) under `label`, or as `suggestion` says. */
type Opening = {
  readonly account: Pick<AccountRecord, "id" | "label"> | null;
  readonly label?: string;
  readonly nameByEmail?: boolean;
  readonly suggestion?: { readonly label: string; readonly email: string };
};

/** The sign-in card the pane has open, keyed so another replaces it whole; `succeeded`, the line its Done will say once its sign-in has. */
type Signing = Opening & { readonly key: number; readonly succeeded?: string };

/**
 * The Accounts row, `accounts.accounts` (docs/specs/gui.md, "Settings";
 * claude-adapter spec, "The account store"; ADR 0018, ADR 0027; #414), on
 * the environment its picker names: the Account step's question, then a card
 * per account from `accounts.list` in the request cache, which
 * `account.updated` and `signin.updated` refresh, so a change made by
 * another client shows at once. The accounts' status is read again as the
 * pane opens on an environment (`accounts.refresh`, ADR 0018). The pane
 * keeps nothing of the accounts itself (ADR 0004). Carry over, homed here
 * beside Account, is its step's card in Set up, which a link opens.
 */
export const AccountsPane = () => {
  const picked = usePickedEnvironment();
  return picked === undefined ? null : <AccountsOn key={picked.environmentId} view={picked} />;
};

const AccountsOn = ({ view }: { readonly view: EnvironmentView }) => (
  <>
    <p className="text-2xs leading-relaxed text-ink-faint">{settingsRow("accounts.accounts").hint}</p>
    <AccountsList view={view} inlineSignIn />
    <StepLinks steps={CARRY_OVER} />
  </>
);

export interface AccountsListProps {
  readonly view: EnvironmentView;
  /** The name typed for the next new account (the Account step's More options); empty or absent for `Claude account`, then its email. */
  readonly label?: string;
  /** Empties the name typed once an account has taken it. */
  readonly labelTaken?: () => void;
  readonly inlineSignIn?: boolean;
}

/** A computer as a line names it: "this computer" for the one this app runs on, else its name (setup-copy.md §2). */
export const computerOf = (view: EnvironmentView): string => (view.kind === "local" ? "this computer" : nameOf(view));

/**
 * Why nothing of the accounts can be changed while the environment is not
 * ready (setup-copy.md §5.1): it cannot be reached, so they show once it can,
 * or they are as this app last read them, from when it was last reached.
 */
const unreachedLine = (runtime: Runtime, view: EnvironmentView, read: boolean): string => {
  const name = nameOf(view);
  const blocked = runtime.capability(view.environmentId, "settings.get");
  if (!read) return view.unreachableSince === null && blocked.status === "absent" ? blocked.message : `This app cannot reach ${name} right now. Accounts show once it can.`;
  const from = view.unreachableSince === null ? "These are the accounts as this app last read them." : `These are the accounts from ${clockTime(view.unreachableSince)}.`;
  return `${from} You cannot change them until ${name} is back.`;
};

/** What a command did, in one line over the cards: a refusal as an alert, its raw words under Details. */
export const SaidLine = ({ said }: { readonly said: AccountOutcome }) => (
  <>
    {said.ok ? (
      <p role="status" className="text-sm text-ink-muted">{said.line}</p>
    ) : (
      <p role="alert" className="text-sm text-signal"><span className="sr-only">Error: </span>{said.line}</p>
    )}
    {said.details !== undefined && said.details.length > 0 && <CopyLine label="Details" text={said.details.join("\n")} copyLabel="Copy details" />}
  </>
);

/**
 * An environment's accounts as the Accounts row and the Account step's card
 * draw them (#414, #575, #1842; setup-copy.md §5.1): the status read again as
 * it opens; while the environment cannot be reached, why, and the accounts as
 * this app last read them, read-only; without `admin`, read-only with the
 * capability's line; the question of how to sign in; another computer's
 * accounts to sign in here too; what a command did in one line; and a card
 * per account. An account Sign in with Claude added as `Claude account` is
 * renamed to its email once it is signed in, unless a person chose or renamed its name first.
 */
export const AccountsList = ({ view, label = "", labelTaken, inlineSignIn = false }: AccountsListProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const shell = useShell();
  const { environmentId } = view;
  const environments = useObservable(runtime.projections.environments);
  const listed = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId]));
  const { values } = useSettingsValues(environmentId);
  const { gauges } = useObservable(runtime.projections.usage);
  const [said, setSaid] = useState<AccountOutcome | undefined>(undefined);
  const say = (line: string) => setSaid({ ok: true, line });
  const [signing, setSigning] = useState<Signing | undefined>(undefined);
  const opened = useRef(0);
  // A card whose sign-in succeeded holds nothing on the environment: opening another says its end, as its Done would.
  const held = signing !== undefined && signing.succeeded === undefined;
  const signIn = (opening: Opening) => {
    if (signing?.succeeded !== undefined) say(signing.succeeded);
    setSigning({ ...opening, key: ++opened.current });
  };
  const [removing, remove] = useState<AccountRecord | undefined>(undefined);
  const ready = view.phase === "ready";
  const admin = runtime.capability(environmentId, "accounts.adopt");
  const writable = ready && admin.status === "present";
  const accounts = listed.value;

  // The status read again as the list opens on the environment, and as it is reached again; what it records is noticed.
  useEffect(() => {
    if (ready) void runtime.requests.call(environmentId, "accounts.refresh", {});
  }, [runtime, environmentId, ready]);

  // A new account takes its email as its name once signed in (setup-copy.md §5.1), asked once per account while this list is open.
  const named = useRef(new Set<string>());
  useEffect(() => {
    if (!writable || accounts === null) return;
    for (const account of accounts) {
      const email = emailLabel(account);
      if (email === undefined || named.current.has(account.id) || accounts.some((other) => other.label.toLowerCase() === email.toLowerCase())) continue;
      named.current.add(account.id);
      void relabelAccount(runtime, environmentId, account, email, uuidv7(clock.now()), true).then((outcome) => {
        // Keep an in-flight attempt unique, but allow a later account update or reconnection to retry a refusal.
        if (!outcome.ok) named.current.delete(account.id);
      });
    }
  }, [runtime, environmentId, accounts, writable]);

  // A name typed that the account cannot have is said here, before the sign-in card, which would ask for another.
  const signInNew = () => {
    const typed = label.trim();
    const problem = typed === "" ? undefined : nameProblem(typed);
    if (problem !== undefined) return setSaid({ ok: false, line: problem });
    signIn({ account: null, label: typed === "" ? newAccountLabel(accounts ?? []) : typed, nameByEmail: typed === "" });
    if (typed !== "") labelTaken?.();
  };
  const adopted = (outcome: AccountOutcome) => {
    if (outcome.ok && label.trim() !== "") labelTaken?.();
    setSaid(outcome);
  };

  return (
    <>
      {!ready && <p className="text-sm text-amber">{unreachedLine(runtime, view, accounts !== null)}</p>}
      {ready && admin.status === "absent" && <AccessUnavailable environmentId={view.environmentId} answer={admin}><p data-phone-grant-guidance={shell === undefined || undefined} className="text-sm text-amber">You can look but not change this. {admin.message}{shell === undefined && " Pair again using a Custom code with admin from a trusted client to sign in or change environment settings."}</p></AccessUnavailable>}
      {ready && <SignInQuestion environmentId={environmentId} computer={computerOf(view)} writable={writable} {...(held ? { held: SIGN_IN_HELD } : {})} label={label.trim()} signIn={signInNew} say={adopted} />}
      {accounts !== null && environments.filter(source => source.environmentId !== environmentId && source.enabled).map(source => (
        <AccountsElsewhere key={source.environmentId} source={source} here={accounts} disabled={!writable || held}
          suggest={(suggestion) => signIn({ account: null, suggestion })} />
      ))}
      {signing !== undefined && <SignInCard key={signing.key} nameByEmail={signing.nameByEmail === true} {...(signing.suggestion === undefined ? {} : { suggestion: signing.suggestion })} {...(signing.label === undefined ? {} : { label: signing.label })} inline={inlineSignIn} environmentId={environmentId} account={signing.account} close={() => setSigning(undefined)}
        succeeded={(line) => setSigning((open) => open?.key === signing.key ? { ...open, succeeded: line } : open)} say={say} />}
      {said !== undefined && <SaidLine said={said} />}
      {accounts === null
        ? ready && (listed.error === null
          ? <p className="text-sm text-ink-faint">Reading the accounts…</p>
          : <>
              <SaidLine said={{ ok: false, line: "agent-harness could not read the accounts. Choose Check again.", details: [listed.error.message] }} />
              <AccountAction icon={RotateCw} variant="outline" className="self-start" onClick={() => runtime.requests.refresh(environmentId, "accounts.list", {})}>Check again</AccountAction>
            </>)
        : accounts.length > 0 && <SettingsCardGrid>{accounts.map((account) => (
            <AccountCard selected={values !== null && account.id === (values["accounts.defaultAccount"] ?? accounts[0]?.id)} key={account.id} environmentId={environmentId} account={account} gauges={gauges} writable={writable} signIn={() => signIn({ account })} {...(held ? { signInHeld: SIGN_IN_HELD } : {})} remove={() => remove(account)} say={setSaid} />
          ))}</SettingsCardGrid>}
      {removing !== undefined && <ConfirmRemove environmentId={environmentId} computer={computerOf(view)} account={removing} close={() => remove(undefined)} say={setSaid} />}
    </>
  );
};


const sameIdentity = (left: AccountIdentity | null, right: AccountIdentity): boolean => left !== null &&
  left.provider === right.provider && left.email.toLowerCase() === right.email.toLowerCase() && left.organisation === right.organisation;

/** Account identity is only a hint: adding here asks this environment's provider CLI to sign in afresh. */
const AccountsElsewhere = ({ source, here, disabled, suggest }: {
  readonly source: EnvironmentView;
  readonly here: readonly AccountRecord[];
  readonly disabled: boolean;
  readonly suggest: (suggestion: { readonly label: string; readonly email: string }) => void;
}) => {
  const runtime = useRuntime();
  const listed = useObservable(useMemo(() => runtime.projections.accounts(source.environmentId), [runtime, source.environmentId]));
  if (source.phase !== "ready") return null;
  const identities = new Set<string>();
  return <>{listed.value?.filter(account => {
    const identity = account.identity;
    if (account.provider !== "claude" || account.status.state !== "signed-in" || identity === null || here.some(held => sameIdentity(held.identity, identity))) return false;
    const key = JSON.stringify([identity.provider, identity.email.toLowerCase(), identity.organisation]);
    if (identities.has(key)) return false;
    identities.add(key);
    return true;
  }).map(account => {
    const identity = account.identity;
    if (identity === null) return null;
    let label = account.label;
    for (let number = 2; here.some(held => held.label.toLowerCase() === label.toLowerCase()); number++) {
      const suffix = ` (${number})`;
      label = account.label.slice(0, 200 - suffix.length).trimEnd() + suffix;
    }
    return <div key={account.id} role="group" aria-label={`${identity.email} on ${nameOf(source)}`} className="flex flex-wrap items-center gap-2 text-sm">
      <span>{identity.email} is signed in on {nameOf(source)}. Each computer signs in on its own.</span>
      <AccountAction icon={Plus} disabled={disabled} onClick={() => suggest({ label, email: identity.email })}>Sign in here too</AccountAction>
    </div>;
  })}</>;
};
