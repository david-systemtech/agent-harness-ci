import {
  attachmentRefusal,
  interruptRun,
  isLive,
  liveRunIdOf,
  lockOf,
  replaceMention,
  sendMessage,
  shellLine,
  workspaceGoneLine,
  undoFile,
  type CapabilityAnswer,
  type Lock,
} from "@agent-harness/client-runtime";
import { useMemo, useState } from "react";
import { KeyContext, useKeyAction, type Offer } from "../keys/key-dispatch.js";
import { useSessionQueue } from "../queue/session-queue.js";
import { useModelChoice } from "../status/run-choices.js";
import { usePaneLine } from "../session/pane-line.js";
import { useProvider } from "../session/provider.js";
import { useSettingsCommand } from "../settings/settings-command.js";
import { useShellLines } from "../terminal/shell-lines.js";
import { Button } from "../ui/index.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";
import { MissingWorkspace, useGoneWorkspace } from "../workspace/missing.js";
import { AttachmentChips, AttachmentPicker, useAttachments } from "./attachments.js";
import { useBox } from "./box.js";
import { MenuList, optionId, useMenus, type Menu } from "./menus.js";
import { useSessionDraft } from "./session-draft.js";
import { notWired, typedCommand, useSlashCommand, useWiredCommands } from "./slash-commands.js";
import { usePromptWalk } from "./walk.js";

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
 * - **The model** the status line's model picker chose goes with the
 *   session's next `runs.start` (#402).
 * - **Slash commands.** `/` opens the commands the window wires and the
 *   provider's own; a name of the shared list is the window's, any other
 *   word goes to the agent as typed.
 * - **Files.** `@` lists the session's workspace (`files.list`, in the
 *   request cache) as the name is typed; choosing one writes its path.
 * - **Attachments** by a paste, a drop or the shell's file dialog (Attach
 *   files, `/attach`), the page's own file picker where the shell has none
 *   (#484), shown as chips.
 * - **`/settings [row]`** opens Settings on the row it names, or the last
 *   one opened, on this session's environment (`useSettingsCommand`, #625).
 * - **Send and Stop** share one button (story 9).
 * - **The queue** (#401): ↑ in an empty composer takes the newest queued
 *   message back (`composer.withdrawLast`), and `composer.readNow` reads the
 *   whole queue from the command palette.
 * - **Stop the run** (`app.interrupt`) is the palette's stop of this pane's
 *   run, Stop's own; no key stops a run until "Esc stops the run" is on.
 * - **Shell lines** (#409), as the terminal UI runs them (`useShellLines`):
 *   `!command` in a terminal of its own in the side column's Terminal pane,
 *   the composer keeping the keys; `!!command` in one nobody sees, what it
 *   printed sent to the agent as the session's next message.
 * - **A missing workspace** (#328, #421): while the environment has found
 *   the session's workspace gone, nothing is sent and the box gives way to
 *   the gone path and Choose a workspace (`MissingWorkspace`); its actions
 *   stay wired, Send saying why it cannot, so Stop still stops a run.
 *
 * Each action it wires is offered to the palette with whether it can be
 * done now, as the runtime says: dim there with the line while it cannot.
 */
export const Composer = ({ environmentId, sessionId }: ComposerProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  // The connections' phases: the lock and the shell's members are asked again whenever one moves.
  useObservable(runtime.projections.environments);
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const runs = useObservable(useMemo(() => runtime.projections.runs.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const provider = useProvider(environmentId, projection);
  const [line, say] = usePaneLine();
  const box = useBox();
  useSessionDraft(environmentId, sessionId, projection, box);
  const attachments = useAttachments({ environmentId, provider, say, insert: box.insert });
  const menus = useMenus({ environmentId, sessionId, provider, text: box.text, caret: box.caret });
  const walk = usePromptWalk(projection, box);
  const wired = useWiredCommands();
  useSlashCommand("attach", attachments.choose);
  useSettingsCommand(environmentId);
  useSlashCommand("undo", (argument) => {
    if (argument.length > 0) return say("Usage: /undo");
    const text = box.current();
    void undoFile(runtime, clock, environmentId, sessionId).then((outcome) => {
      say(outcome.line);
      if (outcome.ok && box.current() === text) box.put("");
    });
  }, runtime.capability(environmentId, "files.undo"), { keepComposer: true });
  const queue = useSessionQueue();
  const [choice] = useModelChoice(environmentId, sessionId);

  // The session's workspace, while the environment has found it gone: no run reads anything there until it has another.
  const gone = useGoneWorkspace(environmentId, sessionId);
  const capability = runtime.capability(environmentId, "runs.send");
  const sending: Offer = gone === undefined ? capability : { status: "absent", message: workspaceGoneLine(gone) };
  const lock: Lock = gone === undefined ? lockOf(capability) : { locked: true, reason: workspaceGoneLine(gone) };
  // The run a send joins and Stop interrupts, and the run this composer asked to stop: Stopping… while it is still live.
  const liveRunId = liveRunIdOf(projection, runs);
  const live = isLive(runs.state) || liveRunId !== undefined;
  const [interruptAsked, askInterrupt] = useState<string | undefined>(undefined);
  const stoppable = stopOffer(runtime.capability(environmentId, "runs.interrupt"), live, liveRunId, interruptAsked);
  const runShellLine = useShellLines({ environmentId, sessionId, line, say, lock, live });

  /** Sends `raw` as the box would: a command of the window's is run, anything else goes to the agent with the attachments. */
  const send = (raw: string) => {
    const shell = shellLine(raw);
    if (shell !== null) {
      if (runShellLine(shell)) box.put("");
      return;
    }
    const typed = typedCommand(raw);
    if (typed !== undefined) {
      const command = wired.find((candidate) => candidate.name === typed.name);
      if (command === undefined) return say(notWired(typed.name));
      if (!command.keepComposer) box.put("");
      say(undefined);
      return command.run(typed.argument);
    }
    const message = { text: raw.trim(), attachments: attachments.current() };
    if (message.text.length === 0) return message.attachments.length > 0 ? say("Write a message to go with the attachments.") : undefined;
    if (lock.locked) return say(`Not sent: ${lock.reason}`);
    const refused = attachmentRefusal(message, provider);
    if (refused !== undefined) return say(refused);
    box.put("");
    attachments.set([]);
    say(undefined);
    void sendMessage(runtime, environmentId, sessionId, message, live, choice).then((outcome) => {
      if (outcome.ok) return;
      say(outcome.line);
      // What was not sent comes back into an empty box, so it is not lost.
      if (box.current().length === 0) box.put(raw);
      if (attachments.current().length === 0) attachments.set(message.attachments);
    });
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

  /** Writes the file's path over the `@` token, a space after it. */
  const writePath = (files: Extract<Menu, { kind: "files" }>, index: number) => {
    const row = files.rows[index];
    if (row === undefined) return;
    const written = replaceMention(box.current(), files.mention.start, files.mention.end, `@${row.path}`);
    box.put(written.text, written.cursor);
  };
  const { open: menu, at } = menus;
  /** A row chosen by Enter or a click: a command runs as if typed out in full, a file's path is written. */
  const choose = (index: number) => {
    if (menu?.kind === "files") return writePath(menu, index);
    const row = menu?.rows[index];
    if (row !== undefined) send(`/${row.name}`);
  };
  /** Tab: the highlighted row filled in, a command with a space when it takes words after it; the window's Tab with no menu. */
  const complete = (): false | void => {
    if (menu === null || at < 0) return false;
    if (menu.kind === "files") return writePath(menu, at);
    const row = menu.rows[at];
    if (row !== undefined) box.put(`/${row.name}${row.usage.includes(" ") ? " " : ""}`);
  };
  const submit = () => (menu !== null && at >= 0 ? choose(at) : send(box.current()));
  /**
   * ↑ in an empty composer: the newest queued message a withdraw can reach (the runtime's `withdrawTarget`) taken back into
   * the draft; with none to reach, the key is declined, and ↑ walks the prompts.
   */
  const withdrawLast = (): false | void => (queue.runs.withdrawTarget === null ? false : queue.withdrawNewest());

  const conditions = {
    "composer.atStart": () => box.field.current?.selectionStart === 0 && box.field.current.selectionEnd === 0,
    "composer.empty": () => box.current().length === 0 && attachments.current().length === 0,
  };
  return (
    <>
      <KeyContext context="composer" conditions={conditions}>
        <ComposerKeys
          send={submit}
          newline={() => box.insert("\n")}
          navigate={walk}
          complete={complete}
          commandMenu={() => (box.current().length > 0 ? false : box.put("/"))}
          fileMention={() => box.insert("@")}
          paste={attachments.paste}
          withdrawLast={withdrawLast}
          readNow={queue.readNow}
          stop={stop}
          offers={{
            send: sending,
            paste: runtime.capability(environmentId, "shell.clipboard"),
            withdrawLast: queue.runs.verbs.withdraw,
            readNow: queue.runs.verbs.readNow,
            stop: stoppable,
          }}
        />
        {gone === undefined && (
          <div className="flex shrink-0 flex-col gap-1.5 border-t border-hairline px-4 py-3" onDragOver={attachments.dragging} onDrop={attachments.dropped}>
            {lock.locked && <p className="text-xs text-amber">Locked: {lock.reason}</p>}
            {menu !== null && <MenuList id={menus.listId} menu={menu} highlighted={at} choose={choose} />}
            <AttachmentChips attachments={attachments} />
            <div className="flex items-end gap-2">
              <textarea
                ref={box.field}
                aria-label="Message"
                aria-controls={menu === null ? undefined : menus.listId}
                aria-activedescendant={menu === null || at < 0 ? undefined : optionId(menus.listId, at)}
                value={box.text}
                onChange={(event) => box.put(event.target.value, null)}
                onSelect={box.moved}
                onKeyDown={menus.keyDown}
                onPaste={attachments.pasted}
                rows={3}
                className="min-w-0 flex-1 resize-none rounded-md border border-line bg-inset px-3 py-2 text-sm text-ink outline-none focus-visible:border-beam"
              />
              <Button aria-label="Attach files" onClick={attachments.choose}>
                Attach
              </Button>
              <AttachmentPicker attachments={attachments} />
              <SendOrStop
                stops={live && box.text.trim().length === 0 && attachments.list.length === 0}
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
        )}
      </KeyContext>
      {gone !== undefined && <MissingWorkspace environmentId={environmentId} sessionId={sessionId} path={gone} line={line} />}
    </>
  );
};

/** Whether Stop the run can stop the pane's run now: the connection's answer, then whether a run is live, has an id, and is not stopping already. */
const stopOffer = (interrupt: CapabilityAnswer, live: boolean, liveRunId: string | undefined, interruptAsked: string | undefined): Offer => {
  if (interrupt.status === "absent") return interrupt;
  if (!live) return { status: "absent", message: "Nothing is running in this session." };
  if (liveRunId === undefined) return { status: "absent", message: "The run has not started yet." };
  if (interruptAsked === liveRunId) return { status: "absent", message: "The run is stopping." };
  return interrupt;
};

interface ComposerKeysProps {
  readonly send: () => void;
  readonly newline: () => void;
  readonly navigate: (key: number) => false | void;
  readonly complete: () => false | void;
  readonly commandMenu: () => false | void;
  readonly fileMention: () => void;
  readonly paste: () => false | void;
  readonly withdrawLast: () => false | void;
  readonly readNow: () => void;
  readonly stop: () => void;
  /** Whether each action that can be refused can be done now, as the command palette draws it. */
  readonly offers: { readonly send: Offer; readonly paste: Offer; readonly withdrawLast: Offer; readonly readNow: Offer; readonly stop: Offer };
}

/**
 * The composer's actions from its GUI column, wired in its region; one with nothing to do declines the key.
 * `composer.readNow` has no key by default, and `app.interrupt`'s Esc is off: the command palette runs them.
 */
const ComposerKeys = ({ send, newline, navigate, complete, commandMenu, fileMention, paste, withdrawLast, readNow, stop, offers }: ComposerKeysProps) => {
  useKeyAction("composer.send", send, offers.send);
  useKeyAction("composer.newline", newline);
  useKeyAction("composer.navigate", navigate);
  useKeyAction("composer.complete", complete);
  useKeyAction("composer.command.menu", commandMenu);
  useKeyAction("composer.file.mention", fileMention);
  useKeyAction("composer.paste", paste, offers.paste);
  useKeyAction("composer.withdrawLast", withdrawLast, offers.withdrawLast);
  useKeyAction("composer.readNow", readNow, offers.readNow);
  useKeyAction("app.interrupt", stop, offers.stop);
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
