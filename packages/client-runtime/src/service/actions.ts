import type { Runtime } from "../runtime.js";
import { adminCall } from "../status/actions.js";
import { clockTime } from "../transcript/format.js";
import { DRAIN_TRIGGER_WORDS } from "./words.js";

/**
 * What the Service row sends, as any renderer sends it and says it (env
 * spec, "Lifecycle"; #417): a drain and a rebuild of the projections, each
 * an `admin` command sent as a direct request (`adminCall`), never the
 * outbox's, so one made while the environment cannot be reached fails at
 * once. Each answers what it did, or why not, in one line.
 */

/** What a verb did, in one line. */
export interface ServiceOutcome {
  readonly ok: boolean;
  readonly line: string;
}

/**
 * Drains the environment (`environment.drain`): it refuses new runs, lets
 * running ones finish, then stops. A drain already under way is joined, and
 * says since when and what started it.
 */
export const drainEnvironment = async (runtime: Pick<Runtime, "requests">, environmentId: string, environment: string, commandId: string): Promise<ServiceOutcome> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "environment.drain", { commandId }));
  if (!answer.ok) return { ok: false, line: `Not drained: ${answer.line}` };
  const drain = answer.result;
  if (drain === undefined) return { ok: true, line: `${environment} is draining.` };
  const since = clockTime(drain.drainingSince);
  return answer.changed
    ? { ok: true, line: `${environment} is draining since ${since}: it refuses new runs and stops once the running ones finish.` }
    : { ok: true, line: `${environment} was draining already, since ${since}, started by ${DRAIN_TRIGGER_WORDS[drain.trigger]}.` };
};

/** Rebuilds the environment's projections from its event log (`environment.rebuildProjections`): which were rebuilt, through which event. */
export const rebuildProjections = async (runtime: Pick<Runtime, "requests">, environmentId: string, environment: string, commandId: string): Promise<ServiceOutcome> => {
  const answer = await adminCall(() => runtime.requests.call(environmentId, "environment.rebuildProjections", { commandId }));
  if (!answer.ok) return { ok: false, line: `Not rebuilt: ${answer.line}` };
  const rebuilt = answer.result;
  if (rebuilt === undefined) return { ok: true, line: `Rebuilt ${environment}'s projections from its log.` };
  const count = rebuilt.projectors.length;
  return { ok: true, line: `Rebuilt ${environment}'s ${count} projection${count === 1 ? "" : "s"} from its log, through event ${rebuilt.sequence}.` };
};
