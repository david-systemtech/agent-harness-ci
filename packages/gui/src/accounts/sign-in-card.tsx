import { LOCAL_PLACEHOLDER_ID, addAccount, cancelSignIn, fallbackOf, followedSignIn, labelProblem, sendSignInCode, signInEnd, signInLeftWords, startSignIn, uuidv4, type SignInEnding } from "@agent-harness/client-runtime";
import { Check, ClipboardPaste, Copy, ExternalLink, KeyRound, LoaderCircle, LogIn, Plus, RotateCcw, X } from "lucide-react";
import { SIGN_IN_ENDED_STATES, SignInCode, type AccountRecord, type SignInState } from "@agent-harness/contracts";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useEnvironmentCountdown } from "../environment-countdown.js";
import { THIS_MACHINE } from "../frame/sidebar-region.js";
import { TechnicalDetails } from "../setup/details.js";
import { SetupNotice } from "../setup/notice.js";
import { useDetails } from "../setup/use-details.js";
import { DialogFooter } from "../ui/dialog.js";
import { Dialog, DialogContent, Fold, Input } from "../ui/index.js";
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
  /** Closes the card. */
  readonly close: () => void;
  /** Told, inline, as the sign-in succeeds, with the line Done will say: the card waits only on Done from then on. */
  readonly succeeded?: (line: string) => void;
  /** Says one line where the card was opened from: how the sign-in ended, or why it could not go on. */
  readonly say: (line: string) => void;
}

/** The command on its way, whose answer the card waits for: the new account, the sign-in's start, or the code. */
type Sending = "add" | "start" | "code" | null;

const ENDED: readonly SignInState[] = SIGN_IN_ENDED_STATES;

/** A copy button with its name in words, saying beside it that it copied, or to select the text when the copy was refused. */
const CopyAction = ({ text, copy, label, children }: { readonly text: string; readonly copy: (text: string) => Promise<void>; readonly label?: string; readonly children: ReactNode }) => {
  const [status, setStatus] = useState<"ready" | "copied" | "refused">("ready");
  useEffect(() => setStatus("ready"), [text]);
  return <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
    <AccountAction icon={Copy} type="button" {...(label !== undefined && { "aria-label": label })} onClick={() => { Promise.resolve().then(() => copy(text)).then(() => setStatus("copied"), () => setStatus("refused")); }}>{children}</AccountAction>
    <span role="status" className={status === "refused" ? "text-xs text-signal" : "text-xs text-ink-muted"}>{status === "copied" ? "Copied." : status === "refused" ? "Could not copy. Select the text and copy it manually." : ""}</span>
    {status === "refused" && <textarea data-ui-input aria-label="Text to copy manually" readOnly value={text} onFocus={(event) => event.currentTarget.select()} className="max-h-40 w-full min-w-0 resize-y border border-hairline bg-inset p-2 font-mono text-xs text-ink" />}
  </span>;
};

/**
 * The sign-in dialog (setup-copy.md §5.2; docs/specs/gui.md, "A session pane":
 * Add an account with the sign-in card; ADR 0018; #147's card in the window,
 * #402), which the account picker, the hand-off picker, the Accounts pane and
 * Set up's Sign in again (#573) open. The rules and words are the client
 * runtime's (`status/sign-in.ts`), so the terminal UI's card runs the same:
 *
 * - **A new account** is labelled first, then added (`accounts.add`), which
 *   starts its sign-in; **an account not signed in** has its sign-in
 *   started (`accounts.signin.start`).
 * - The card follows the environment's sign-in through `accounts.signin.get`
 *   in the request cache: "Starting the sign-in…", then, on this computer,
 *   the line saying the provider's own browser flow opened, with the three
 *   numbered steps folded under "The page did not open?"; on another computer
 *   the steps at once and the page opened through the shell's `openExternal`.
 *   The steps open or copy the page, show its QR, and take the whole code,
 *   pasted or read from the clipboard and sent with `accounts.signin.code`
 *   ("Checking the code…"). The page's link is never drawn: Copy link and
 *   Details carry it. The command for a terminal on that computer is folded
 *   under "Sign in from a terminal instead"; the time left is counted down on
 *   the environment's clock from its `expiresAt` (ten minutes, ADR 0018; #575).
 * - The dialog stops at the window less its margin (look.md §11.1, #1690): its
 *   title and close X above and Sign in and Cancel the sign-in below stay in
 *   the window while the middle scrolls.
 * - A refused code, an expiry, a failed CLI and a cancel the system made keep
 *   the card open with a notice saying so plainly, Start again (which signs
 *   the account in afresh) and the environment's words in Details (#1843).
 *   Inline success stays until Done; a person's cancel and a success in the
 *   dialog close the card, said in one line where it was opened; so is a
 *   refusal of the first start. Closing the card cancels the sign-in it
 *   started (`accounts.signin.cancel`), since the card is its attendant.
 */
export const SignInCard = ({ environmentId, account, close, say, succeeded, inline = false, suggestion }: SignInCardProps) => {
  const heading = useId();
  const codeForm = useId();
  const codeError = useId();
  const runtime = useRuntime();
  const shell = useShell();
  const details = useDetails();
  const environments = useObservable(runtime.projections.environments);
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId]));
  const held = useFollowed(useMemo(() => runtime.requests.cached(environmentId, "accounts.signin.get", {}), [runtime, environmentId]))?.result?.signIn;
  const view = environments.find((candidate) => candidate.environmentId === environmentId);
  const environment = view?.name ?? THIS_MACHINE;
  const thisComputer = view === undefined || view.kind === "local";
  const localBrowser = shell !== undefined && view?.kind === "local";
  const [label, setLabel] = useState(account?.label ?? "");
  const [accountId, setAccountId] = useState<string | null>(account?.id ?? null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [sending, setSending] = useState<Sending>(account === null ? (suggestion === undefined ? null : "add") : "start");
  const [typed, setTyped] = useState("");
  const [completed, setCompleted] = useState<string | null>(null);
  const [stopped, setStopped] = useState<SignInEnding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageFold, setPageFold] = useState(false);
  const [terminalFold, setTerminalFold] = useState(false);
  const opened = useRef<string | null>(null);
  const ended = useRef(false);
  const departed = useRef(false);
  const attended = useRef<Pick<AccountRecord, "id" | "label"> | null>(null);
  const cancelDeparted = (owned: Pick<AccountRecord, "id" | "label">) => {
    attended.current = null;
    void cancelSignIn(runtime, environmentId, owned, uuidv4());
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
  const end = followed ? signInEnd(followed, label) : undefined;
  const openExternal = runtime.capability(environmentId, "shell.openExternal");
  const url = followed?.url ?? null;
  const left = useEnvironmentCountdown(environmentId, followed?.expiresAt);

  /** Starts `owned`'s sign-in; a refusal goes to `refused`, with its line and the raw words. */
  const begin = (owned: Pick<AccountRecord, "id" | "label">, refused: (line: string, words: readonly string[]) => void) => {
    void startSignIn(runtime, environmentId, owned, uuidv4()).then((started) => {
      if (!started.ok) {
        ended.current = true;
        return refused(started.line, started.details);
      }
      attend(owned);
      if (departed.current) return;
      setStartedAt(started.startedAt);
      setSending(null);
    });
  };

  // An account given is signed in as the card opens; a refusal of that first start is said by the opener.
  useEffect(() => {
    if (account === null) return;
    begin(account, (line) => { close(); say(line); });
  }, []);

  // A stop keeps the card open with Start again; inline success stays visible until Done; other ends are said by the opener.
  useEffect(() => {
    if (end === undefined || ended.current) return;
    ended.current = true;
    if (end.kind === "stopped") setStopped(end);
    else if (inline && end.kind === "done") { setCompleted(end.line); succeeded?.(end.line); }
    else { close(); say(end.line); }
  }, [end?.line]);

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

  /** Start again: the account's sign-in afresh, the one still running (a refused code's) cancelled first. */
  const startAgain = () => {
    if (accountId === null) return;
    const owned = { id: accountId, label };
    const running = followed !== undefined && !ENDED.includes(followed.state);
    ended.current = false;
    opened.current = null;
    setStopped(null);
    setError(null);
    setTyped("");
    setSending("start");
    const restart = () => begin(owned, (line, words) => { setSending(null); setStopped({ kind: "stopped", title: line, next: null, line, again: true, details: words }); });
    if (running) void cancelSignIn(runtime, environmentId, owned, uuidv4()).then(restart);
    else restart();
  };

  const addLabel = (trimmed: string) => {
    const problem = labelProblem(trimmed);
    if (problem !== undefined) { setSending(null); return setError(problem); }
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
      attend(added.account);
      if (departed.current) return;
      setAccountId(added.account.id);
      setTyped("");
      setSending(null);
    });
  };

  const add = (event: FormEvent) => { event.preventDefault(); addLabel(typed.trim()); };
  useEffect(() => { if (suggestion !== undefined) addLabel(suggestion.label); }, []);

  const submitCode = (text: string) => {
    if (accountId === null) return;
    const code = text.trim();
    if (!SignInCode.safeParse(code).success || !/^[^#\s]+#[^#\s]+$/.test(code)) {
      setError("Paste the whole code from the Claude page. It has a # in the middle.");
      return;
    }
    const expectedState = url === null ? null : new URL(url).searchParams.get("state");
    if (expectedState !== null && code.split("#")[1] !== expectedState) {
      setError("This code is from a different sign-in. Copy the code from the page you just opened.");
      return;
    }
    setSending("code");
    setError(null);
    void sendSignInCode(runtime, environmentId, accountId, code, uuidv4()).then((refused) => {
      setSending(null);
      if (refused === undefined) return setTyped("");
      if (departed.current || ended.current) return;
      ended.current = true;
      setStopped(refused);
      // The environment's sign-in may still wait for a code: the card ends it, so it holds no sign-in after this one.
      void cancelSignIn(runtime, environmentId, { id: accountId, label }, uuidv4());
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
    void cancelSignIn(runtime, environmentId, { id: accountId, label }, uuidv4()).then(say);
  };

  const directory = accounts.value?.find((candidate) => candidate.id === accountId)?.directory.path;
  const labelling = accountId === null && sending !== "add";
  const showsPage = stopped === null && url !== null && (followed?.state === "awaiting-code" || followed?.state === "submitting" || sending === "code");
  const checking = sending === "code" || followed?.state === "submitting";
  const takesCode = stopped === null && followed?.state === "awaiting-code" && sending === null;
  const stepsShown = showsPage && (!localBrowser || pageFold);

  const title = account === null && accountId === null ? `Add an account on ${environment}` : thisComputer ? "Sign in to Claude" : `Sign in to Claude on ${environment}`;
  const clipboard = runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.clipboard").status === "present" ? shell?.clipboard : undefined;
  const canReadClipboard = clipboard !== undefined || typeof navigator.clipboard?.readText === "function";
  const copyText = (text: string) => clipboard?.writeText(text) ?? navigator.clipboard.writeText(text);
  const openAbsent = shell !== undefined && openExternal.status === "absent";
  // The inline card keeps its actions in its flow; the dialog holds them in its footer, under the scrolling middle.
  const signInButton = <AccountAction icon={LogIn} variant="default" type="submit" form={codeForm} className={inline ? "self-end" : undefined}>Sign in</AccountAction>;
  const leaveButton = stopped === null
    ? <AccountAction icon={X} className={inline ? "self-end" : undefined} onClick={leave}>Cancel the sign-in</AccountAction>
    : <AccountAction icon={X} className={inline ? "self-end" : undefined} onClick={leave}>Close</AccountAction>;
  const steps = url !== null && (
    <ol className="flex list-decimal flex-col gap-3 pl-5">
      <li>
        <div className="flex min-w-0 flex-col gap-2">
          <span>Open the Claude sign-in page.</span>
          <div className="flex flex-wrap items-start gap-2">
            {shell === undefined ? <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 text-sm text-beam-text underline"><ExternalLink aria-hidden="true" className="size-4" />Open the sign-in page</a> : <AccountAction icon={ExternalLink}
              aria-disabled={openAbsent ? true : undefined}
              onClick={() => { if (!openAbsent) void shell?.openExternal?.(url); }}
            >
              Open the sign-in page
            </AccountAction>}
            <CopyAction text={url} copy={copyText}>Copy link</CopyAction>
          </div>
          {openAbsent && <p className="text-xs text-ink-muted">This app cannot open your browser here. Choose Copy link instead.</p>}
          <SignInQr url={url} />
        </div>
      </li>
      <li><div><span>Sign in and choose Authorize.</span></div></li>
      <li>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span>Copy the code the page shows and paste it here.</span>
          {checking ? <p role="status" className="flex items-center gap-2 text-ink-faint"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Checking the code…</p> : takesCode && (
            <form id={codeForm} aria-label="Send the code" className="flex flex-col gap-1.5" onSubmit={sendCode}>
              <label className="flex flex-col gap-1">
                Code
                <Input value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus aria-invalid={error !== null ? true : undefined} aria-describedby={error !== null ? codeError : undefined} />
              </label>
              {error !== null && <p id={codeError} role="alert" className="text-xs text-signal"><span className="sr-only">Error: </span>{error}</p>}
              {canReadClipboard && <AccountAction icon={ClipboardPaste} type="button" className="self-start" onClick={() => void pasteCode()}>Paste from clipboard</AccountAction>}
              {inline && signInButton}
            </form>
          )}
        </div>
      </li>
    </ol>
  );
  const content = completed !== null ? <div className="flex flex-col gap-3">
    <p role="status" className="flex items-center gap-2 text-sm text-mint"><Check aria-hidden="true" className="size-4" />{completed}</p>
    <AccountAction icon={Check} variant="default" className="self-end" onClick={() => { say(completed); close(); }}>Done</AccountAction>
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
          <div className="flex flex-col gap-3 text-sm">
            {suggestion !== undefined && <p>Choose {suggestion.email} on the provider page. {environment} keeps its own sign-in.</p>}
            {stopped !== null && (
              <SetupNotice
                tone={stopped.again ? "error" : "info"}
                title={stopped.title}
                {...(stopped.next !== null && { description: stopped.next })}
                {...(stopped.again && { actions: <AccountAction icon={RotateCcw} variant="default" onClick={startAgain}>Start again</AccountAction> })}
                details={details({ computer: { name: environment }, line: stopped.line, details: stopped.details })}
              />
            )}
            {showsPage && (localBrowser ? (
              <>
                <p>A Claude page opened in your browser. Sign in there and choose Authorize. This window finishes by itself.</p>
                <Fold summary="The page did not open?" open={pageFold} onOpenChange={setPageFold}>{steps}</Fold>
              </>
            ) : steps)}
            {showsPage && !stepsShown && checking && <p role="status" className="flex items-center gap-2 text-ink-faint"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Checking the code…</p>}
            {stopped === null && sending === "add" && <p className="text-ink-faint">Adding {label}…</p>}
            {stopped === null && sending !== "add" && !showsPage && (!followed || followed.state === "starting" || sending === "start") && <p className="text-ink-faint">Starting the sign-in…</p>}
            {stopped === null && left !== undefined && (
              <p role="timer" className="text-xs text-ink-muted">
                {signInLeftWords(left)}
              </p>
            )}
            {stopped === null && followed && (
              <div data-sign-in-terminal>
                <Fold summary="Sign in from a terminal instead" open={terminalFold} onOpenChange={setTerminalFold}>
                  <section aria-label="Terminal command" className="flex flex-col items-start gap-2 rounded-lg border border-hairline bg-inset p-2">
                    <code className="min-w-0 break-all font-mono text-2xs select-all">{fallbackOf(followed, directory)}</code>
                    <CopyAction text={fallbackOf(followed, directory)} copy={copyText} label="Copy the command">Copy</CopyAction>
                  </section>
                </Fold>
              </div>
            )}
            {showsPage && <TechnicalDetails {...details({ computer: { name: environment }, line: "Waiting for the code from the Claude page.", details: [`Sign-in page: ${url}`] })} />}
            {inline && leaveButton}
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
      {completed === null && !labelling && <DialogFooter data-sign-in-footer>{leaveButton}{takesCode && stepsShown && signInButton}</DialogFooter>}
    </DialogContent>
  </Dialog>;
};
