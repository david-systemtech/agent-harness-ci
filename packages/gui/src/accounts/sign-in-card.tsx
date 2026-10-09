import { LOCAL_PLACEHOLDER_ID, addAccount, cancelSignIn, fallbackOf, followedSignIn, labelProblem, sendSignInCode, signInEnd, signInFailed, signInLeftWords, startSignIn, uuidv4 } from "@agent-harness/client-runtime";
import { Check, Copy, ExternalLink, KeyRound, LoaderCircle, Plus, Send, X } from "lucide-react";
import { SignInCode, type AccountRecord } from "@agent-harness/contracts";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useEnvironmentCountdown } from "../environment-countdown.js";
import { THIS_MACHINE } from "../frame/sidebar-region.js";
import { DialogFooter } from "../ui/dialog.js";
import { CopyButton, Dialog, DialogContent, Input } from "../ui/index.js";
import { useFollowed, useObservable, useRuntime, useShell } from "../window-context.js";

import { SignInQr } from "./sign-in-qr.js";

import { AccountAction } from "./action.js";

export interface SignInCardProps {
  readonly environmentId: string;
  /** Accounts embeds the flow in its pane; other openers keep their dialog. */
  readonly inline?: boolean;
  /** The account to sign in, by its id and label; null to add a new one, labelled first. */
  readonly account: Pick<AccountRecord, "id" | "label"> | null;
  /** A label and identity hint from another environment; starts a fresh local account, carries no credential. */
  readonly suggestion?: { readonly label: string; readonly email: string };
  /** A new account's label, added at once with no label form (the Account step's Sign in with Claude, setup-copy.md §5.1). */
  readonly label?: string;
  /** True only when the opener generated the name, rather than a person typing it. */
  readonly nameByEmail?: boolean;
  /** Closes the card. */
  readonly close: () => void;
  /** Told, inline, as the sign-in succeeds, with the line Done will say: the card waits only on Done from then on. */
  readonly succeeded?: (line: string) => void;
  /** Says one line where the card was opened from: how the sign-in ended, or why it could not go on; `ok` false for a failure. */
  readonly say: (line: string, ok: boolean) => void;
}

/** The command on its way, whose answer the card waits for: the new account, the sign-in's start, or the code. */
type Sending = "add" | "start" | "code" | null;

/**
 * The sign-in card (docs/specs/gui.md, "A session pane": Add an account with
 * the sign-in card; ADR 0018; #147's card in the window, #402), which the
 * account picker, the hand-off picker, the Accounts pane and Set up's Sign
 * in again (#573) open. The rules
 * are the client runtime's (`status/sign-in.ts`), so the terminal UI's card
 * runs the same:
 *
 * - **A new account** is labelled first, then added (`accounts.add`), which
 *   starts its sign-in; **an account not signed in** has its sign-in
 *   started (`accounts.signin.start`).
 * - The card follows the environment's sign-in through `accounts.signin.get`
 *   in the request cache: "Starting the sign-in…", then the verification URL,
 *   the local provider's browser flow left alone, or the paired flow's URL
 *   opened through the shell's `openExternal` (and again on a press), the
 *   full code pasted or read from the clipboard and sent with
 *   `accounts.signin.code` ("Checking the code…"), and the fallback command
 *   for a terminal on the environment's machine under it, and the time the
 *   sign-in has left, counted down on the environment's clock from its
 *   `expiresAt` (ten minutes, ADR 0018; #575).
 * - The dialog stops at the window less its margin (look.md §11.1, #1690): its
 *   title and close X above and Send the code and Cancel the sign-in below
 *   stay in the window while the middle (QR, link, code, command) scrolls,
 *   and the page link folds to two lines beside Copy and Open.
 * - Inline success stays until Done; other ends close the card, said in one line
 *   where the card was opened; so is a refusal of the start. Closing the
 *   card cancels the sign-in it started (`accounts.signin.cancel`), since
 *   the card is its attendant.
 */
export const SignInCard = ({ environmentId, account, close, say, succeeded, inline = false, suggestion, label: given, nameByEmail = false }: SignInCardProps) => {
  const heading = useId();
  const codeForm = useId();
  const runtime = useRuntime();
  const shell = useShell();
  const environments = useObservable(runtime.projections.environments);
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId]));
  const held = useFollowed(useMemo(() => runtime.requests.cached(environmentId, "accounts.signin.get", {}), [runtime, environmentId]))?.result?.signIn;
  const view = environments.find((candidate) => candidate.environmentId === environmentId);
  const environment = view?.name ?? THIS_MACHINE;
  const localBrowser = shell !== undefined && view?.kind === "local";
  const [label, setLabel] = useState(account?.label ?? "");
  const [accountId, setAccountId] = useState<string | null>(account?.id ?? null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const added = account === null ? (suggestion?.label ?? given) : undefined;
  const [sending, setSending] = useState<Sending>(account === null ? (added === undefined ? null : "add") : "start");
  const [typed, setTyped] = useState("");
  const [completed, setCompleted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opened = useRef<string | null>(null);
  const ended = useRef(false);
  const departed = useRef(false);
  const attended = useRef<Pick<AccountRecord, "id" | "label"> | null>(null);
  const cancelDeparted = (owned: Pick<AccountRecord, "id" | "label">) => {
    attended.current = null;
    void cancelSignIn(runtime, environmentId, owned, uuidv4(), environment);
  };
  const attend = (owned: Pick<AccountRecord, "id" | "label">) => {
    if (departed.current) cancelDeparted(owned);
    else attended.current = owned;
  };

  // Inline flows leave with their pane, including a start or add answered after it unmounts.
  useEffect(() => () => {
    if (!inline) return;
    departed.current = true;
    if (!ended.current && attended.current !== null) cancelDeparted(attended.current);
  }, []);

  const followed = followedSignIn(held, { accountId, startedAt, starting: sending === "start" });
  const end = followed ? signInEnd(followed, label, environment) : undefined;
  const openExternal = runtime.capability(environmentId, "shell.openExternal");
  const url = followed?.url ?? null;
  const left = useEnvironmentCountdown(environmentId, followed?.expiresAt);

  // An account given is signed in as the card opens.
  useEffect(() => {
    if (account === null) return;
    void startSignIn(runtime, environmentId, account, uuidv4()).then((started) => {
      if (!started.ok) {
        ended.current = true;
        close();
        return say(started.line, false);
      }
      attend(account);
      if (departed.current) return;
      setStartedAt(started.startedAt);
      setSending(null);
    });
  }, []);

  // Inline success stays visible until Done; other ends are said by the opener.
  useEffect(() => {
    if (end === undefined || ended.current) return;
    ended.current = true;
    if (inline && followed?.state === "done") { setCompleted(end); succeeded?.(end); }
    else { close(); say(end, followed === undefined || !signInFailed(followed)); }
  }, [end]);

  // The local provider opens its loopback flow itself. Paired flows open the manual URL once.
  useEffect(() => {
    if (localBrowser || shell === undefined || url === null || opened.current === url || openExternal.status === "absent") return;
    opened.current = url;
    void shell?.openExternal?.(url);
  }, [url]);

  // A returning tab may have missed notices while suspended. Re-read status without restarting sign-in.
  useEffect(() => {
    if (shell !== undefined || accountId === null || completed !== null) return;
    const resume = () => { if (document.visibilityState === "visible") runtime.requests.refresh(environmentId, "accounts.signin.get", {}); };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => { window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); };
  }, [runtime, environmentId, accountId, completed, shell]);

  const addLabel = (trimmed: string) => {
    const problem = labelProblem(trimmed);
    if (problem !== undefined) { setSending(null); return setError(problem); }
    setLabel(trimmed);
    setSending("add");
    setError(null);
    void addAccount(runtime, environmentId, trimmed, uuidv4(), environment, nameByEmail).then((added) => {
      if (added.kind === "refused") {
        setSending(null);
        return setError(added.line);
      }
      if (added.kind === "added") {
        ended.current = true;
        close();
        return say(added.line, added.ok);
      }
      attend(added.account);
      if (departed.current) return;
      setAccountId(added.account.id);
      setTyped("");
      setSending(null);
    });
  };

  const add = (event: FormEvent) => { event.preventDefault(); addLabel(typed.trim()); };
  useEffect(() => { if (added !== undefined) addLabel(added); }, []);

  const submitCode = (text: string) => {
    if (accountId === null) return;
    const code = text.trim();
    if (!SignInCode.safeParse(code).success || !/^[^#\s]+#[^#\s]+$/.test(code)) {
      setError("Paste the full code from the provider page (code#state).");
      return;
    }
    const expectedState = url === null ? null : new URL(url).searchParams.get("state");
    if (expectedState !== null && code.split("#")[1] !== expectedState) {
      setError("This code belongs to another sign-in. Copy the code from this sign-in page.");
      return;
    }
    setSending("code");
    setError(null);
    void sendSignInCode(runtime, environmentId, accountId, code, uuidv4()).then((refused) => {
      setSending(null);
      if (refused === undefined) setTyped("");
      else setError(refused);
    });
  };

  const sendCode = (event: FormEvent) => { event.preventDefault(); submitCode(typed); };
  const pasteCode = async () => {
    try {
      const text = await (clipboard?.readText() ?? navigator.clipboard.readText());
      if (departed.current || ended.current) return;
      setTyped(text.trim());
      submitCode(text);
    } catch {
      if (!departed.current && !ended.current) setError("Clipboard access was refused. Paste the code into the field instead.");
    }
  };

  /** Leaving the card: the sign-in it started is its to end, so it is cancelled whatever state it has reached. */
  const leave = () => {
    departed.current = true;
    close();
    if (accountId === null || ended.current || (inline && attended.current === null)) return;
    ended.current = true;
    void cancelSignIn(runtime, environmentId, { id: accountId, label }, uuidv4(), environment).then(({ ok, line }) => say(line, ok));
  };

  const directory = accounts.value?.find((candidate) => candidate.id === accountId)?.directory.path;
  const labelling = accountId === null && sending !== "add";
  const showsPage = url !== null && (followed?.state === "awaiting-code" || followed?.state === "submitting" || sending === "code");
  const checking = sending === "code" || followed?.state === "submitting";
  const takesCode = followed?.state === "awaiting-code" && sending === null;

  const title = account === null && accountId === null ? `Add an account on ${environment}` : `Sign in: ${label} on ${environment}`;
  const clipboard = runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.clipboard").status === "present" ? shell?.clipboard : undefined;
  const canReadClipboard = clipboard !== undefined || typeof navigator.clipboard?.readText === "function";
  const copyText = (text: string) => clipboard?.writeText(text) ?? navigator.clipboard.writeText(text);
  // The inline card keeps its actions in its flow; the dialog holds them in its footer, under the scrolling middle.
  const sendButton = <AccountAction icon={Send} variant="default" type="submit" form={codeForm} className={inline ? "self-end" : undefined} disabled={typed.trim() === ""}>Send the code</AccountAction>;
  const cancelButton = <AccountAction icon={X} className={inline ? "self-end" : undefined} onClick={leave}>Cancel the sign-in</AccountAction>;
  const content = completed !== null ? <div className="flex flex-col gap-3">
    <p role="status" className="flex items-center gap-2 text-sm text-mint"><Check aria-hidden="true" className="size-4" />{completed}</p>
    <AccountAction icon={Check} variant="default" className="self-end" onClick={() => { say(completed, true); close(); }}>Done</AccountAction>
  </div> : (
    <>
        {labelling ? (
          <form aria-label="Add an account" className="flex flex-col gap-1.5" onSubmit={add}>
            <label className="flex flex-col gap-1 text-sm">
              Label for the new account
              <Input value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus />
            </label>
            <p className="text-xs text-ink-faint">The email it signs in as makes a good label.</p>
            {error !== null && <p role="alert" className="text-xs text-signal">{error}</p>}
            <div className="flex justify-end gap-2">
              <AccountAction icon={X} onClick={leave}>Cancel</AccountAction>
              <AccountAction icon={Plus} variant="default" type="submit">
                Add
              </AccountAction>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            {suggestion !== undefined && <p>Choose {suggestion.email} on the provider page. {environment} keeps its own sign-in.</p>}
            {showsPage && (
              <>
                <p>{localBrowser ? "Finish signing in in the browser on this machine. This dialog completes automatically. If no browser opened, use the page below and paste its code." : `Sign in on ${environment}. Open this page on any device already signed in to the provider:`}</p>
                <SignInQr url={url} />
                <div className="flex items-start gap-2">
                  <p title={url} className="line-clamp-2 min-w-0 flex-1 break-all font-mono text-xs text-beam-text">{url}</p>
                  <CopyButton text={url} copy={copyText} label="Copy the sign-in page link" />
                </div>
                {shell === undefined ? <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 text-sm text-beam-text underline"><ExternalLink aria-hidden="true" className="size-4" />Open the sign-in page</a> : <AccountAction icon={ExternalLink}
                  className="self-start"
                  aria-disabled={openExternal.status === "absent" ? true : undefined}
                  title={openExternal.status === "absent" ? openExternal.message : undefined}
                  onClick={() => (openExternal.status === "absent" ? setError(openExternal.message) : void shell?.openExternal?.(url))}
                >
                  Open the sign-in page
                </AccountAction>}
              </>
            )}
            {sending === "add" && <p className="text-ink-faint">Adding {label}…</p>}
            {sending !== "add" && (checking ? <p role="status" className="flex items-center gap-2 text-ink-faint"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Checking the code…</p> : (!followed || followed.state === "starting" || sending === "start") && <p className="text-ink-faint">Starting the sign-in…</p>)}
            {takesCode && (
              <form id={codeForm} aria-label="Send the code" className="flex flex-col gap-1.5" onSubmit={sendCode}>
                <label className="flex flex-col gap-1">
                  Then paste the code it shows
                  <Input value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus />
                </label>
                {canReadClipboard && <AccountAction icon={Copy} type="button" onClick={() => void pasteCode()}>Paste code from clipboard</AccountAction>}
                {inline && sendButton}
              </form>
            )}
            {error !== null && <p role="alert" className="text-xs text-signal">{error}</p>}
            {left !== undefined && (
              <p role="timer" className="text-xs text-ink-faint">
                {signInLeftWords(left)}
              </p>
            )}
            {followed && (
              <>
                <p className="text-xs text-ink-faint">Or run this in a terminal on {environment}'s machine:</p>
                <section aria-label="Terminal fallback" className="flex items-start gap-2 rounded-lg border border-hairline bg-inset p-2">
                  <code className="min-w-0 flex-1 break-all font-mono text-2xs select-all">{fallbackOf(followed, directory)}</code>
                  <AccountAction icon={Copy} size="xs" aria-label="Copy terminal command" disabled={clipboard === undefined} onClick={() => { void clipboard?.writeText(fallbackOf(followed, directory)).then(() => setCopied(true)); }}>Copy</AccountAction>
                </section>
                {copied && <p role="status" className="text-2xs text-ink-muted">Terminal command copied.</p>}
              </>
            )}
            {inline && cancelButton}
          </div>
        )}
    </>
  );
  return inline ? <section data-account-sign-in aria-labelledby={heading} className="flex flex-col gap-3 rounded-lg border border-hairline bg-panel p-3">
    <h3 id={heading} className="flex items-center gap-2 text-sm font-medium"><KeyRound aria-hidden="true" className="size-4" />{title}</h3>
    {content}
  </section> : <Dialog open onOpenChange={(open) => !open && leave()}>
    <DialogContent title={title} className="max-w-lg max-h-[calc(100dvh-4rem)]">
      <div data-sign-in-body className="-m-1 min-h-0 overflow-y-auto p-1">{content}</div>
      {completed === null && !labelling && <DialogFooter data-sign-in-footer>{cancelButton}{takesCode && sendButton}</DialogFooter>}
    </DialogContent>
  </Dialog>;
};
