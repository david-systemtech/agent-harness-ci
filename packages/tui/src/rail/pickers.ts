import { writable, type CommandParams, type DispatchAnswer, type EnvironmentView, type Runtime, type SessionRow } from "@agent-harness/client-runtime";
import { groupNameKey, shelfOf, type CommandMethodName, type DeletedSessionSummary } from "@agent-harness/contracts";
import { nameOf } from "../view.js";
import type { Badge } from "./badge.js";
import { isReachable, rowKey } from "./model.js";
import { pickerOf, type Chip, type Picker, type PickerRow } from "./picker.js";
import { WHEN_EXAMPLES, parseWhen, presetTimes, whenWords } from "./when.js";

/**
 * The rail's pickers (docs/specs/tui.md, "The rail"): snooze (an hour, this
 * evening, tomorrow morning, next Monday, a typed time; absolute UTC on the
 * wire), tag, group (the merged headings plus a new one, created on the
 * session's environment first when it lacks it), search (`projections.search`
 * across environments, no environment call), restore (the deleted sessions
 * each environment can still restore), and the steps of starting a session
 * on an environment: its account, its model, then its workspace, a
 * `directory` from the paths that environment's sessions already carry, or
 * typed. Each is a function of the runtime's projections, read as drawn.
 */

/** What a picker does through the rail: commands with a row's pending marker, lines, and where the cursor goes. */
export interface RailActs {
  readonly runtime: Runtime;
  readonly views: readonly EnvironmentView[];
  readonly badges: ReadonlyMap<string, Badge>;
  /** The terminal's workspace (`--cwd`, else the current directory): offered on the local environment. */
  readonly workspace: string;
  say(line: string): void;
  /**
   * Sends `method` through the outbox, the line `key` names pending until its
   * answer; says `said` at once, and why when it is refused before it is
   * kept. A rejection after is the runtime's one notice.
   */
  send<N extends CommandMethodName>(environmentId: string, key: string | null, method: N, params: CommandParams<N>, said: string, done?: (answer: Extract<DispatchAnswer<N>, { readonly ok: true }>) => void): void;
  /** `commands.moveToGroup`, with the row's pending marker. */
  move(row: SessionRow, name: string | null, said: string): void;
  /** Puts the rail's cursor on the line `key` names, opening its heading, and gives the rail the keys. */
  reveal(key: string): void;
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

/** "; it applies when <environment> is back" while the environment cannot be reached. */
export const whenBack = (acts: Pick<RailActs, "views">, environmentId: string): string => {
  const view = acts.views.find((v) => v.environmentId === environmentId);
  return view && !isReachable(view) ? `; it applies when ${nameOf(view)} is back` : "";
};

const snoozeTo = (acts: RailActs, row: SessionRow, at: Date) =>
  acts.send(row.environmentId, rowKey(row), "sessions.snooze", { sessionId: row.summary.id, until: at.toISOString() }, `Snoozed ${titleOf(row)} until ${whenWords(at)}${whenBack(acts, row.environmentId)}.`);

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
        : [{ key: "wake", text: "Wake it now", choose: () => acts.send(row.environmentId, rowKey(row), "sessions.unsnooze", { sessionId: row.summary.id }, `Woke ${titleOf(row)}${whenBack(acts, row.environmentId)}.`) }];
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
          : [{ key: "add", text: `Add #${typed}`, choose: () => acts.send(row.environmentId, rowKey(row), "sessions.tag", { sessionId: row.summary.id, tag: typed }, `Tagged ${titleOf(row)} #${typed}${whenBack(acts, row.environmentId)}.`) }];
      const held = row.summary.tags
        .filter((tag) => tag.toLowerCase().includes(typed.toLowerCase()))
        .map(
          (tag): PickerRow => ({
            key: `tag:${tag}`,
            text: `#${tag}`,
            detail: "Enter takes it off",
            choose: () => acts.send(row.environmentId, rowKey(row), "sessions.untag", { sessionId: row.summary.id, tag }, `Took #${tag} off ${titleOf(row)}${whenBack(acts, row.environmentId)}.`),
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
            choose: () => acts.send(d.environmentId, `${d.environmentId}/${d.summary.id}`, "sessions.restore", { sessionId: d.summary.id }, `Restored ${title}${whenBack(acts, d.environmentId)}.`),
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

/** A choice made on the way to a new session: an id, or the environment's default (null). */
interface Choice {
  readonly id: string | null;
  readonly label: string;
}

const DEFAULT_ACCOUNT: Choice = { id: null, label: "default" };
const DEFAULT_MODEL: Choice = { id: null, label: "default" };

const chipsOf = (acts: RailActs, view: EnvironmentView, account?: Choice, model?: Choice): Chip[] => {
  const badge = acts.badges.get(view.environmentId);
  return [
    { label: "environment", value: `${badge ? `${badge.icon}${badge.abbreviation} ` : ""}${nameOf(view)}`, ...(badge && { colour: badge.colour }) },
    { label: "account", value: account?.label ?? "…" },
    { label: "model", value: model?.label ?? "…" },
  ];
};

/** A full path on the environment's machine: a workspace is never relative to a client. */
const isFullPath = (path: string) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path);

/** The paths the environment's sessions carry, the most recently used first, each with how many sessions use it. */
const pathsOn = (acts: RailActs, environmentId: string): { readonly path: string; readonly count: number }[] => {
  const used = new Map<string, { count: number; last: number }>();
  for (const row of acts.runtime.projections.sessionList.read().rows) {
    if (row.environmentId !== environmentId) continue;
    const { path } = row.summary.workspace;
    const last = Date.parse(row.summary.lastActivityAt ?? row.summary.createdAt);
    const seen = used.get(path);
    used.set(path, { count: (seen?.count ?? 0) + 1, last: Math.max(seen?.last ?? 0, last) });
  }
  return [...used].sort(([, a], [, b]) => b.last - a.last).map(([path, { count }]) => ({ path, count }));
};

const createOn = (acts: RailActs, view: EnvironmentView, account: Choice, model: Choice, path: string) => {
  const id = acts.newId();
  const key = `${view.environmentId}/${id}`;
  acts.send(
    view.environmentId,
    key,
    "sessions.create",
    { id, workspace: { kind: "directory", path }, ...(account.id !== null && { account: account.id }), ...(model.id !== null && { model: model.id }) },
    `Starting a session on ${nameOf(view)} in ${path}${whenBack(acts, view.environmentId)}.`,
    // Accepted later, maybe once the keys are elsewhere: the cursor goes to it, the focus and a filter stay.
    () => acts.land(key),
  );
};

/** The last step: the workspace, a `directory` path on the environment, from the paths its sessions carry, or typed (`/cwd` opens it). */
export const workspacePicker = (acts: RailActs, view: EnvironmentView, account: Choice, model: Choice, back?: Picker, query = ""): Picker =>
  pickerOf({
    title: `New session on ${nameOf(view)}: where it works`,
    chips: chipsOf(acts, view, account, model),
    typed: true,
    placeholder: `a path on ${nameOf(view)}, or pick one its sessions use`,
    query,
    ...(back && { back }),
    rows: (typed) => {
      const needle = typed.trim();
      const listed = pathsOn(acts, view.environmentId);
      const here = view.kind === "local" && isFullPath(acts.workspace) && !listed.some((p) => p.path === acts.workspace) ? [{ path: acts.workspace, count: 0 }] : [];
      const paths = [...here, ...listed]
        .filter(({ path }) => path.toLowerCase().includes(needle.toLowerCase()))
        .map(
          ({ path, count }): PickerRow => ({
            key: `path:${path}`,
            text: path,
            detail: count === 0 ? "this directory" : `${count} ${count === 1 ? "session" : "sessions"}`,
            choose: () => createOn(acts, view, account, model, path),
          }),
        );
      const exact = paths.some((row) => row.text === needle);
      const typedRow: PickerRow[] =
        needle === "" || exact
          ? []
          : isFullPath(needle)
            ? [{ key: "typed", text: needle, detail: "typed", choose: () => createOn(acts, view, account, model, needle) }]
            : [{ key: "typed", text: needle, absent: `a workspace is a full path on ${nameOf(view)}` }];
      return [...typedRow, ...paths];
    },
  });

/** The second step: the model, from the account's catalogue (every account's for the default). */
const modelPicker = (acts: RailActs, view: EnvironmentView, account: Choice, back: Picker): Picker => {
  const models = acts.runtime.projections.models(view.environmentId);
  const self: Picker = pickerOf({
    title: `New session on ${nameOf(view)}: its model`,
    chips: chipsOf(acts, view, account),
    typed: false,
    back,
    follows: [models],
    rows: () => {
      const seen = new Set<string>();
      const listed = (models.read().value ?? [])
        .filter((catalogue) => account.id === null || catalogue.accountId === account.id)
        .flatMap((catalogue) => catalogue.models)
        .filter((model) => !seen.has(model.id) && seen.add(model.id))
        .map((model): PickerRow => {
          const choice = { id: model.id, label: model.label ?? model.id };
          return { key: `model:${model.id}`, text: choice.label, detail: model.family, choose: () => workspacePicker(acts, view, account, choice, self) };
        });
      return [{ key: "default", text: "The account's default model", choose: () => workspacePicker(acts, view, account, DEFAULT_MODEL, self) }, ...listed];
    },
    note: () => {
      const answer = models.read();
      if (answer.value === null && answer.loading) return "Listing the models…";
      return answer.error ? `The models could not be listed: ${answer.error.message}` : undefined;
    },
  });
  return self;
};

/** Enter on an environment's heading: the account, then the model, then the workspace; `sessions.create` with a client-minted id. */
export const startPicker = (acts: RailActs, view: EnvironmentView): Picker => {
  const accounts = acts.runtime.projections.accounts(view.environmentId);
  const self: Picker = pickerOf({
    title: `New session on ${nameOf(view)}: its account`,
    chips: chipsOf(acts, view),
    typed: false,
    follows: [accounts],
    rows: () => [
      { key: "default", text: "The environment's default account", choose: () => modelPicker(acts, view, DEFAULT_ACCOUNT, self) },
      ...(accounts.read().value ?? []).map((account): PickerRow => {
        const choice = { id: account.id, label: account.label };
        return { key: `account:${account.id}`, text: account.label, detail: account.identity?.email ?? account.provider, choose: () => modelPicker(acts, view, choice, self) };
      }),
    ],
    note: () => {
      const answer = accounts.read();
      if (answer.value === null && answer.loading) return "Listing the accounts…";
      return answer.error ? `The accounts could not be listed: ${answer.error.message}` : undefined;
    },
  });
  return self;
};

/** `/cwd`: the workspace step on its own, on the environment the header is about, with its default account and model. */
export const cwdPicker = (acts: RailActs, view: EnvironmentView, query: string): Picker => workspacePicker(acts, view, DEFAULT_ACCOUNT, DEFAULT_MODEL, undefined, query);
