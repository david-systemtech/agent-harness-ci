import { CapabilityDots } from "./capability-dots.js";
import { LogIn, Plus, Star, X } from "lucide-react";
import { ActionButton as Button, AccessField as Field } from "../key-managers/action-button.js";
import {
  FORGE_KIND_WORDS,
  SETUP_ACTION_WORDS,
  addForgeAlias,
  forgeAliasWords,
  forgeIdentityWords,
  forgeProblemAction,
  forgeRowProblem,
  setPrimaryForge,
  signInForgeAgain,
  verifyForge,
  type ForgeProblemAction,
} from "@agent-harness/client-runtime";
import { forgeTokenPages } from "@agent-harness/contracts";
import { useId, useState, type FormEvent } from "react";
import { MoveToKeyManager } from "../key-managers/move-card.js";
import { useChecklist } from "../setup/checklist-window.js";
import { Fact, Input } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";
import { TokenPages } from "./add-forge.js";
import { useForgeVerb, type ForgeCardProps } from "./forge-card.js";

/** What each problem action's button says. */
const PROBLEM_ACTION_WORDS: { readonly [Action in ForgeProblemAction]: string } = {
  "check-again": SETUP_ACTION_WORDS["check-again"],
  "key-manager": "Open Key manager",
  "sign-in-again": SETUP_ACTION_WORDS["sign-in-again"],
};

/**
 * A forge account's row on the Forges step's card (the Set up
 * specification, "4. Forges"; ADR 0020, ADR 0032; #589), from
 * `forge.accounts.list`'s record as the request cache holds it: its origin
 * with the primary star, or Make primary; its aliases with their
 * verification; its kind and who it answers as; each capability with its
 * dot; its problem's line with the action that fixes it (Check again,
 * Sign in again with a new token, or the Key manager step for a reference);
 * the alias field, whose alias the environment verifies before it is used;
 * and on a stored token, Move to your key manager (the Forges row's, #590).
 * No expiry is drawn, an `expiring` problem's line included: the card's
 * thirty-day warning is milestone 2's (ADR 0033), and the step's own line
 * above says it.
 */
export const ForgeAccountRow = ({ environmentId, account, writable, say }: ForgeCardProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const { choose } = useChecklist();
  const heading = useId();
  const { sending, send } = useForgeVerb(say);
  const [signingIn, setSigningIn] = useState(false);
  const sender = { runtime, clock };
  const problem = forgeRowProblem(account);
  const action = forgeProblemAction(account);
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
        <h3 id={heading} className="text-xs font-semibold text-ink">
          {account.origin}
        </h3>
        {account.primary ? (
          <span role="img" aria-label="Primary forge" className="text-amber">
            <Star aria-hidden="true" className="size-3" />
          </span>
        ) : (
          <Button icon={Star} label="Make primary" disabled={!writable || sending} onClick={() => send(() => setPrimaryForge(sender, environmentId, account))}>
            Make primary
          </Button>
        )}
      </header>
      {account.aliases.length > 0 && (
        <ul aria-label="Aliases" className="flex flex-col gap-0.5 text-sm text-ink-muted">
          {account.aliases.map((alias) => (
            <li key={alias.origin}>
              {alias.origin}: {forgeAliasWords(alias, account, clock.now())}
            </li>
          ))}
        </ul>
      )}
      <dl className="grid grid-cols-[minmax(0,112px)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <Fact name="Kind">{FORGE_KIND_WORDS[account.kind]}</Fact>
        <Fact name="Signed in as">{forgeIdentityWords(account.identity)}</Fact>
      </dl>
      <CapabilityDots capabilities={account.capabilities} />
      {problem !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-amber">{problem.message}</p>
          {action !== null && (
            // The Key manager step is only a way there; the rest change the forge account.
            <Button icon={LogIn} label={PROBLEM_ACTION_WORDS[action]} disabled={action !== "key-manager" && (!writable || sending)} onClick={() => act(action)}>
              {PROBLEM_ACTION_WORDS[action]}
            </Button>
          )}
        </div>
      )}
      {signingIn && <SignInAgain environmentId={environmentId} account={account} close={() => setSigningIn(false)} say={say} />}
      <AliasField environmentId={environmentId} account={account} writable={writable} say={say} />
      {account.credential.kind === "stored" && (
        <div className="flex flex-wrap gap-2">
          <MoveToKeyManager environmentId={environmentId} />
        </div>
      )}
    </section>
  );
};

/**
 * Sign in again: a new token in place of the forge account's credential
 * (`forge.accounts.update`, sent directly), beneath the pages to mint it on
 * with what to grant it. The token leaves the field as it is sent, so a
 * refusal, said in one line here, asks for it again; once signed in again
 * the form closes, saying so on the card.
 */
const SignInAgain = ({ environmentId, account, close, say }: Omit<ForgeCardProps, "writable"> & { readonly close: () => void }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [token, setToken] = useState("");
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim() === "") return setRefused("Paste the token you minted.");
    const sent = token;
    setToken("");
    setRefused(undefined);
    setSending(true);
    void signInForgeAgain({ runtime, clock }, environmentId, account, sent).then((done) => {
      setSending(false);
      if (!done.ok) return setRefused(done.line);
      close();
      say(done.line);
    });
  };
  return (
    <form aria-label={`Sign in again to ${account.origin}`} className="flex flex-col gap-2 text-sm" onSubmit={submit}>
      <TokenPages pages={forgeTokenPages(account.kind, account.origin)} />
      <Field label="Token">
        <Input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />
      </Field>
      {refused !== undefined && <p className="text-sm text-signal">{refused}</p>}
      <div className="flex flex-wrap gap-2">
        <Button icon={LogIn} label="Sign in again" variant="default" type="submit" disabled={sending}>
          Sign in again
        </Button>
        <Button icon={X} label="Cancel" onClick={close}>Cancel</Button>
      </div>
    </form>
  );
};

/**
 * The alias field under a forge account (ADR 0020): another origin the same
 * forge answers on, sent with its aliases in `forge.accounts.update`, which
 * the environment verifies on that origin before it is used. A refusal
 * stays under the field in one line, the alias typed kept; what the alias
 * came to is said on the card.
 */
const AliasField = ({ environmentId, account, writable, say }: ForgeCardProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [alias, setAlias] = useState("");
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (alias.trim() === "") return setRefused("Give the alias's URL.");
    setRefused(undefined);
    setSending(true);
    void addForgeAlias({ runtime, clock }, environmentId, account, alias).then((done) => {
      setSending(false);
      if (!done.ok) return setRefused(done.line);
      setAlias("");
      say(done.line);
    });
  };
  return (
    <form aria-label={`Add an alias to ${account.origin}`} className="flex flex-col gap-1" onSubmit={submit}>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Alias">
          <Input value={alias} placeholder="https://alias.example.test" disabled={!writable} onChange={(event) => setAlias(event.target.value)} />
        </Field>
        <Button icon={Plus} label="Add alias" type="submit" disabled={!writable || sending}>
          Add alias
        </Button>
      </div>
      {refused !== undefined && <p className="text-sm text-signal">{refused}</p>}
    </form>
  );
};
