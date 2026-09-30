import { WHEN_EXAMPLES, parseWhen, presetTimes, whenWords, writable, type CommandParams, type DispatchAnswer, type DispatchFailure, type EnvironmentView, type Runtime, type SessionRow, type StartSessionChoice } from "@agent-harness/client-runtime";
import { groupNameKey, shelfOf, type CommandMethodName, type DeletedSessionSummary } from "@agent-harness/contracts";
import { nameOf } from "../view.js";
import type { Badge } from "./badge.js";
import { isReachable, rowKey } from "./model.js";
import { pickerOf, type Picker, type PickerRow } from "./picker.js";

/**
 * The rail's pickers (docs/specs/tui.md, "The rail"): snooze (an hour, this
 * evening, tomorrow morning, next Monday, a typed time; absolute UTC on the
 * wire), tag, group (the merged headings plus a new one, created on the
 * session's environment first when it lacks it), search (`projections.search`
 * across environments, no environment call) and restore (the deleted
 * sessions each environment can still restore). Each is a function of the
 * runtime's projections, read as drawn. The new-session card and its
 * workspace step are `new-session.ts` and `workspace-step.ts` (#334).
 */

/** What a picker does through the rail: commands, lines, and where the cursor goes. */
export interface RailActs {
  readonly runtime: Runtime;
  readonly views: readonly EnvironmentView[];
  readonly badges: ReadonlyMap<string, Badge>;
  /** The terminal's workspace (`--cwd`, else the current directory): offered on the local environment. */
  readonly workspace: string;
  say(line: string): void;
  /**
   * Sends `method` through the outbox; says `said` at once, and why when it
   * is refused before it is kept. A rejection after is the runtime's one
   * notice. `refused`, when given, hears either refusal instead of the line.
   * The row it is about shows pending from the runtime's `awaitingReceipt`
   * until its receipt.
   */
  send<N extends CommandMethodName>(
    environmentId: string,
    method: N,
    params: CommandParams<N>,
    said: string,
    done?: (answer: Extract<DispatchAnswer<N>, { readonly ok: true }>) => void,
    refused?: (failure: DispatchFailure) => void,
  ): void;
  /**
   * `commands.startSession`, said and heard as `send` says and hears a
   * command: `done` once the environment accepts the create, `refused`
   * hearing either refusal instead of the line.
   */
  start(environmentId: string, choice: StartSessionChoice, said: string, done?: () => void, refused?: (failure: DispatchFailure) => void): void;
  /** Opens a session in the transcript. */
  openSession(target: { readonly environmentId: string; readonly sessionId: string }): void;
  /** `commands.moveToGroup`. */
  move(row: SessionRow, name: string | null, said: string): void;
  /** Puts the rail's cursor on the line `key` names, opening its heading, and gives the rail the keys. */
  reveal(key: string): void;
  /** Closes the card when it still shows `picker`, as typed at since; leaves any other card. */
  close(picker: Picker): void;
  /**
   * Puts the rail's cursor on the line `key` names, for what lands later (a
   * new session accepted): the focus and a filter being typed are left as
   * they are, and while a filter is typed the cursor stays where it is.
   */
  land(key: string): void;
  /** Mints the id of a session this terminal creates: a version 4 UUID (the runtime's `uuidv4`). */
  newId(): string;
}

/** A session's title as a line quotes it. */
export const titleOf = (item: { readonly summary: { readonly title: string } }): string => `“${item.summary.title}”`;

/** "; it applies when <environment> is back" while the environment cannot be reached, as the runtime lists it now. */
export const whenBack = (acts: Pick<RailActs, "runtime">, environmentId: string): string => {
  const view = acts.runtime.projections.environments.read().find((v) => v.environmentId === environmentId);
  return view && !isReachable(view) ? `; it applies when ${nameOf(view)} is back` : "";
};

const snoozeTo = (acts: RailActs, row: SessionRow, at: Date) =>
  acts.send(row.environmentId, "sessions.snooze", { sessionId: row.summary.id, until: at.toISOString() }, `Snoozed ${titleOf(row)} until ${whenWords(at)}${whenBack(acts, row.environmentId)}.`);

/** `/snooze <when>`: the typed time on the session's environment's clock, or the problem. */
export const snoozeTyped = (acts: RailActs, row: SessionRow, typed: string): void => {
  const at = parseWhen(typed, acts.runtime.environmentNow(row.environmentId));
  if (at instanceof Date) snoozeTo(acts, row, at);
  else acts.say(at.problem);
};

export const snoozePicker = (acts: RailActs, row: SessionRow): Picker =>
  pickerOf({
    title: `Snooze ${titleOf(row)} until`,
    typed: true,
    placeholder: `pick one, or type a time: ${WHEN_EXAMPLES}`,
    rows: (query) => {
      const now = acts.runtime.environmentNow(row.environmentId);
      const needle = query.trim().toLowerCase();
      const presets = presetTimes(now)
        .filter((preset) => needle === "" || preset.label.toLowerCase().includes(needle))
        .map((preset): PickerRow => {
          const at = preset.at;
          return at === null
            ? { key: preset.label, text: preset.label, absent: preset.absent ?? "not now" }
            : { key: preset.label, text: preset.label, detail: whenWords(at), choose: () => snoozeTo(acts, row, at) };
        });
      const typed: PickerRow[] = [];
      if (needle !== "") {
        const at = parseWhen(query, now);
        typed.push(at instanceof Date ? { key: "typed", text: `At ${whenWords(at)}`, choose: () => snoozeTo(acts, row, at) } : { key: "typed", text: query.trim(), absent: at.problem });
      }
      const awake = row.summary.snoozedUntil === null || Date.parse(row.summary.snoozedUntil) <= now.getTime();
      const wake: PickerRow[] = awake
        ? []
        : [{ key: "wake", text: "Wake it now", choose: () => acts.send(row.environmentId, "sessions.unsnooze", { sessionId: row.summary.id }, `Woke ${titleOf(row)}${whenBack(acts, row.environmentId)}.`) }];
      // A time typed that reads comes first; one that does not, last, where it says why.
      const reads = typed[0]?.absent === undefined;
      return reads ? [...typed, ...presets, ...wake] : [...presets, ...wake, ...typed];
    },
  });

export const tagPicker = (acts: RailActs, row: SessionRow): Picker =>
  pickerOf({
    title: `Tag ${titleOf(row)}`,
    typed: true,
    placeholder: "type a tag to add it; Enter on one it has takes it off",
    rows: (query) => {
      const typed = query.trim();
      const has = row.summary.tags.some((tag) => tag.toLowerCase() === typed.toLowerCase());
      const add: PickerRow[] =
        typed === "" || has
          ? []
          : [{ key: "add", text: `Add #${typed}`, choose: () => acts.send(row.environmentId, "sessions.tag", { sessionId: row.summary.id, tag: typed }, `Tagged ${titleOf(row)} #${typed}${whenBack(acts, row.environmentId)}.`) }];
      const held = row.summary.tags
        .filter((tag) => tag.toLowerCase().includes(typed.toLowerCase()))
        .map(
          (tag): PickerRow => ({
            key: `tag:${tag}`,
            text: `#${tag}`,
            detail: "Enter takes it off",
            choose: () => acts.send(row.environmentId, "sessions.untag", { sessionId: row.summary.id, tag }, `Took #${tag} off ${titleOf(row)}${whenBack(acts, row.environmentId)}.`),
          }),
        );
      return [...add, ...held];
    },
  });

/** The picker of merged headings plus a new one (`g`, bare `/group`). */
export const groupPicker = (acts: RailActs, row: SessionRow): Picker =>
  pickerOf({
    title: `Put ${titleOf(row)} in a group`,
    typed: true,
    placeholder: "pick one, or type a new group's name",
    rows: (query) => {
      const typed = query.trim().replace(/\s+/g, " ");
      const headings = acts.runtime.projections.sessionList.read().groups;
      const where = (environmentIds: readonly string[]) => environmentIds.map((id) => acts.badges.get(id)?.abbreviation ?? "??").join(" ");
      const listed = headings
        .filter((heading) => heading.name.toLowerCase().includes(typed.toLowerCase()))
        .map((heading): PickerRow => {
          const here = heading.groups.some((g) => g.environmentId === row.environmentId && g.groupId === row.summary.groupId);
          return here
            ? { key: `group:${heading.key}`, text: heading.name, absent: "it is in it" }
            : {
                key: `group:${heading.key}`,
                text: heading.name,
                detail: `on ${where(heading.groups.map((g) => g.environmentId))}`,
                choose: () => acts.move(row, heading.name, `Moved ${titleOf(row)} into ${heading.name}${whenBack(acts, row.environmentId)}.`),
              };
        });
      const fresh: PickerRow[] =
        typed === "" || headings.some((heading) => heading.key === groupNameKey(typed))
          ? []
          : [{ key: "new", text: `New group ${typed}`, choose: () => acts.move(row, typed, `Moved ${titleOf(row)} into a new group ${typed}${whenBack(acts, row.environmentId)}.`) }];
      const out: PickerRow[] =
        row.summary.groupId === null
          ? []
          : [{ key: "none", text: "No group", choose: () => acts.move(row, null, `Took ${titleOf(row)} out of ${row.groupName ?? "its group"}${whenBack(acts, row.environmentId)}.`) }];
      // The headings the typing matches first, so a name typed in part picks the heading; a new one after them.
      return [...listed, ...fresh, ...out];
    },
  });

/** Where a session is, in words, for a search result: its shelf, or its group, or its environment. */
const whereOf = (acts: RailActs, row: SessionRow): string => {
  const shelf = shelfOf(row.summary, acts.runtime.environmentNow(row.environmentId));
  if (shelf === "snoozed" && row.summary.snoozedUntil !== null) return `snoozed until ${whenWords(new Date(row.summary.snoozedUntil))}`;
  if (shelf === "archived") return "archive";
  if (shelf !== "active") return shelf;
  const view = acts.views.find((v) => v.environmentId === row.environmentId);
  return row.groupName ?? (view ? nameOf(view) : "");
};

/** `/search <text>`: `projections.search` over every environment's cached sessions, as typed; no environment is asked. */
export const searchPicker = (acts: RailActs, query: string): Picker =>
  pickerOf({
    title: "Search every environment",
    typed: true,
    placeholder: "titles, tags, group names, repositories",
    query,
    rows: (typed) =>
      acts.runtime.projections
        .search(typed)
        .read()
        .map((row): PickerRow => ({
          key: rowKey(row),
          text: row.summary.title,
          ...(acts.badges.get(row.environmentId) && { badge: acts.badges.get(row.environmentId) as Badge }),
          detail: [whereOf(acts, row), ...row.summary.tags.map((tag) => `#${tag}`)].join(" "),
          choose: () => acts.reveal(rowKey(row)),
        })),
  });

interface Deleted {
  readonly environmentId: string;
  readonly summary: DeletedSessionSummary;
}

/**
 * `/restore`: the sessions each reachable environment deleted and can still
 * restore (`sessions.listDeleted`), newest first; Enter restores one.
 */
export const restorePicker = (acts: RailActs, query: string): Picker => {
  const asked = acts.views.filter((view) => view.name !== null && view.enabled);
  const listing = writable<{ readonly found: readonly Deleted[]; readonly notes: readonly string[]; readonly asking: number }>({ found: [], notes: [], asking: asked.length });
  for (const view of asked) {
    void acts.runtime.requests.call(view.environmentId, "sessions.listDeleted", {}).then((answer) =>
      listing.update((now) => ({
        found: answer.ok ? [...now.found, ...answer.result.sessions.map((summary) => ({ environmentId: view.environmentId, summary }))] : now.found,
        notes: answer.ok ? now.notes : [...now.notes, `${nameOf(view)} could not be asked: ${answer.error.message}`],
        asking: now.asking - 1,
      })),
    );
  }
  return pickerOf({
    title: "Restore a deleted session",
    typed: true,
    placeholder: "type to filter by title",
    query,
    follows: [listing],
    rows: (typed) =>
      [...listing.read().found]
        .sort((a, b) => Date.parse(b.summary.deletedAt) - Date.parse(a.summary.deletedAt))
        .filter((d) => d.summary.title.toLowerCase().includes(typed.trim().toLowerCase()))
        .map((d): PickerRow => {
          const title = titleOf(d);
          return {
            key: `${d.environmentId}/${d.summary.id}`,
            text: d.summary.title,
            ...(acts.badges.get(d.environmentId) && { badge: acts.badges.get(d.environmentId) as Badge }),
            detail: `restorable until ${whenWords(new Date(d.summary.purgeAt))}`,
            choose: () => acts.send(d.environmentId, "sessions.restore", { sessionId: d.summary.id }, `Restored ${title}${whenBack(acts, d.environmentId)}.`),
          };
        }),
    note: () => {
      const { notes, asking, found } = listing.read();
      if (asking > 0) return "Asking each environment what it deleted…";
      if (notes.length > 0) return notes.join(" ");
      return found.length === 0 ? "Nothing deleted can be restored: a deleted session is purged after 30 days." : undefined;
    },
  });
};
