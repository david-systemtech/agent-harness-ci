import type { CommandParams, DispatchAnswer } from "@agent-harness/client-runtime";
import type { CommandMethodName } from "@agent-harness/contracts";
import { createContext, use, useMemo, useState, type ReactNode } from "react";
import { useRuntime } from "../window-context.js";
import { notDone } from "./words.js";

/**
 * Organising from the sidebar (docs/specs/gui.md, "The window and the
 * sidebar"; #398): what its context menus, its dialogs and its drags share.
 * Every command goes through the outbox (`commands.dispatch`, or the
 * runtime's composed commands), once, with its command id; its effect shows
 * at once and the row it is about is marked until its receipt
 * (`awaitingReceipt`). What one did not do is said in one line at the
 * sidebar's foot, the latest over the one before: a refusal before it was
 * kept, a rejection after (which the runtime raises as its notice too), a
 * refused drop. The sidebar's one dialog at a time is held here too.
 *
 * A session pane organises its session so too, with its organising slash
 * commands (#753): its own dialogs, the sidebar's, and its own line, the
 * pane's, where the command was typed.
 */

/**
 * A dialog the sidebar has open: a row's (by its `rowKey`), a merged group's
 * (by its heading's key), or Restore, listing the deleted sessions whose
 * titles hold `query` (`/restore <query>`; every one while it is empty).
 * Snooze's presets and Move to group's choices are a dialog for a session
 * pane's bare `/snooze` and `/group`, where no context menu is open.
 */
export type SidebarDialog =
  | { readonly kind: "snooze" | "snooze-presets" | "tags" | "new-group" | "move-to-group" | "delete"; readonly row: string }
  | { readonly kind: "delete-group"; readonly heading: string }
  | { readonly kind: "restore"; readonly query?: string };

interface Organise {
  /** What the sidebar's line says now; nothing where the line is another's. */
  readonly line: string | undefined;
  /** Says a line at the sidebar's foot (or on the line organising is given), or (undefined) clears it. */
  say(line: string | undefined): void;
  /** Sends one command through the outbox, saying what it did not do and why if it is refused. */
  send<N extends CommandMethodName>(environmentId: string, method: N, params: CommandParams<N>): void;
  /** Moves a session into the group named (null: out of any) with `commands.moveToGroup`, saying what it did not do and why if it is refused. */
  move(environmentId: string, sessionId: string, name: string | null): void;
  /** Says the first refusal among `answers`, after what they did not do (`notDone`'s words). */
  hear(answers: Promise<readonly DispatchAnswer<CommandMethodName>[]>, what: string): void;
  readonly dialog: SidebarDialog | null;
  /** Opens a dialog, or (null) closes the one open. */
  open(dialog: SidebarDialog | null): void;
}

const OrganiseContext = createContext<Organise | null>(null);

/** Organising with its own line, the sidebar's, or with `say`'s, a session pane's. */
export const OrganiseProvider = ({ say: sayElsewhere, children }: { readonly say?: (line: string | undefined) => void; readonly children: ReactNode }) => {
  const runtime = useRuntime();
  const [line, sayHere] = useState<string | undefined>(undefined);
  const say = sayElsewhere ?? sayHere;
  const [dialog, open] = useState<SidebarDialog | null>(null);
  const organise = useMemo<Organise>(() => {
    const hear: Organise["hear"] = (answers, what) => {
      say(undefined);
      void answers.then((answered) => {
        const refused = answered.find((answer) => !answer.ok);
        if (refused !== undefined && !refused.ok) say(`${what}: ${refused.error.message}`);
      });
    };
    return {
      line,
      say,
      send: (environmentId, method, params) => hear(runtime.commands.dispatch(environmentId, method, params).then((answer) => [answer]), notDone(method)),
      move: (environmentId, sessionId, name) => hear(runtime.commands.moveToGroup(environmentId, sessionId, name).then((answer) => [answer]), notDone("sessions.setGroup")),
      hear,
      dialog,
      open,
    };
  }, [runtime, line, say, dialog]);
  return <OrganiseContext value={organise}>{children}</OrganiseContext>;
};

/** What the sidebar's menus, dialogs and drags, and a session pane's organising slash commands, organise with. */
export const useOrganise = (): Organise => {
  const organise = use(OrganiseContext);
  if (organise === null) throw new Error("Organising is done inside the sidebar or a session pane, which holds its line and its dialogs.");
  return organise;
};

/** The line at the sidebar's foot: what an organising command, or a drop, did not do and why. */
export const OrganiseLine = () => {
  const { line } = useOrganise();
  return line === undefined ? null : (
    <p role="status" className="text-xs text-ink-muted">
      {line}
    </p>
  );
};
