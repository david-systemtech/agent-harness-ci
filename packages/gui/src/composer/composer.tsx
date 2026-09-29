import {
  attachmentRefusal,
  interruptRun,
  isLive,
  liveRunIdOf,
  lockOf,
  replaceMention,
  sendMessage,
  type CapabilityAnswer,
} from "@agent-harness/client-runtime";
import { useMemo, useState } from "react";
import { KeyContext, useKeyAction } from "../keys/key-dispatch.js";
import { usePaneLine } from "../session/pane-line.js";
import { useProvider } from "../session/provider.js";
import { Button } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { AttachmentChips, useAttachments } from "./attachments.js";
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
 * - **Slash commands.** `/` opens the commands the window wires and the
 *   provider's own; a name of the shared list is the window's, any other
 *   word goes to the agent as typed.
 * - **Files.** `@` lists the session's workspace (`files.list`, in the
 *   request cache) as the name is typed; choosing one writes its path.
 * - **Attachments** by a paste, a drop or the shell's file dialog (Attach
 *   files, `/attach`), shown as chips.
 * - **Send and Stop** share one button (story 9).
 */
export const Composer = ({ environmentId, sessionId }: ComposerProps) => {
  const runtime = useRuntime();
  // The connections' phases: the lock and the shell's members are asked again whenever one moves.
  useObservable(runtime.projections.environments);
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const runs = useObservable(useMemo(() => runtime.projections.runs.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const provider = useProvider(environmentId, projection);
  const [line, say] = usePaneLine();
  const box = useBox();
  useSessionDraft(environmentId, sessionId, projection, box);
  const attachments = useAttachments({ environmentId, provider, say, insert: box.insert });
  const menus = useMenus({ environmentId, sessionId, summary: projection.summary, provider, text: box.text, caret: box.caret });
  const walk = usePromptWalk(projection, box);
  const wired = useWiredCommands();
  useSlashCommand("attach", attachments.choose);

  const lock = lockOf(runtime.capability(environmentId, "runs.send"));
  // The run a send joins and Stop interrupts, and the run this composer asked to stop: Stopping… while it is still live.
  const liveRunId = liveRunIdOf(projection, runs);
  const live = isLive(runs.state) || liveRunId !== undefined;
  const [interruptAsked, askInterrupt] = useState<string | undefined>(undefined);

  /** Sends `raw` as the box would: a command of the window's is run, anything else goes to the agent with the attachments. */
  const send = (raw: string) => {
    const typed = typedCommand(raw);
    if (typed !== undefined) {
      const command = wired.find((candidate) => candidate.name === typed.name);
      if (command === undefined) return say(notWired(typed.name));
      box.put("");
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
    void sendMessage(runtime, environmentId, sessionId, message, live).then((outcome) => {
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

  const conditions = {
    "composer.atStart": () => box.field.current?.selectionStart === 0 && box.field.current.selectionEnd === 0,
    "composer.empty": () => box.current().length === 0 && attachments.current().length === 0,
  };
  return (
    <KeyContext context="composer" conditions={conditions}>
      <ComposerKeys
        send={submit}
        newline={() => box.insert("\n")}
        navigate={walk}
        complete={complete}
        commandMenu={() => (box.current().length > 0 ? false : box.put("/"))}
        fileMention={() => box.insert("@")}
        paste={attachments.paste}
      />
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
          <Button
            aria-label="Attach files"
            disabled={attachments.dialog.status === "absent"}
            title={attachments.dialog.status === "absent" ? attachments.dialog.message : undefined}
            onClick={attachments.choose}
          >
            Attach
          </Button>
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
    </KeyContext>
  );
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

/** The composer's actions from its GUI column, wired in its region; one with nothing to do declines the key. */
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
