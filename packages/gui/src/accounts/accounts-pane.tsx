import { SettingsCardGrid } from "../settings/part.js";
import { AccessUnavailable } from "../connections/limited-access.js";
import type { EnvironmentView } from "@agent-harness/client-runtime";
import { settingsRow, type AccountIdentity, type AccountRecord } from "@agent-harness/contracts";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { nameOf } from "../connections/words.js";
import { reachWords } from "../settings/generic-editor.js";
import { StepLinks } from "../settings/step-links.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { AccountAction } from "./action.js";
import { useObservable, useRuntime, useShell } from "../window-context.js";
import { AccountCard } from "./account-card.js";
import { AdoptOffer } from "./adopt-offer.js";
import { ConfirmRemove } from "./confirm-remove.js";
import { SignInCard } from "./sign-in-card.js";

/** The step homed on this row beside Account whose card is not drawn here: its link opens it in Set up. */
const CARRY_OVER = ["carry-over"] as const;

/** The sign-in card the pane has open: on an account, or adding one (`null`). */
type Signing = { readonly account: Pick<AccountRecord, "id" | "label"> | null; readonly suggestion?: { readonly label: string; readonly email: string } };

/**
 * The Accounts row, `accounts.accounts` (docs/specs/gui.md, "Settings";
 * claude-adapter spec, "The account store"; ADR 0018, ADR 0027; #414), on
 * the environment its picker names: a card per account from `accounts.list`
 * in the request cache, which `account.updated` and `signin.updated`
 * refresh, so a change made by another client shows at once; the offer to
 * adopt the machine's own Claude Code sign-in; Add an account… on the
 * sign-in card; and each card's relabel, sign-in and removal. What each did
 * is one line over the cards. The accounts' status is read again as the pane
 * opens on an environment (`accounts.refresh`, ADR 0018). The pane keeps
 * nothing of the accounts itself (ADR 0004). Carry over, homed here beside
 * Account, is its step's card in Set up, which a link opens.
 *
 * Without `admin` it is read-only with the capability's line; while the
 * environment cannot be reached it shows the accounts as this window last
 * read them, read-only, with since when.
 */
export const AccountsPane = () => {
  const picked = usePickedEnvironment();
  return picked === undefined ? null : <AccountsOn key={picked.environmentId} view={picked} />;
};

const AccountsOn = ({ view }: { readonly view: EnvironmentView }) => (
  <>
    <p className="text-2xs leading-relaxed text-ink-faint">{settingsRow("accounts.accounts").hint}</p>
    <AccountsList view={view} add="Add an account…" inlineSignIn />
    <StepLinks steps={CARRY_OVER} />
  </>
);

export interface AccountsListProps {
  readonly view: EnvironmentView;
  /** What the button that adds an account, on the sign-in card, says. */
  readonly add: string;
  readonly inlineSignIn?: boolean;
}

/**
 * An environment's accounts as the Accounts row and the Account step's card
 * draw them (#414, #575): the status read again as it opens; while the
 * environment cannot be reached, the accounts as this window last read them,
 * read-only, with since when; without `admin`, read-only with the
 * capability's line; the offer of the machine's own sign-in; the button that
 * adds an account on the sign-in card; what a command did in one line; and
 * a card per account.
 */
export const AccountsList = ({ view, add, inlineSignIn = false }: AccountsListProps) => {
  const runtime = useRuntime();
  const shell = useShell();
  const { environmentId } = view;
  const environments = useObservable(runtime.projections.environments);
  const listed = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId]));
  const { values } = useSettingsValues(environmentId);
  const { gauges } = useObservable(runtime.projections.usage);
  const [line, say] = useState<string | undefined>(undefined);
  const [signing, signIn] = useState<Signing | undefined>(undefined);
  const [removing, remove] = useState<AccountRecord | undefined>(undefined);
  const ready = view.phase === "ready";
  const admin = runtime.capability(environmentId, "accounts.adopt");
  const writable = ready && admin.status === "present";

  // The status read again as the list opens on the environment, and as it is reached again; what it records is noticed.
  useEffect(() => {
    if (ready) void runtime.requests.call(environmentId, "accounts.refresh", {});
  }, [runtime, environmentId, ready]);

  const accounts = listed.value;
  return (
    <>
      {!ready && (
        <p className="text-sm text-amber">
          {reachWords(runtime, view)}: {accounts === null ? "this window has read none of its accounts." : "its accounts as this window last read them, read-only."}
        </p>
      )}
      {ready && admin.status === "absent" && <AccessUnavailable environmentId={view.environmentId} answer={admin}><p data-phone-grant-guidance={shell === undefined || undefined} className="text-sm text-amber">Read-only: {admin.message}{shell === undefined && " Pair again using a Custom code with admin from a trusted client to sign in or change environment settings."}</p></AccessUnavailable>}
      {ready && <AdoptOffer environmentId={environmentId} environment={nameOf(view)} writable={writable} say={say} />}
      <div className="flex flex-wrap gap-2">
        <AccountAction icon={Plus} variant="default" disabled={!writable || signing !== undefined} onClick={() => signIn({ account: null })}>
          {add}
        </AccountAction>
      </div>
      {accounts !== null && environments.filter(source => source.environmentId !== environmentId && source.enabled).map(source => (
        <AccountsElsewhere key={source.environmentId} source={source} here={accounts} disabled={!writable || signing !== undefined}
          suggest={(suggestion) => signIn({ account: null, suggestion })} />
      ))}
      {signing !== undefined && <SignInCard {...(signing.suggestion === undefined ? {} : { suggestion: signing.suggestion })} inline={inlineSignIn} environmentId={environmentId} account={signing.account} close={() => signIn(undefined)} say={say} />}
      {line !== undefined && <p className="text-sm text-ink-muted">{line}</p>}
      {accounts === null
        ? ready && <p className="text-sm text-ink-faint">{listed.error === null ? "Reading the accounts…" : `The accounts could not be read: ${listed.error.message}`}</p>
        : accounts.length === 0
          ? <p className="text-sm text-ink-muted">No account is held here.</p>
          : <SettingsCardGrid>{accounts.map((account) => (
              <AccountCard selected={values !== null && account.id === (values["accounts.defaultAccount"] ?? accounts[0]?.id)} key={account.id} environmentId={environmentId} account={account} gauges={gauges} writable={writable} signIn={() => signing === undefined && signIn({ account })} remove={() => remove(account)} say={say} />
            ))}</SettingsCardGrid>}
      {removing !== undefined && <ConfirmRemove environmentId={environmentId} environment={nameOf(view)} account={removing} close={() => remove(undefined)} say={say} />}
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
      <span>{identity.email} on {nameOf(source)}</span>
      <AccountAction icon={Plus} disabled={disabled} onClick={() => suggest({ label, email: identity.email })}>Sign in this account here too</AccountAction>
    </div>;
  })}</>;
};
