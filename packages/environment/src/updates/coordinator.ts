import { randomUUID } from "node:crypto";
import {
  ContractError,
  ENVIRONMENT_STREAM_KIND,
  UpdateCancelledPayload,
  UpdatePendingPayload,
  UpdateStartedPayload,
  invalidParams,
  type EnvironmentActivity,
  type ParamsOf,
  type PendingUpdate,
  type UpdateCause,
  type UpdateConflictReason,
  type UpdateFailedPayload,
  type UpdateSource,
  type UpdatesStatus,
} from "@agent-harness/contracts";
import { formatActor, type EventInput, type EventLog, type JsonObject, type StreamRef } from "../event-log/event-log.js";
import type { Clock, Timer } from "../serve/clock.js";
import type { LauncherChannel } from "../serve/launcher.js";
import type { DrainCause } from "../serve/lifecycle.js";
import type { CommandContext, CommandRejection, MethodHandler, MethodHandlers, PrepareContext } from "../serve/methods.js";
import type { RunRegistry } from "../serve/run-registry.js";
import { readUpdateHistory, settleLatestUpdate } from "./outcomes.js";
import { StagingError, stageArtefact, tarUnpack, unstage, type Unpack } from "./staging.js";

/**
 * The update coordinator (launcher-update spec, "The update coordinator";
 * ADR 0007): the environment's module that holds when an update goes. This
 * part is the wait, the drain and the switch for an update asked for with
 * an artefact on this machine (#343): `updates.apply` stages the artefact
 * and has the launcher install it, and the installed version is a pending
 * update, `waiting`, appended as `environment.update-pending`. On every
 * run-registry change, every minute and at its `deferUntil`, the
 * coordinator reads the activity, and in that same tick, when the
 * environment is idle or the deferral cap has passed (or at once, asked
 * with `when: now`), appends `environment.update-started` and starts the
 * drain with the trigger `update`, which refuses new runs from then on. The
 * drain waits for running runs up to its cap, not for parked ones; then
 * every client hears `bye: updating` and the launcher is asked `switch?`
 * (`switchOver`); a refused switch is `environment.update-failed` at stage
 * `switch`, appended before the environment closes, and the launcher starts
 * the same version again. `updates.cancel` withdraws an update not yet
 * draining.
 *
 * A pending update is read back from the log as the environment starts, so
 * it is still pending after a restart, with its `since`: when an update
 * first became pending, kept when a newer one replaces it. Its `deferUntil`
 * is `since` plus the deferral cap as it is set now.
 */

const MINUTE_MS = 60_000;

/** Who the coordinator's own notices name: the environment's updates, never a client. */
const UPDATES_ACTOR = formatActor({ kind: "system", id: "updates" });

export interface UpdateCoordinatorOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  /** The environment's own stream, where every update notice goes. */
  readonly stream: StreamRef;
  /** The data directory, whose staging area an artefact is unpacked into. */
  readonly dataDir: string;
  /** The harness version the environment runs: every update goes from it. */
  readonly harnessVersion: string;
  readonly launcher: LauncherChannel;
  /** The run registry, whose every change the coordinator hears. */
  readonly runs: Pick<RunRegistry, "onChange">;
  /** The environment's activity now: idle, busy with why, or draining. */
  readonly activity: () => EnvironmentActivity;
  /** The deferral cap in milliseconds, read each time it is needed: the environment's `updates.deferralCapHours`. */
  readonly deferralCapMs: () => number;
  /** Starts the drain with the trigger `update`, recording who asked on its notice. */
  readonly drain: (cause: DrainCause) => void;
  /** How an artefact is unpacked. Preset: the platform's `tar`. */
  readonly unpack?: Unpack;
}

export interface UpdateCoordinator {
  /** The pending update with its state, and what a waiting one waits on: what `updates.status` answers as `pending`. */
  pending(): PendingUpdate;
  /** How the last update ended, and the versions whose update failed, read from the log: what `updates.status` answers of them. */
  outcomes(): Pick<UpdatesStatus, "lastOutcome" | "failedVersions">;
  /**
   * The settle, once this start has passed its gate and before the wire
   * serves anyone: the update that began last gets its outcome, when it has
   * none yet, from the version this start runs and the outcome record, which
   * is deleted after (`outcomes.ts`).
   */
  settle(): void;
  readonly handlers: Required<Pick<MethodHandlers, "updates.apply" | "updates.cancel">>;
  /** Starts hearing the run registry, the minute and the cap; returns the stop. Called once the wire is open. */
  start(): () => void;
  /**
   * The switch, once an update's drain has waited and every client has
   * heard `bye: updating`: asks the launcher `switch?`, and on a refusal
   * appends `environment.update-failed` (stage `switch`, the launcher's
   * reason). Settles once answered; the environment closes after.
   */
  switchOver(): Promise<void>;
}

/** A pending update, as the coordinator holds it. */
interface Update {
  readonly updateId: string;
  readonly toVersion: string;
  readonly source: UpdateSource;
  /** When an update first became pending. */
  readonly since: Date;
}

/** Where the coordinator is. */
type Held =
  | { readonly state: "current" }
  | { readonly state: "waiting"; readonly update: Update }
  | { readonly state: "draining" | "switching"; readonly update: Update; readonly cause: UpdateCause };

/** The update-pending, -started and -cancelled notices, which say what is pending. */
const PENDING_TYPES = ["environment.update-pending", "environment.update-started", "environment.update-cancelled"] as const;

type Refusal = CommandRejection<"forbidden" | "not_found" | "conflict" | "unavailable">;

const conflict = (reason: UpdateConflictReason, message: string, data: JsonObject = {}): Refusal => ({ code: "conflict", message, data: { reason, ...data } });

/**
 * The update pending in the log, if any: the newest `environment.update-pending`
 * that no `environment.update-started` or `-cancelled` of its update has
 * followed. A payload that is not one is passed over.
 */
const pendingInLog = (log: EventLog): Update | undefined => {
  let pending: Update | undefined;
  for (const event of log.readStream({ kinds: [ENVIRONMENT_STREAM_KIND], types: [...PENDING_TYPES] })) {
    if (event.type === "environment.update-pending") {
      const payload = UpdatePendingPayload.safeParse(event.payload);
      if (payload.success) pending = { updateId: payload.data.updateId, toVersion: payload.data.toVersion, source: payload.data.source, since: new Date(payload.data.since) };
      continue;
    }
    const ended = (event.type === "environment.update-started" ? UpdateStartedPayload : UpdateCancelledPayload).safeParse(event.payload);
    if (ended.success && ended.data.updateId === pending?.updateId) pending = undefined;
  }
  return pending;
};

export const createUpdateCoordinator = (options: UpdateCoordinatorOptions): UpdateCoordinator => {
  const { log, clock, stream, launcher, harnessVersion } = options;
  const unpack = options.unpack ?? tarUnpack;
  const recovered = pendingInLog(log);
  let held: Held = recovered ? { state: "waiting", update: recovered } : { state: "current" };
  /** The update an `updates.apply` is staging now, shown while nothing else is pending. */
  let staging: Omit<Update, "since"> | undefined;
  let started = false;
  let stopped = false;
  let capTimer: Timer | undefined;

  const deferUntil = (update: Update): Date => new Date(update.since.getTime() + options.deferralCapMs());

  /** The notices that begin `update`'s drain for `cause`. */
  const startedEvent = (update: Update, cause: UpdateCause): EventInput => {
    const payload: UpdateStartedPayload = { updateId: update.updateId, fromVersion: harnessVersion, toVersion: update.toVersion, cause };
    return { type: "environment.update-started", payload };
  };

  /** The drain has begun for `update`: new runs are refused from here on. Called in the tick that decided it. */
  const draining = (update: Update, cause: UpdateCause, by: DrainCause): void => {
    capTimer?.cancel();
    held = { state: "draining", update, cause };
    options.drain(by);
  };

  /** Arms the timer that reads the activity again at the waiting update's `deferUntil`. */
  const armCap = (): void => {
    capTimer?.cancel();
    capTimer = undefined;
    if (!started || stopped || held.state !== "waiting") return;
    capTimer = clock.setTimeout(evaluate, Math.max(0, deferUntil(held.update).getTime() - clock.now().getTime()));
  };

  /**
   * The tick: reads the activity and, in the same tick, begins the drain
   * of the waiting update when the environment is idle or its deferral cap
   * has passed. A drain some other trigger began is left to close the
   * environment: the update is still pending at the next start.
   */
  function evaluate(): void {
    if (stopped || held.state !== "waiting") return;
    const { update } = held;
    const activity = options.activity();
    if (activity.state === "draining") return;
    const cause: UpdateCause | undefined = activity.state === "idle" ? "idle" : clock.now() >= deferUntil(update) ? "cap" : undefined;
    if (cause === undefined) return armCap();
    try {
      log.append(stream, [startedEvent(update, cause)], { actor: UPDATES_ACTOR });
    } catch (error) {
      // The next minute's tick tries again; the cap's timer is not re-armed, which would fire at once, again and again.
      console.error(`Appending the start of update ${update.updateId} failed; it stays pending:`, error);
      return;
    }
    draining(update, cause, { actor: UPDATES_ACTOR });
  }

  /** Why an update cannot be asked for now, whatever it is: one is draining or switching, or the environment is draining for another reason. */
  const underWay = (): Refusal | undefined => {
    if (held.state === "draining" || held.state === "switching") {
      return conflict("in_progress", `The update to ${held.update.toVersion} is ${held.state}; it cannot be changed now.`);
    }
    if (options.activity().state === "draining") {
      return { code: "unavailable", message: "The environment is draining and takes no update.", data: { readiness: "draining" } };
    }
    return undefined;
  };

  const refuse =
    (rejected: Refusal): MethodHandler<"updates.apply"> =>
    () => ({ aggregate: stream, rejected });

  /** The command that takes the waiting `update` as asked: at once with `when: now`, else as it waits. */
  const takeWaiting =
    (update: Update, when: ParamsOf<"updates.apply">["when"]): MethodHandler<"updates.apply"> =>
    (_params, context) => {
      const refused = underWay();
      if (refused) return { aggregate: stream, rejected: refused };
      if (held.state !== "waiting" || held.update !== update) return { aggregate: stream, rejected: { code: "not_found", message: `The update to ${update.toVersion} is no longer pending.` } };
      const result = { updateId: update.updateId, toVersion: update.toVersion };
      if (when === "idle") {
        context.tx.afterCommit(evaluate);
        return { aggregate: stream, result };
      }
      context.tx.afterCommit(() => {
        if (held.state === "waiting" && held.update === update) draining(update, "requested", { actor: context.actor, commandId: context.commandId });
      });
      return { aggregate: stream, result, events: [startedEvent(update, "requested")] };
    };

  /**
   * The command that makes the installed `staged` update the pending one:
   * `since` carried over from an update it replaces, else now; draining at
   * once with `when: now`, else waiting.
   */
  const makePending =
    (staged: Omit<Update, "since">, when: ParamsOf<"updates.apply">["when"]): MethodHandler<"updates.apply"> =>
    (_params, context: CommandContext) => {
      const refused = underWay();
      if (refused) return { aggregate: stream, rejected: refused };
      const update: Update = { ...staged, since: held.state === "waiting" ? held.update.since : clock.now() };
      const payload: UpdatePendingPayload = {
        updateId: update.updateId,
        toVersion: update.toVersion,
        source: update.source,
        since: update.since.toISOString(),
        deferUntil: deferUntil(update).toISOString(),
      };
      const events: EventInput[] = [{ type: "environment.update-pending", payload }];
      if (when === "now") events.push(startedEvent(update, "requested"));
      context.tx.afterCommit(() => {
        held = { state: "waiting", update };
        if (when === "now") draining(update, "requested", { actor: context.actor, commandId: context.commandId });
        else {
          armCap();
          evaluate();
        }
      });
      return { aggregate: stream, result: { updateId: update.updateId, toVersion: update.toVersion }, events };
    };

  /**
   * `updates.apply`, prepared: what it can refuse is refused first and the
   * waiting update is taken as it is, both at once, so the command keeps its
   * place among its socket's requests; otherwise the artefact is staged and
   * installed, outside any transaction, and the command then makes it the
   * pending update.
   */
  const prepareApply = (params: ParamsOf<"updates.apply">, context: PrepareContext): MethodHandler<"updates.apply"> | Promise<MethodHandler<"updates.apply">> => {
    const { version, artefactPath, when } = params;
    if (artefactPath !== undefined && !context.clientSession.local) {
      return refuse({
        code: "forbidden",
        message: "Only a local client session may name an artefact path: a path on this machine is trusted as the bootstrap grant is.",
        data: { scope: "admin", reason: "local" },
      });
    }
    if (artefactPath !== undefined && version === undefined) {
      throw new ContractError(invalidParams([{ code: "custom", path: ["version"], message: "An artefact path is taken with the version the artefact holds." }]));
    }
    const refused = underWay();
    if (refused) return refuse(refused);
    if (version === harnessVersion) return refuse(conflict("current", `This environment runs ${harnessVersion} already.`));
    if (held.state === "waiting" && (version === undefined || version === held.update.toVersion)) return takeWaiting(held.update, when);
    if (artefactPath === undefined || version === undefined) {
      return refuse(conflict("no_release_access", "This environment reads no releases yet: name the version with the path of its artefact on this machine."));
    }
    if (!launcher.present()) return refuse(noLauncher());
    // One artefact is staged at a time, so no two installs share the staging area.
    if (staging !== undefined) return refuse(conflict("in_progress", `The artefact of ${staging.toVersion} is being staged and installed; ask again once it is.`));
    const source: UpdateSource = context.clientSession.kind === "desktop" ? "desktop" : "request";
    return install({ updateId: randomUUID(), toVersion: version, source }, artefactPath, when);
  };

  /** Stages the artefact at `artefactPath` for `update` and has the launcher install it; then the command makes it pending. */
  const install = async (update: Omit<Update, "since">, artefactPath: string, when: ParamsOf<"updates.apply">["when"]): Promise<MethodHandler<"updates.apply">> => {
    const version = update.toVersion;
    staging = update;
    try {
      let staged: string;
      try {
        staged = await stageArtefact({ dataDir: options.dataDir, version, artefact: artefactPath, unpack });
      } catch (error) {
        if (!(error instanceof StagingError)) throw error;
        if (error.kind === "missing") return refuse({ code: "not_found", message: error.message });
        throw new ContractError(invalidParams([{ code: "custom", path: ["artefactPath"], message: error.message }], error.message));
      }
      const answer = await launcher.request({ type: "install?", version, staged });
      if (answer.type === "refused") {
        unstage(options.dataDir, version);
        if (answer.reason === "no-launcher") return refuse(noLauncher());
        return refuse(conflict("install", `The launcher refused to install ${version}: ${answer.reason}.`, { launcherReason: answer.reason }));
      }
    } finally {
      if (staging === update) staging = undefined;
    }
    return makePending(update, when);
  };

  const noLauncher = (): Refusal =>
    conflict("no_launcher", "No launcher runs this environment to switch its version: serve runs in the foreground; `service install` runs the environment under one.");

  /** What every state with an update shows of it: `deferUntil` read with the cap as it is set now, and no image, which only a container's update has. */
  const pendingParts = (update: Update) => ({
    updateId: update.updateId,
    toVersion: update.toVersion,
    source: update.source,
    since: update.since.toISOString(),
    deferUntil: deferUntil(update).toISOString(),
    image: null,
  });

  return {
    pending() {
      switch (held.state) {
        case "current":
          return staging ? { state: "staging", ...staging } : { state: "current" };
        case "waiting": {
          const activity = options.activity();
          const waitsOn = activity.state === "busy" ? { reason: activity.reason, until: activity.busyUntil ?? null } : null;
          return { state: "waiting", ...pendingParts(held.update), waitsOn };
        }
        case "draining":
        case "switching":
          return { state: held.state, ...pendingParts(held.update), cause: held.cause };
      }
    },

    outcomes: () => readUpdateHistory(log).outcomes,

    settle: () => settleLatestUpdate({ log, stream, dataDir: options.dataDir, harnessVersion, actor: UPDATES_ACTOR }),

    handlers: {
      "updates.apply": { prepare: prepareApply },

      "updates.cancel": (_params, context) => {
        if (held.state === "draining" || held.state === "switching") {
          return { aggregate: stream, rejected: conflict("in_progress", `The update to ${held.update.toVersion} is ${held.state} and can no longer be withdrawn.`) };
        }
        if (held.state !== "waiting") return { aggregate: stream, rejected: { code: "not_found", message: "No update is pending." } };
        const { update } = held;
        const payload: UpdateCancelledPayload = { updateId: update.updateId, toVersion: update.toVersion, cause: "requested" };
        context.tx.afterCommit(() => {
          if (held.state !== "waiting" || held.update !== update) return;
          held = { state: "current" };
          armCap();
        });
        return { aggregate: stream, result: { updateId: update.updateId, toVersion: update.toVersion }, events: [{ type: "environment.update-cancelled", payload }] };
      },
    },

    start() {
      started = true;
      // Heard after the change's own work is done, so the tick never runs inside another's transaction.
      const stopRuns = options.runs.onChange(() => queueMicrotask(evaluate));
      const minute = clock.setInterval(evaluate, MINUTE_MS);
      armCap();
      return () => {
        stopped = true;
        stopRuns();
        minute.cancel();
        capTimer?.cancel();
      };
    },

    async switchOver() {
      if (held.state !== "draining") return;
      const { update, cause } = held;
      held = { state: "switching", update, cause };
      const answer = await launcher.request({ type: "switch?", updateId: update.updateId, version: update.toVersion });
      if (answer.type === "switching") return;
      const failed: UpdateFailedPayload = {
        updateId: update.updateId,
        fromVersion: harnessVersion,
        toVersion: update.toVersion,
        stage: "switch",
        reason: answer.reason,
        rolledBack: false,
      };
      try {
        log.append(stream, [{ type: "environment.update-failed", payload: failed }], { actor: UPDATES_ACTOR });
      } catch (error) {
        console.error(`Appending the refused switch of update ${update.updateId} failed:`, error);
      }
    },
  };
};
