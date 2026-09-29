import {
  ACCOUNT_STATUS_WORDS,
  BETWEEN_ENVIRONMENTS,
  gaugeOf,
  handOff,
  handedOffAlreadyWords,
  handingOffWords,
  identityWords,
  readingWords,
} from "@agent-harness/client-runtime";
import type { AccountRecord } from "@agent-harness/contracts";
import { useMemo } from "react";
import { THIS_MACHINE } from "../frame/sidebar-region.js";
import { usePaneLine } from "../session/pane-line.js";
import { classes } from "../ui/classes.js";
import { Dialog, DialogContent } from "../ui/index.js";
import { useFollowed, useObservable, usePresentation, useRuntime } from "../window-context.js";
import { useHandedOnto, useKeepHandedOnto } from "./run-choices.js";

/**
 * The hand-off onto another account (docs/specs/gui.md, "A session pane";
 * ADR 0015: the hand-off on one environment; #402). A session's account is
 * fixed (`runs.start` takes none), so the hand-off is the runtime's fork of
 * the whole session onto the account (`handOff`, `commands.fork` with
 * `account`), which carries the source's draft onto the fork; the fork opens
 * in the pane, and the source stays as it is.
 */

/**
 * What choosing an account for the session does: an account the session is
 * on already says so; any other is handed off onto, the fork opened in the
 * pane once the environment accepts it. The line says a refusal.
 */
export const useHandOffOnto = (environmentId: string, sessionId: string): ((account: AccountRecord) => void) => {
  const runtime = useRuntime();
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const handedOnto = useHandedOnto(environmentId, sessionId);
  const keep = useKeepHandedOnto();
  const [, setLayout] = usePresentation("paneLayout");
  const [, say] = usePaneLine();
  const from = projection.summary?.title ?? "this session";
  const current = projection.summary?.accountId ?? handedOnto ?? null;
  return (account) => {
    if (account.id === current) return say(handedOffAlreadyWords(from, account));
    const forking = runtime.capability(environmentId, "sessions.fork");
    if (forking.status === "absent") return say(`Not handed off: ${forking.message}`);
    say(handingOffWords(from, account));
    void handOff(runtime, environmentId, sessionId, account, from).then((handed) => {
      if (!handed.ok) return say(handed.line);
      keep(environmentId, handed.sessionId, account.id);
      setLayout({ session: { environmentId, sessionId: handed.sessionId } });
    });
  };
};

export interface HandoffPickerProps {
  readonly environmentId: string;
  readonly sessionId: string;
  /** Opens the sign-in card for an account not signed in. */
  readonly signIn: (account: AccountRecord) => void;
  readonly close: () => void;
}

/**
 * The hand-off picker (#147's, in the window): the session's environment's
 * accounts, each with its identity, its sign-in status and its identity's
 * plan reading, the one the environment recommends marked and its sentence
 * over the list; last, another environment, absent with its reason
 * (milestone 2). Choosing a signed-in account hands the session off onto
 * it; one not signed in starts its sign-in. The status line's offer opens
 * it, and so does Fork onto another account under a message.
 */
export const HandoffPicker = ({ environmentId, sessionId, signIn, close }: HandoffPickerProps) => {
  const runtime = useRuntime();
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId]));
  const usage = useObservable(runtime.projections.usage);
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const environments = useObservable(runtime.projections.environments);
  const handedOnto = useHandedOnto(environmentId, sessionId);
  const current = projection.summary?.accountId ?? handedOnto ?? null;
  const recommendation = useFollowed(
    useMemo(() => (current === null ? undefined : runtime.requests.cached(environmentId, "accounts.handoff.recommend", { fromAccountId: current })), [runtime, environmentId, current]),
  )?.result;
  const handOffOnto = useHandOffOnto(environmentId, sessionId);
  const environment = environments.find((view) => view.environmentId === environmentId)?.name ?? THIS_MACHINE;
  const title = projection.summary?.title ?? "this session";

  const choose = (account: AccountRecord) => {
    close();
    if (account.status.state !== "signed-in") return signIn(account);
    handOffOnto(account);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent title={`Hand off ${title} on ${environment}`} description={recommendation?.message} className="max-w-lg">
        {accounts.value === null ? (
          <p className="text-sm text-ink-faint">{accounts.error ? `The accounts could not be read: ${accounts.error.message}` : "Reading the accounts…"}</p>
        ) : (
          <ul aria-label="Accounts" className="flex flex-col gap-1">
            {accounts.value.map((account) => {
              const notes = [ACCOUNT_STATUS_WORDS[account.status.state], ...(account.id === current ? ["this session"] : []), ...(account.id === recommendation?.accountId ? ["recommended"] : [])];
              const reading = readingWords(gaugeOf(usage.gauges, environmentId, account.id));
              return (
                <li key={account.id}>
                  <button
                    type="button"
                    onClick={() => choose(account)}
                    className={classes(
                      "flex w-full flex-col items-start rounded-md px-3 py-2 text-left text-sm hover:bg-wash focus-visible:outline-2 focus-visible:outline-beam",
                      account.id === recommendation?.accountId && "bg-wash",
                    )}
                  >
                    <span>
                      <span className="font-medium">{account.label}</span> <span className="text-ink-muted">{identityWords(account)}</span>{" "}
                      <span className="text-xs text-ink-faint">{notes.join(" · ")}</span>
                    </span>
                    {reading !== undefined && <span className="text-xs text-ink-faint">{reading}</span>}
                  </button>
                </li>
              );
            })}
            <li aria-disabled="true" className="flex flex-col px-3 py-2 text-sm text-ink-faint">
              <span>On another environment</span>
              <span className="text-xs">{BETWEEN_ENVIRONMENTS}</span>
            </li>
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
};
