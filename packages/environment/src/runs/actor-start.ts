import type { Mode, RoutineInjection, RunOrigin } from "@agent-harness/contracts";
import type { RunAdmission } from "../serve/run-registry.js";
import type { AdapterHost } from "../adapter/host.js";
import { formatActor, type EventLog, type Tx } from "../event-log/event-log.js";
import type { RunActor } from "../permissions/resolver.js";
import { startRunIn, type RunStartOutcome } from "./run-methods.js";

/**
 * The actor start (#131): a run an actor that is no client session starts,
 * as `runs.start` starts one for a client session. The environment's
 * `startRun` runs it in a transaction of its own; a routine's firing (#523)
 * runs it inside the transaction that makes the firing's session.
 */

/** Who starts a run that no client session starts: a routine, a bot, or the completions surface. */
type ActorOfRun<K extends RunActor["kind"]> = Extract<RunActor, { readonly kind: K }>;

/**
 * A run an actor that is no client session starts: the session, who (a
 * routine or a bot by its id, which the log names it by, since its name can
 * change; the completions surface), the message it starts with, and a mode
 * and an effort of its own if it names them. A routine's or a bot's may
 * carry its own credential injection (#367), which a firing passes as the
 * routine saved it: `allow` or `deny` outranks its account's entry and the
 * environment's value, and `inherit`, or none, leaves the answer to them. A
 * completions request cannot ask for one.
 */
export type ActorRunRequest = {
  readonly sessionId: string;
  readonly text: string;
  readonly mode?: Mode;
  /** The reasoning effort the run takes, one its model takes; the default's (`accounts.defaultEffort`) when absent. */
  readonly effort?: string;
  /** Extra always-on names from the enabled skill set, after the account’s choices. */
  readonly alwaysOn?: readonly string[];
} & (
  | { readonly actor: Omit<ActorOfRun<"routine" | "bot">, "injection">; readonly actorId: string; readonly injection?: RoutineInjection }
  | { readonly actor: ActorOfRun<"completions">; readonly actorId?: undefined; readonly injection?: undefined }
);

/** Who runs `request`: its actor, a routine's or a bot's with its own injection when it names `allow` or `deny` (#367). */
const actorOfRequest = (request: ActorRunRequest): RunActor => {
  if (request.actorId === undefined || request.injection === undefined || request.injection === "inherit") return request.actor;
  return { ...request.actor, injection: { answer: request.injection, id: request.actorId } };
};

/** Where a run an actor starts comes from, and who the log says started it: a bot's runs are its routines' (ADR 0008). */
const startedBy = (request: ActorRunRequest): { readonly origin: RunOrigin; readonly actor: string } => {
  const { actor } = request;
  if (actor.kind === "completions") return { origin: "completions", actor: formatActor({ kind: "system", id: "completions" }) };
  const id = request.actorId ?? "";
  return actor.kind === "routine"
    ? { origin: "routine", actor: formatActor({ kind: "routine", id }) }
    : { origin: "routine", actor: formatActor({ kind: "system", id: `bot:${id}` }) };
};

/**
 * Starts `request`'s run in the open transaction `tx` (`startRunIn`), its
 * events attributed to the actor that started it and, when given, the
 * command it is part of.
 */
export const startActorRunIn = (log: EventLog, host: AdapterHost, tx: Tx, request: ActorRunRequest, commandId?: string, admission?: RunAdmission): RunStartOutcome => {
  const { origin, actor } = startedBy(request);
  return startRunIn(log, host, tx, { actor, ...(commandId !== undefined && { commandId }) }, {
    admission,
    sessionId: request.sessionId,
    actor: actorOfRequest(request),
    origin,
    text: request.text,
    mode: request.mode,
    effort: request.effort,
    alwaysOn: request.alwaysOn,
  });
};
