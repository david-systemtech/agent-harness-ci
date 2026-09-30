import { whenWords, writable, type DispatchFailure, type EnvironmentView, type KnownDirectory, type Observable, type RequestAnswer, type SessionRow, type Writable } from "@agent-harness/client-runtime";
import {
  RequestedDirectory,
  WORKSPACES_BROWSE_CAP,
  WORKSPACES_INSPECT_BRANCH_CAP,
  WorkspaceProblem,
  type InspectedBranch,
  type InspectedRepository,
  type Workspace,
  type WorkspaceRequest,
} from "@agent-harness/contracts";
import { nameOf } from "../view.js";
import { STAYS, pickerOf, type Chip, type Picker, type PickerRow } from "./picker.js";
import { titleOf, whenBack, type RailActs } from "./pickers.js";

/**
 * The workspace step (workspace-picker spec, "Renderers"; docs/specs/tui.md,
 * "Starting a session"; #334): where a session works on its environment. It
 * offers the environment's known directories (`projections.knownDirectories`:
 * each with its repository identity, one found gone shown so and not
 * offered, `picker.hide` taking one off the list on this client), the
 * terminal's own directory on the local environment, a typed path, browsing
 * the environment's directories (`workspaces.browse`), a worktree (a
 * repository, then a new branch with its presets or one the repository has,
 * from `workspaces.inspect`) and scratch. The new-session card is this step
 * with its chips (`new-session.ts`); a session whose workspace is missing
 * has it too, giving the session the workspace chosen (#328). What is chosen
 * goes as a workspace request, which the environment checks: its refusal is
 * one line on the step, which stays open.
 */

/** What a step says under its rows once a workspace is chosen: that it waits for the environment's answer, or its refusal. */
export type StepNote = { readonly waiting: string } | { readonly refused: string; readonly query: string };

/** The step a choice is made on: the picker, its note, and the query it was chosen at. */
export interface StepAt {
  readonly step: Picker;
  readonly note: Writable<StepNote | null>;
  readonly query: string;
}

/** Where the steps are, and what choosing a workspace there does. */
export interface StepPlace {
  readonly acts: RailActs;
  readonly view: EnvironmentView;
  /** The session the workspace is for: a new worktree branch's preset name is `agent-harness/` and its first eight characters. */
  readonly sessionId: string;
  /** The environment's known directories, less those hidden on this client. */
  known(): readonly KnownDirectory[];
  /** The chips over each step: the workspace chip says `workspace` (what a later step is making) when it is given. */
  chips(workspace?: string): readonly Chip[];
  /** Sends the command for `request`, chosen on the step `at`. */
  choose(request: WorkspaceRequest, at: StepAt): typeof STAYS | void;
  /** What each step's rows read besides its own answers: followed while it is drawn. */
  readonly follows: readonly Observable<unknown>[];
}

/** A command a step sends for the workspace chosen, and how it reads. */
export interface StepCommand {
  readonly request: WorkspaceRequest;
  /** Sends it, saying `said` at once; `accepted` hears the environment accept it, `refused` a refusal. */
  send(said: string, accepted: () => void, refused?: (failure: DispatchFailure) => void): void;
  /** What the activity line says as it is sent, before any "when back" and the full stop. */
  readonly said: string;
  /** What a refusal the step has no line of its own for says did not happen. */
  readonly unsent: string;
  /** What follows once the environment accepts it. */
  readonly done: () => void;
}

/** The last part of a path, as the environment's operating system writes it; the path itself when it has none. */
export const baseName = (path: string): string => path.split(/[\\/]/).filter((part) => part !== "").at(-1) ?? path;

/** A recorded workspace as the header and a chip say it: its kind, its directory's name, a worktree's repository and branch. */
export const workspaceLabel = (workspace: Workspace): string => {
  switch (workspace.kind) {
    case "worktree":
      return `worktree ${baseName(workspace.repository)} on ${workspace.branch}`;
    case "scratch":
      return "scratch";
    default:
      return `directory ${baseName(workspace.path)}`;
  }
};

/** A workspace request as its chip says it; a `session` request as the workspace it shares, found among `rows`. */
export const requestLabel = (request: WorkspaceRequest, sessionId: string, rows: readonly SessionRow[]): string => {
  switch (request.kind) {
    case "directory":
      return `directory ${baseName(request.path)}`;
    case "scratch":
      return "scratch";
    case "worktree":
      return `worktree ${baseName(request.repository)} on ${request.branch ?? request.newBranch?.name ?? presetBranch(sessionId)}`;
    case "session": {
      const shared = rows.find((row) => row.summary.id === request.sessionId.toLowerCase());
      return shared ? workspaceLabel(shared.summary.workspace) : "another session's";
    }
  }
};

/** A workspace request in the words of the line that says it is being sent. */
export const requestWords = (request: WorkspaceRequest, sessionId: string, rows: readonly SessionRow[]): string => {
  switch (request.kind) {
    case "directory":
      return request.path;
    case "scratch":
      return "a scratch directory";
    case "worktree":
      return `a worktree of ${request.repository} on ${request.branch ?? request.newBranch?.name ?? presetBranch(sessionId)}`;
    case "session": {
      const shared = rows.find((row) => row.summary.id === request.sessionId.toLowerCase());
      return shared ? `the workspace of ${titleOf(shared)}` : "another session's workspace";
    }
  }
};

/** The name the environment gives a new worktree branch it is not given one for (the workspace-picker spec's preset). */
export const presetBranch = (sessionId: string): string => `agent-harness/${sessionId.slice(0, 8)}`;

/** A repository identity as a row shows it: without its scheme, which is always `https://`. */
const identityWords = (identity: string): string => identity.replace(/^https:\/\//, "");

/** Whether the terminal's own directory is a full path, which the local environment's step offers as it is. */
export const isFullPath = (path: string) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path);

/** A directory's child `name`, in its separator. */
const childOf = (path: string, name: string): string => {
  const separator = /^[A-Za-z]:\\|^\\\\/.test(path) ? "\\" : "/";
  return path.endsWith("/") || path.endsWith("\\") ? `${path}${name}` : `${path}${separator}${name}`;
};

/** How the environment's refusal of a directory reads on the step, by its problem (#325). */
const PROBLEM_LINES: Readonly<Record<WorkspaceProblem, (path: string, where: string) => string>> = {
  does_not_exist: (path, where) => `${path} does not exist on ${where}.`,
  not_a_directory: (path, where) => `${path} is not a directory on ${where}.`,
  not_readable: (path, where) => `${where} cannot list or enter ${path}.`,
  reserved: (path, where) => `${path} is inside ${where}'s data directory.`,
};

/** What a refusal's data names, read as text; undefined where it names nothing. */
const textOf = (data: Readonly<Record<string, unknown>>, key: string): string | undefined => (typeof data[key] === "string" ? data[key] : undefined);

/** The session the environment names, by its title when this client lists it. */
const sessionWords = (acts: RailActs, environmentId: string, sessionId: string): string => {
  const row = acts.runtime.projections.sessionList.read().rows.find((r) => r.environmentId === environmentId && r.summary.id === sessionId.toLowerCase());
  return row ? titleOf(row) : `the session ${sessionId.slice(0, 8)}`;
};

/** Where a branch is checked out, and by which session when the harness made that worktree. */
const heldWords = (acts: RailActs, environmentId: string, worktree: string, sessionId: string | null | undefined): string =>
  `checked out in ${worktree}${sessionId == null ? "" : ` by ${sessionWords(acts, environmentId, sessionId)}`}`;

/**
 * A refusal of the workspace chosen, in one line: a path that is not full
 * (the contracts' own check, refused before it is sent), a directory's
 * problem, a worktree's branch or repository reason, or else what the
 * environment says after `unsent` (what did not happen).
 */
const refusalLine = (place: StepPlace, failure: DispatchFailure, request: WorkspaceRequest, unsent: string): string => {
  const where = nameOf(place.view);
  const data = failure.data ?? {};
  if (failure.code === "invalid_params" && request.kind === "directory") return `A workspace is a full path on ${where}, or one from its home (~).`;
  if (failure.code === "invalid_params" && request.kind === "worktree") return `A repository is a full path on ${where}: pick one, or browse to it.`;
  const problem = WorkspaceProblem.safeParse(data["problem"]);
  if (problem.success) return PROBLEM_LINES[problem.data](textOf(data, "path") ?? (request.kind === "directory" ? request.path : ""), where);
  const branch = textOf(data, "branch") ?? "";
  const repository = textOf(data, "repository") ?? (request.kind === "worktree" ? request.repository : "");
  switch (textOf(data, "reason")) {
    case "branch_checked_out":
      return `${branch} is ${heldWords(place.acts, place.view.environmentId, textOf(data, "worktree") ?? "another worktree", textOf(data, "sessionId"))}.`;
    case "branch_exists":
      return `${repository} already has a branch ${branch}: pick it from the list, or name another.`;
    case "branch_not_found":
      return `${repository} has no local branch ${branch} on ${where}.`;
    case "not_a_repository":
      return `${textOf(data, "path") ?? repository} is in no git repository on ${where}.`;
    case "no_commits":
      return `${repository} has no commit for a new branch to start from.`;
    case "git_unavailable":
      return `${where} has no git to make a worktree with.`;
    default:
      return `${unsent}: ${failure.message}`;
  }
};

/**
 * Sends a step's command for the workspace chosen; the environment checks
 * it, not the step (#325). While the environment can answer, the step stays
 * open until it does: accepted, the step closes and `done` follows; refused,
 * the step says why in one line and waits for another choice. An
 * environment that cannot be reached applies it when it is back: the step
 * closes at once, and a refusal then is the runtime's notice.
 */
export const sendFromStep = (place: StepPlace, at: StepAt, command: StepCommand): typeof STAYS | void => {
  const { acts, view } = place;
  const now = at.note.read();
  if (now !== null && "waiting" in now) return STAYS;
  const later = whenBack(acts, view.environmentId);
  const said = `${command.said}${later}.`;
  // Accepted later, maybe once the keys are elsewhere: what follows then leaves the focus and a filter where they are.
  if (later !== "") return command.send(said, command.done);
  at.note.set({ waiting: `Waiting for ${nameOf(view)}'s answer…` });
  command.send(
    said,
    () => {
      at.note.set(null);
      acts.close(at.step);
      command.done();
    },
    (failure) => at.note.set({ refused: refusalLine(place, failure, command.request, command.unsent), query: at.query }),
  );
  return STAYS;
};

/** The line a step's note says for a choice made on it: waiting, or the refusal while the query it was chosen at stands. */
const choiceNote = (note: Writable<StepNote | null>, typed: string): string | undefined => {
  const now = note.read();
  if (now === null) return undefined;
  // A refusal is of the choice made at its query: typing another leaves it behind.
  return "waiting" in now ? now.waiting : typed === now.query ? now.refused : undefined;
};

/** What a browse step's take row does with the directory listed: its words, and the choice. */
interface Take {
  readonly text: (path: string) => string;
  readonly choose: (path: string, at: StepAt) => Picker | typeof STAYS | void;
}

/** A browse from `path` (the home when absent), dot-directories listed or not, stepping back to `back`. */
interface BrowseFrom {
  readonly path: string | undefined;
  readonly hidden: boolean;
  readonly back: Picker;
  readonly take: Take;
}

/** What went wrong asking to browse or inspect `path`, in one line. */
const askedLine = (answer: Extract<RequestAnswer<"workspaces.browse">, { readonly ok: false }>, path: string, where: string): string => {
  if (answer.error.code === "not_found") return `${path} is not a directory on ${where}.`;
  if (answer.error.data?.["reason"] === "not_readable") return `${where} cannot list ${path}.`;
  return `${where} could not list ${path}: ${answer.error.message}`;
};

/**
 * Browsing the environment's directories (`workspaces.browse`): the
 * directory listed taken by its first row, its parent, each subdirectory
 * (a repository's root marked) to go into, dot-directories on a toggle,
 * and a line when it holds more than were listed.
 */
const browseStep = (place: StepPlace, from: BrowseFrom): Picker => {
  const { acts, view } = place;
  const where = nameOf(view);
  const listing = writable<RequestAnswer<"workspaces.browse"> | null>(null);
  void acts.runtime.requests
    .call(view.environmentId, "workspaces.browse", { ...(from.path !== undefined && { path: from.path }), ...(from.hidden && { hidden: true }) })
    .then((answer) => listing.set(answer));
  const note = writable<StepNote | null>(null);
  const asked = from.path ?? `${where}'s home`;
  const step: Picker = pickerOf({
    title: () => {
      const answer = listing.read();
      return `Browse ${where}: ${answer?.ok ? answer.result.path : asked}`;
    },
    chips: () => {
      const answer = listing.read();
      return place.chips(answer?.ok ? `directory ${baseName(answer.result.path)}` : undefined);
    },
    typed: true,
    placeholder: "type to filter its directories by name",
    back: from.back,
    follows: [listing, note, ...place.follows],
    rows: (typed) => {
      const answer = listing.read();
      if (!answer?.ok) return [];
      const { path, parent, directories } = answer.result;
      const at: StepAt = { step, note, query: typed };
      const needle = typed.trim().toLowerCase();
      const into = (to: string): Picker => browseStep(place, { ...from, path: to, back: step });
      const take: PickerRow = { key: "take", text: from.take.text(path), choose: () => from.take.choose(path, at) };
      const up: PickerRow[] = parent === null ? [] : [{ key: "parent", text: "..", detail: `up to ${parent}`, choose: () => into(parent) }];
      const listed = directories
        .filter((directory) => directory.name.toLowerCase().includes(needle))
        .map((directory): PickerRow => ({
          key: `directory:${directory.name}`,
          text: `${directory.name}/`,
          ...(directory.repository && { detail: "repository" }),
          choose: () => into(childOf(path, directory.name)),
        }));
      // The same directory again with the dot-directories shown or not: in this step's place, stepping back where it does.
      const toggle: PickerRow = {
        key: "hidden",
        text: from.hidden ? "Hide the dot-directories" : "Show the dot-directories",
        choose: () => browseStep(place, { ...from, path, hidden: !from.hidden }),
      };
      return [take, ...up, ...listed, toggle];
    },
    note: (typed) => {
      const chosen = choiceNote(note, typed);
      if (chosen !== undefined) return chosen;
      const answer = listing.read();
      if (answer === null) return `Listing ${asked}…`;
      if (!answer.ok) return askedLine(answer, asked, where);
      return answer.result.truncated ? `Only the first ${WORKSPACES_BROWSE_CAP.toLocaleString("en")} directories are listed: type a path on the step before to reach the rest.` : undefined;
    },
  });
  return step;
};

/** The row that browses the environment's directories, from a path typed when one is: absent, with the capability's line, without `terminal`. */
const browseRow = (place: StepPlace, needle: string, back: Picker, take: Take): PickerRow => {
  const capability = place.acts.runtime.capability(place.view.environmentId, "workspaces.browse");
  const from = needle !== "" && RequestedDirectory.safeParse(needle).success ? needle : undefined;
  const text = from === undefined ? `Browse ${nameOf(place.view)}'s directories` : `Browse from ${from}`;
  if (capability.status === "absent") return { key: "browse", text, absent: capability.message };
  return { key: "browse", text, choose: () => browseStep(place, { path: from, hidden: false, back, take }) };
};

/** The branch a new worktree branch starts from, as the picker says it: the main checkout's. */
const baseWords = (repository: InspectedRepository | null): string => {
  if (repository === null) return "the main checkout's HEAD";
  const main = repository.branches.find((branch) => branch.worktree === repository.mainCheckout)?.name ?? (repository.root === repository.mainCheckout ? repository.branch : null);
  return main ?? "the main checkout's HEAD";
};

/**
 * A worktree's branch: a new one with its presets (named from the
 * session's id, from the main checkout's `HEAD`) or named as typed, or one
 * the repository has, from `workspaces.inspect`; a branch another worktree
 * holds is shown with that worktree and its session, and not offered.
 * Without `terminal` the branches cannot be read: the note says why, and a
 * typed name is offered as a new branch or one the repository has.
 */
const branchStep = (place: StepPlace, repository: string, back: Picker): Picker => {
  const { acts, view } = place;
  const where = nameOf(view);
  const capability = acts.runtime.capability(view.environmentId, "workspaces.inspect");
  const inspection = writable<RequestAnswer<"workspaces.inspect"> | null>(null);
  if (capability.status === "present") void acts.runtime.requests.call(view.environmentId, "workspaces.inspect", { path: repository }).then((answer) => inspection.set(answer));
  const note = writable<StepNote | null>(null);
  const name = baseName(repository);
  const step: Picker = pickerOf({
    title: `A worktree of ${name} on ${where}: its branch`,
    chips: () => place.chips(`worktree ${name}`),
    typed: true,
    placeholder: "a new branch's name, or pick one the repository has",
    back,
    follows: [inspection, note, ...place.follows],
    rows: (typed) => {
      const answer = inspection.read();
      const inspected = answer?.ok ? answer.result : null;
      // A path the environment could not use, or in no repository: nothing to make a worktree of (the note says why).
      if (inspected !== null && (inspected.problem !== null || inspected.repository === null)) return [];
      if (capability.status === "present" && answer === null) return [];
      const read = inspected?.repository ?? null;
      const at: StepAt = { step, note, query: typed };
      const make = (branch: Pick<Extract<WorkspaceRequest, { readonly kind: "worktree" }>, "branch" | "newBranch">) => () =>
        place.choose({ kind: "worktree", repository: inspected?.path ?? repository, ...branch }, at);
      const base = baseWords(read);
      const needle = typed.trim();
      const branches = read?.branches ?? [];
      const typedRows: PickerRow[] =
        needle === "" || branches.some((branch) => branch.name === needle)
          ? []
          : [
              { key: "typed", text: `New branch ${needle}`, detail: `from ${base}`, choose: make({ newBranch: { name: needle } }) },
              // Unread, the branches may hold it: offered as one the repository has too, for the environment to find.
              ...(read === null ? [{ key: "typed-existing", text: `Branch ${needle}`, detail: "one the repository has", choose: make({ branch: needle }) }] : []),
            ];
      const preset: PickerRow = { key: "new", text: `New branch ${presetBranch(place.sessionId)}`, detail: `from ${base}`, choose: make({ newBranch: {} }) };
      const listed = branches
        .filter((branch) => branch.name.toLowerCase().includes(needle.toLowerCase()))
        .map(
          (branch: InspectedBranch): PickerRow =>
            branch.worktree === null
              ? { key: `branch:${branch.name}`, text: branch.name, detail: `committed ${whenWords(new Date(branch.committedAt))}`, choose: make({ branch: branch.name }) }
              : { key: `branch:${branch.name}`, text: branch.name, absent: heldWords(acts, view.environmentId, branch.worktree, branch.sessionId) },
        );
      return [...typedRows, preset, ...listed];
    },
    note: (typed) => {
      const chosen = choiceNote(note, typed);
      if (chosen !== undefined) return chosen;
      if (capability.status === "absent") return capability.message;
      const answer = inspection.read();
      if (answer === null) return `Reading ${name}'s branches…`;
      if (!answer.ok) return `${where} could not read ${repository}: ${answer.error.message}`;
      const { path, problem, repository: read } = answer.result;
      if (problem !== null) return PROBLEM_LINES[problem](path, where);
      if (read === null) return `${path} is in no git repository on ${where}.`;
      return read.branchesTruncated ? `Only the ${WORKSPACES_INSPECT_BRANCH_CAP.toLocaleString("en")} most recently committed branches are listed: type another's name.` : undefined;
    },
  });
  return step;
};

/** A worktree's repository: a known directory, a path typed, or one browsed to; then its branch. */
const repositoryStep = (place: StepPlace, back: Picker): Picker => {
  const where = nameOf(place.view);
  const step: Picker = pickerOf({
    title: `A worktree on ${where}: its repository`,
    chips: () => place.chips("worktree"),
    typed: true,
    placeholder: `a path in a repository on ${where}, or pick one its sessions use`,
    back,
    follows: place.follows,
    rows: (typed) => {
      const needle = typed.trim();
      const known = place
        .known()
        .filter((directory) => directory.missingSince === null && directory.path.toLowerCase().includes(needle.toLowerCase()))
        .map(
          (directory): PickerRow => ({
            key: `path:${directory.path}`,
            text: directory.path,
            ...(directory.repositoryIdentity !== null && { detail: identityWords(directory.repositoryIdentity) }),
            choose: () => branchStep(place, directory.path, step),
          }),
        );
      const exact = known.some((row) => row.text === needle);
      // A path the environment can read as a directory request's (full, or from its home); anything else says so on its row.
      const typedRow: PickerRow[] =
        needle === "" || exact
          ? []
          : [
              RequestedDirectory.safeParse(needle).success
                ? { key: "typed", text: needle, detail: "typed", choose: () => branchStep(place, needle, step) }
                : { key: "typed", text: needle, absent: `a repository is a full path on ${where}, or one from its home (~)` },
            ];
      const take: Take = { text: (path) => `Make the worktree from ${path}`, choose: (path, at) => branchStep(place, path, at.step) };
      return [...typedRow, ...known, browseRow(place, needle, step, take)];
    },
  });
  return step;
};

/** What the workspace step is, beside its place. */
export interface WorkspaceStepOptions {
  readonly title: string | (() => string);
  /** The request preset: its row comes first, where the cursor starts, and a `session` preset has a row of its own. */
  readonly preset?: WorkspaceRequest | null;
  /** Rows after the workspace's own: the card's chips to change. */
  readonly more?: (back: Picker) => readonly PickerRow[];
  readonly query?: string;
}

/** The key of the row a preset request is offered on; undefined for one with no row of its own (a worktree). */
const presetKey = (preset: WorkspaceRequest | null | undefined): string | undefined => {
  if (preset?.kind === "directory") return `path:${preset.path}`;
  if (preset?.kind === "scratch" || preset?.kind === "session") return preset.kind;
  return undefined;
};

/** The workspace step: known directories, the terminal's own on the local environment, typed, Browse, a worktree, scratch. */
export const workspaceStep = (place: StepPlace, options: WorkspaceStepOptions): Picker => {
  const { acts, view } = place;
  const where = nameOf(view);
  const note = writable<StepNote | null>(null);
  const step: Picker = pickerOf({
    title: options.title,
    chips: () => place.chips(),
    typed: true,
    placeholder: `a path on ${where} (~ for its home), or pick one its sessions use`,
    ...(options.query !== undefined && { query: options.query }),
    follows: [note, ...place.follows],
    note: (typed) => choiceNote(note, typed),
    rows: (typed) => {
      const needle = typed.trim();
      const at: StepAt = { step, note, query: typed };
      const chosen = (request: WorkspaceRequest) => () => place.choose(request, at);
      const directory = (path: string) => chosen({ kind: "directory", path });
      const matches = (path: string) => path.toLowerCase().includes(needle.toLowerCase());
      const listed = place.known();
      const sessions = acts.runtime.projections.sessionList.read().rows;
      const sharing = options.preset?.kind === "session" ? options.preset : undefined;
      const shared = sharing && sessions.find((row) => row.environmentId === view.environmentId && row.summary.id === sharing.sessionId.toLowerCase());
      const session: PickerRow[] =
        sharing && shared && matches(shared.summary.workspace.path)
          ? [{ key: "session", text: `Where ${titleOf(shared)} works`, detail: shared.summary.workspace.path, choose: chosen(sharing) }]
          : [];
      const known = listed
        .filter((known) => matches(known.path))
        .map(
          (known): PickerRow => ({
            key: `path:${known.path}`,
            text: known.path,
            ...(known.repositoryIdentity !== null && { detail: identityWords(known.repositoryIdentity) }),
            ...(known.missingSince === null ? { choose: directory(known.path) } : { absent: `gone since ${whenWords(new Date(known.missingSince))}` }),
            hide: () => hideDirectory(place, known.path),
          }),
        );
      const here: PickerRow[] =
        view.kind === "local" && isFullPath(acts.workspace) && !listed.some((known) => known.path === acts.workspace) && matches(acts.workspace)
          ? [{ key: `path:${acts.workspace}`, text: acts.workspace, detail: "this directory", choose: directory(acts.workspace) }]
          : [];
      const exact = [...known, ...here].some((row) => row.text === needle);
      const typedRow: PickerRow[] = needle === "" || exact ? [] : [{ key: "typed", text: needle, detail: "typed", choose: directory(needle) }];
      const take: Take = { text: (path) => `Work in ${path}`, choose: (path, from) => place.choose({ kind: "directory", path }, from) };
      const rows: PickerRow[] = [
        ...session,
        ...known,
        ...here,
        browseRow(place, needle, step, take),
        { key: "worktree", text: "A worktree", detail: "of a repository, on a new branch or one it has", choose: () => repositoryStep(place, step) },
        { key: "scratch", text: "Scratch", detail: "a directory of the session's own", choose: chosen({ kind: "scratch" }) },
        ...(options.more?.(step) ?? []),
      ];
      // With nothing typed the preset's row comes first, where the cursor starts: a directory listed later (another
      // client's session) goes after it, never under the cursor.
      const preset = rows.findIndex((row) => row.key === presetKey(options.preset));
      return [...typedRow, ...(needle === "" && preset > 0 ? [rows[preset] as PickerRow, ...rows.filter((_, i) => i !== preset)] : rows)];
    },
  });
  return step;
};

/** Takes a known directory off the step's list on this client, until a session uses it again (`hiddenDirectories`). */
const hideDirectory = (place: StepPlace, path: string): void => {
  const { acts, view } = place;
  void acts.runtime.knownDirectories.hide(view.environmentId, path).then(
    () => acts.say(`Hid ${path} from ${nameOf(view)}'s list on this terminal; it comes back when a session works there again.`),
    (error: unknown) => acts.say(`${path} was not hidden: ${error instanceof Error ? error.message : String(error)}`),
  );
};

/** The environment a step is on, as its chip: the badge in its colour, then the name, as the runtime lists the environment now. */
export const environmentChip = (acts: Pick<RailActs, "runtime" | "badge">, view: EnvironmentView): Chip => {
  const now = acts.runtime.projections.environments.read().find((v) => v.environmentId === view.environmentId) ?? view;
  const badge = acts.badge(view.environmentId);
  return { label: "environment", value: `${badge ? `${badge.abbreviation} ` : ""}${nameOf(now)}`, ...(badge && { colour: badge.colour }) };
};

/**
 * `/cwd` on a session whose workspace is missing (workspace-picker spec,
 * "Missing workspaces"; ADR 0021; #328): the workspace step for that
 * session, which gives it the workspace chosen (`sessions.setWorkspace`).
 */
export const setWorkspacePicker = (acts: RailActs, view: EnvironmentView, row: SessionRow, query = ""): Picker => {
  const known = acts.runtime.projections.knownDirectories(view.environmentId);
  const title = titleOf(row);
  const rows = () => acts.runtime.projections.sessionList.read().rows;
  const place: StepPlace = {
    acts,
    view,
    sessionId: row.summary.id,
    known: () => known.read(),
    chips: () => [environmentChip(acts, view)],
    follows: [known],
    choose: (request, at) =>
      sendFromStep(place, at, {
        request,
        send: (said, accepted, refused) => acts.send(view.environmentId, "sessions.setWorkspace", { sessionId: row.summary.id, workspace: request }, said, accepted, refused),
        said: `${title} works in ${requestWords(request, row.summary.id, rows())} now`,
        unsent: "The workspace was not changed",
        done: () => undefined,
      }),
  };
  return workspaceStep(place, { title: `Choose a workspace for ${title} on ${nameOf(view)}`, query });
};
