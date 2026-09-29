import {
  adapterOf,
  attachmentRefusal,
  attachmentRefused,
  followDraft,
  interruptRun,
  isLive,
  liveRun,
  lockOf,
  mentionAt,
  replaceMention,
  sendMessage,
  type CapabilityAnswer,
  type InStep,
  type SessionProjection,
} from "@agent-harness/client-runtime";
import { MAX_ATTACHMENT_BYTES, type AdapterCapabilities, type AttachmentInput } from "@agent-harness/contracts";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { KeyContext, useKeyAction } from "../keys/key-dispatch.js";
import { Button } from "../ui/index.js";
import { useFollowed, useObservable, useRuntime, useShell } from "../window-context.js";
import { MAX_ATTACHMENTS, fromClipboardImage, fromFile, fromShellFile, type Taken } from "./attachments.js";
import { MenuList, highlighted, menuOf, optionId, slashWord, type CommandRow, type Menu } from "./menus.js";
import { notWired, typedCommand, useSlashCommand, useWiredCommands } from "./slash-commands.js";

export interface ComposerProps {
  readonly environmentId: string;
  readonly sessionId: string;
}

/**
 * The composer under a session's transcript (docs/specs/gui.md, "A session
 * pane"; #400), as the terminal UI's composer is (docs/specs/tui.md, "The
 * composer"):
 *
 * - **The draft.** The text is the session's draft (`drafts.set`), so it is
 *   in every client; the runtime's rule (`followDraft`) keeps the two in step.
 * - **Sending.** Enter sends `runs.start`, or `runs.send` during a run, which
 *   the environment queues or steers; Shift+Enter breaks the line. A run
 *   command never waits in the outbox: while no run can start the composer is
 *   locked with `capability`'s line, and a send is refused at once with it.
 * - **Slash commands.** `/` opens the commands the window wires and the
 *   provider's own; a name of the shared list is the window's, any other
 *   word goes to the agent as typed.
 * - **Files.** `@` lists the session's workspace (`files.list`, in the
 *   request cache) as the name is typed; choosing one writes its path.
 * - **Attachments** by a paste (Mod+V: an image off the shell's clipboard),
 *   a drop, or the shell's file dialog (Attach files, `/attach`), shown as
 *   chips; one the provider's input flags refuse is said with its reason.
 * - **Send and Stop** share one button (story 9).
 */
export const Composer = ({ environmentId, sessionId }: ComposerProps) => {
  const runtime = useRuntime();
  const shell = useShell();
  // The connections' phases: the lock and the shell's members are asked again whenever one moves.
  useObservable(runtime.projections.environments);
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const runs = useObservable(useMemo(() => runtime.projections.runs.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const provider = useProvider(environmentId, projection);
  const box = useBox();
  const tray = useTray();
  const [line, say] = useState<string | undefined>(undefined);
  const lock = lockOf(runtime.capability(environmentId, "runs.send"));
  // The run a send joins and Stop interrupts: the live run the transcript or the run state names.
  const liveRunId = liveRun(projection)?.runId ?? (runs.state === "running" || runs.state === "parked" ? (runs.runId ?? undefined) : undefined);
  const live = isLive(runs.state) || liveRunId !== undefined;
  // The run this composer asked to stop: Stopping… while it is still the live one.
  const [interruptAsked, askInterrupt] = useState<string | undefined>(undefined);

  // The text is the session's draft, kept in step by the runtime's rule: saved a second after the last key, taken when
  // the session opens, and another client's taken only while nothing was typed over what this composer held. A slash
  // command being typed (one word after a `/`, the menu's text) or a command of the window's with what follows it is
  // sent nowhere as a message, so it is never saved.
  const inStep = useRef<InStep | undefined>(undefined);
  useEffect(() => {
    const text = box.current();
    const step = followDraft(inStep.current, {
      session: `${environmentId} ${sessionId}`,
      held: projection.summary === null ? undefined : (projection.draft ?? ""),
      text,
      saves: slashWord(text, text.length) === undefined && typedCommand(text) === undefined,
    });
    inStep.current = step.inStep;
    if (step.take !== undefined) box.put(step.take);
    if (step.save !== undefined) runtime.drafts.set(environmentId, sessionId, step.save.length > 0 ? step.save : null);
  });

  // The menus: the commands wired and the provider's own while its adapter lists them, and the workspace's files while
  // a file is being named, each asked for only while its menu could open.
  const wired = useWiredCommands();
  const slashing = box.text.startsWith("/");
  const workspace = projection.summary?.workspace;
  const accountId = projection.summary?.accountId ?? undefined;
  const commandsKey = slashing && provider?.commands === true && workspace !== undefined ? JSON.stringify([workspace, accountId ?? null]) : undefined;
  const providerCommands = useFollowed(
    // The workspace and account are read through their key, so an equal summary does not make a new query.
    useMemo(() => (commandsKey === undefined || workspace === undefined ? undefined : runtime.requests.cached(environmentId, "commands.list", { workspace, ...(accountId !== undefined && { accountId }) })), [runtime, environmentId, commandsKey]),
  );
  const naming = mentionAt(box.text, box.caret) !== null;
  const files = useFollowed(useMemo(() => (naming ? runtime.requests.cached(environmentId, "files.list", { sessionId }) : undefined), [runtime, environmentId, sessionId, naming]));
  const commandRows = useMemo(() => commandRowsOf(wired, providerCommands?.result?.commands ?? []), [wired, providerCommands]);
  const [highlight, setHighlight] = useState<{ readonly key: string; readonly index: number } | null>(null);
  const [dismissed, dismiss] = useState<string | null>(null);
  const opened = menuOf(box.text, box.caret, commandRows, files);
  const menu = opened !== null && opened.key !== dismissed ? opened : null;
  const at = menu === null ? -1 : highlighted(menu, highlight);
  const listId = useId();

  /** Adds what was read to the attachments, saying in one line what was refused and why; the others are kept. */
  const take = (candidates: readonly Taken[]) => {
    const refusals: string[] = [];
    let next = tray.current();
    for (const candidate of candidates) {
      if ("refused" in candidate) {
        refusals.push(candidate.refused);
        continue;
      }
      const { attachment } = candidate;
      const refused = attachmentRefused(attachment, provider);
      if (refused !== undefined) refusals.push(refused);
      else if (next.length >= MAX_ATTACHMENTS) refusals.push(`A message carries at most ${String(MAX_ATTACHMENTS)} attachments: ${attachment.name} was not attached.`);
      else next = [...next, attachment];
    }
    tray.set(next);
    say(refusals.length > 0 ? refusals.join(" ") : undefined);
  };

  const dialogs = runtime.capability(environmentId, "shell.dialogs");
  /** The shell's file dialog, every file chosen read within the wire's cap. */
  const chooseFiles = () => {
    if (dialogs.status === "absent") return say(dialogs.message);
    void shell?.dialogs?.openFileContents({ title: "Attach files", multiple: true, maxBytes: MAX_ATTACHMENT_BYTES }).then((chosen) => take(chosen.map(fromShellFile)));
  };
  useSlashCommand("attach", chooseFiles);

  /** Mod+V: an image off the shell's clipboard as an attachment, else its text where the caret is; the page's own paste without one. */
  const pastes = useRef(0);
  const paste = (): false | undefined => {
    const clipboard = shell?.clipboard;
    if (clipboard === undefined || runtime.capability(environmentId, "shell.clipboard").status === "absent") return false;
    void (async () => {
      const image = await clipboard.readImage().catch(() => undefined);
      if (image !== undefined) return take([fromClipboardImage(image, ++pastes.current)]);
      const text = await clipboard.readText().catch(() => "");
      if (text.length > 0) return box.insert(text);
      say("The clipboard holds no image and no text.");
    })();
    return undefined;
  };
  /** A paste the page makes (the context menu's, or a browser tab's Mod+V): its files are attached, its text is the box's. */
  const pasted = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const dropped = [...event.clipboardData.files];
    if (dropped.length === 0) return;
    event.preventDefault();
    void Promise.all(dropped.map(fromFile)).then(take);
  };
  const dragging = (event: DragEvent) => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  };
  const dropped = (event: DragEvent) => {
    const chosen = [...event.dataTransfer.files];
    if (chosen.length === 0) return;
    event.preventDefault();
    void Promise.all(chosen.map(fromFile)).then(take);
  };

  /** Sends `raw` as the box would: a command of the window's is run, anything else goes to the agent. */
  const send = (raw: string) => {
    const typed = typedCommand(raw);
    if (typed !== undefined) {
      const command = wired.find((candidate) => candidate.name === typed.name);
      if (command === undefined) return say(notWired(typed.name));
      box.put("");
      say(undefined);
      return command.run(typed.argument);
    }
    const message = { text: raw.trim(), attachments: tray.current() };
    if (message.text.length === 0) return message.attachments.length > 0 ? say("Write a message to go with the attachments.") : undefined;
    if (lock.locked) return say(`Not sent: ${lock.reason}`);
    const refused = attachmentRefusal(message, provider);
    if (refused !== undefined) return say(refused);
    box.put("");
    tray.set([]);
    say(undefined);
    void sendMessage(runtime, environmentId, sessionId, message, live).then((outcome) => {
      if (outcome.ok) return;
      say(outcome.line);
      // What was not sent comes back into an empty box, so it is not lost.
      if (box.current().length === 0) box.put(raw);
      if (tray.current().length === 0) tray.set(message.attachments);
    });
  };

  /** Writes the chosen file's path over the `@` token, a space after it. */
  const writePath = (files: Extract<Menu, { kind: "files" }>, index: number) => {
    const row = files.rows[index];
    if (row === undefined) return;
    const written = replaceMention(box.current(), files.mention.start, files.mention.end, `@${row.path}`);
    box.put(written.text, written.cursor);
  };
  /** A row chosen by Enter or a click: a command runs as if typed out in full, a file's path is written. */
  const choose = (index: number) => {
    if (menu?.kind === "files") return writePath(menu, index);
    const row = menu?.rows[index];
    if (row !== undefined) send(`/${row.name}`);
  };

  const submit = () => (menu !== null && at >= 0 ? choose(at) : send(box.current()));

  /** Tab: the highlighted row filled in, a command with a space when it takes words after it; the page's Tab with no menu. */
  const complete = (): false | undefined => {
    if (menu === null || at < 0) return false;
    if (menu.kind === "files") writePath(menu, at);
    else {
      const row = menu.rows[at];
      if (row !== undefined) box.put(`/${row.name}${row.usage.includes(" ") ? " " : ""}`);
    }
    return undefined;
  };

  // ↑ and ↓ from the start of the box walk the prompts sent in this session, newest first, back to what was there.
  const prompts = useMemo(() => promptsOf(projection), [projection]);
  const walk = useRef<Walk | null>(null);
  const navigate = (key: number): false | undefined => {
    const text = box.current();
    const current = walk.current !== null && walk.current.shown === text ? walk.current : { texts: prompts, position: -1, origin: text, shown: text };
    const position = Math.min(Math.max(current.position + (key === 0 ? 1 : -1), -1), current.texts.length - 1);
    if (position === current.position) return false;
    const shown = position === -1 ? current.origin : (current.texts[position] ?? current.origin);
    walk.current = { ...current, position, shown };
    // The caret stays at the start, so the next ↑ or ↓ walks on.
    box.put(shown, 0);
    return undefined;
  };

  const stop = () => {
    if (liveRunId === undefined) return;
    askInterrupt(liveRunId);
    void interruptRun(runtime, environmentId, liveRunId).then((refused) => {
      if (refused === undefined) return;
      say(refused);
      askInterrupt(undefined);
    });
  };

  /** A menu's own keys, before the composer's: ↑ and ↓ move its highlight, Esc puts it away until the text changes. */
  const menuKeys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu === null || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "Escape") dismiss(menu.key);
    else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && menu.rows.length > 0) {
      const step = event.key === "ArrowUp" ? -1 : 1;
      setHighlight({ key: menu.key, index: Math.min(Math.max(at + step, 0), menu.rows.length - 1) });
    } else return;
    event.preventDefault();
  };

  const conditions = {
    "composer.atStart": () => box.field.current?.selectionStart === 0 && box.field.current.selectionEnd === 0,
    "composer.empty": () => box.current().length === 0 && tray.current().length === 0,
  };
  const empty = box.text.trim().length === 0 && tray.list.length === 0;
  return (
    <KeyContext context="composer" conditions={conditions}>
      <ComposerKeys
        send={submit}
        newline={() => box.insert("\n")}
        navigate={navigate}
        complete={complete}
        commandMenu={() => (box.current().length > 0 ? false : box.put("/"))}
        fileMention={() => box.insert("@")}
        paste={paste}
      />
      <div className="flex shrink-0 flex-col gap-1.5 border-t border-hairline px-4 py-3" onDragOver={dragging} onDrop={dropped}>
        {lock.locked && <p className="text-xs text-amber">Locked: {lock.reason}</p>}
        {menu !== null && <MenuList id={listId} menu={menu} highlighted={at} choose={choose} />}
        {tray.list.length > 0 && (
          <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
            {tray.list.map((attachment, index) => (
              <li key={`${String(index)} ${attachment.name}`} className="flex items-center gap-1 rounded-full border border-line bg-raised py-0.5 pr-1 pl-2.5 text-xs text-ink">
                <span>{attachment.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => tray.set(tray.current().filter((_, other) => other !== index))}
                  className="rounded-full px-1 text-ink-muted hover:bg-wash hover:text-ink"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={box.field}
            aria-label="Message"
            aria-controls={menu === null ? undefined : listId}
            aria-activedescendant={menu === null || at < 0 ? undefined : optionId(listId, at)}
            value={box.text}
            onChange={(event) => box.put(event.target.value, null)}
            onSelect={box.moved}
            onKeyDown={menuKeys}
            onPaste={pasted}
            rows={3}
            className="min-w-0 flex-1 resize-none rounded-md border border-line bg-inset px-3 py-2 text-sm text-ink outline-none focus-visible:border-beam"
          />
          <Button aria-label="Attach files" disabled={dialogs.status === "absent"} title={dialogs.status === "absent" ? dialogs.message : undefined} onClick={chooseFiles}>
            Attach
          </Button>
          <SendOrStop
            stops={live && empty}
            sends={!lock.locked && box.text.trim().length > 0}
            stopping={liveRunId !== undefined && interruptAsked === liveRunId}
            interrupt={liveRunId === undefined ? undefined : runtime.capability(environmentId, "runs.interrupt")}
            send={submit}
            stop={stop}
          />
        </div>
        {line !== undefined && (
          <p role="status" className="text-xs text-ink-muted">
            {line}
          </p>
        )}
      </div>
    </KeyContext>
  );
};

/** The slash menu's rows: the commands wired, then the provider's own that no command of the shared list shadows. */
const commandRowsOf = (wired: readonly Omit<CommandRow, "provider">[], provided: readonly { readonly name: string; readonly description: string }[]): readonly CommandRow[] => [
  ...wired.map(({ name, usage, description }) => ({ name, usage, description, provider: false })),
  ...provided.filter((command) => typedCommand(`/${command.name}`) === undefined).map(({ name, description }) => ({ name, usage: `/${name}`, description, provider: true })),
];

/** The prompts sent in the session that a run read, newest first: what ↑ walks. */
const promptsOf = (projection: SessionProjection): readonly string[] =>
  projection.items.flatMap((entry) => (entry.kind === "user-message" && entry.delivery !== "queued" && entry.text.length > 0 ? [entry.text] : [])).reverse();

/** A walk through the session's prompts, alive while the box holds what it put there. */
interface Walk {
  readonly texts: readonly string[];
  /** -1 is the text the walk began from; 0 the newest prompt. */
  readonly position: number;
  readonly origin: string;
  readonly shown: string;
}

/** The session's provider, once `providers.list` has answered: the environment's only one, else its account's. */
const useProvider = (environmentId: string, projection: SessionProjection): AdapterCapabilities | undefined => {
  const runtime = useRuntime();
  const providers = useObservable(useMemo(() => runtime.requests.cached(environmentId, "providers.list", {}), [runtime, environmentId]));
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId]));
  return adapterOf(projection.summary?.accountId ?? null, accounts.value, providers.result?.providers ?? null) ?? undefined;
};

interface ComposerKeysProps {
  readonly send: () => void;
  readonly newline: () => void;
  readonly navigate: (key: number) => false | void;
  readonly complete: () => false | void;
  readonly commandMenu: () => false | void;
  readonly fileMention: () => void;
  readonly paste: () => false | void;
}

/** The composer's actions from its GUI column, wired in its region; one that has nothing to do declines the key. */
const ComposerKeys = ({ send, newline, navigate, complete, commandMenu, fileMention, paste }: ComposerKeysProps) => {
  useKeyAction("composer.send", send);
  useKeyAction("composer.newline", newline);
  useKeyAction("composer.navigate", navigate);
  useKeyAction("composer.complete", complete);
  useKeyAction("composer.command.menu", commandMenu);
  useKeyAction("composer.file.mention", fileMention);
  useKeyAction("composer.paste", paste);
  return null;
};

interface SendOrStopProps {
  /** A run is live and the box is empty: the button stops the run. */
  readonly stops: boolean;
  /** There is something to send, and a run can start. */
  readonly sends: boolean;
  /** The live run was asked to stop and has not ended. */
  readonly stopping: boolean;
  /** Whether the live run can be interrupted from here; undefined while its id is not known yet. */
  readonly interrupt: CapabilityAnswer | undefined;
  readonly send: () => void;
  readonly stop: () => void;
}

/**
 * Send and Stop share one button (docs/specs/gui.md, "A session pane"; story
 * 9): Stop while a run is live and the box is empty (`runs.interrupt`), then
 * Stopping… until the run ends; Send otherwise. A Stop the connection cannot
 * send says why on hover.
 */
const SendOrStop = ({ stops, sends, stopping, interrupt, send, stop }: SendOrStopProps) => {
  if (!stops)
    return (
      <Button tone="primary" disabled={!sends} onClick={send}>
        Send
      </Button>
    );
  if (stopping)
    return (
      <Button tone="danger" disabled>
        Stopping…
      </Button>
    );
  const absent = interrupt?.status === "absent" ? interrupt.message : interrupt === undefined ? "The run has not started yet." : undefined;
  return (
    <Button tone="danger" disabled={absent !== undefined} title={absent} onClick={stop}>
      Stop
    </Button>
  );
};

/**
 * The box's text and caret: the text is the composer's until it is sent, and
 * a change made here (a newline, a draft taken, a path chosen) puts the caret
 * where the change says once it is drawn. The caret is followed as it moves,
 * since the menus open by where it is.
 */
const useBox = () => {
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const placing = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (placing.current === null || field.current === null) return;
    field.current.setSelectionRange(placing.current, placing.current);
    setCaret(placing.current);
    placing.current = null;
  });
  /** The text as the box holds it now, a key typed since the last render included. */
  const current = () => field.current?.value ?? text;
  /** Replaces the text, the caret at `at` (its end unless said; null where the typing left it). */
  const put = (next: string, at: number | null = next.length) => {
    placing.current = at;
    setText(next);
    if (at === null) setCaret(field.current?.selectionStart ?? next.length);
  };
  /** Types `chars` over the selection. */
  const insert = (chars: string) => {
    const now = current();
    const start = field.current?.selectionStart ?? now.length;
    const end = field.current?.selectionEnd ?? start;
    put(now.slice(0, start) + chars + now.slice(end), start + chars.length);
  };
  /** The caret moved (a click, an arrow key): the menus follow it. */
  const moved = () => setCaret(field.current?.selectionStart ?? 0);
  return { field, text, caret, current, put, insert, moved };
};

/** The attachments going with the next message, read as they are now by a paste or a dialog answered later. */
const useTray = () => {
  const [list, setList] = useState<readonly AttachmentInput[]>([]);
  const now = useRef(list);
  const set = (next: readonly AttachmentInput[]) => {
    now.current = next;
    setList(next);
  };
  return { list, current: () => now.current, set };
};
