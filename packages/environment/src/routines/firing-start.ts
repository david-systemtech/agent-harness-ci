import type { RunAdmission } from "../serve/run-registry.js";
import { randomUUID } from "node:crypto";
import {
  ContractError,
  ENVIRONMENT_STREAM_KIND,
  ROUTINE_STREAM_KIND,
  WorkspaceRequest,
  type CannotStartReason,
  type Mode,
  type PreCheckRecord,
  type RoutineDefinition,
  type RoutineFiringStartedPayload,
  type RoutineSkippedPayload,
  type RoutineTrigger,
  type SessionContainmentSetPayload,
  type SkipReason,
} from "@agent-harness/contracts";
import type { AdapterHost } from "../adapter/host.js";
import type { EventLog, Tx } from "../event-log/event-log.js";
import { clampMode } from "../permissions/resolver.js";
import { startActorRunIn } from "../runs/actor-start.js";
import type { AccountFacts } from "../runs/run-decider.js";
import { createSessionIn } from "../sessions/methods.js";
import type { Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
import type { Resolution, WorkspaceResolver } from "../workspace/resolver.js";
import { readSkillSetFor, routineAccount, unknownSkills, type RoutineAccounts, type SkillSetReader } from "./listing.js";
import { preCheckBlock, type BlockBaseline } from "./pre-check-block.js";
import type { PreCheckRunner } from "./pre-check.js";
import { appendRoutineRecord, routineActor, routineStream } from "./records.js";
import { liveFiringOfRoutine, liveRoutine, routineBaseline, routinesWithLiveFirings } from "./routine-store.js";

/**
 * A firing's start (routines spec, "A firing": Start; #523): what run now
 * and the scheduler (#527) feed. The start runs in the background, so run
 * now answers at once with the firing's id, which its record then shows: a
 * firing, or the skip it became.
 *
 * - **Four at a time** (#527): at most four firings are in a pre-check or a
 *   run on the environment, whatever started them: from a start's take-up
 *   to its skip, or to its firing's end. Later ones wait in memory, in the
 *   order they were asked for, and are taken up as slots free; the
 *   environment's close drops them, and their due times stay unhandled for
 *   the next start's missed rule.
 * - **Overlap** (#527): a firing asked for, or taken up, while a firing of
 *   its routine is in its pre-check or live is a skip `overlap`. One taken up
 *   after its routine was deleted is dropped, as is one from the schedule
 *   after its routine was disabled.
 *
 * - **The pre-check** (#526), first, when the firing asks for one and its
 *   routine has one: its output compared with the baseline's. Unchanged
 *   output is a skip `no-change`, recorded with no `routine.updated`, so
 *   nothing is made, called, delivered or noticed; a failure is a skip
 *   `pre-check-failed` with its detail and standard error, the baseline
 *   untouched; changed output, or none to compare with, goes on, and the
 *   firing records the pre-check and is told what changed.
 * - **Checks**, before anything is made: the routine's account, found by
 *   identity (null: the default account), is here and signed in, and offers
 *   its model (null: some model, the default family's strongest when it has
 *   one); and that account's skill set holds each of its skills (#531).
 *   Else the entry is a skip `cannot-start`, `account_missing`,
 *   `account_signed_out`, `model_unavailable` or `skill_unknown` (naming
 *   the names it lacks), with no session.
 * - **The workspace**, through the resolver in process (#321), as any
 *   session's: a directory checked, a scratch directory or a worktree made
 *   for the firing's session. A refusal is `cannot-start`
 *   `workspace_unusable`, carrying the resolver's problem.
 * - **One transaction**, the firing id its command id as the routine's actor
 *   (`routine:<id>`), so a retry under it makes nothing twice: the session,
 *   through `sessions.create`'s path, titled with the routine's name and
 *   the due time in its zone, tagged `routine` and the name, on the account
 *   with the model and mode, the routine's containment its own level; the
 *   run, through the actor start (#131) as a routine by its name and
 *   effort, under the firing's ceiling, starting with the header and the
 *   instructions and the pre-check's block, its skills the run's extra
 *   always-on names (#531); and `routine.firing-started` with the
 *   pre-check, and the targets, the silence marker and the maximum duration
 *   it finishes under (#524), and the skills its runs load (#531). A refusal anywhere, or a
 *   failure, rolls it all back: the resolver's undo removes what it made,
 *   and the entry is `cannot-start` `start_refused`, so no firing session
 *   is left without a run.
 */

/** The tag every firing's session carries, beside its routine's name. */
const ROUTINE_TAG = "routine";

/** How many firings may be in a pre-check or a run at once on an environment (routines spec, "The scheduler"). */
export const FIRINGS_AT_ONCE = 4;

/** A firing to start. */
export interface FiringStart {
  readonly routineId: string;
  /** The definition it starts, and finishes, under: its routine's as it was when the firing was asked for. */
  readonly definition: RoutineDefinition;
  /** Its id, minted by what asked for it: the firing's, or its skip's. */
  readonly firingId: string;
  readonly trigger: RoutineTrigger;
  /** The due time it fires for; for run now, when it was asked. */
  readonly dueAt: string;
  /** How many due times it stands for. */
  readonly count: number;
  /** The client session that ran it now; null for the schedule. */
  readonly requestedBy: string | null;
  /** The ceiling its run is resolved under: the routine's saved one, for run now lowered to the caller's. */
  readonly ceiling: Mode;
  /** Whether its routine's pre-check runs first: always from the schedule, for run now only when asked. */
  readonly withPreCheck: boolean;
}

export interface FiringStarterOptions {
  readonly log: EventLog;
  /** The environment's clock, which stamps the records. */
  readonly clock: () => Date;
  /** The environment's id: its stream carries the `routine.updated` notices. */
  readonly environmentId: string;
  /** The environment's name now, which the first message names. */
  readonly environmentName: () => string;
  readonly host: AdapterHost;
  /** The account store's facts and default account, which the checks read. */
  readonly accounts: RoutineAccounts["accounts"];
  /** The resolver a firing's session gets its workspace through, as `sessions.create`'s does (#321). */
  readonly resolver: WorkspaceResolver;
  /** What runs a routine's pre-check (#526). */
  readonly preChecks: PreCheckRunner;
  /** Reads the skill set, which a firing's skills are checked against (#531). */
  readonly readSkillSet: SkillSetReader;
}

export interface FiringStarter {
  /** Whether a firing of the routine is waiting for a slot, starting or live, so another is not asked for. */
  live(routineId: string): boolean;
  /** Checks the drain gate before a run now is accepted. */
  admit(): void;
  /** Starts `firing` in the background once a slot is free, or skips it `overlap`: its record says how it went. */
  start(firing: FiringStart): void;
  /** Lets the starts under way finish, each making nothing more once it sees the environment is closing. */
  close(): Promise<void>;
}

/** Where the resolver placed a firing's session. */
type Place = Exclude<Resolution, { readonly refused: unknown }>;

/** Why a firing could not start: the reason and what a person should know. */
interface CannotStart {
  readonly reason: CannotStartReason;
  readonly detail: string;
}

/** A skip as the firing records it: why, why it could not start when that is why, what a person should know, and the pre-check it ran. */
export interface Skip {
  readonly reason: SkipReason;
  readonly cannotStart: CannotStartReason | null;
  readonly detail: string | null;
  readonly preCheck: PreCheckRecord | null;
}

/** The pre-check a firing ran and goes on with: what it found, and the baseline its output is told against. */
interface Observation {
  readonly record: PreCheckRecord;
  readonly baseline: BlockBaseline | null;
}

/** What records a skip: the log, the clock that stamps it, and the environment whose stream carries its notice. */
export interface SkipRecorder {
  readonly log: EventLog;
  readonly clock: () => Date;
  readonly environmentId: string;
}

/** A skip's due time, as the firing it would have been names it. */
export type SkippedDue = Pick<FiringStart, "routineId" | "firingId" | "trigger" | "dueAt" | "count">;

/** Records `due` as a skip, under its id, as the routine, in a command of its own; a `no-change` skip raises no `routine.updated`. */
export const recordSkip = ({ log, clock, environmentId }: SkipRecorder, due: SkippedDue, skipped: Skip): void => {
  const actor = routineActor(due.routineId);
  const payload: RoutineSkippedPayload = {
    skipId: due.firingId,
    trigger: due.trigger,
    dueAt: due.dueAt,
    reason: skipped.reason,
    cannotStart: skipped.cannotStart,
    count: due.count,
    detail: skipped.detail,
    preCheck: skipped.preCheck,
  };
  const change = skipped.reason === "no-change" ? null : "skipped";
  log.command({ actor, commandId: due.firingId }, (tx) => {
    appendRoutineRecord(log, environmentId, due.routineId, { event: { type: "routine.skipped", payload, occurredAt: clock().toISOString() }, change }, { tx, actor, commandId: due.firingId });
    return { aggregate: routineStream(due.routineId), result: null };
  });
};

/** A skip with no pre-check and no detail, for a reason other than `cannot-start`: `overlap` or `missed`. */
export const plainSkip = (reason: "overlap" | "missed"): Skip => ({ reason, cannotStart: null, detail: null, preCheck: null });

/** A pre-check's failure as its skip's detail: why, then the last of the script's standard error when it wrote any. */
const failureDetail = (record: PreCheckRecord): string => {
  const why = record.failure?.detail ?? "The pre-check failed.";
  return record.stderr === null ? why : `${why}\n\nThe last of its standard error:\n${record.stderr}`;
};

/** The instant `at` in `zone` to the minute, `yyyy-mm-dd HH:MM`; in UTC when the runtime does not know the zone. */
export const minuteIn = (at: string, zone: string): string => {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch {
    return minuteIn(at, "UTC");
  }
  const part = Object.fromEntries(format.formatToParts(new Date(at)).map(({ type, value }) => [type, value]));
  return `${part["year"]}-${part["month"]}-${part["day"]} ${part["hour"]}:${part["minute"]}`;
};

/**
 * The firing's first message: a header naming the routine, the environment
 * and the due time, saying nobody is present and prompts are answered
 * automatically, and that the marker alone sends nothing; then the
 * instructions; then, when a pre-check ran, its block.
 */
export const firingMessage = (firing: FiringStart, environmentName: string, observation: Observation | null): string => {
  const { name, timezone, silenceMarker, instructions } = firing.definition;
  const block = observation === null ? [] : ["", preCheckBlock(observation.record.output ?? "", observation.record.startedAt, observation.baseline)];
  return [
    `This is a firing of the routine "${name}" on the environment "${environmentName}", due ${minuteIn(firing.dueAt, timezone)} (${timezone}).`,
    "Nobody is present: prompts are answered automatically, and anything that needs a person's approval is denied.",
    `If there is nothing worth reporting, answer with ${silenceMarker} alone, and nothing is sent.`,
    "",
    instructions,
    ...block,
  ].join("\n");
};

/** The account a firing runs on, or why it cannot start: the checks made before anything is. */
const checked = (definition: RoutineDefinition, account: AccountFacts | null): { readonly account: AccountFacts } | { readonly refused: CannotStart } => {
  if (account === null) {
    const detail =
      definition.account === null
        ? "No account is the environment's default, so the firing has none to run on."
        : `No account here is signed in as ${definition.account.email} on ${definition.account.provider}.`;
    return { refused: { reason: "account_missing", detail } };
  }
  if (!account.signedIn) return { refused: { reason: "account_signed_out", detail: `The account ${account.id} is not signed in on this environment.` } };
  const { model } = definition;
  if (model === null ? account.models.length === 0 : !account.models.some((option) => option.id === model)) {
    const detail = model === null ? `The account ${account.id} offers no model.` : `The account ${account.id} does not offer the model ${model}.`;
    return { refused: { reason: "model_unavailable", detail } };
  }
  return { account };
};

/** A resolver's refusal, for a person: its message, and the problem or reason it names. */
const workspaceDetail = (refused: { readonly message: string; readonly data: Readonly<Record<string, unknown>> }): string => {
  const why = [refused.data["problem"], refused.data["reason"]].find((value): value is string => typeof value === "string");
  return why === undefined ? refused.message : `${refused.message} (${why})`;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const createFiringStarter = (options: FiringStarterOptions): FiringStarter => {
  const { log, environmentId, host, resolver, preChecks } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  /** The firing starting for each routine: from its take-up to its record's commit. */
  const starting = new Map<string, string>();
  /** The firings asked for while every slot was taken, in the order they were asked for. */
  const waiting: FiringStart[] = [];
  const underWay = new Set<Promise<void>>();
  /** Stops the pre-checks under way once the environment is closing. */
  const closer = new AbortController();
  let closing = false;
  let draining = false;

  /** Records the firing as a skip, under its id, as the routine; a `no-change` skip raises no `routine.updated`. */
  const skip = (firing: FiringStart, skipped: Skip): void => recordSkip(options, firing, skipped);

  /** Whether a firing of the routine is in its pre-check or live. */
  const busy = (routineId: string): boolean => starting.has(routineId) || liveFiringOfRoutine(reader, routineId) !== null;

  /** How many firings hold a slot: those starting, and those live, each once. */
  const held = (): number => new Set([...starting.keys(), ...routinesWithLiveFirings(reader)]).size;

  /** Records the firing as a skip `cannot-start`, with the pre-check it ran. */
  const cannotStart = (firing: FiringStart, why: CannotStart, observation: Observation | null): void =>
    skip(firing, { reason: "cannot-start", cannotStart: why.reason, detail: why.detail, preCheck: observation?.record ?? null });

  /**
   * Runs the firing's pre-check when it asks for one and its routine has
   * one: answers what the firing goes on with (null when none ran), or
   * `stop` when it goes on no further: its output was unchanged or it
   * failed, and its skip is recorded, or the environment closed meanwhile.
   */
  const observe = async (firing: FiringStart): Promise<Observation | null | "stop"> => {
    const { preCheck, name, workspace, account, injection } = firing.definition;
    if (!firing.withPreCheck || preCheck === null) return null;
    const baseline = routineBaseline(reader, firing.routineId);
    const subject = { routine: { id: firing.routineId, name }, dueAt: firing.dueAt, trigger: firing.trigger, workspace, account, injection };
    const { record } = await preChecks.run(preCheck, subject, { baselineHash: baseline?.hash ?? null, signal: closer.signal });
    if (closing) return "stop";
    if (record.failure !== null) {
      skip(firing, { reason: "pre-check-failed", cannotStart: null, detail: failureDetail(record), preCheck: record });
      return "stop";
    }
    if (record.differs === false) {
      // The output is the baseline's, which keeps it: the skip keeps none.
      skip(firing, { reason: "no-change", cannotStart: null, detail: null, preCheck: { ...record, output: null } });
      return "stop";
    }
    return { record, baseline };
  };

  /** The firing's session, containment and run, and its `routine.firing-started`, in the open transaction; a refusal is thrown. */
  const make = (tx: Tx, firing: FiringStart, sessionId: string, place: Place, account: AccountFacts, observation: Observation | null, admission: RunAdmission): void => {
    const { routineId, firingId, definition, ceiling } = firing;
    const actor = routineActor(routineId);
    const attribution = { tx, actor, commandId: firingId };
    if (liveRoutine(reader, routineId) === null) {
      throw new ContractError({ code: "not_found", message: `The routine ${routineId} was deleted before its firing started.`, data: { kind: "routine", routineId } });
    }
    const created = createSessionIn(
      log,
      attribution,
      {
        id: sessionId,
        title: `${definition.name} ${minuteIn(firing.dueAt, definition.timezone)}`,
        tags: [ROUTINE_TAG, definition.name],
        workspace: place.workspace,
        repositoryIdentity: place.repositoryIdentity,
        account: account.id,
        model: definition.model,
        mode: definition.mode,
      },
      // The session's mode is stored as the firing's ceiling allows it, as a create stores a client's.
      { validateRunParameters: host.validateSessionInput, clampMode: (mode) => clampMode(mode, mode, ceiling, account.descriptor.modes)?.effective ?? null },
    );
    if (created.rejected !== undefined) throw new ContractError(created.rejected);
    if (definition.containment !== null) {
      // The routine's level is the session's own, which each of its runs asks the resolver for (ADR 0006).
      const level = definition.containment;
      const payload: SessionContainmentSetPayload = { containment: { requested: level, effective: level, clamped: false } };
      log.append(sessionStream(sessionId), [{ type: "session.containment.set", payload }], attribution);
    }
    const run = startActorRunIn(
      log,
      host,
      tx,
      {
        sessionId,
        text: firingMessage(firing, options.environmentName(), observation),
        ...(definition.mode !== null && { mode: definition.mode }),
        ...(definition.effort !== null && { effort: definition.effort }),
        actor: { kind: "routine", name: definition.name, ceiling, clientSessionId: null },
        actorId: routineId,
        injection: definition.injection,
        alwaysOn: definition.skills,
      },
      firingId,
      admission,
    );
    if (run.rejected !== undefined) throw new ContractError(run.rejected);
    const payload: RoutineFiringStartedPayload = {
      firingId,
      trigger: firing.trigger,
      dueAt: firing.dueAt,
      count: firing.count,
      sessionId,
      runId: run.runId,
      requestedBy: firing.requestedBy,
      preCheck: observation?.record ?? null,
      targets: definition.delivery,
      silenceMarker: definition.silenceMarker,
      maxDurationMinutes: definition.maxDurationMinutes,
      skills: definition.skills,
    };
    appendRoutineRecord(log, environmentId, routineId, { event: { type: "routine.firing-started", payload }, change: "firing-started" }, attribution);
  };

  /** Removes what the resolver made for a firing that was not made; a removal that fails is logged. */
  const discard = async (place: Place): Promise<void> => {
    try {
      await place.undo?.();
    } catch (error) {
      console.error("Removing what the resolver made for a firing that did not start failed:", error);
    }
  };

  /** Where the firing's session works, as the resolver places it; or why it cannot, a refusal or a throw alike `workspace_unusable`. */
  const placeFor = async (firing: FiringStart, sessionId: string): Promise<{ readonly place: Place } | { readonly refused: CannotStart }> => {
    try {
      const resolved = await resolver.resolve(WorkspaceRequest.parse(firing.definition.workspace), sessionId);
      return resolved.refused === undefined ? { place: resolved } : { refused: { reason: "workspace_unusable", detail: workspaceDetail(resolved.refused) } };
    } catch (error) {
      return { refused: { reason: "workspace_unusable", detail: messageOf(error) } };
    }
  };

  const begin = async (firing: FiringStart, admission: RunAdmission): Promise<void> => {
    const observation = await observe(firing);
    if (observation === "stop") return;
    const check = checked(firing.definition, routineAccount(firing.definition.account, { reader, accounts: options.accounts }));
    if ("refused" in check) return cannotStart(firing, check.refused, observation);
    const { skills } = firing.definition;
    const unknown = unknownSkills(skills, await readSkillSetFor(skills, options.readSkillSet), check.account.id);
    if (unknown.length > 0) {
      return cannotStart(firing, { reason: "skill_unknown", detail: `The skill set of the account ${check.account.id} does not hold: ${unknown.join(", ")}.` }, observation);
    }
    const sessionId = randomUUID();
    const placed = await placeFor(firing, sessionId);
    if ("refused" in placed) return cannotStart(firing, placed.refused, observation);
    const { place } = placed;
    if (closing) return discard(place);
    try {
      const outcome = log.command({ actor: routineActor(firing.routineId), commandId: firing.firingId }, (tx) => {
        make(tx, firing, sessionId, place, check.account, observation, admission);
        return { aggregate: routineStream(firing.routineId), result: null };
      });
      // A retry under a firing id already made makes nothing: what it resolved goes again.
      if (outcome.replayed) await discard(place);
    } catch (error) {
      await discard(place);
      if (!(error instanceof ContractError)) console.error(`The firing ${firing.firingId} of the routine ${firing.routineId} could not start:`, error);
      cannotStart(firing, { reason: "start_refused", detail: messageOf(error) }, observation);
    }
  };

  /** Begins the firing in the background, holding a slot until its record commits; the next waiting ones are taken up after. */
  const launch = (firing: FiringStart): void => {
    const { routineId, firingId } = firing;
    const admission = host.runs.reserve(firingId);
    starting.set(routineId, firingId);
    const work = begin(firing, admission)
      .catch((error: unknown) => console.error(`Starting the firing ${firingId} of the routine ${routineId} failed:`, error))
      .finally(() => {
        if (starting.get(routineId) === firingId) starting.delete(routineId);
        underWay.delete(work);
        admission.release();
        takeUp();
      });
    underWay.add(work);
  };

  /**
   * Takes up a waiting firing: dropped when its routine is gone, or when it
   * is the schedule's and its routine is disabled now; a skip `overlap`
   * when a firing of its routine is busy; else begun.
   */
  const takeUpOne = (firing: FiringStart): void => {
    const routine = liveRoutine(reader, firing.routineId);
    if (routine === null || (firing.trigger !== "run-now" && !routine.definition.enabled)) return;
    if (busy(firing.routineId)) return skip(firing, plainSkip("overlap"));
    launch(firing);
  };

  /** Takes up waiting firings, in order, while a slot is free; one whose take-up fails is logged and the next taken up. */
  const takeUp = (): void => {
    for (let next = waiting[0]; !closing && !draining && next !== undefined && held() < FIRINGS_AT_ONCE; next = waiting[0]) {
      waiting.shift();
      try {
        takeUpOne(next);
      } catch (error) {
        console.error(`Taking up the firing ${next.firingId} of the routine ${next.routineId} failed:`, error);
      }
    }
  };

  // A firing's end frees its slot: the next waiting firing is taken up once the end commits.
  const unsubscribe = log.subscribe((event) => {
    if (event.streamKind === ENVIRONMENT_STREAM_KIND && event.type === "environment.draining") {
      draining = true;
      waiting.length = 0;
    } else if (event.streamKind === ROUTINE_STREAM_KIND && event.type === "routine.firing-ended") takeUp();
  });

  return {
    admit: () => host.admit(),
    live: (routineId) => busy(routineId) || waiting.some((firing) => firing.routineId === routineId),
    start(firing) {
      if (closing || draining) return;
      host.admit();
      if (busy(firing.routineId)) return skip(firing, plainSkip("overlap"));
      waiting.push(firing);
      takeUp();
    },
    async close() {
      closing = true;
      waiting.length = 0;
      unsubscribe();
      closer.abort();
      await Promise.all(underWay);
    },
  };
};
