import { randomUUID } from "node:crypto";
import {
  ContractError,
  ROUTINE_HISTORY_LIMIT,
  lowerMode,
  type Ceiling,
  type ListedRoutine,
  type RoutineChange,
  type RoutineCreatedPayload,
  type RoutineDefinition,
  type RoutineDisabledPayload,
  type RoutineEditedPayload,
  type RoutineEnabledPayload,
  type RoutineFields,
  type RoutineMoveLink,
  type RoutineWorkspace,
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
import { nameHolders, nameTakenIssue, oneDocumentIssue, readImport } from "./import-documents.js";
import { listRoutine, routineAttention, type RoutineAccounts } from "./listing.js";
import { appendRoutineRecord, routineStream } from "./records.js";
import { entryPosition, listStoredRoutines, liveFiringOfRoutine, liveRoutine, routineEntries, routineEver, routineNamed, type StoredRoutine } from "./routine-store.js";
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
  | "routines.checkImport";

/** What a command on one routine decides: the event to append for it, with the change its notice names, or its refusal. */
type Decision = { readonly event: EventInput; readonly change: RoutineChange; readonly rejected?: undefined } | { readonly rejected: CommandRejection<"not_found" | "conflict"> };

/** The refusal of a routine the environment does not hold, or has deleted. */
const routineNotFound = (routineId: string) => ({ code: "not_found" as const, message: `No routine ${routineId} is on this environment.`, data: { kind: "routine", routineId } });

const notFound = (routineId: string): Decision => ({ rejected: routineNotFound(routineId) });

export const routineMethods = (options: RoutineMethodsOptions): Required<Pick<MethodHandlers, RoutineMethodName>> => {
  const { log, clock, environmentId } = options;
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const where: RoutineAccounts = { reader, accounts: options.accounts };

  const listed = (routine: StoredRoutine): ListedRoutine => listRoutine(routine, where, readSettings(reader)["permissions.unattended.mode"]);

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

  /** The refusal of a routine made under `id`: one was made under it before, or another live routine holds `name`; null when it may be made. */
  const createRefusal = (id: string, name: string): CommandRejection<"conflict"> | null =>
    routineEver(reader, id) ? { code: "conflict", message: `A routine ${id} was made on this environment already.`, data: { reason: "exists", routineId: id } } : nameTaken(name, id);

  /** `then` over a workspace as a save records it (`workspace.ts`): at once when placing it asks nothing, else once it is placed. */
  const placed = <R>(workspace: RoutineWorkspace, reresolve: boolean, then: (placement: PlacedWorkspace) => R): R | Promise<R> => {
    const placement = options.workspaces.place(workspace, reresolve);
    return placement instanceof Promise ? placement.then(then) : then(placement);
  };

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
  const onRoutine = <R>(
    routineId: string,
    context: CommandContext,
    decide: (id: string, at: string) => Decision,
    answer: (id: string) => R,
  ): CommandAnswer<R, "not_found" | "conflict"> => {
    const id = routineId.toLowerCase();
    const aggregate = routineStream(id);
    const at = clock().toISOString();
    const decision = liveRoutine(reader, id) === null ? notFound(id) : decide(id, at);
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
     * firing of the routine is starting or live. The pre-check it may ask
     * for is #526's.
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
        placed(params.definition.workspace, false, ({ workspace }): MethodHandler<"routines.create"> => (_params, context) => {
          const id = params.routineId.toLowerCase();
          const { timezone, ...written } = params.definition;
          const definition: RoutineDefinition = { ...written, workspace, name: written.name.trim(), timezone: timezone ?? options.timeZone };
          const refused = createRefusal(id, definition.name);
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
              const taken = fields.name === undefined ? null : nameTaken(fields.name, id);
              if (taken !== null) return { rejected: taken };
              const payload: RoutineEditedPayload = { fields, savedUnderCeiling: ceilingOf(context.clientSession) };
              return { event: { type: "routine.edited", payload }, change: "edited" };
            },
            listedAfter,
          );
        return params.fields.workspace === undefined ? edit(undefined) : placed(params.fields.workspace, false, (placement) => edit(placement.workspace));
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
