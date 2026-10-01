import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { CommandParams, DispatchAnswer, DispatchFailure, EnvironmentView, Runtime } from "@agent-harness/client-runtime";
import { BYPASS_SENTENCE, type SchemaIssue } from "@agent-harness/contracts";
import { expandHome } from "../composer/attachments.js";
import type { ExternalEditResult } from "../composer/external-editor.js";
import { messageOf } from "../view.js";
import type { RoutineRef, RoutinesCard } from "./cards.js";
import { ROUTINE_TEMPLATE, annotated, asksBypass, documentCount, type DocumentIssue } from "./document.js";

/**
 * Saving routine YAML from the terminal UI (docs/specs/tui.md, "The
 * routines"; #533): a routine edited in the editor (`e`), a new one from
 * the template (`/routines new`), and a file imported (`/routines
 * import`). Each save is checked with `routines.checkImport`, a document
 * asking for `bypassPermissions` is confirmed with the permissions spec's
 * sentence, and `routines.import` goes through the outbox, which queues it
 * while the environment cannot be reached; an edit the environment refuses
 * opens again with its issues written in as comments (`document.ts`).
 */

export interface SaverHost {
  readonly runtime: Runtime;
  /** Where a relative path typed for an import is read from. */
  readonly cwd: string;
  /** The header's environment: where a new routine or an import goes. */
  current(): EnvironmentView | undefined;
  environmentName(environmentId: string): string;
  say(line: string): void;
  /** Asks yes or no on the confirm line. */
  confirm(text: string): Promise<boolean>;
  open(card: RoutinesCard): void;
  close(): void;
  /** Mints a routine's id: a version 4 UUID. */
  newRoutineId(): string;
  /** The YAML in `$VISUAL` or `$EDITOR`, with the terminal lent to it. */
  editYaml(yaml: string): Promise<ExternalEditResult>;
}

export interface RoutineSaver {
  /** `e`: the routine's YAML as its environment exports it, in the editor, applied with `routines.import` naming it. */
  edit(routine: RoutineRef): Promise<void>;
  /** `/routines new`: the template in the editor, saved as a new routine on the header's environment. */
  create(): Promise<void>;
  /** `/routines import <path>`: the file shown as `routines.checkImport` reads it, and imported once confirmed. */
  importFile(typed: string): Promise<void>;
}

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

/** The confirmation a document asking for `bypassPermissions` needs: the permissions spec's sentence, after who asks. */
const bypassWords = (names: readonly string[]): string => `${namesWords(names)} ${names.length === 1 ? "asks" : "ask"} for bypassPermissions. ${BYPASS_SENTENCE}`;

export const routineSaver = (host: SaverHost): RoutineSaver => {
  const { runtime } = host;

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

  /**
   * `routines.import` through the outbox, and its answer while the
   * environment can be reached; `gone` once it cannot, the import waiting in
   * the outbox (its routine pending) and a refusal then its notice.
   */
  const sendImport = async (environmentId: string, params: CommandParams<"routines.import">): Promise<DispatchAnswer<"routines.import"> | "gone"> => {
    // What the outbox would not keep (a connection without the scope) is refused now, whether or not the environment can be reached.
    if (runtime.commands.admits(environmentId, "routines.import").status === "absent") return runtime.commands.dispatch(environmentId, "routines.import", params);
    const sent = runtime.commands.dispatch(environmentId, "routines.import", params);
    const watch = untilUnreachable(environmentId);
    const answer = reachable(environmentId) ? await Promise.race([sent, watch.gone]) : "gone";
    watch.stop();
    return answer;
  };

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
    const where = host.environmentName(environmentId);
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
    if (bypass.length > 0 && !(await host.confirm(`${bypassWords(bypass)} Apply it? y/n`))) {
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
    const view = host.current();
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
    const view = host.current();
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
    host.open({ kind: "import", environmentId: view.environmentId, path, documents, cursor: 0 });
    if (documents.length === 0 || documents.some((document) => document.issues.length > 0)) return;
    const names = documents.flatMap((document) => (document.definition ? [document.definition.name] : []));
    const bypass = documents.flatMap((document) => (document.definition?.mode === "bypassPermissions" ? [document.definition.name] : []));
    const where = host.environmentName(view.environmentId);
    const count = `${documents.length} routine${documents.length === 1 ? "" : "s"}`;
    if (!(await host.confirm(`Import ${count} to ${where}?${bypass.length > 0 ? ` ${bypassWords(bypass)}` : ""} y/n`))) {
      host.close();
      return host.say("Nothing was imported.");
    }
    const answer = await sendImport(view.environmentId, { yaml, routineIds: documents.map(() => host.newRoutineId()) });
    if (answer === "gone") return host.say(`Queued: ${namesWords(names)} ${names.length === 1 ? "is" : "are"} imported once ${where} can be reached.`);
    if (!answer.ok) return host.say(`Not imported: ${answer.error.message}`);
    host.open({ kind: "list", cursor: 0, exporting: null });
    host.say(`Imported ${namesWords(names)} to ${where}.`);
  };

  return { edit, create, importFile };
};
