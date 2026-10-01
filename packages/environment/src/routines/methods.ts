import { randomUUID } from "node:crypto";
import {
  ContractError,
  ROUTINE_HISTORY_LIMIT,
  hostOf,
  invalidParams,
  lowerMode,
  type Ceiling,
  type ListedRoutine,
  type PreCheck,
  type RoutineChange,
  type RoutineCreatedPayload,
  type RoutineDefinition,
  type RoutineDisabledPayload,
  type RoutineEditedPayload,
  type RoutineEnabledPayload,
  type RoutineFields,
  type RoutineMoveLink,
  type RoutineWorkspace,
  type SchemaIssue,
} from "@agent-harness/contracts";
import { renderRoutineYaml } from "@agent-harness/contracts/routine-yaml";
import type { VerifiedClientSession } from "../auth/client-sessions.js";
import type { EventInput, EventLog } from "../event-log/event-log.js";
import { currentCeiling } from "../permissions/methods.js";
import { readSettings } from "../settings/settings-store.js";
import type { CommandAnswer, CommandContext, CommandRejection, MethodHandler, MethodHandlers } from "../serve/methods.js";
import type { Reader } from "../sessions/session-tables.js";
import { endFiring, firingText } from "./firing-end.js";
import type { FiringStart, FiringStarter } from "./firing-start.js";
import { heldBy, nameHolders, nameTakenIssue, oneDocumentIssue, readImport, type ImportDocument } from "./import-documents.js";
import { listRoutine, routineAttention, type RoutineAccounts, type RoutineSurroundings } from "./listing.js";
import { appendRoutineRecord, routineStream } from "./records.js";
import { entryPosition, listStoredRoutines, liveFiringOfRoutine, liveRoutine, routineEntries, routineEver, routineNamed, type StoredRoutine } from "./routine-store.js";
import type { ScriptsDirectory } from "./scripts-directory.js";
import type { PlacedWorkspace, RoutineWorkspaces } from "./workspace.js";

/**
 * The routine commands and the list (routines spec, "Methods on the wire";
 * #521): `routines.create`, `routines.update`, `routines.enable`,
 * `routines.disable` and `routines.delete` at `sessions:write`, each ordered
 * and appended to the routine's own stream as the client session in the
 * command's transaction, with a `routine.updated` notice on the environment's
 * stream beside it; `routines.list` at `read`, from the routine store. Run
 * now and the history (#523): `routines.runNow` at `runs:drive`, never
 * queued, which answers the firing's id at once and has the firing
 * starter start it once the command commits, and `routines.history` at
 * `read`. A delete ends the routine's live firing `cancelled`, its run going
 * on as its session's.
 *
 * A structural problem is the wire's `invalid_params`, from the schema; what
 * the environment lacks (an account, a model) refuses nothing and shows as
 * attention. A create, an edit and an enable record the calling client
 * session's ceiling as the one the routine is saved under, and the session
 * as who saved it; a disable and a delete widen nothing and record neither.
 * A create, an update or an import whose URL pre-check names a host on the
 * denylist's hosts is refused `denylisted`, naming the host (#526).
 */

export interface RoutineMethodsOptions {
  readonly log: EventLog;
  /** The environment's clock, which stamps the routine's events. */
  readonly clock: () => Date;
  /** The environment's id: the id of its stream, where the `routine.updated` notices go. */
  readonly environmentId: string;
  /** The environment's name as it is now, which an export's opening comment names. */
  readonly environmentName: () => string;
  /** The environment's own IANA zone, which a create that names none takes. */
  readonly timeZone: string;
  /** The account store's facts and default account, which the list's effective mode and attention read. */
  readonly accounts: RoutineAccounts["accounts"];
  /** A client session's ceiling as it is now; undefined when it is not live. */
  readonly ceilingOf: (clientSessionId: string) => Ceiling | undefined;
  /** What starts a firing, and says whether one of a routine is starting or live (#523). */
  readonly firings: Pick<FiringStarter, "live" | "start">;
  /** Where a saved routine's workspace stands here: the identity it resolves to, and an import's re-resolution (#528). */
  readonly workspaces: RoutineWorkspaces;
  /** The scripts directory, whose missing script the list's attention names (#526). */
  readonly scripts: Pick<ScriptsDirectory, "present">;
  /** Whether the host `url` reaches is on the denylist's hosts, as the denylist is now: a URL pre-check's, at a save (#526). */
  readonly denylisted: (url: string) => boolean;
}

type RoutineMethodName =
  | "routines.list"
  | "routines.history"
  | "routines.create"
  | "routines.update"
  | "routines.enable"
  | "routines.disable"
  | "routines.delete"
  | "routines.runNow"
  | "routines.export"
  | "routines.checkImport"
  | "routines.import";

/** What a command on one routine decides: the event to append for it, with the change its notice names, or its refusal. */
type Decision<Code extends string = "not_found" | "conflict"> =
  | { readonly event: EventInput; readonly change: RoutineChange; readonly rejected?: undefined }
  | { readonly rejected: CommandRejection<Code> };

/** `then` over a value a seam answers at once or later: at once when it is there, so a command keeps its place among its socket's requests. */
const whenReady = <T, R>(value: T | Promise<T>, then: (ready: T) => R): R | Promise<R> => (value instanceof Promise ? value.then(then) : then(value));

/** Whether a document read with no issue, so it holds its definition. */
const isRead = (document: ImportDocument): document is ImportDocument & { readonly definition: RoutineDefinition } => document.definition !== null;

/** An `invalid_params` issue about the import's params as a whole, at `path`. */
const importIssue = (path: (string | number)[], message: string): SchemaIssue => ({ code: "custom", path, message });

/**
 * Why an import cannot be read, before any routine is looked at: a document
 * with an issue (each at its path under `yaml` and the document's place),
 * none at all, more than one replacing a routine, ids for another count, or
 * an id given twice in another case.
 */
const unreadable = (documents: readonly ImportDocument[], routineIds: readonly string[] | undefined, replacing: boolean): SchemaIssue[] => {
  const issues = documents.flatMap((document) => document.issues.map((issue) => ({ ...issue, path: ["yaml", document.index, ...issue.path] })));
  if (issues.length > 0) return issues;
  if (documents.length === 0) return [importIssue(["yaml"], "The YAML holds no routine document.")];
  if (replacing && documents.length > 1) return [importIssue(["yaml"], oneDocumentIssue(documents.length).message)];
  if (routineIds !== undefined && routineIds.length !== documents.length) {
    return [importIssue(["routineIds"], `${routineIds.length} ids were given for ${documents.length} routine documents; one is needed for each.`)];
  }
  const ids = (routineIds ?? []).map((id) => id.toLowerCase());
  return ids.flatMap((id, index) => (ids.indexOf(id) === index ? [] : [importIssue(["routineIds", index], `The id ${id} is given twice, in another case.`)]));
};

/** The refusal of a routine the environment does not hold, or has deleted. */
export const routineNotFound = (routineId: string) => ({ code: "not_found" as const, message: `No routine ${routineId} is on this environment.`, data: { kind: "routine", routineId } });

const notFound = (routineId: string): Decision<"not_found"> => ({ rejected: routineNotFound(routineId) });

export const routineMethods = (options: RoutineMethodsOptions): Required<Pick<MethodHandlers, RoutineMethodName>> => {
  const { log, clock, environmentId } = options;
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const where: RoutineSurroundings = { reader, accounts: options.accounts, scriptPresent: (path) => options.scripts.present(path) };

  const listed = (routine: StoredRoutine): ListedRoutine => listRoutine(routine, where, readSettings(reader)["permissions.unattended.mode"], clock());

  const ceilingOf = (clientSession: VerifiedClientSession): Ceiling => currentCeiling(options.ceilingOf, clientSession);

  /** The refusal of a name another live routine holds ignoring case; null when none but `routineId` holds it. */
  const nameTaken = (name: string, routineId: string): CommandRejection<"conflict"> | null => {
    const holder = routineNamed(reader, name);
    if (holder === null || holder.id === routineId) return null;
    return {
      code: "conflict",
      message: `The routine ${holder.id} is named ${JSON.stringify(holder.name)}, which is ${JSON.stringify(name)} ignoring case.`,
      data: { reason: "name_taken", name, heldName: holder.name, routineId: holder.id },
    };
  };

  /** The refusal of a URL pre-check whose host is on the denylist's hosts; null for any other pre-check, or none. */
  const deniedPreCheck = (preCheck: PreCheck | null | undefined): CommandRejection<"denylisted"> | null => {
    if (preCheck?.kind !== "url" || !options.denylisted(preCheck.url)) return null;
    const host = hostOf(preCheck.url) ?? preCheck.url;
    return { code: "denylisted", message: `${host} is on the denylist's hosts, so no pre-check may fetch ${preCheck.url}.`, data: { host } };
  };

  /** The refusal of a routine made under `id` when one was made under it before, deleted since or not; null when none was. */
  const usedId = (id: string): CommandRejection<"conflict"> | null =>
    routineEver(reader, id) ? { code: "conflict", message: `A routine ${id} was made on this environment already.`, data: { reason: "exists", routineId: id } } : null;

  /** `then` over a workspace as a create or an edit records it (`workspace.ts`): at once when placing it asks nothing, else once it is placed. */
  const placed = <R>(workspace: RoutineWorkspace, then: (placement: PlacedWorkspace) => R): R | Promise<R> => whenReady(options.workspaces.place(workspace, false), then);

  /**
   * Appends a decision's event to the routine's stream as the command, and
   * the `routine.updated` notice its commit raises to the environment's,
   * caused by it, both in the command's transaction at its one instant.
   */
  const append = (routineId: string, decision: Decision & { rejected?: undefined }, context: CommandContext, occurredAt: string): void => {
    const attribution = { tx: context.tx, actor: context.actor, commandId: context.commandId };
    appendRoutineRecord(log, environmentId, routineId, { event: { ...decision.event, occurredAt }, change: decision.change }, attribution);
  };

  /** Appends `routine.created` for a routine made under `id` from `definition`, saved under the calling client session's ceiling. */
  const appendCreated = (id: string, definition: RoutineDefinition, movedFrom: RoutineMoveLink | null, context: CommandContext, at: string): void => {
    const payload: RoutineCreatedPayload = { definition, savedUnderCeiling: ceilingOf(context.clientSession), movedFrom };
    append(id, { event: { type: "routine.created", payload }, change: "created" }, context, at);
  };

  /** Runs a command on a routine the environment holds: the decision over it, appended, answered with what the command leaves. */
  const onRoutine = <R, Code extends string = "conflict">(
    routineId: string,
    context: CommandContext,
    decide: (id: string, at: string) => Decision<Code>,
    answer: (id: string) => R,
  ): CommandAnswer<R, Code | "not_found"> => {
    const id = routineId.toLowerCase();
    const aggregate = routineStream(id);
    const at = clock().toISOString();
    const decision: Decision<Code | "not_found"> = liveRoutine(reader, id) === null ? notFound(id) : decide(id, at);
    if (decision.rejected !== undefined) return { aggregate, rejected: decision.rejected };
    append(id, decision, context, at);
    return { aggregate, result: answer(id) };
  };

  /** The routine a command leaves, read after it appended. */
  const listedAfter = (id: string): { routine: ListedRoutine } => {
    const routine = liveRoutine(reader, id);
    if (routine === null) throw new Error(`The routine ${id} is not in the store after a command applied to it.`);
    return { routine: listed(routine) };
  };

  /**
   * Ends the routine's live firing `cancelled` in the open transaction, as
   * the routine, at `at`: its text so far, no usage yet. Its run goes on as
   * its session's, and its end ends nothing.
   */
  const cancelLiveFiring = (routineId: string, context: CommandContext, at: string): void => {
    const firing = liveFiringOfRoutine(reader, routineId);
    if (firing === null) return;
    endFiring(log, environmentId, firing, { outcome: "cancelled", reason: null, text: firingText(reader, firing, null), usage: null }, at, {
      tx: context.tx,
      commandId: context.commandId,
      correlationId: firing.entry.runId,
    });
  };

  return {
    "routines.list": () => ({ routines: listStoredRoutines(reader).map(listed) }),

    /**
     * What importing the YAML would do, per document, saving nothing (#528):
     * the definition as it would be saved, its workspace placed here; the
     * issues at their paths, a name another routine or an earlier document
     * holds among them, and a second document when one routine's is to be
     * replaced; the attention it would show here, saved under the caller's
     * ceiling, and its workspace as re-resolved.
     */
    "routines.checkImport": async (params, context) => {
      const replacing = params.routineId === undefined ? null : params.routineId.toLowerCase();
      const target = replacing === null ? null : liveRoutine(reader, replacing);
      if (replacing !== null && target === null) throw new ContractError(routineNotFound(replacing));
      const documents = await readImport(params.yaml, options.timeZone, options.workspaces);
      const holders = nameHolders(reader, documents, replacing);
      const saved = { savedUnderCeiling: ceilingOf(context.clientSession), failureStreak: target?.state.failureStreak ?? 0 };
      const unattendedMode = readSettings(reader)["permissions.unattended.mode"];
      return {
        documents: documents.map(({ index, definition, issues, reresolved }, at) => {
          const holder = holders[at] ?? null;
          return {
            index,
            definition,
            issues: [...issues, ...(holder === null ? [] : [nameTakenIssue(holder)]), ...(replacing !== null && documents.length > 1 ? [oneDocumentIssue(documents.length)] : [])],
            warnings: { attention: definition === null ? [] : routineAttention({ definition, state: saved }, where, unattendedMode), workspace: reresolved },
          };
        }),
      };
    },

    /**
     * Imports routine documents, all or nothing (#528): read, and each
     * workspace placed, before the command's transaction, where a document
     * with an issue refuses the whole import `invalid_params`. In it, each
     * document becomes a routine under the id given for it (minted when
     * none are), linked to the routine `movedFrom` names; or, with
     * `routineId`, the one document replaces that routine's definition,
     * the routine keeping its id, state and links. Saved under the calling
     * client session's ceiling. A name another routine or an earlier
     * document holds, or an id a routine was made under before, refuses
     * it before anything is appended. Answered with the routines and
     * `routines.checkImport`'s warnings.
     */
    "routines.import": {
      prepare: (params) =>
        whenReady(readImport(params.yaml, options.timeZone, options.workspaces), (documents): MethodHandler<"routines.import"> => {
          const replacing = params.routineId === undefined ? null : params.routineId.toLowerCase();
          const issues = unreadable(documents, params.routineIds, replacing !== null);
          if (issues.length > 0) throw new ContractError(invalidParams(issues, "The YAML cannot be imported as it is."));
          const read = documents.filter(isRead);
          return (_params, context) => {
            const at = clock().toISOString();
            const holders = nameHolders(reader, read, replacing);
            /** The refusal of the document at `index` when a routine or an earlier document holds its name; null when none does. */
            const nameRefusal = (index: number): CommandRejection<"conflict"> | null => {
              const holder = holders[index] ?? null;
              if (holder === null) return null;
              const name = read[index]?.definition.name ?? "";
              const held = holder.kind === "routine" ? { routineId: holder.routineId } : { heldByDocument: holder.document };
              return { code: "conflict", message: `Document ${index} names its routine ${JSON.stringify(name)}. ${heldBy(holder)}.`, data: { reason: "name_taken", document: index, name, heldName: holder.heldName, ...held } };
            };
            const warningsOf = (document: ImportDocument, routine: ListedRoutine) => ({ attention: routine.attention, workspace: document.reresolved });

            const [replacement] = read;
            if (replacing !== null && replacement !== undefined) {
              return onRoutine(
                replacing,
                context,
                () => {
                  const refused = nameRefusal(0) ?? deniedPreCheck(replacement.definition.preCheck);
                  if (refused !== null) return { rejected: refused };
                  const payload: RoutineEditedPayload = { fields: replacement.definition, savedUnderCeiling: ceilingOf(context.clientSession) };
                  return { event: { type: "routine.edited", payload }, change: "edited" };
                },
                (id) => {
                  const { routine } = listedAfter(id);
                  return { routines: [routine], warnings: [warningsOf(replacement, routine)] };
                },
              );
            }

            const made = read.map((document, index) => ({ document, id: (params.routineIds?.[index] ?? randomUUID()).toLowerCase() }));
            const aggregate = routineStream(made[0]?.id ?? "");
            for (const [index, { id, document }] of made.entries()) {
              const refused = usedId(id) ?? nameRefusal(index) ?? deniedPreCheck(document.definition.preCheck);
              if (refused !== null) return { aggregate, rejected: refused };
            }
            const { movedFrom } = params;
            const link = movedFrom === undefined ? null : { environmentId: movedFrom.environmentId, routineId: movedFrom.routineId.toLowerCase(), at, ...(movedFrom.definitionSequence !== undefined && { definitionSequence: movedFrom.definitionSequence }) };
            const listedMade = made.map(({ document, id }) => {
              appendCreated(id, document.definition, link, context, at);
              return { document, routine: listedAfter(id).routine };
            });
            return {
              aggregate,
              result: { routines: listedMade.map(({ routine }) => routine), warnings: listedMade.map(({ document, routine }) => warningsOf(document, routine)) },
            };
          };
        }),
    },

    /** The routines as YAML (#528), every one or those named, in the list's order, under a comment naming the environment and the time. */
    "routines.export": (params) => {
      const routines = listStoredRoutines(reader);
      const named = params.routineIds === undefined ? null : new Set(params.routineIds.map((id) => id.toLowerCase()));
      for (const id of named ?? []) if (!routines.some((routine) => routine.state.id === id)) throw new ContractError(routineNotFound(id));
      const definitions = routines.filter((routine) => named === null || named.has(routine.state.id)).map((routine) => routine.definition);
      return { yaml: renderRoutineYaml(definitions, { environmentName: options.environmentName(), exportedAt: clock().toISOString() }) };
    },

    /** The routine's entries newest first, a page at a time: those recorded before `before` when it names one of them. */
    "routines.history": (params) => {
      const id = params.routineId.toLowerCase();
      if (liveRoutine(reader, id) === null) throw new ContractError(routineNotFound(id));
      const before = params.before === undefined ? null : params.before.toLowerCase();
      const position = before === null ? null : entryPosition(reader, id, before);
      if (before !== null && position === null) {
        throw new ContractError({ code: "not_found", message: `The routine ${id} has no entry ${before}.`, data: { kind: "entry", routineId: id, entryId: before } });
      }
      return { entries: routineEntries(reader, id, position, params.limit ?? ROUTINE_HISTORY_LIMIT) };
    },

    /**
     * Asks for a firing now, trigger `run-now`, due now, answering its id at
     * once: the firing starter starts it once the command commits, under
     * the routine's definition as it is now and the lower of its saved
     * ceiling and the caller's. Refused `conflict` `firing_running` while a
     * firing of the routine is waiting for a slot, starting or live; it waits
     * for a slot itself while four firings are (#527). Its routine's pre-check
     * runs first only when `withPreCheck` asks (#526); a firing without one
     * leaves the baseline alone.
     */
    "routines.runNow": (params, context) => {
      const id = params.routineId.toLowerCase();
      const aggregate = routineStream(id);
      const routine = liveRoutine(reader, id);
      if (routine === null) return { aggregate, rejected: routineNotFound(id) };
      if (options.firings.live(id)) {
        return { aggregate, rejected: { code: "conflict", message: `A firing of the routine ${id} is live; run it again once it has ended.`, data: { reason: "firing_running", routineId: id } } };
      }
      const firing: FiringStart = {
        routineId: id,
        definition: routine.definition,
        firingId: randomUUID(),
        trigger: "run-now",
        dueAt: clock().toISOString(),
        count: 1,
        requestedBy: context.clientSession.id,
        ceiling: lowerMode(routine.state.savedUnderCeiling, ceilingOf(context.clientSession)),
        withPreCheck: params.withPreCheck === true,
      };
      context.tx.afterCommit(() => options.firings.start(firing));
      return { aggregate, result: { entryId: firing.firingId } };
    },

    /**
     * Makes a routine under the id its client minted, never one used before:
     * the definition as the schema gives it, presets applied, its name
     * trimmed and, when it names no zone, the environment's own; its
     * workspace with the repository identity it resolves to here, found
     * before the command's transaction.
     */
    "routines.create": {
      prepare: (params) =>
        placed(params.definition.workspace, ({ workspace }): MethodHandler<"routines.create"> => (_params, context) => {
          const id = params.routineId.toLowerCase();
          const { timezone, ...written } = params.definition;
          const definition: RoutineDefinition = { ...written, workspace, name: written.name.trim(), timezone: timezone ?? options.timeZone };
          const refused = usedId(id) ?? nameTaken(definition.name, id) ?? deniedPreCheck(definition.preCheck);
          if (refused !== null) return { aggregate: routineStream(id), rejected: refused };
          appendCreated(id, definition, null, context, clock().toISOString());
          return { aggregate: routineStream(id), result: listedAfter(id) };
        }),
    },

    /**
     * Writes the fields it names and no others, none filled from a preset;
     * the name trimmed, and never another routine's; a workspace with the
     * repository identity it resolves to here, found before the command's
     * transaction.
     */
    "routines.update": {
      prepare: (params) => {
        const edit = (workspace: RoutineWorkspace | undefined): MethodHandler<"routines.update"> => (_params, context) =>
          onRoutine(
            params.routineId,
            context,
            (id) => {
              const { name } = params.fields;
              const fields: RoutineFields = { ...params.fields, ...(name !== undefined && { name: name.trim() }), ...(workspace !== undefined && { workspace }) };
              const refused = (fields.name === undefined ? null : nameTaken(fields.name, id)) ?? deniedPreCheck(fields.preCheck);
              if (refused !== null) return { rejected: refused };
              const payload: RoutineEditedPayload = { fields, savedUnderCeiling: ceilingOf(context.clientSession) };
              return { event: { type: "routine.edited", payload }, change: "edited" };
            },
            listedAfter,
          );
        return params.fields.workspace === undefined ? edit(undefined) : placed(params.fields.workspace, (placement) => edit(placement.workspace));
      },
    },

    "routines.enable": (params, context) =>
      onRoutine(
        params.routineId,
        context,
        () => {
          const payload: RoutineEnabledPayload = { savedUnderCeiling: ceilingOf(context.clientSession) };
          return { event: { type: "routine.enabled", payload }, change: "enabled" };
        },
        listedAfter,
      ),

    /** Disables the routine, linking the copy a move made when one is named, as recorded now. */
    "routines.disable": (params, context) =>
      onRoutine(
        params.routineId,
        context,
        (_id, at) => {
          const { movedTo } = params;
          const payload: RoutineDisabledPayload = {
            movedTo: movedTo === undefined ? null : { environmentId: movedTo.environmentId, routineId: movedTo.routineId.toLowerCase(), at },
          };
          return { event: { type: "routine.disabled", payload }, change: "disabled" };
        },
        listedAfter,
      ),

    /** Deletes the routine, ending its live firing `cancelled` first, in the same transaction. */
    "routines.delete": (params, context) =>
      onRoutine(
        params.routineId,
        context,
        (id, at) => {
          cancelLiveFiring(id, context, at);
          return { event: { type: "routine.deleted", payload: {} }, change: "deleted" };
        },
        (id) => ({ routineId: id }),
      ),
  };
};
