import { writable, type CommandParams, type DispatchAnswer, type DispatchFailure, type EnvironmentView, type Runtime, type SessionRow, type Writable } from "@agent-harness/client-runtime";
import { WorkspaceProblem, groupNameKey, shelfOf, type CommandMethodName, type DeletedSessionSummary } from "@agent-harness/contracts";
import { nameOf } from "../view.js";
import type { Badge } from "./badge.js";
import { isReachable, rowKey } from "./model.js";
import { STAYS, pickerOf, type Chip, type Picker, type PickerRow } from "./picker.js";
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
 * typed, which the environment checks (#325). Each is a function of the
 * runtime's projections, read as drawn. `/cwd` on a session whose workspace
 * is missing is the workspace step for that session, which gives it the
 * directory chosen (#328).
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

/** "; it applies when <environment> is back" while the environment cannot be reached. */
export const whenBack = (acts: Pick<RailActs, "views">, environmentId: string): string => {
  const view = acts.views.find((v) => v.environmentId === environmentId);
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

/** A choice made on the way to a new session: an id, or the environment's default (null). */
interface Choice {
  readonly id: string | null;
  readonly label: string;
}

const DEFAULT_ACCOUNT: Choice = { id: null, label: "default" };
const DEFAULT_MODEL: Choice = { id: null, label: "default" };

/** The environment a step is on, with its badge. */
const environmentChip = (acts: RailActs, view: EnvironmentView): Chip => {
  const badge = acts.badges.get(view.environmentId);
  return { label: "environment", value: `${badge ? `${badge.icon}${badge.abbreviation} ` : ""}${nameOf(view)}`, ...(badge && { colour: badge.colour }) };
};

const chipsOf = (acts: RailActs, view: EnvironmentView, account?: Choice, model?: Choice): Chip[] => [
  environmentChip(acts, view),
  { label: "account", value: account?.label ?? "…" },
  { label: "model", value: model?.label ?? "…" },
];

/** Whether the terminal's own directory is a full path, which the local environment's step offers as it is. */
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

/** What the workspace step says under its rows once a path is chosen: that it waits for the environment's answer, or its refusal. */
type StepNote = { readonly waiting: string } | { readonly refused: string; readonly query: string };

/** How the environment's refusal of a directory reads on the step, by its problem (#325). */
const PROBLEM_LINES: Readonly<Record<WorkspaceProblem, (path: string, where: string) => string>> = {
  does_not_exist: (path, where) => `${path} does not exist on ${where}.`,
  not_a_directory: (path, where) => `${path} is not a directory on ${where}.`,
  not_readable: (path, where) => `${where} cannot list or enter ${path}.`,
  reserved: (path, where) => `${path} is inside ${where}'s data directory.`,
};

/**
 * A refusal of a directory chosen on the workspace step in one line: a
 * path that is not full (the contracts' own check, refused before it is
 * sent), a problem the environment names, or else what the environment
 * says after `unsent` (what did not happen).
 */
const refusalLine = (failure: DispatchFailure, path: string, view: EnvironmentView, unsent: string): string => {
  const where = nameOf(view);
  if (failure.code === "invalid_params") return `A workspace is a full path on ${where}, or one from its home (~).`;
  const problem = WorkspaceProblem.safeParse(failure.data?.["problem"]);
  const at = failure.data?.["path"];
  if (problem.success) return PROBLEM_LINES[problem.data](typeof at === "string" ? at : path, where);
  return `${unsent}: ${failure.message}`;
};

/** The workspace step a choice is made on: the picker, its note, and the query it was chosen at. */
interface StepAt {
  readonly step: Picker;
  readonly note: Writable<StepNote | null>;
  readonly query: string;
}

/** A command the workspace step sends for the path chosen, and how it reads. */
interface StepCommand<N extends "sessions.create" | "sessions.setWorkspace"> {
  readonly method: N;
  readonly params: CommandParams<N>;
  /** What the activity line says as it is sent, before any "when back" and the full stop. */
  readonly said: string;
  /** What a refusal the step has no line of its own for says did not happen. */
  readonly unsent: string;
  /** What follows once the environment accepts it. */
  readonly done: () => void;
}

/**
 * Sends the step's command for `path`, as typed; the environment checks
 * the path, not the step (#325). While the environment can answer, the step
 * stays open until it does: accepted, the step closes and `done` follows;
 * refused, the step says why in one line and waits for another path. An
 * environment that cannot be reached applies it when it is back: the step
 * closes at once, and a refusal then is the runtime's notice.
 */
const sendFromStep = <N extends "sessions.create" | "sessions.setWorkspace">(
  acts: RailActs,
  view: EnvironmentView,
  path: string,
  at: StepAt,
  command: StepCommand<N>,
): typeof STAYS | void => {
  const now = at.note.read();
  if (now !== null && "waiting" in now) return STAYS;
  const later = whenBack(acts, view.environmentId);
  const said = `${command.said}${later}.`;
  // Accepted later, maybe once the keys are elsewhere: what follows then leaves the focus and a filter where they are.
  if (later !== "") return acts.send(view.environmentId, command.method, command.params, said, command.done);
  at.note.set({ waiting: `Waiting for ${nameOf(view)}'s answer…` });
  acts.send(
    view.environmentId,
    command.method,
    command.params,
    said,
    () => {
      at.note.set(null);
      acts.close(at.step);
      command.done();
    },
    (failure) => at.note.set({ refused: refusalLine(failure, path, view, command.unsent), query: at.query }),
  );
  return STAYS;
};

/** Asks the environment for a session in `path`; made, the cursor goes to it. */
const createOn = (acts: RailActs, view: EnvironmentView, account: Choice, model: Choice, path: string, at: StepAt): typeof STAYS | void => {
  const id = acts.newId();
  const key = `${view.environmentId}/${id}`;
  return sendFromStep(acts, view, path, at, {
    method: "sessions.create",
    params: {
      id,
      workspace: { kind: "directory", path },
      ...(account.id !== null && { account: account.id }),
      ...(model.id !== null && { model: model.id }),
    },
    said: `Starting a session on ${nameOf(view)} in ${path}`,
    unsent: "No session was started",
    done: () => acts.land(key),
  });
};

/**
 * The last step: the workspace, a `directory` path on the environment, from
 * the paths its sessions carry, or typed as it is, `~` for the environment's
 * home (`/cwd` opens it). The environment's refusal of the path chosen is its
 * note while that query stands.
 */
export const workspacePicker = (acts: RailActs, view: EnvironmentView, account: Choice, model: Choice, back?: Picker, query = ""): Picker => {
  const note = writable<StepNote | null>(null);
  const step: Picker = pickerOf({
    title: `New session on ${nameOf(view)}: where it works`,
    chips: chipsOf(acts, view, account, model),
    typed: true,
    placeholder: `a path on ${nameOf(view)} (~ for its home), or pick one its sessions use`,
    query,
    ...(back && { back }),
    follows: [note],
    note: (typed) => {
      const now = note.read();
      if (now === null) return undefined;
      // A refusal is of the path chosen at its query: typing another leaves it behind.
      return "waiting" in now ? now.waiting : typed === now.query ? now.refused : undefined;
    },
    rows: (typed) => {
      const needle = typed.trim();
      const chosen = (path: string) => () => createOn(acts, view, account, model, path, { step, note, query: typed });
      const listed = pathsOn(acts, view.environmentId);
      const here = view.kind === "local" && isFullPath(acts.workspace) && !listed.some((p) => p.path === acts.workspace) ? [{ path: acts.workspace, count: 0 }] : [];
      const paths = [...here, ...listed]
        .filter(({ path }) => path.toLowerCase().includes(needle.toLowerCase()))
        .map(
          ({ path, count }): PickerRow => ({
            key: `path:${path}`,
            text: path,
            detail: count === 0 ? "this directory" : `${count} ${count === 1 ? "session" : "sessions"}`,
            choose: chosen(path),
          }),
        );
      const exact = paths.some((row) => row.text === needle);
      const typedRow: PickerRow[] = needle === "" || exact ? [] : [{ key: "typed", text: needle, detail: "typed", choose: chosen(needle) }];
      return [...typedRow, ...paths];
    },
  });
  return step;
};

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

/**
 * `/cwd` on a session whose workspace is missing (workspace-picker spec,
 * "Missing workspaces"; ADR 0021; #328): the workspace step for that
 * session, a `directory` from the directories its environment's sessions
 * use (`projections.knownDirectories`, one found gone shown so and not
 * offered), the terminal's own on the local environment, or typed as it is;
 * the one chosen becomes the session's workspace (`sessions.setWorkspace`).
 */
export const setWorkspacePicker = (acts: RailActs, view: EnvironmentView, row: SessionRow, query = ""): Picker => {
  const note = writable<StepNote | null>(null);
  const known = acts.runtime.projections.knownDirectories(view.environmentId);
  const title = titleOf(row);
  const step: Picker = pickerOf({
    title: `Choose a workspace for ${title} on ${nameOf(view)}`,
    chips: [environmentChip(acts, view)],
    typed: true,
    placeholder: `a path on ${nameOf(view)} (~ for its home), or pick one its sessions use`,
    query,
    follows: [note, known],
    note: (typed) => {
      const now = note.read();
      if (now === null) return undefined;
      return "waiting" in now ? now.waiting : typed === now.query ? now.refused : undefined;
    },
    rows: (typed) => {
      const needle = typed.trim();
      const chosen = (path: string) => () =>
        sendFromStep(acts, view, path, { step, note, query: typed }, {
          method: "sessions.setWorkspace",
          params: { sessionId: row.summary.id, workspace: { kind: "directory", path } },
          said: `${title} works in ${path} now`,
          unsent: "The workspace was not changed",
          done: () => undefined,
        });
      const listed = known.read();
      const here = view.kind === "local" && isFullPath(acts.workspace) && !listed.some((directory) => directory.path === acts.workspace);
      const paths = [
        ...(here ? [{ path: acts.workspace, detail: "this directory", missingSince: null }] : []),
        ...listed.map((directory) => ({ path: directory.path, detail: directory.repositoryIdentity ?? "no repository", missingSince: directory.missingSince })),
      ]
        .filter(({ path }) => path.toLowerCase().includes(needle.toLowerCase()))
        .map(
          ({ path, detail, missingSince }): PickerRow =>
            missingSince === null
              ? { key: `path:${path}`, text: path, detail, choose: chosen(path) }
              : { key: `path:${path}`, text: path, absent: `gone since ${whenWords(new Date(missingSince))}` },
        );
      const exact = paths.some((one) => one.text === needle);
      const typedRow: PickerRow[] = needle === "" || exact ? [] : [{ key: "typed", text: needle, detail: "typed", choose: chosen(needle) }];
      return [...typedRow, ...paths];
    },
  });
  return step;
};
