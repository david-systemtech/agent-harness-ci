import {
  ACCOUNT_STATUS_WORDS,
  BETWEEN_ENVIRONMENTS,
  gaugeOf,
  handOff,
  handedOffAlreadyWords,
  handingOffWords,
  identityWords,
  oneLine,
  readingWords,
} from "@agent-harness/client-runtime";
import type { AccountRecord } from "@agent-harness/contracts";
import { useMemo, useRef, useState } from "react";
import { THIS_MACHINE } from "../frame/sidebar-region.js";
import { useMessageLine, useOpenInPane, usePaneLine, useSayUnder } from "../session/pane-line.js";
import { classes } from "../ui/classes.js";
import { DialogAction as Button } from "../ui/dialog-action.js";
import { ArrowRightLeft, UserRound, X } from "lucide-react";
import { DialogFooter } from "../ui/dialog.js";
import { Dialog, DialogContent, Tooltip } from "../ui/index.js";
import { useFollowed, useObservable, useRuntime } from "../window-context.js";
import type { MessageAnchor } from "./pane-dialogs.js";
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
 * pane once the environment accepts it. With `at`, a user message (Fork onto
 * another account, #403), the fork is taken before it, the message its
 * draft, and the line is said under the message; else on the pane's line.
 * The line says a refusal.
 */
export const useHandOffOnto = (environmentId: string, sessionId: string, at: MessageAnchor | null = null): ((account: AccountRecord) => Promise<boolean>) => {
  const runtime = useRuntime();
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const handedOnto = useHandedOnto(environmentId, sessionId);
  const keep = useKeepHandedOnto();
  const openInPane = useOpenInPane();
  const [, sayOnPane] = usePaneLine();
  const sayUnder = useSayUnder();
  const say = (line: string) => (at === null ? sayOnPane(line) : sayUnder(at.messageId, line));
  const from = projection.summary?.title ?? "this session";
  const current = projection.summary?.accountId ?? handedOnto ?? null;
  return async (account) => {
    if (account.id === current) { say(handedOffAlreadyWords(from, account)); return true; }
    const forking = runtime.capability(environmentId, "sessions.fork");
    if (forking.status === "absent") { say(`Not handed off: ${forking.message}`); return false; }
    say(handingOffWords(from, account));
    try {
      const handed = await handOff(runtime, environmentId, sessionId, account, from, at?.messageId);
      if (!handed.ok) { say(handed.line); return false; }
      keep(environmentId, handed.sessionId, account.id);
      openInPane(environmentId, handed.sessionId);
      return true;
    } catch (error) {
      say(`Not handed off: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
};

export interface HandoffPickerProps {
  readonly environmentId: string;
  readonly sessionId: string;
  /** The user message the fork is taken before (Fork onto another account); null for the whole session. */
  readonly at?: MessageAnchor | null;
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
 * it, and so does Fork onto another account under a message, anchored
 * there: it says so under its title, and the fork holds what came before the
 * message, the message its draft.
 */
export const HandoffPicker = ({ environmentId, sessionId, at = null, signIn, close }: HandoffPickerProps) => {
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
  const handOffOnto = useHandOffOnto(environmentId, sessionId, at);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [paneLine, say] = usePaneLine();
  const messageLine = useMessageLine(at?.messageId ?? "");
  const line = at === null ? paneLine : messageLine;
  const catalogues = useObservable(useMemo(() => runtime.projections.models(environmentId), [runtime, environmentId]));
  const offer = runtime.capability(environmentId, "sessions.fork");
  const environment = environments.find((view) => view.environmentId === environmentId)?.name ?? THIS_MACHINE;
  const title = projection.summary?.title ?? "this session";

  const choose = async (account: AccountRecord) => {
    if (submitting.current) return;
    if (account.status.state !== "signed-in") { close(); return signIn(account); }
    submitting.current = true;
    setBusy(true);
    const accepted = await handOffOnto(account);
    submitting.current = false;
    setBusy(false);
    if (accepted) close();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting.current && close()}>
      <DialogContent title={`Hand off ${title} on ${environment}`} description={recommendation?.message} showClose={!busy} className="max-w-[35rem] max-h-[calc(100dvh-4rem)] overflow-y-auto" onEscapeKeyDown={(event) => { if (submitting.current) event.preventDefault(); }} onPointerDownOutside={(event) => { if (submitting.current) event.preventDefault(); }}>
        {at !== null && (
          <p className="text-sm text-ink-muted">{`Forks before ${oneLine(at.text, 80)}: the new session holds what came before it, with it as its draft.`}</p>
        )}
        {accounts.value === null ? (
          <p className="text-sm text-ink-faint">{accounts.error ? `The accounts could not be read: ${accounts.error.message}` : "Reading the accounts…"}</p>
        ) : (
          <ul aria-label="Accounts" className="flex flex-col gap-1">
            {accounts.value.map((account) => {
              const notes = [ACCOUNT_STATUS_WORDS[account.status.state], ...(account.id === current ? ["this session"] : []), ...(account.id === recommendation?.accountId ? ["recommended"] : [])];
              const reading = readingWords(gaugeOf(usage.gauges, environmentId, account.id));
              const blocked = account.status.state === "signed-in" && account.id !== current && offer.status === "absent" ? offer.message : undefined;
              const models = catalogues.value?.find((catalogue) => catalogue.accountId === account.id)?.models;
              return (
                <li key={account.id}>
                  <Tooltip content={blocked ? `${account.label} · ${blocked}` : account.label} keys="Enter / Space">
                  <span role={blocked ? "group" : undefined} tabIndex={blocked ? 0 : undefined} aria-label={blocked ? `${account.label} · ${blocked}` : undefined} className="block rounded-lg focus-visible:outline-2 focus-visible:outline-beam">
                  <button
                    type="button"
                    disabled={busy || blocked !== undefined}
                    onClick={() => void choose(account)}
                    className={classes(
                      "flex w-full flex-col items-start gap-1 rounded-lg border border-hairline px-3 py-2 text-left text-sm hover:bg-raised focus-visible:outline-2 focus-visible:outline-beam disabled:opacity-50",
                      account.id === recommendation?.accountId && "bg-wash",
                    )}
                  >
                    <span className="flex flex-wrap items-center gap-1">
                      <UserRound aria-hidden="true" className="size-4" /><span className="font-medium">{account.label}</span> <span className="text-ink-muted">{identityWords(account)}</span>{" "}
                      <span className="text-xs text-ink-faint">{notes.join(" · ")}</span>
                    </span>
                    {reading !== undefined && <span className="text-xs text-ink-faint">{reading}</span>}
                    {models !== undefined && <span className="font-mono text-xs text-ink-muted">Models: {models.length === 0 ? "none available" : models.map((model) => model.label ?? model.id).join(", ")}</span>}
                    {blocked !== undefined && <span className="text-xs text-signal">{blocked}</span>}
                  </button>
                  </span>
                  </Tooltip>
                </li>
              );
            })}
            <li aria-disabled="true" className="flex flex-col px-3 py-2 text-sm text-ink-faint">
              <span>On another environment</span>
              <span className="text-xs">{BETWEEN_ENVIRONMENTS}</span>
            </li>
          </ul>
        )}
        {busy && <p role="status" className="text-sm text-ink-muted">Handing off…</p>}
        {!busy && line?.startsWith("Not handed off:") && <p role="status" className="text-sm text-signal">{line}</p>}
        <DialogFooter><Button icon={ArrowRightLeft} disabled={busy} onClick={() => { say("Keep working on this session with its current account."); close(); }}>Keep working here</Button><Button icon={X} keys="Escape" disabled={busy} onClick={close}>Cancel</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
