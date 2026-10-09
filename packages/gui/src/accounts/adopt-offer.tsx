import { adoptAccount, ambientSignIn, uuidv7, type AccountOutcome } from "@agent-harness/client-runtime";
import { KeyRound, LogIn } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { RadioGroup, RadioGroupItem, Tooltip } from "../ui/index.js";
import { AccountAction } from "./action.js";
import { useClock, useFollowed, useRuntime } from "../window-context.js";

export interface SignInQuestionProps {
  readonly environmentId: string;
  /** The computer as a line names it: "this computer", or its name. */
  readonly computer: string;
  /** Whether this client may sign in: the environment reached, with `admin`. */
  readonly writable: boolean;
  /** Why the buttons wait while a sign-in card is open: they are disabled, with this line under them. */
  readonly held?: string;
  /** The name typed for the new account in More options, trimmed; empty for its email (or `Claude account` until signed in). */
  readonly label: string;
  /** Opens the sign-in card on a new account. */
  readonly signIn: () => void;
  /** Says one line in the pane: what using the sign-in did, or why it did not. */
  readonly say: (outcome: AccountOutcome) => void;
}

/** The two answers to the question. */
type Answer = "use" | "sign-in";

/**
 * The Account step's one question (setup-copy.md §5.1; claude-adapter spec,
 * "Adopt reads nothing itself"; ADR 0018; #414, #1842): how to sign in. While
 * Claude Code on this computer is signed in and no account holds it
 * (`accounts.probe` from the request cache, read again on `account.updated`),
 * using its sign-in is a choice, pre-selected, beside Sign in with Claude, and
 * the button does the one chosen: Use this sign-in sends `accounts.adopt`,
 * named by its email unless a name was typed. While Claude Code is here but
 * signed out, a line says so. Sign in with Claude, always there, opens the
 * sign-in card on a new account, with no label form.
 */
export const SignInQuestion = ({ environmentId, computer, writable, held, label, signIn, say }: SignInQuestionProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const heading = useId();
  const why = useId();
  const probed = runtime.capability(environmentId, "accounts.probe").status === "present";
  const probe = useFollowed(useMemo(() => (probed ? runtime.requests.cached(environmentId, "accounts.probe", {}) : undefined), [runtime, environmentId, probed]))?.result;
  const [answer, setAnswer] = useState<Answer>("use");
  const [sending, setSending] = useState(false);
  const ambient = ambientSignIn(probe, computer);
  const offer = ambient?.kind === "offer" ? ambient.choice : undefined;
  const using = offer !== undefined && answer === "use";
  const waits = { disabled: !writable || held !== undefined, ...(held === undefined ? {} : { "aria-describedby": why }) };

  const adopt = () => {
    setSending(true);
    void adoptAccount(runtime, environmentId, label, uuidv7(clock.now())).then((adopted) => {
      setSending(false);
      say(adopted);
    });
  };

  return (
    <section role="group" aria-labelledby={heading} className="flex flex-col gap-2">
      <h3 id={heading} className="text-sm font-medium text-ink">
        How do you want to sign in?
      </h3>
      {ambient?.kind === "signed-out" && <p data-ambient-signed-out className="text-sm text-ink-muted">{ambient.line}</p>}
      {offer !== undefined && (
        <RadioGroup value={answer} onValueChange={(next) => (next === "use" || next === "sign-in") && setAnswer(next)} className="gap-0.5 rounded-lg border border-hairline bg-panel p-1.5">
          <Choice value="use" label={offer} selected={answer === "use"} />
          <Choice value="sign-in" label="Sign in with Claude" selected={answer === "sign-in"} />
        </RadioGroup>
      )}
      <div className="flex flex-wrap gap-2">
        {using ? (
          <AccountAction icon={KeyRound} variant="default" {...waits} disabled={waits.disabled || sending} onClick={adopt}>
            Use this sign-in
          </AccountAction>
        ) : (
          <AccountAction icon={LogIn} variant="default" {...waits} onClick={signIn}>
            Sign in with Claude
          </AccountAction>
        )}
      </div>
      {held !== undefined && <p id={why} className="text-2xs text-ink-muted">{held}</p>}
    </section>
  );
};

/** One answer, as a described choice row (look.md §12.2). */
const Choice = ({ value, label, selected }: { readonly value: Answer; readonly label: string; readonly selected: boolean }) => (
  <label className={`flex items-start gap-2.5 rounded-md px-2.5 py-2 hover:bg-wash ${selected ? "bg-wash-strong" : ""}`}>
    <Tooltip content={label} keys="Arrow keys, Space">
      <RadioGroupItem value={value} aria-label={label} className="mt-[3px]" />
    </Tooltip>
    <span className="min-w-0 text-sm text-ink">{label}</span>
  </label>
);
