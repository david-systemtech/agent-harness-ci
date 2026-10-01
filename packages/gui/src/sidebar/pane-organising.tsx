import { organiseUsage, parseWhen, rowKey, toggleOf, type SessionRow, type Toggle } from "@agent-harness/client-runtime";
import type { CommandMethodName } from "@agent-harness/contracts";
import { useSlashCommand } from "../composer/slash-commands.js";
import type { Offer } from "../keys/key-dispatch.js";
import { usePaneLine } from "../session/pane-line.js";
import { useObservable, useRuntime } from "../window-context.js";
import { SidebarDialogs } from "./dialogs.js";
import { OrganiseProvider, useOrganise } from "./organise.js";
import { useSidebarSearch } from "./window-sidebar.js";

/**
 * A session pane's organising slash commands (docs/specs/gui.md, "The
 * window and the sidebar"; #753): `/pin`, `/title <name>`, `/archive`,
 * `/group [name]`, `/tag <tag>`, `/settle`, `/snooze [when]`, `/restore`
 * and `/search <text>`, wired for as long as the pane shows its session, so
 * the composer's menu and the command palette offer them (the palette as if
 * typed bare). Each acts on the pane's session as the terminal UI's slash
 * form acts on the session in hand, sending what the sidebar's context menu
 * sends, once, with its command id, through the outbox (`organise.tsx`):
 *
 * - `/pin`, `/archive` and `/settle` toggle, as the session stands (the
 *   runtime's `toggleOf`); `/title <name>` renames; `/tag <tag>` tags.
 * - `/group <name>` moves it into the group so named, created on its
 *   environment first when it lacks it (`commands.moveToGroup`); bare, it
 *   opens Move to group's choices.
 * - `/snooze <when>` snoozes it to a typed time on its environment's clock
 *   (`parseWhen`, whose problem is the line); bare, it opens Snooze's
 *   presets.
 * - `/restore [title]` opens the sidebar's Restore, listing the deleted
 *   sessions whose titles hold what follows.
 * - `/search <text>` types it in the sidebar's filter, showing the sidebar.
 *
 * A form typed wrong says the client runtime's usage line, the terminal
 * UI's (`organiseUsage`), and a command the connection cannot send says the
 * capability's line (`commands.admits`; the palette draws it dim with it),
 * on the pane's line, where it was typed; so does what a command did not
 * do, in the sidebar's words ("Not pinned: …"). What it did shows on the
 * session's row, as the sidebar's commands' does. The dialogs they open are
 * the sidebar's, over the pane.
 */
export const PaneOrganising = ({ environmentId, sessionId }: { readonly environmentId: string; readonly sessionId: string }) => {
  const [, say] = usePaneLine();
  return (
    <OrganiseProvider say={say}>
      <OrganiseCommands environmentId={environmentId} sessionId={sessionId} />
      <SidebarDialogs />
    </OrganiseProvider>
  );
};

/** Why an organising command waits: the session list does not hold the pane's session (not listed yet, or deleted since). */
const NOT_LISTED: Offer = { status: "absent", message: "This session is not in the sessions list now." };

/**
 * Wires the organising command `/name` on the pane's session `row`: a form
 * typed wrong says its usage line, and while `offer` says the command cannot
 * be sent the line says why; else `act` does it with what followed the name.
 */
const useOrganiseCommand = (name: string, row: SessionRow | undefined, offer: Offer, act: (row: SessionRow, argument: string) => void): void => {
  const organise = useOrganise();
  useSlashCommand(
    name,
    (argument) => {
      const usage = organiseUsage(name, argument);
      if (usage !== undefined) return organise.say(usage);
      if (offer.status === "absent") return organise.say(offer.message);
      if (row !== undefined) act(row, argument);
    },
    offer,
  );
};

const OrganiseCommands = ({ environmentId, sessionId }: { readonly environmentId: string; readonly sessionId: string }) => {
  const runtime = useRuntime();
  const organise = useOrganise();
  const search = useSidebarSearch();
  const list = useObservable(runtime.projections.sessionList);
  // The connections' phases and scopes: whether a command can be sent is asked again whenever one moves.
  useObservable(runtime.projections.environments);
  const row = list.rows.find((held) => held.environmentId === environmentId && held.summary.id === sessionId);

  /** Whether `method` can be sent about the pane's session now. */
  const offerOf = (method: CommandMethodName): Offer => (row === undefined ? NOT_LISTED : runtime.commands.admits(environmentId, method));
  /** A toggle's command as the session stands, and whether it can be sent. */
  const toggled = (which: Toggle): Offer => (row === undefined ? NOT_LISTED : offerOf(toggleOf(row.summary, which).method));
  const toggle = (which: Toggle) => (held: SessionRow) => organise.send(environmentId, toggleOf(held.summary, which).method, { sessionId: held.summary.id });

  useOrganiseCommand("pin", row, toggled("pin"), toggle("pin"));
  useOrganiseCommand("title", row, offerOf("sessions.rename"), (held, title) => organise.send(environmentId, "sessions.rename", { sessionId: held.summary.id, title }));
  useOrganiseCommand("archive", row, toggled("archive"), toggle("archive"));
  useOrganiseCommand("group", row, offerOf("sessions.setGroup"), (held, name) => {
    if (name === "") return organise.open({ kind: "move-to-group", row: rowKey(held) });
    organise.move(environmentId, held.summary.id, name);
  });
  useOrganiseCommand("tag", row, offerOf("sessions.tag"), (held, tag) => organise.send(environmentId, "sessions.tag", { sessionId: held.summary.id, tag }));
  useOrganiseCommand("settle", row, toggled("settle"), toggle("settle"));
  useOrganiseCommand("snooze", row, offerOf("sessions.snooze"), (held, typed) => {
    if (typed === "") return organise.open({ kind: "snooze-presets", row: rowKey(held) });
    const at = parseWhen(typed, runtime.environmentNow(environmentId));
    if (!(at instanceof Date)) return organise.say(at.problem);
    organise.send(environmentId, "sessions.snooze", { sessionId: held.summary.id, until: at.toISOString() });
  });
  useSlashCommand("restore", (query) => organise.open({ kind: "restore", query }));
  useSlashCommand("search", search);
  return null;
};
