import {
  ENVIRONMENT_STREAM_KIND,
  ROUTINE_STREAM_KIND,
  type Ceiling,
  type ListedRoutine,
  type RoutineChange,
  type RoutineCreatedPayload,
  type RoutineDefinition,
  type RoutineDisabledPayload,
  type RoutineEditedPayload,
  type RoutineEnabledPayload,
  type RoutineFields,
  type RoutineUpdatedPayload,
} from "@agent-harness/contracts";
import type { VerifiedClientSession } from "../auth/client-sessions.js";
import type { EventInput, EventLog, StreamRef } from "../event-log/event-log.js";
import { currentCeiling } from "../permissions/methods.js";
import { readSettings } from "../settings/settings-store.js";
import type { CommandAnswer, CommandContext, CommandRejection, MethodHandlers } from "../serve/methods.js";
import type { Reader } from "../sessions/session-tables.js";
import { listRoutine, type RoutineAccounts } from "./listing.js";
import { listStoredRoutines, liveRoutine, routineEver, routineNamed, type StoredRoutine } from "./routine-store.js";

/**
 * The routine commands and the list (routines spec, "Methods on the wire";
 * #521): `routines.create`, `routines.update`, `routines.enable`,
 * `routines.disable` and `routines.delete` at `sessions:write`, each ordered
 * and appended to the routine's own stream as the client session in the
 * command's transaction, with a `routine.updated` notice on the environment's
 * stream beside it; `routines.list` at `read`, from the routine store.
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
  /** The environment's own IANA zone, which a create that names none takes. */
  readonly timeZone: string;
  /** The account store's facts and default account, which the list's effective mode and attention read. */
  readonly accounts: RoutineAccounts["accounts"];
  /** A client session's ceiling as it is now; undefined when it is not live. */
  readonly ceilingOf: (clientSessionId: string) => Ceiling | undefined;
}

type RoutineMethodName = "routines.list" | "routines.create" | "routines.update" | "routines.enable" | "routines.disable" | "routines.delete";

/** A routine's stream. */
const routineStream = (id: string): StreamRef => ({ kind: ROUTINE_STREAM_KIND, id });

/** What a command on one routine decides: the event to append for it, with the change its notice names, or its refusal. */
type Decision = { readonly event: EventInput; readonly change: RoutineChange; readonly rejected?: undefined } | { readonly rejected: CommandRejection<"not_found" | "conflict"> };

const notFound = (routineId: string): Decision => ({
  rejected: { code: "not_found", message: `No routine ${routineId} is on this environment.`, data: { kind: "routine", routineId } },
});

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

  /**
   * Appends a decision's event to the routine's stream as the command, and
   * the `routine.updated` notice its commit raises to the environment's,
   * caused by it, both in the command's transaction at its one instant.
   */
  const append = (routineId: string, decision: Decision & { rejected?: undefined }, context: CommandContext, occurredAt: string): void => {
    const attribution = { tx: context.tx, actor: context.actor, commandId: context.commandId };
    const [event] = log.append(routineStream(routineId), [{ ...decision.event, occurredAt }], attribution).events;
    if (event === undefined) throw new Error(`The ${decision.event.type} of the routine ${routineId} appended no event.`);
    const notice: RoutineUpdatedPayload = { routineId, change: decision.change };
    log.append({ kind: ENVIRONMENT_STREAM_KIND, id: environmentId }, [{ type: "routine.updated", payload: notice, occurredAt }], { ...attribution, causationId: event.eventId });
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

  return {
    "routines.list": () => ({ routines: listStoredRoutines(reader).map(listed) }),

    /**
     * Makes a routine under the id its client minted, never one used before:
     * the definition as the schema gives it, presets applied, its name
     * trimmed and, when it names no zone, the environment's own.
     */
    "routines.create": (params, context) => {
      const id = params.routineId.toLowerCase();
      const aggregate = routineStream(id);
      if (routineEver(reader, id)) {
        return { aggregate, rejected: { code: "conflict", message: `A routine ${id} was made on this environment already.`, data: { reason: "exists", routineId: id } } };
      }
      const { timezone, ...written } = params.definition;
      const definition: RoutineDefinition = { ...written, name: written.name.trim(), timezone: timezone ?? options.timeZone };
      const taken = nameTaken(definition.name, id);
      if (taken !== null) return { aggregate, rejected: taken };
      const payload: RoutineCreatedPayload = { definition, savedUnderCeiling: ceilingOf(context.clientSession), movedFrom: null };
      append(id, { event: { type: "routine.created", payload }, change: "created" }, context, clock().toISOString());
      return { aggregate, result: listedAfter(id) };
    },

    /** Writes the fields it names and no others, none filled from a preset; the name trimmed, and never another routine's. */
    "routines.update": (params, context) =>
      onRoutine(
        params.routineId,
        context,
        (id) => {
          const fields: RoutineFields = { ...params.fields, ...(params.fields.name !== undefined && { name: params.fields.name.trim() }) };
          const taken = fields.name === undefined ? null : nameTaken(fields.name, id);
          if (taken !== null) return { rejected: taken };
          const payload: RoutineEditedPayload = { fields, savedUnderCeiling: ceilingOf(context.clientSession) };
          return { event: { type: "routine.edited", payload }, change: "edited" };
        },
        listedAfter,
      ),

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

    "routines.delete": (params, context) =>
      onRoutine(
        params.routineId,
        context,
        () => ({ event: { type: "routine.deleted", payload: {} }, change: "deleted" }),
        (id) => ({ routineId: id }),
      ),
  };
};
