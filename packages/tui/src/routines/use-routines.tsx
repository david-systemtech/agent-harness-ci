import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { useMemo, type ReactElement } from "react";
import type { Clock, CommandParams, DispatchAnswer, DispatchFailure, EnvironmentView, RoutineRow, Runtime } from "@agent-harness/client-runtime";
import { BYPASS_SENTENCE, ROUTINE_HISTORY_MAX, type KeyActionId, type RoutineEntry, type SchemaIssue } from "@agent-harness/contracts";
import { TERMINAL_ROLES } from "@agent-harness/theme";
import { expandHome } from "../composer/attachments.js";
import type { ExternalEditResult } from "../composer/external-editor.js";
import type { Handler } from "../keys.js";
import { LinesPanel, ListCard, TypedLine, wrappedRows } from "../pickers/cards.js";
import { useFollow, type Opened } from "../session/use-session.js";
import { messageOf, nameOf, type Question } from "../view.js";
import { entryLines, historyRows, importLines, listRows, type ListRow, type RoutineRef, type RoutinesCard } from "./cards.js";
import { ROUTINE_TEMPLATE, annotated, asksBypass, documentCount, type DocumentIssue } from "./document.js";
import type { RoutineKey, RoutinesCommand } from "./commands.js";

/**
 * The routines card's hook (docs/specs/tui.md, "The routines"; #533): it
 * follows what the open card shows (`projections.routines`, a routine's
 * `projections.routineHistory`, the endpoints' cached list), runs what the
 * keys choose, and lends the terminal to the editor for an edit. The
 * runtime answers who may do what: a `sessions:write` command goes through
 * the outbox (`commands.dispatch`), which queues it while its environment
 * cannot be reached; run now, a `runs:drive` command, is refused at once
 * then; the queries and the `admin` calls are direct (`requests.call`).
 */

export interface RoutinesHost {
  readonly runtime: Runtime;
  readonly clock: Clock;
  readonly request: () => void;
  readonly views: readonly EnvironmentView[];
  /** The header's environment: whose endpoints `/routines endpoints` shows, and where a new routine or an import goes. */
  readonly current: EnvironmentView | undefined;
  /** The open card, when it is the routines card. */
  readonly card: RoutinesCard | undefined;
  open(card: RoutinesCard): void;
  /** Changes the open card while it is still the routines card. */
  change(update: (card: RoutinesCard) => RoutinesCard): void;
  close(): void;
  say(line: string): void;
  ask(question: Question): void;
  openSession(opened: Opened): void;
  newCommandId(): string;
  /** Mints a routine's id for a new routine or an import: a version 4 UUID. */
  newRoutineId(): string;
  keys(action: KeyActionId): string;
  /** The routine's YAML in `$VISUAL` or `$EDITOR`, with the terminal lent to it. */
  editYaml(yaml: string): Promise<ExternalEditResult>;
  /** Where a relative path typed for an export or an import is read from. */
  readonly cwd: string;
}

export interface Routines {
  run(command: RoutinesCommand): void;
  /** How many rows the card's list has. */
  rows(card: RoutinesCard): number;
  move(card: RoutinesCard, step: number): RoutinesCard;
  /** Enter. */
  choose(card: RoutinesCard): void;
  /** Esc: the card to go back to, or null to close it. */
  back(card: RoutinesCard): RoutinesCard | null;
  /** The card takes what is typed as text (a path, an endpoint's name, URL or secret). */
  takesText(card: RoutinesCard): boolean;
  typed(card: RoutinesCard, text: string): RoutinesCard;
  erased(card: RoutinesCard): RoutinesCard;
  readonly handlers: Readonly<Record<RoutineKey, Handler>>;
  hint(card: RoutinesCard): string;
  render(card: RoutinesCard, size: { readonly width: number; readonly height: number }): ReactElement;
}

const clamp = (cursor: number, rows: number): number => (rows <= 0 ? 0 : Math.min(Math.max(cursor, 0), rows - 1));

const refOf = (row: RoutineRow): RoutineRef => ({ environmentId: row.environmentId, routineId: row.routineId, name: row.definition.name });

/** The file an export of `name` is offered: its name in lower case, a hyphen for each run of anything else, `.yaml`. */
const exportFile = (name: string): string => `${name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "routine"}.yaml`;

/** Whether two saves of a document are the same: an editor adds a newline at the end or not, as it likes. */
const sameText = (a: string, b: string): boolean => a.replace(/\s+$/, "") === b.replace(/\s+$/, "");

/** An issue as `routines.checkImport` answers it, in its document. */
const checkedIssue = (document: number, issue: SchemaIssue): DocumentIssue => {
  const line = issue["params"] !== null && typeof issue["params"] === "object" ? (issue["params"] as Record<string, unknown>)["line"] : undefined;
  return { document, path: issue.path, message: issue.message, ...(typeof line === "number" && { line }) };
};

/**
 * The issues a refused `routines.import` names, in their documents: its
 * `invalid_params` issues at `yaml`, the document's place and the path in
 * it, or a name another routine holds (`conflict` `name_taken`) at the
 * document's name; null for a refusal that names no place in the YAML.
 */
const refusalIssues = (error: DispatchFailure): readonly DocumentIssue[] | null => {
  const data = error.data ?? {};
  if (error.code === "conflict" && data["reason"] === "name_taken") return [{ document: typeof data["document"] === "number" ? data["document"] : 0, path: ["name"], message: error.message }];
  if (error.code !== "invalid_params" || !Array.isArray(data["issues"])) return null;
  return (data["issues"] as SchemaIssue[]).map((issue) => {
    const [at, document, ...path] = issue.path;
    return at === "yaml" && typeof document === "number" ? checkedIssue(document, { ...issue, path }) : checkedIssue(0, issue);
  });
};

/** What a save writes to: the routine it replaces, or (null) new routines on the environment, named for its lines. */
interface SaveTarget {
  readonly environmentId: string;
  readonly routineId: string | null;
  readonly name: string;
}

/** Names as a line says them: `A`, `A and B`, `A, B and C`. */
const namesWords = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`);

/** What became of one save: refused with issues to write into the document, or done, its line said. */
type Saved = { readonly kind: "refused"; readonly issues: readonly DocumentIssue[] } | { readonly kind: "done" };
const DONE: Saved = { kind: "done" };

/** The newest firing among `entries`, newest first: a skip has no session. */
const newestFiring = (entries: readonly RoutineEntry[]) => entries.find((entry) => entry.kind === "firing");

export const useRoutines = (host: RoutinesHost): Routines => {
  const { runtime, request, card } = host;
  useFollow(card !== undefined ? runtime.projections.routines : undefined, request);
  const now = host.clock.now();
  // The history shown, followed while its card is open: its newest page from the request cache, each older one as the cursor reaches it.
  const shownRoutine = card?.kind === "history" ? card.routine : undefined;
  const history = useMemo(
    () => (shownRoutine ? runtime.projections.routineHistory(shownRoutine.environmentId, shownRoutine.routineId) : undefined),
    [runtime, shownRoutine?.environmentId, shownRoutine?.routineId],
  );
  useFollow(history, request);
  const entries = () => history?.read().entries ?? [];
  const list = (): readonly ListRow[] => listRows(runtime.projections.routines.read(), now);

  /** The routine under the list's cursor; none on an environment that lists none. */
  const routineAt = (shown: Extract<RoutinesCard, { kind: "list" }>): RoutineRow | undefined => {
    const rows = list();
    const at = rows[clamp(shown.cursor, rows.length)];
    return at?.kind === "routine" ? at.row : undefined;
  };

  /** A firing's session, opened in place of the card. */
  const openFiring = (environmentId: string, sessionId: string) => {
    host.close();
    host.openSession({ environmentId, sessionId });
  };

  /**
   * Enter on a routine: its live firing's session, else its newest firing's
   * in its history, read whole (500 entries, the most a page holds), or as
   * the request cache last held it while its environment cannot be reached.
   */
  const openLatest = async (routine: RoutineRef, row: RoutineRow) => {
    const live = row.listed?.state.liveFiring;
    if (live) return openFiring(routine.environmentId, live.sessionId);
    const answer = await runtime.requests.call(routine.environmentId, "routines.history", { routineId: routine.routineId, limit: ROUTINE_HISTORY_MAX });
    const entries = answer.ok ? answer.result.entries : runtime.projections.routineHistory(routine.environmentId, routine.routineId).read().entries;
    const firing = newestFiring(entries);
    if (firing?.kind === "firing") return openFiring(routine.environmentId, firing.sessionId);
    if (!answer.ok && entries.length === 0) return host.say(`Not opened: ${answer.error.message}`);
    host.say(entries.length < ROUTINE_HISTORY_MAX ? `${routine.name} has not fired yet.` : `${routine.name} has not fired in its latest ${ROUTINE_HISTORY_MAX} due times.`);
  };

  const environmentName = (environmentId: string): string => {
    const view = host.views.find((v) => v.environmentId === environmentId);
    return view ? nameOf(view) : "its environment";
  };

  /** The verb's routine: the one under the list's cursor, while the list is the card shown and nothing is typed into it. */
  const verbOn = (): RoutineRow | undefined => (card?.kind === "list" && card.exporting === null ? routineAt(card) : undefined);

  /** A routine command through the outbox: refused at dispatch, it says why in one line, as nothing else will; a refusal after it was kept is its notice's. */
  const send = (routine: RoutineRef, method: "routines.enable" | "routines.disable", verb: string) =>
    void runtime.commands.dispatch(routine.environmentId, method, { routineId: routine.routineId }).then((answer) => {
      if (!answer.ok && answer.commandId === null) host.say(`Not ${verb}: ${answer.error.message}`);
    });

  /** `r`: run now never waits in the outbox, so it is refused at once while the environment cannot be reached. */
  const runNow = (routine: RoutineRef) =>
    void runtime.commands.dispatch(routine.environmentId, "routines.runNow", { routineId: routine.routineId }).then((answer) => {
      if (answer.ok) return host.say(`Running ${routine.name} on ${environmentName(routine.environmentId)} now.`);
      const firing = answer.error.code === "conflict" && answer.error.data?.["reason"] === "firing_running";
      host.say(firing ? `Not run: ${routine.name} is firing already.` : `Not run: ${answer.error.message}`);
    });

  const reachable = (environmentId: string): boolean => {
    const phase = runtime.projections.environments.read().find((v) => v.environmentId === environmentId)?.phase;
    return phase === "ready" || phase === "syncing";
  };

  /** Settles once the environment cannot be reached, unless `stop` is called first. */
  const untilUnreachable = (environmentId: string) => {
    let stop = () => undefined as void;
    const gone = new Promise<"gone">((settle) => {
      const unsubscribe = runtime.projections.environments.subscribe(() => {
        if (!reachable(environmentId)) settle("gone");
      });
      stop = unsubscribe;
    });
    return { gone, stop: () => stop() };
  };

  const confirmed = (text: string): Promise<boolean> => new Promise((settle) => host.ask({ text, yes: () => settle(true), no: () => settle(false) }));

  /**
   * `routines.import` through the outbox, and its answer while the
   * environment can be reached; `gone` once it cannot, the import waiting in
   * the outbox (its routine pending) and a refusal then its notice.
   */
  const sendImport = async (environmentId: string, params: CommandParams<"routines.import">): Promise<DispatchAnswer<"routines.import"> | "gone"> => {
    const sent = runtime.commands.dispatch(environmentId, "routines.import", params);
    const watch = untilUnreachable(environmentId);
    const answer = reachable(environmentId) ? await Promise.race([sent, watch.gone]) : "gone";
    watch.stop();
    return answer;
  };

  /** The confirmation a document asking for `bypassPermissions` needs: the permissions spec's sentence, after who asks. */
  const bypassWords = (names: readonly string[]): string => `${namesWords(names)} ${names.length === 1 ? "asks" : "ask"} for bypassPermissions. ${BYPASS_SENTENCE}`;

  /**
   * One save of routine YAML: checked with `routines.checkImport`, whose
   * issues send it back to the editor; a document asking for
   * `bypassPermissions` confirmed with the permissions spec's sentence (read
   * from the document itself when the environment cannot be asked); then
   * `routines.import`, replacing the routine the target names, or making
   * each document a routine under an id this client mints.
   */
  const save = async (target: SaveTarget, yaml: string): Promise<Saved> => {
    const { environmentId } = target;
    const where = environmentName(environmentId);
    const check = await runtime.requests.call(environmentId, "routines.checkImport", { yaml, ...(target.routineId !== null && { routineId: target.routineId }) });
    const documents = check.ok ? check.result.documents : null;
    if (documents !== null) {
      if (documents.length === 0) return { kind: "refused", issues: [{ document: 0, path: [], message: "There is no routine document here." }] };
      const issues = documents.flatMap((document) => document.issues.map((issue) => checkedIssue(document.index, issue)));
      if (issues.length > 0) return { kind: "refused", issues };
    }
    const names = documents?.flatMap((document) => (document.definition ? [document.definition.name] : [])) ?? [];
    const name = target.routineId === null && names.length > 0 ? namesWords(names) : target.name;
    const bypass = documents === null ? (asksBypass(yaml) ? [name] : []) : documents.flatMap((document) => (document.definition?.mode === "bypassPermissions" ? [document.definition.name] : []));
    if (bypass.length > 0 && !(await confirmed(`${bypassWords(bypass)} Apply it? y/n`))) {
      host.say(`Not applied: ${target.routineId === null ? `nothing was made on ${where}` : `${name} on ${where} is as it was`}.`);
      return DONE;
    }
    if (reachable(environmentId)) host.say(`Saving ${name} on ${where}…`);
    const answer = await sendImport(
      environmentId,
      target.routineId !== null ? { yaml, routineId: target.routineId } : { yaml, routineIds: Array.from({ length: documents?.length ?? documentCount(yaml) }, () => host.newRoutineId()) },
    );
    if (answer === "gone") {
      host.say(`Queued: ${name} is saved once ${where} can be reached; until then it shows pending.`);
      return DONE;
    }
    if (answer.ok) {
      host.say(`Saved ${name} on ${where}.`);
      return DONE;
    }
    const issues = refusalIssues(answer.error);
    if (issues !== null) return { kind: "refused", issues };
    host.say(`Not saved: ${answer.error.message}`);
    return DONE;
  };

  /**
   * The editor over `first`: what is saved, applied (`save`), and a refusal
   * opened again with its issues as comments, until a save is applied, or
   * comes back unchanged, or the editor is left without saving.
   */
  const editLoop = async (target: SaveTarget, first: string) => {
    let opened = first;
    for (;;) {
      const edited = await host.editYaml(opened).catch((error: unknown): ExternalEditResult => ({ ok: false, reason: messageOf(error) }));
      if (!edited.ok) return host.say(`${target.routineId === null ? "Not made" : "Not edited"}: ${edited.reason}.`);
      if (sameText(edited.text, opened)) return host.say(`${target.name} is unchanged: nothing was sent.`);
      const saved = await save(target, edited.text);
      if (saved.kind === "done") return;
      host.say(`${target.name} was refused: its issues are written into it.`);
      opened = annotated(edited.text, saved.issues);
    }
  };

  /** `e`: the routine's YAML as its environment exports it, in the editor, applied with `routines.import` naming it. */
  const edit = async (routine: RoutineRef) => {
    const exported = await runtime.requests.call(routine.environmentId, "routines.export", { routineIds: [routine.routineId] });
    if (!exported.ok) return host.say(`Not edited: ${exported.error.message}`);
    await editLoop(routine, exported.result.yaml);
  };

  /** `/routines new`: the template in the editor, saved as a new routine on the header's environment. */
  const create = async () => {
    const view = host.current;
    if (!view) return host.say("There is no environment to make a routine on: /pair one first.");
    await editLoop({ environmentId: view.environmentId, routineId: null, name: "The new routine" }, ROUTINE_TEMPLATE);
  };

  /**
   * `/routines import <path>`: the file, relative to the working directory,
   * read by `routines.checkImport` on the header's environment and shown;
   * with no issue, imported once confirmed, each document a routine under an
   * id this client mints.
   */
  const importFile = async (typed: string) => {
    const view = host.current;
    if (!view) return host.say("There is no environment to import routines to: /pair one first.");
    const path = resolve(host.cwd, expandHome(typed, homedir()));
    let yaml: string;
    try {
      yaml = await readFile(path, "utf8");
    } catch (error) {
      return host.say(`Not imported: ${messageOf(error)}`);
    }
    if (yaml.trim() === "") return host.say(`Not imported: ${path} is empty.`);
    const check = await runtime.requests.call(view.environmentId, "routines.checkImport", { yaml });
    if (!check.ok) return host.say(`Not imported: ${check.error.message}`);
    const { documents } = check.result;
    host.open({ kind: "import", environmentId: view.environmentId, path, yaml, documents, cursor: 0 });
    if (documents.length === 0 || documents.some((document) => document.issues.length > 0)) return;
    const names = documents.flatMap((document) => (document.definition ? [document.definition.name] : []));
    const bypass = documents.flatMap((document) => (document.definition?.mode === "bypassPermissions" ? [document.definition.name] : []));
    const where = environmentName(view.environmentId);
    const count = `${documents.length} routine${documents.length === 1 ? "" : "s"}`;
    if (!(await confirmed(`Import ${count} to ${where}?${bypass.length > 0 ? ` ${bypassWords(bypass)}` : ""} y/n`))) {
      host.close();
      return host.say("Nothing was imported.");
    }
    const answer = await sendImport(view.environmentId, { yaml, routineIds: documents.map(() => host.newRoutineId()) });
    if (answer === "gone") return host.say(`Queued: ${namesWords(names)} ${names.length === 1 ? "is" : "are"} imported once ${where} can be reached.`);
    if (!answer.ok) return host.say(`Not imported: ${answer.error.message}`);
    host.open({ kind: "list", cursor: 0, exporting: null });
    host.say(`Imported ${namesWords(names)} to ${where}.`);
  };

  /** The export typed: the routine's YAML as its environment exports it, written to the path, relative to the working directory. */
  const exportTo = async (routine: RoutineRef, typed: string) => {
    const path = resolve(host.cwd, expandHome(typed.trim(), homedir()));
    const answer = await runtime.requests.call(routine.environmentId, "routines.export", { routineIds: [routine.routineId] });
    const failed = (line: string) => host.change((shown) => (shown.kind === "list" && shown.exporting !== null ? { ...shown, exporting: { ...shown.exporting, error: line } } : shown));
    if (!answer.ok) return failed(`Not exported: ${answer.error.message}`);
    try {
      await writeFile(path, answer.result.yaml, "utf8");
    } catch (error) {
      return failed(`Not written: ${messageOf(error)}`);
    }
    host.change((shown) => (shown.kind === "list" ? { ...shown, exporting: null } : shown));
    host.say(`Exported ${routine.name} to ${path}.`);
  };

  const rowsOf = (shown: RoutinesCard): number => {
    switch (shown.kind) {
      case "list":
        return list().length;
      case "history":
        return entries().length;
      case "import":
        return 0;
    }
  };

  /** The cursor moved to the history's last entry reads the page before it. */
  const moved = (shown: RoutinesCard, cursor: number): RoutinesCard => {
    if (shown.kind === "history" && cursor >= entries().length - 1) void history?.more();
    return { ...shown, cursor };
  };

  const routines: Routines = {
    run(command) {
      switch (command.name) {
        case "list":
          return host.open({ kind: "list", cursor: 0, exporting: null });
        case "new":
          return void create();
        case "import":
          return void importFile(command.path);
        default:
          return host.say(`/routines ${command.name} is not in this build yet.`);
      }
    },
    rows: rowsOf,
    move: (shown, step) => moved(shown, clamp(shown.cursor + step, rowsOf(shown))),
    choose(shown) {
      switch (shown.kind) {
        case "list": {
          if (shown.exporting !== null) {
            if (shown.exporting.text.trim() !== "") void exportTo(shown.exporting.routine, shown.exporting.text);
            return;
          }
          const row = routineAt(shown);
          if (row) void openLatest(refOf(row), row);
          return;
        }
        case "history": {
          const entry = entries()[clamp(shown.cursor, entries().length)];
          if (entry?.kind === "firing") return openFiring(shown.routine.environmentId, entry.sessionId);
          if (entry) host.say("A skip has no session: the due time was skipped before one started.");
          return;
        }
        case "import":
          return;
      }
    },
    back: (shown) => (shown.kind === "history" ? shown.back : shown.kind === "list" && shown.exporting !== null ? { ...shown, exporting: null } : null),
    takesText: (shown) => shown.kind === "list" && shown.exporting !== null,
    typed: (shown, text) => (shown.kind === "list" && shown.exporting !== null ? { ...shown, exporting: { ...shown.exporting, text: shown.exporting.text + text.replace(/[\r\n]/g, ""), error: null } } : shown),
    erased: (shown) => (shown.kind === "list" && shown.exporting !== null ? { ...shown, exporting: { ...shown.exporting, text: [...shown.exporting.text].slice(0, -1).join("") } } : shown),
    handlers: {
      "routines.runNow": () => {
        const row = verbOn();
        if (!row) return false;
        runNow(refOf(row));
      },
      "routines.enable": () => {
        const row = verbOn();
        if (!row) return false;
        if (row.definition.enabled) send(refOf(row), "routines.disable", "disabled");
        else send(refOf(row), "routines.enable", "enabled");
      },
      "routines.history": () => {
        const row = verbOn();
        if (!row || card?.kind !== "list") return false;
        host.open({ kind: "history", routine: refOf(row), cursor: 0, back: card });
      },
      "routines.export": () => {
        const row = verbOn();
        if (!row || card?.kind !== "list") return false;
        host.change((shown) => (shown.kind === "list" ? { ...shown, exporting: { routine: refOf(row), text: exportFile(row.definition.name), error: null } } : shown));
      },
      "routines.edit": () => {
        const row = verbOn();
        if (!row) return false;
        void edit(refOf(row));
      },
      "routines.endpoint.add": () => false,
      "routines.endpoint.test": () => false,
      "routines.endpoint.remove": () => false,
    },
    hint(shown) {
      const k = host.keys;
      if (shown.kind === "history") return `${k("picker.move")} move · ${k("picker.choose")} opens its firing · ${k("picker.leave")} back`;
      if (shown.kind === "import") return `${k("picker.leave")} close`;
      if (shown.exporting !== null) return `${k("picker.choose")} exports it · ${k("picker.leave")} leaves it`;
      return `${k("picker.move")} move · ${k("picker.choose")} opens its latest firing · ${k("picker.leave")} close`;
    },
    render(shown, size) {
      if (shown.kind === "import") {
        const refused = shown.documents.length === 0 || shown.documents.some((document) => document.issues.length > 0);
        return (
          <LinesPanel
            title={`Import from ${shown.path} to ${environmentName(shown.environmentId)}`}
            hint={routines.hint(shown)}
            lines={importLines(shown.documents)}
            after={refused ? [[], [{ text: shown.documents.length === 0 ? "There is no routine document in it." : "Nothing is imported until the file's issues are fixed.", dim: true }]] : []}
          />
        );
      }
      if (shown.kind === "history") {
        const read = history?.read();
        const all = read?.entries ?? [];
        const cursor = clamp(shown.cursor, all.length);
        const at = all[cursor];
        return (
          <ListCard
            width={size.width}
            title={`History of ${shown.routine.name} on ${environmentName(shown.routine.environmentId)}`}
            hint={routines.hint(shown)}
            rows={read ? historyRows(read, now) : []}
            cursor={cursor}
            height={size.height}
            empty={read?.error ? `Not read: ${read.error.message}` : read?.fetchedAt == null ? "Reading its history…" : "It has not fired or skipped a due time yet."}
            footer={[...(at ? entryLines(at) : []), ...(read?.loading && all.length > 0 ? [[{ text: "Reading older entries…", dim: true }]] : [])]}
          />
        );
      }
      const rows = list();
      const { exporting } = shown;
      const prompt = exporting === null ? "" : `Export ${exporting.routine.name} to:`;
      const k = host.keys;
      const verbs = `${k("routines.runNow")} run now · ${k("routines.enable")} enable or disable · ${k("routines.history")} history · ${k("routines.edit")} edit · ${k("routines.export")} export`;
      return (
        <ListCard
          width={size.width}
          title="Routines"
          hint={routines.hint(shown)}
          rows={rows.map((row) => row.panel)}
          cursor={clamp(shown.cursor, rows.length)}
          height={size.height}
          empty="No environment is enabled: /environment lists them."
          footer={[
            [],
            [{ text: `${verbs} · /routines new · /routines import <path> · /routines endpoints`, dim: true }],
            ...(exporting?.error ? [[{ text: exporting.error, color: TERMINAL_ROLES.danger }]] : []),
          ]}
          childRows={exporting === null ? 0 : wrappedRows(`${prompt} ${exporting.text} `, size.width)}
        >
          {exporting !== null && <TypedLine prompt={prompt} text={exporting.text} />}
        </ListCard>
      );
    },
  };
  return routines;
};
