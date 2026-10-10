import { KeyRound, LogIn, Plus, RefreshCw, Star, X } from "lucide-react";
import { ActionButton as Button, AccessField as Field } from "../key-managers/action-button.js";
import {
  FORGE_KIND_WORDS,
  addForgeAlias,
  capabilityName,
  capabilityStateWords,
  forgeAccountName,
  forgeAliasWords,
  forgeProblemAction,
  forgeRowProblem,
  forgeRowState,
  setPrimaryForge,
  signInForgeAgain,
  verifyForge,
  type ForgeOutcome,
  type ForgeProblemAction,
  type ForgeRefused,
} from "@agent-harness/client-runtime";
import { FORGE_CAPABILITIES, forgeOriginHost, forgeTokenPages, type ForgeAccountRecord, type ForgeCapabilities } from "@agent-harness/contracts";
import { useId, useState, type FormEvent } from "react";
import { HealthDot, STATE_WORDS } from "../setup/health-dot.js";
import { useChecklist } from "../setup/checklist-window.js";
import { Fact, Fold, Input, StatusDot, ToneBadge } from "../ui/index.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";
import { TokenSteps } from "./add-forge.js";
import type { ForgeCardProps } from "./forge-card.js";
import { KeepInKeyManager } from "./keep-in-key-manager.js";
import { ForgeDetails, RefusalLine } from "./refusal-line.js";

/** What fixes a problem, as its button says it (setup-copy.md §5.6): a forge copied with no token takes its first one. */
const problemActionWords = (action: ForgeProblemAction, account: Pick<ForgeAccountRecord, "problem">): string => {
  switch (action) {
    case "check-again":
      return "Check again";
    case "key-manager":
      return "Go to Key manager";
    case "sign-in-again":
      return account.problem?.kind === "needs-credential" ? "Add token" : "Add a new token";
  }
};

/**
 * A forge account's row on the Forges step's card (setup-copy.md §5.6; ADR
 * 0020, ADR 0032; #589, #1849), from `forge.accounts.list`'s record as the
 * request cache holds it: `{login} on {host}` with the Main forge badge or
 * Make main and its state word; its kind; what the token can do, each in
 * words; its problem's line with the button that fixes it (Check again, Add
 * a new token in place of the token, or Go to Key manager for a reference)
 * and its raw facts under Details; under More options its other addresses,
 * each verified before it is used; and on a stored token, Keep this token in
 * your key manager while one is connected. No expiry is drawn, an `expiring`
 * problem's line included: the card's thirty-day warning is milestone 2's
 * (ADR 0033), and the step's own line above says it.
 */
export const ForgeAccountRow = ({ environmentId, account, writable, say }: ForgeCardProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const { choose } = useChecklist();
  const heading = useId();
  const computer = useComputerName(environmentId);
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<ForgeRefused | undefined>(undefined);
  const [signingIn, setSigningIn] = useState(false);
  const [more, setMore] = useState(false);
  const sender = { runtime, clock };
  const problem = forgeRowProblem(account);
  const action = forgeProblemAction(account);
  const state = forgeRowState(account);
  const send = (verb: () => Promise<ForgeOutcome>) => {
    setRefused(undefined);
    setSending(true);
    void verb().then((done) => {
      setSending(false);
      if (!done.ok) return setRefused(done);
      say(done.line);
    });
  };
  const act = (chosen: ForgeProblemAction) => {
    switch (chosen) {
      case "check-again":
        return send(() => verifyForge(runtime, environmentId, account));
      case "key-manager":
        return choose("key-manager");
      case "sign-in-again":
        return setSigningIn(true);
    }
  };
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3 rounded-lg border border-hairline bg-panel p-3">
      <header className="flex flex-wrap items-center gap-2">
        <h3 id={heading} className="min-w-0 break-all text-xs font-semibold text-ink">
          {forgeAccountName(account)}
        </h3>
        {account.primary ? (
          <ToneBadge tone="warning">
            <Star aria-hidden="true" />
            Main forge
          </ToneBadge>
        ) : (
          <Button icon={Star} label="Make main" disabled={!writable || sending} onClick={() => send(() => setPrimaryForge(sender, environmentId, account))}>
            Make main
          </Button>
        )}
        <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
          <HealthDot state={state} />
          {STATE_WORDS[state]}
        </span>
      </header>
      <dl className="grid grid-cols-[minmax(0,112px)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <Fact name="Kind">{FORGE_KIND_WORDS[account.kind]}</Fact>
      </dl>
      <CapabilityList capabilities={account.capabilities} />
      {problem !== null && (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-amber">{problem.message}</p>
            {action !== null && (
              // Go to Key manager is only a way there; the rest change the forge account.
              <Button
                icon={action === "check-again" ? RefreshCw : action === "key-manager" ? KeyRound : LogIn}
                label={problemActionWords(action, account)}
                disabled={action !== "key-manager" && (!writable || sending)}
                onClick={() => act(action)}
              >
                {problemActionWords(action, account)}
              </Button>
            )}
          </div>
          <ForgeDetails line={problem.message} details={problem.details ?? []} computer={computer} />
        </div>
      )}
      {refused !== undefined && <RefusalLine refused={refused} computer={computer} />}
      {signingIn && <NewToken environmentId={environmentId} account={account} computer={computer} close={() => setSigningIn(false)} say={say} />}
      {account.credential.kind === "stored" && <KeepInKeyManager environmentId={environmentId} />}
      <Fold summary="More options" open={more} onOpenChange={setMore}>
        <OtherAddresses environmentId={environmentId} account={account} writable={writable} say={say} computer={computer} />
      </Fold>
    </section>
  );
};

/** The environment's name, as Details names the computer a command went to. */
const useComputerName = (environmentId: string): string => {
  const runtime = useRuntime();
  return useObservable(runtime.projections.environments).find((view) => view.environmentId === environmentId)?.name ?? "the computer";
};

/** What the token can do, each capability and where it stands in words beside its dot (setup-copy.md §5.6): never in a tooltip alone. */
export const CapabilityList = ({ capabilities }: { readonly capabilities: ForgeCapabilities }) => (
  <ul aria-label="What the token can do" className="flex flex-col gap-0.5 text-xs text-ink-muted">
    {FORGE_CAPABILITIES.map((name) => {
      const capability = capabilities[name];
      return (
        <li key={name} className="inline-flex items-center gap-1.5">
          <StatusDot tone={capability.state === "verified" ? "success" : capability.state === "failed" ? "danger" : "neutral"} />
          {capabilityName(name)}: {capabilityStateWords(capability)}
        </li>
      );
    })}
  </ul>
);

/**
 * Add a new token in place of the forge account's (`forge.accounts.update`,
 * sent directly), under the token steps for its site and kind. The token
 * stays typed after a refusal, said in one plain line with Details here;
 * once taken the form closes, saying so on the card.
 */
const NewToken = ({ environmentId, account, computer, close, say }: Omit<ForgeCardProps, "writable"> & { readonly computer: string; readonly close: () => void }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [token, setToken] = useState("");
  const [refused, setRefused] = useState<Pick<ForgeRefused, "line" | "details"> | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const site = forgeOriginHost(account.origin);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim() === "") return setRefused({ line: "Paste the token here.", details: [] });
    setRefused(undefined);
    setSending(true);
    void signInForgeAgain({ runtime, clock }, environmentId, account, token).then((done) => {
      setSending(false);
      if (!done.ok) return setRefused(done);
      close();
      say(done.line);
    });
  };
  return (
    <form aria-label={`A new token for ${forgeAccountName(account)}`} className="flex flex-col gap-2 text-sm" onSubmit={submit}>
      <TokenSteps site={site} page={forgeTokenPages(account.kind, account.origin)[0]}>
        <Field label="Token">
          <Input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button icon={LogIn} label="Add a new token" variant="default" type="submit" disabled={sending}>
            Add a new token
          </Button>
          <Button icon={X} label="Cancel" onClick={close}>
            Cancel
          </Button>
        </div>
      </TokenSteps>
      {refused !== undefined && <RefusalLine refused={refused} computer={computer} />}
    </form>
  );
};

/**
 * Other addresses for this site (setup-copy.md §5.6; ADR 0020): each address
 * the same forge answers on, with its verification, and a field for another,
 * sent with the others in `forge.accounts.update`, which the environment
 * verifies there before it is used. A refusal stays under the field in one
 * plain line with Details, the address typed kept; what it came to is said on
 * the card.
 */
const OtherAddresses = ({ environmentId, account, writable, say, computer }: ForgeCardProps & { readonly computer: string }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const heading = useId();
  const [alias, setAlias] = useState("");
  const [refused, setRefused] = useState<Pick<ForgeRefused, "line" | "details"> | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (alias.trim() === "") return setRefused({ line: "Enter the other address.", details: [] });
    setRefused(undefined);
    setSending(true);
    void addForgeAlias({ runtime, clock }, environmentId, account, alias).then((done) => {
      setSending(false);
      if (!done.ok) return setRefused(done);
      setAlias("");
      say(done.line);
    });
  };
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-2">
      <h4 id={heading} className="text-xs font-semibold text-ink">
        Other addresses for this site
      </h4>
      {account.aliases.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-sm text-ink-muted">
          {account.aliases.map((each) => (
            <li key={each.origin}>
              {each.origin}: {forgeAliasWords(each, account, clock.now())}
            </li>
          ))}
        </ul>
      )}
      <form aria-label={`Add another address for ${forgeAccountName(account)}`} className="flex flex-col gap-1" onSubmit={submit}>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Another address for this site">
            <Input value={alias} placeholder="https://forge.example.test" disabled={!writable} onChange={(event) => setAlias(event.target.value)} />
          </Field>
          <Button icon={Plus} label="Add address" type="submit" disabled={!writable || sending}>
            Add address
          </Button>
        </div>
        {refused !== undefined && <RefusalLine refused={refused} computer={computer} />}
      </form>
    </section>
  );
};
