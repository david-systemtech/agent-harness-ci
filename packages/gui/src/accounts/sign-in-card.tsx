import { addAccount, cancelSignIn, fallbackOf, followedSignIn, labelProblem, sendSignInCode, signInEnd, startSignIn, uuidv4 } from "@agent-harness/client-runtime";
import type { AccountRecord } from "@agent-harness/contracts";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { THIS_MACHINE } from "../frame/sidebar-region.js";
import { Button, Dialog, DialogContent, Input } from "../ui/index.js";
import { useFollowed, useObservable, useRuntime, useShell } from "../window-context.js";

export interface SignInCardProps {
  readonly environmentId: string;
  /** The account to sign in; null to add a new one, labelled first. */
  readonly account: AccountRecord | null;
  /** Closes the card. */
  readonly close: () => void;
  /** Says one line where the card was opened from: how the sign-in ended, or why it could not go on. */
  readonly say: (line: string) => void;
}

/** The command on its way, whose answer the card waits for: the new account, the sign-in's start, or the code. */
type Sending = "add" | "start" | "code" | null;

/**
 * The sign-in card (docs/specs/gui.md, "A session pane": Add an account with
 * the sign-in card; ADR 0018; #147's card in the window, #402), which the
 * account picker, the hand-off picker and the Accounts pane open. The rules
 * are the client runtime's (`status/sign-in.ts`), so the terminal UI's card
 * runs the same:
 *
 * - **A new account** is labelled first, then added (`accounts.add`), which
 *   starts its sign-in; **an account not signed in** has its sign-in
 *   started (`accounts.signin.start`).
 * - The card follows the environment's sign-in through `accounts.signin.get`
 *   in the request cache: "Starting the sign-in…", then the verification URL,
 *   opened in the system browser through the shell's `openExternal` as it
 *   arrives (and again on a press), the code pasted and sent with
 *   `accounts.signin.code` ("Checking the code…"), and the fallback command
 *   for a terminal on the environment's machine under it.
 * - A sign-in the card follows that ends closes it, its end said in one line
 *   where the card was opened; so is a refusal of the start. Closing the
 *   card cancels the sign-in it started (`accounts.signin.cancel`), since
 *   the card is its attendant.
 */
export const SignInCard = ({ environmentId, account, close, say }: SignInCardProps) => {
  const runtime = useRuntime();
  const shell = useShell();
  const environments = useObservable(runtime.projections.environments);
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId]));
  const held = useFollowed(useMemo(() => runtime.requests.cached(environmentId, "accounts.signin.get", {}), [runtime, environmentId]))?.result?.signIn;
  const environment = environments.find((view) => view.environmentId === environmentId)?.name ?? THIS_MACHINE;
  const [label, setLabel] = useState(account?.label ?? "");
  const [accountId, setAccountId] = useState<string | null>(account?.id ?? null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [sending, setSending] = useState<Sending>(account === null ? null : "start");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const opened = useRef<string | null>(null);
  const ended = useRef(false);

  const followed = followedSignIn(held, { accountId, startedAt, starting: sending === "start" });
  const end = followed ? signInEnd(followed, label, environment) : undefined;
  const openExternal = runtime.capability(environmentId, "shell.openExternal");
  const url = followed?.url ?? null;

  // An account given is signed in as the card opens.
  useEffect(() => {
    if (account === null) return;
    void startSignIn(runtime, environmentId, account, uuidv4()).then((started) => {
      if (!started.ok) {
        ended.current = true;
        close();
        return say(started.line);
      }
      setStartedAt(started.startedAt);
      setSending(null);
    });
  }, []);

  // A sign-in the card follows that ends closes it, its end said in one line.
  useEffect(() => {
    if (end === undefined || ended.current) return;
    ended.current = true;
    close();
    say(end);
  }, [end]);

  // The verification URL opens in the system browser as it arrives, once.
  useEffect(() => {
    if (url === null || opened.current === url || openExternal.status === "absent") return;
    opened.current = url;
    void shell?.openExternal?.(url);
  }, [url]);

  const add = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = typed.trim();
    const problem = labelProblem(trimmed);
    if (problem !== undefined) return setError(problem);
    setLabel(trimmed);
    setSending("add");
    setError(null);
    void addAccount(runtime, environmentId, trimmed, uuidv4(), environment).then((added) => {
      if (added.kind === "refused") {
        setSending(null);
        return setError(added.line);
      }
      if (added.kind === "added") {
        ended.current = true;
        close();
        return say(added.line);
      }
      setAccountId(added.account.id);
      setTyped("");
      setSending(null);
    });
  };

  const sendCode = (event: FormEvent) => {
    event.preventDefault();
    if (typed.trim() === "" || accountId === null) return;
    setSending("code");
    setError(null);
    void sendSignInCode(runtime, environmentId, accountId, typed, uuidv4()).then((refused) => {
      setSending(null);
      if (refused === undefined) setTyped("");
      else setError(refused);
    });
  };

  /** Leaving the card: the sign-in it started is its to end, so it is cancelled whatever state it has reached. */
  const leave = () => {
    close();
    if (accountId === null || ended.current) return;
    ended.current = true;
    void cancelSignIn(runtime, environmentId, { id: accountId, label }, uuidv4(), environment).then(say);
  };

  const directory = accounts.value?.find((candidate) => candidate.id === accountId)?.directory.path;
  const labelling = accountId === null && sending !== "add";
  const showsPage = url !== null && (followed?.state === "awaiting-code" || followed?.state === "submitting" || sending === "code");
  const checking = sending === "code" || followed?.state === "submitting";
  const takesCode = followed?.state === "awaiting-code" && sending === null;

  return (
    <Dialog open onOpenChange={(open) => !open && leave()}>
      <DialogContent title={account === null && accountId === null ? `Add an account on ${environment}` : `Sign in: ${label} on ${environment}`} className="max-w-lg">
        {labelling ? (
          <form aria-label="Add an account" className="flex flex-col gap-1.5" onSubmit={add}>
            <label className="flex flex-col gap-1 text-sm">
              Label for the new account
              <Input value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus />
            </label>
            <p className="text-xs text-ink-faint">The email it signs in as makes a good label.</p>
            {error !== null && <p className="text-xs text-signal">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button onClick={leave}>Cancel</Button>
              <Button tone="primary" type="submit">
                Add
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            {showsPage && (
              <>
                <p>Open this page and sign in:</p>
                <p className="break-all font-mono text-xs text-beam-text">{url}</p>
                <Button
                  className="self-start"
                  aria-disabled={openExternal.status === "absent" ? true : undefined}
                  title={openExternal.status === "absent" ? openExternal.message : undefined}
                  onClick={() => (openExternal.status === "absent" ? setError(openExternal.message) : void shell?.openExternal?.(url))}
                >
                  Open the sign-in page
                </Button>
              </>
            )}
            {sending === "add" && <p className="text-ink-faint">Adding {label}…</p>}
            {sending !== "add" && (checking ? <p className="text-ink-faint">Checking the code…</p> : (!followed || followed.state === "starting" || sending === "start") && <p className="text-ink-faint">Starting the sign-in…</p>)}
            {takesCode && (
              <form aria-label="Send the code" className="flex flex-col gap-1.5" onSubmit={sendCode}>
                <label className="flex flex-col gap-1">
                  Then paste the code it shows
                  <Input value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus />
                </label>
                <Button tone="primary" type="submit" className="self-end" disabled={typed.trim() === ""}>
                  Send the code
                </Button>
              </form>
            )}
            {error !== null && <p className="text-xs text-signal">{error}</p>}
            {followed && (
              <>
                <p className="text-xs text-ink-faint">Or run this in a terminal on {environment}'s machine:</p>
                <code className="break-all rounded-md bg-inset px-2 py-1 font-mono text-xs">{fallbackOf(followed, directory)}</code>
              </>
            )}
            <Button className="self-end" onClick={leave}>
              Cancel the sign-in
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
