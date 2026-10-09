import { adapterOf, sendMessage, writable, type Writable, type NewSessionChips } from "@agent-harness/client-runtime";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { nameOf } from "../connections/words.js";
import { usePaneGrid } from "../grid/grid.js";
import { KeyContext, useFirstKey, useKeyAction, useKeyMap, useMacOS, type Offer } from "../keys/key-dispatch.js";
import type { PaneNewSession } from "../presentation.js";
import { useOpenInPane } from "../session/pane-line.js";
import { KeyRound, LoaderCircle, Paperclip, SendHorizontal, TriangleAlert } from "lucide-react";
import { AttachmentChips, AttachmentPicker, useAttachments } from "../composer/attachments.js";
import { useSettings } from "../settings/settings-window.js";
import { Alert, AlertDescription, AlertTitle, Button, IconButton, Tooltip } from "../ui/index.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";
import { Welcome } from "../session/empty-state.js";
import { COLUMN_WIDTHS } from "../transcript/transcript.js";
import { CHIPS } from "./chips.js";
import { useSurfaces, type NewSessionMessage } from "./surfaces.js";
import { refusalLine, signInLine } from "./words.js";

/** What the surface says when no environment can start a session now. */
const NONE_USABLE = "No environment can start a session now: the environment chip says why for each.";

/**
 * The new-session surface (docs/specs/gui.md, "A new session"; story 13 and
 * ADR 0005: where first; #420): the chips from `projections.newSession`, for
 * what the surface was opened beside and what was chosen on it, above a
 * composer. What is typed stays in the pane, since there is no session to
 * hold a draft yet (`surfaces.tsx`), so a pane closed before its first send
 * leaves nothing behind. The first send runs `commands.startSession` under
 * the id the surface was minted with, then, once the create is accepted,
 * sends the text as the session's first message, and the pane shows the new
 * session. A refused first message keeps this editor's text and files for
 * retry on the created session, with its choices locked. A refused start is
 * one line on the surface, which keeps its text.
 */
export const NewSessionSurface = ({ surface }: { readonly surface: PaneNewSession }) => {
  const runtime = useRuntime();
  const settings = useSettings();
  const keyMap = useKeyMap();
  const macOS = useMacOS();
  const sendKey = useFirstKey("composer.send");
  const newlineKey = useFirstKey("composer.newline");
  const [readingWidth] = usePresentation("readingWidth");
  const grid = usePaneGrid();
  const openInPane = useOpenInPane();
  const { messages, focusAsked, askFocus } = useSurfaces();
  const { id, focus, chips } = surface;
  const [pending] = useState<Writable<NewSessionMessage>>(() => {
    const held = messages.get(id) ?? writable<NewSessionMessage>({ text: "", attachments: [], environmentId: null, starting: false, line: undefined });
    messages.set(id, held);
    return held;
  });
  const { text, line, starting, environmentId: acceptedEnvironmentId } = useObservable(pending);
  const say = (line: string | undefined) => pending.update(held => ({ ...held, line }));
  const setStarting = (starting: boolean) => pending.update(held => ({ ...held, starting }));
  const creationAccepted = acceptedEnvironmentId !== null;
  const view = useObservable(useMemo(() => runtime.projections.newSession({
    focus, chips: acceptedEnvironmentId === null ? chips : { ...chips, environmentId: acceptedEnvironmentId },
  }), [runtime, focus, chips, acceptedEnvironmentId]));
  const destination = acceptedEnvironmentId ?? view.environment.value;
  const field = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const environment = view.environment.options.find((option) => option.environment.environmentId === destination)?.environment;
  const accountLine = signInLine(view.account, environment === undefined ? "the chosen environment" : nameOf(environment));
  const missingAccount = accountLine !== undefined;
  const unavailable = view.environment.options.find((option) => option.environment.environmentId === destination)?.unusable;
  const notReady = unavailable ?? (environment === undefined ? NONE_USABLE : accountLine ?? (view.workspace.value === null ? "Choose a workspace first." : undefined));
  const sendOffer: Offer = notReady === undefined && !starting ? { status: "present" } : { status: "absent", message: starting ? "The session is starting." : notReady ?? NONE_USABLE };

  useLayoutEffect(() => {
    const editor = field.current;
    if (editor === null) return;
    editor.style.height = "0px";
    editor.style.height = `${Math.max(44, editor.scrollHeight)}px`;
    if (caret.current !== null) {
      editor.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  }, [text]);

  useEffect(() => {
    const editor = field.current;
    if (editor === null) return;
    let width = -1;
    let frame: number | undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined || entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      if (frame !== undefined) cancelAnimationFrame(frame);
      // Changing an observed height during delivery leaves notifications undelivered.
      frame = requestAnimationFrame(() => {
        frame = undefined;
        editor.style.height = "0px";
        editor.style.height = `${Math.max(44, editor.scrollHeight)}px`;
      });
    });
    observer.observe(editor);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (focusAsked?.id !== id) return;
    field.current?.focus();
    askFocus(null);
  }, [focusAsked, id, askFocus]);

  const put = (next: string) => {
    pending.update(held => ({ ...held, text: next }));
    const environmentId = pending.read().environmentId;
    if (environmentId !== null) runtime.drafts.set(environmentId, id, next);
  };
  const providers = useObservable(useMemo(() => runtime.requests.cached(view.environment.value ?? "", "providers.list", {}), [runtime, view.environment.value]));
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(view.environment.value ?? ""), [runtime, view.environment.value]));
  const attachments = useAttachments({
    environmentId: view.environment.value ?? "",
    provider: adapterOf(view.account.value?.id ?? null, accounts.value, providers.result?.providers ?? null) ?? undefined,
    say,
    insert: added => put(text + added),
  });
  const retainedAttachments = useRef(attachments);
  useLayoutEffect(() => {
    const held = retainedAttachments.current;
    held.set(pending.read().attachments);
    return () => { pending.update(message => ({ ...message, attachments: held.current() })); };
  }, [pending]);
  const choose = (chosen: NewSessionChips) => grid.chooseChips(id, (held) => {
    const next = { ...held, ...chosen };
    if (chosen.environmentId !== undefined || chosen.account !== undefined) delete next.browser;
    return next;
  });

  const start = async () => {
    if (pending.read().starting) return;
    const outgoingText = text.trim();
    const environmentId = pending.read().environmentId ?? view.environment.value;
    const workspace = view.workspace.value;
    if (outgoingText.length === 0 || sendOffer.status === "absent") return;
    if (environmentId === null || workspace === null) return say(NONE_USABLE);
    const environment = view.environment.options.find((option) => option.environment.environmentId === environmentId)?.environment;
    const input = { text: outgoingText, attachments: attachments.current() };
    const account = view.account.value;
    const model = view.model.value;
    setStarting(true);
    say(undefined);
    if (pending.read().environmentId === null) {
      const { answer } = await runtime.commands.startSession(environmentId, {
        id,
        workspace,
        browser: view.browser,
        ...(account !== null && { account: account.id }),
        ...(model !== null && { model: model.id }),
      });
      if (!answer.ok) {
        setStarting(false);
        const where = environment === undefined ? "the environment" : nameOf(environment);
        return say(refusalLine(answer.error, workspace, { where, environmentId, rows: runtime.projections.sessionList.read().rows }));
      }
      pending.update(held => ({ ...held, environmentId }));
    }
    // An effort chosen on the chips goes with the first message, its own effort as null; the default's is the environment's to apply (#1950).
    const sent = await sendMessage(runtime, environmentId, id, input, false, view.effort.reason === "chosen" && model !== null ? { model: model.id, effort: view.effort.value } : undefined);
    if (!sent.ok) {
      runtime.drafts.set(environmentId, id, pending.read().text);
      setStarting(false);
      // Keep this editor and its selected files; retry uses the session already created.
      return say(sent.line);
    }
    runtime.drafts.set(environmentId, id, null);
    openInPane(environmentId, id);
  };

  const newline = () => {
    const editor = field.current;
    const at = editor?.selectionStart ?? text.length;
    const end = editor?.selectionEnd ?? at;
    caret.current = at + 1;
    put(text.slice(0, at) + "\n" + text.slice(end));
  };

  return (
    <section data-new-session aria-label="New session" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Welcome keyMap={keyMap} macOS={macOS} sentence={environment === undefined ? "Choose an environment for your first message." : view.account.value === null ? `Start a session on ${nameOf(environment)}.` : `Start a session on ${nameOf(environment)} with ${view.account.value.label}.`}>
          {notReady !== undefined && <Alert className="w-full bg-wash text-left">
            <TriangleAlert aria-hidden="true" className="text-amber" />
            <AlertTitle>Not ready to run</AlertTitle>
            <AlertDescription>
              <p>{notReady}</p>
              {environment !== undefined && missingAccount && <Tooltip content="Sign in" keys="Enter to open Accounts">
                <Button variant="link" size="xs" onClick={() => settings.open("accounts.accounts", environment.environmentId)}><KeyRound aria-hidden="true" />Sign in</Button>
              </Tooltip>}
            </AlertDescription>
          </Alert>}
        </Welcome>
      </div>
      <div data-composer-column className="@container mx-auto w-full shrink-0" style={{ maxWidth: COLUMN_WIDTHS[readingWidth] }}>
        <KeyContext context="composer">
          <SendKey send={() => void start()} newline={newline} offer={sendOffer} />
          <div className="px-3 pt-1.5 pb-1">
            <div data-composer-card className="rounded-[10px] border border-hairline-strong bg-wash focus-within:ring-3 focus-within:ring-beam/50">
              <AttachmentChips attachments={attachments} />
              <textarea
                ref={field}
                aria-label="Message"
                placeholder="The first message starts the session"
                spellCheck={false}
                value={text}
                onChange={(event) => put(event.target.value)}
                onPaste={attachments.pasted}
                onKeyDown={(event) => { if (event.nativeEvent.isComposing) event.stopPropagation(); }}
                rows={1}
                className="block max-h-[35vh] min-h-[44px] w-full resize-none overflow-y-auto bg-transparent px-3 py-2.5 text-sm leading-relaxed text-ink outline-none"
              />
              <div className="flex items-center gap-2 px-2 pb-2">
                <IconButton label="Attach files" onClick={attachments.choose}><Paperclip aria-hidden="true" /></IconButton>
                <AttachmentPicker attachments={attachments} />
                <span className="ml-auto hidden text-2xs text-ink-faint @[640px]:block">{sendKey ?? "Unbound"} send / {newlineKey ?? "Unbound"} newline</span>
                <IconButton label={starting ? "Starting…" : "Send"} {...(sendKey === undefined ? {} : { keys: sendKey })} {...(notReady === undefined ? {} : { disabledReason: notReady })} variant="default" disabled={starting || notReady !== undefined || text.trim().length === 0} className="ml-auto" onClick={() => void start()}>
                  {starting ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <SendHorizontal aria-hidden="true" />}
                </IconButton>
              </div>
            </div>
            {line !== undefined && <p role="status" className="pt-1 text-xs text-ink-muted">{line}</p>}
          </div>
        </KeyContext>
        <div role="group" aria-label="Where it starts" className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-1">
          <fieldset disabled={starting || creationAccepted} className="contents">
            {CHIPS.map((Chip, at) => <Chip key={at} view={view} sessionId={id} choose={choose} say={say} />)}
          </fieldset>
          {creationAccepted && !starting && <p className="w-full text-xs text-ink-muted">The session was created with these choices. Send again to retry its first message.</p>}
        </div>
      </div>
    </section>
  );
};

/** The composer's keys use the effective registry, including remapped newlines. */
const SendKey = ({ send, newline, offer }: { readonly send: () => void; readonly newline: () => void; readonly offer: Offer }) => {
  useKeyAction("composer.send", send, offer);
  useKeyAction("composer.newline", newline);
  return null;
};
