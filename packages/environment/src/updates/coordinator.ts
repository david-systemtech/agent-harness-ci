import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import {
  ContractError,
  ENVIRONMENT_STREAM_KIND,
  ReleaseVersion,
  compareReleaseVersions,
  UpdateCancelledPayload,
  UpdatePendingPayload,
  UpdateStartedPayload,
  invalidParams,
  DRAIN_CAP_MS,
  type EnvironmentActivity,
  type InstallRefusal,
  type ParamsOf,
  type PendingUpdate,
  type UpdateCancelCause,
  type UpdateCause,
  type UpdateConflictReason,
  type UpdateFailedPayload,
  type UpdateSource,
  type UpdatesStatus,
} from "@agent-harness/contracts";
import type { AdapterHost } from "../adapter/host.js";
import { formatActor, type EventInput, type EventLog, type JsonObject, type StreamRef } from "../event-log/event-log.js";
import type { StateCheckAnswer } from "../permissions/step-checks.js";
import type { Clock, Timer } from "../serve/clock.js";
import type { LauncherChannel } from "../serve/launcher.js";
import type { DrainCause } from "../serve/lifecycle.js";
import type { CommandContext, CommandRejection, MethodHandler, MethodHandlers, PrepareContext } from "../serve/methods.js";
import type { RunRegistry } from "../serve/run-registry.js";
import type { ChannelBlock, ChannelContext, ChannelReading, ChannelSettings, ReleaseChannelReader, StageableRelease } from "./channel.js";
import type { StagingFailure } from "./checks.js";
import { settleInterruptedRuns } from "./interrupted-runs.js";
import { readUpdateHistory, settleLatestUpdate } from "./outcomes.js";
import { StagingError, downloadDestination, stageArtefact, tarUnpack, unstage, type Unpack } from "./staging.js";

/**
 * The update coordinator (launcher-update spec, "The update coordinator";
 * ADR 0007): the environment's module that holds when an update goes.
 *
 * **Staging** (#347): what a check of the release channel found to stage
 * (the target, or its stepping stone) is downloaded through the
 * ForgeService, checked against its manifest's size and SHA-256, unpacked
 * into the staging area and sent to the launcher in `install?`, busy or
 * idle; a failure leaves nothing pending, fails the check and is tried again
 * at the next. `updates.apply` stages a version asked for by name the same
 * way (Update now; with none, the pin or the channel's newest), or, from a
 * local client session, an artefact on this machine (#343). One is staged
 * at a time. A target the launcher cannot host, which no stepping stone
 * reaches, is `blocked` until `service install` from its release.
 *
 * **Waiting** (#343): the installed version is a pending update, `waiting`,
 * appended as `environment.update-pending` with where it comes from: the
 * channel, the pin, a request or the desktop. A newer release replacing it
 * takes a new update id and keeps its `since`; a channel's update is
 * withdrawn (`environment.update-cancelled`, cause `settings`) once the
 * settings stop calling for it. On every run-registry change, every minute and at its `deferUntil`, the
 * coordinator reads the activity, and in that same tick, when the
 * environment is idle or the deferral cap has passed (or at once, asked
 * with `when: now`), appends `environment.update-started` and starts the
 * drain with the trigger `update`, which refuses new runs from then on. The
 * drain waits for running runs up to its cap, not for parked ones; then
 * every client hears `bye: updating` and the launcher is asked `switch?`
 * (`switchOver`); a refused switch is `environment.update-failed` at stage
 * `switch`, appended before the environment closes, and the launcher starts
 * the same version again. `updates.cancel` withdraws an update not yet
 * draining. As the next start passes its gate, the coordinator settles the
 * update that began last: updated when that start runs its target, else
 * failed as the outcome record says (`outcomes.ts`, #344); and, whatever
 * the outcome, marks each run that update cut and continues it where it
 * can (`interrupted-runs.ts`, #345).
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
  /** The environment's name, which the continuation of a run an update cut says. */
  readonly environmentName: string;
  /** The harness version the environment runs: every update goes from it. */
  readonly harnessVersion: string;
  readonly launcher: LauncherChannel;
  /** The run registry, whose every change the coordinator hears. */
  readonly runs: Pick<RunRegistry, "onChange">;
  /** Where the continuation of a run an update cut starts, as the settle marks it. */
  readonly host: Pick<AdapterHost, "startFacts" | "launch">;
  /** The environment's activity now: idle, busy with why, or draining. */
  readonly activity: () => EnvironmentActivity;
  /** The deferral cap in milliseconds, read each time it is needed: the environment's `updates.deferralCapHours`. */
  readonly deferralCapMs: () => number;
  /** The update settings the target follows, as they are now. */
  readonly settings: () => ChannelSettings;
  /** The release channel: a release asked for by version, and an artefact's download. */
  readonly channel: Pick<ReleaseChannelReader, "requested" | "download">;
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
   * serves anyone, in two parts each idempotent on its own: the update that
   * began last gets its outcome, when it has none yet, from the version this
   * start runs and the outcome record, which is deleted after
   * (`outcomes.ts`); then each run it cut that has no mark yet gets one, and
   * a continuation where it can go on (`interrupted-runs.ts`).
   */
  settle(): void;
  readonly handlers: Required<Pick<MethodHandlers, "updates.apply" | "updates.cancel">>;
  /** What a check reads the channel with beside the settings: the running launcher's protocol, as its `versions?` answers, and the failed versions. */
  channelContext(): Promise<ChannelContext>;
  /**
   * What a check that read the channel under `settings` found: its block is
   * held, and what it found to stage is staged and made the pending update,
   * unless it is pending already, an update is under way, or the settings
   * changed meanwhile. Null once staged or with nothing to stage; else why
   * staging failed, which the check reports.
   */
  follow(reading: ChannelReading, settings: ChannelSettings): Promise<StagingFailure | null>;
  /**
   * `updates.settings.set` changes the settings from `before` to `after` in
   * `context`'s command: a waiting update the channel called for that they
   * no longer call for (auto-update turned off, the channel changed, a pin
   * naming another version) is withdrawn in the same transaction.
   */
  settingsChanging(before: ChannelSettings, after: ChannelSettings, context: CommandContext): void;
  /**
   * The Your machines step's `your-machines.updates`, with `newest` the
   * channel's newest as the last check found it: auto-update effective or
   * that newest running, no update past its deferral cap and its drain,
   * nothing blocked, and no failed update above the version running.
   */
  machineHolds(newest: string | null): StateCheckAnswer;
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
 * Why a release was not staged and installed: its artefact did not download
 * (the release access refused, or the artefact itself), did not match its
 * manifest or did not unpack; the launcher refused it, saying why; or no
 * launcher is there to install it.
 */
type Unstaged =
  | { readonly reason: "no_release_access" | "unreachable" | "manifest" | "artefact" | "no_launcher"; readonly message: string }
  | { readonly reason: "install"; readonly message: string; readonly launcherReason: InstallRefusal };

/** `unstaged` as `updates.apply` refuses it: in conflict, the launcher's refusal with its reason. */
const refusalOf = (unstaged: Unstaged): Refusal =>
  unstaged.reason === "install" ? conflict("install", unstaged.message, { launcherReason: unstaged.launcherReason }) : conflict(unstaged.reason, unstaged.message);

/** Why no launcher can switch the version, for people. */
const NO_LAUNCHER_MESSAGE = "No launcher runs this environment to switch its version: serve runs in the foreground; `service install` runs the environment under one.";

/** Whether `a` is a release version newer than `b`; a version that is none is never newer. */
const newer = (a: string, b: string): boolean => ReleaseVersion.safeParse(a).success && ReleaseVersion.safeParse(b).success && compareReleaseVersions(a, b) > 0;

/** Whether two readings of the settings call for the same target: auto-update, the channel and the pin alike. */
const sameTarget = (a: ChannelSettings, b: ChannelSettings): boolean => a.autoUpdate === b.autoUpdate && a.channel === b.channel && a.pinnedVersion === b.pinnedVersion;

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
  /** The update being staged now, by a check or `updates.apply`, shown while nothing else is pending: one at a time. */
  let staging: Omit<Update, "since"> | undefined;
  /** The target the last check that read the channel found blocked, shown while nothing else is pending. */
  let blocked: ChannelBlock | null = null;
  let started = false;
  let stopped = false;
  let capTimer: Timer | undefined;

  const deferUntil = (update: Update): Date => new Date(update.since.getTime() + options.deferralCapMs());

  /** The notice that makes `update` the pending one. */
  const pendingEvent = (update: Update): EventInput => {
    const payload: UpdatePendingPayload = {
      updateId: update.updateId,
      toVersion: update.toVersion,
      source: update.source,
      since: update.since.toISOString(),
      deferUntil: deferUntil(update).toISOString(),
    };
    return { type: "environment.update-pending", payload };
  };

  /** The notice that withdraws `update` for `cause`. */
  const cancelledEvent = (update: Update, cause: UpdateCancelCause): EventInput => {
    const payload: UpdateCancelledPayload = { updateId: update.updateId, toVersion: update.toVersion, cause };
    return { type: "environment.update-cancelled", payload };
  };

  /** `staged` as the pending update: `since` carried over from an update it replaces, else now. */
  const pendingOf = (staged: Omit<Update, "since">): Update => ({ ...staged, since: held.state === "waiting" ? held.update.since : clock.now() });

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
      const update = pendingOf(staged);
      const events: EventInput[] = [pendingEvent(update)];
      if (when === "now") events.push(startedEvent(update, "requested"));
      context.tx.afterCommit(() => {
        held = { state: "waiting", update };
        if (when === "now") draining(update, "requested", { actor: context.actor, commandId: context.commandId });
        else wait();
      });
      return { aggregate: stream, result: { updateId: update.updateId, toVersion: update.toVersion }, events };
    };

  /** The waiting update's wait begins, or goes on with a new update: the cap's timer armed, and the activity read at once. */
  const wait = (): void => {
    armCap();
    evaluate();
  };

  /**
   * `updates.apply`, prepared: what it can refuse is refused first and the
   * waiting update is taken as it is, both at once, so the command keeps its
   * place among its socket's requests; otherwise the artefact at the path
   * given, or the release of the version asked for, is staged and installed,
   * outside any transaction, and the command then makes it the pending
   * update.
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
    const { pinnedVersion } = options.settings();
    if (artefactPath === undefined && version !== undefined && pinnedVersion !== null && version !== pinnedVersion) {
      return refuse(conflict("pinned", `${pinnedVersion} is pinned: pin ${version}, or unpin, to update to it.`));
    }
    if (!launcher.present()) return refuse(conflict("no_launcher", NO_LAUNCHER_MESSAGE));
    const busy = stagingUnderWay();
    if (busy) return refuse(busy);
    if (artefactPath !== undefined && version !== undefined) {
      const source: UpdateSource = context.clientSession.kind === "desktop" ? "desktop" : "request";
      return install({ updateId: randomUUID(), toVersion: version, source }, artefactPath, when);
    }
    return download(version ?? pinnedVersion ?? undefined, when);
  };

  /** Why no other update can be staged now: one is being staged, and they share the staging area. */
  const stagingUnderWay = (): Refusal | undefined =>
    staging === undefined ? undefined : conflict("in_progress", `The update to ${staging.toVersion} is being staged and installed; ask again once it is.`);

  /** Runs `work` as the staging of `update`: shown on `updates.status`, and the only one until it ends. */
  const stagingOf = async <T>(update: Omit<Update, "since">, work: () => Promise<T>): Promise<T> => {
    staging = update;
    try {
      return await work();
    } finally {
      if (staging === update) staging = undefined;
    }
  };

  /** Has the launcher install `version`, unpacked at `staged`: null once installed; else, what it staged removed, why not. */
  const installStaged = async (version: string, staged: string): Promise<Unstaged | null> => {
    const answer = await launcher.request({ type: "install?", version, staged });
    if (answer.type === "installed") return null;
    unstage(options.dataDir, version);
    if (answer.reason === "no-launcher") return { reason: "no_launcher", message: NO_LAUNCHER_MESSAGE };
    return { reason: "install", message: `The launcher refused to install ${version}: ${answer.reason}.`, launcherReason: answer.reason };
  };

  /**
   * Downloads `release`'s artefact into the staging area through the
   * release channel, which checks it against the manifest, unpacks it and
   * has the launcher install it: null once installed, else why not. The
   * download is removed either way.
   */
  const fetchAndInstall = async (release: StageableRelease): Promise<Unstaged | null> => {
    const archive = downloadDestination(options.dataDir, release.version);
    try {
      const fetched = await options.channel.download(release, archive);
      if (fetched !== null) return fetched;
      let staged: string;
      try {
        staged = await stageArtefact({ dataDir: options.dataDir, version: release.version, artefact: archive, unpack });
      } catch (error) {
        if (!(error instanceof StagingError)) throw error;
        return { reason: "artefact", message: error.message };
      }
      return await installStaged(release.version, staged);
    } finally {
      rmSync(archive, { force: true });
    }
  };

  /** Stages the artefact at `artefactPath` for `update` and has the launcher install it; then the command makes it pending. */
  const install = (update: Omit<Update, "since">, artefactPath: string, when: ParamsOf<"updates.apply">["when"]): Promise<MethodHandler<"updates.apply">> =>
    stagingOf(update, async () => {
      const version = update.toVersion;
      let staged: string;
      try {
        staged = await stageArtefact({ dataDir: options.dataDir, version, artefact: artefactPath, unpack });
      } catch (error) {
        if (!(error instanceof StagingError)) throw error;
        if (error.kind === "missing") return refuse({ code: "not_found", message: error.message });
        throw new ContractError(invalidParams([{ code: "custom", path: ["artefactPath"], message: error.message }], error.message));
      }
      const unstaged = await installStaged(version, staged);
      return unstaged === null ? makePending(update, when) : refuse(refusalOf(unstaged));
    });

  /**
   * Stages the release of `version`, or with none the channel's newest, as
   * a request (Update now): read from the channel for the launcher running
   * the environment, downloaded, checked, unpacked and installed; then the
   * command makes it pending, or takes the waiting update when that is the
   * version the channel names.
   */
  const download = async (version: string | undefined, when: ParamsOf<"updates.apply">["when"]): Promise<MethodHandler<"updates.apply">> => {
    const versions = await launcher.request({ type: "versions?" });
    if (versions.type === "refused") return refuse(conflict("no_launcher", NO_LAUNCHER_MESSAGE));
    const release = await options.channel.requested(version, options.settings().channel, versions.launcherProtocol);
    if ("code" in release) return refuse(release);
    // What changed while the channel was read: an update began or is staged, or the newest named is what waits.
    const refused = underWay() ?? stagingUnderWay();
    if (refused) return refuse(refused);
    if (held.state === "waiting" && held.update.toVersion === release.version) return takeWaiting(held.update, when);
    const update = { updateId: randomUUID(), toVersion: release.version, source: "request" } as const;
    const unstaged = await stagingOf(update, () => fetchAndInstall(release));
    return unstaged === null ? makePending(update, when) : refuse(refusalOf(unstaged));
  };

  /**
   * Whether the channel's `version` is staged to replace what is pending:
   * with nothing pending, or in place of a waiting update of another version
   * that the settings called for (the channel's or the pin's) or that is
   * older; never while an update drains or switches.
   */
  const channelReplaces = (version: string): boolean => {
    if (held.state === "current") return true;
    if (held.state !== "waiting" || held.update.toVersion === version) return false;
    const { source, toVersion } = held.update;
    return source === "channel" || source === "pin" || newer(version, toVersion);
  };

  /** The check's staged `update` becomes the pending one: appended, and its wait begun. */
  const pendFromChannel = (staged: Omit<Update, "since">): void => {
    const update = pendingOf(staged);
    log.append(stream, [pendingEvent(update)], { actor: UPDATES_ACTOR });
    held = { state: "waiting", update };
    wait();
  };

  /** What every state with an update shows of it: `deferUntil` read with the cap as it is set now, and no image, which only a container's update has. */
  const pendingParts = (update: Update) => ({
    updateId: update.updateId,
    toVersion: update.toVersion,
    source: update.source,
    since: update.since.toISOString(),
    deferUntil: deferUntil(update).toISOString(),
    image: null,
  });

  /** Withdraws the waiting `update` once `context`'s command commits: nothing is pending after. */
  const withdrawOnCommit = (update: Update, context: CommandContext): void =>
    context.tx.afterCommit(() => {
      if (held.state !== "waiting" || held.update !== update) return;
      held = { state: "current" };
      armCap();
    });

  /** Whether a settings change from `before` to `after` stops calling for the channel's waiting `update`. */
  const settingsWithdraw = (update: Update, before: ChannelSettings, after: ChannelSettings): boolean =>
    !after.autoUpdate || after.channel !== before.channel || (after.pinnedVersion !== null && after.pinnedVersion !== update.toVersion);

  /** Why the update that is pending is past its cap: due to drain at its `deferUntil`, it has not switched by the end of the drain's own cap. */
  const pastCap = (): string | undefined => {
    if (held.state !== "waiting" && held.state !== "draining") return undefined;
    const due = deferUntil(held.update);
    if (clock.now().getTime() <= due.getTime() + DRAIN_CAP_MS) return undefined;
    return `The update to ${held.update.toVersion} was due at ${due.toISOString()} and has not gone through its drain: it is ${held.state}.`;
  };

  return {
    pending() {
      switch (held.state) {
        case "current":
          if (staging) return { state: "staging", ...staging };
          return blocked ? { state: "blocked", ...blocked } : { state: "current" };
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

    settle() {
      settleLatestUpdate({ log, stream, dataDir: options.dataDir, harnessVersion, actor: UPDATES_ACTOR });
      settleInterruptedRuns({ log, host: options.host, environmentName: options.environmentName, harnessVersion, actor: UPDATES_ACTOR });
    },

    handlers: {
      "updates.apply": { prepare: prepareApply },

      "updates.cancel": (_params, context) => {
        if (held.state === "draining" || held.state === "switching") {
          return { aggregate: stream, rejected: conflict("in_progress", `The update to ${held.update.toVersion} is ${held.state} and can no longer be withdrawn.`) };
        }
        if (held.state !== "waiting") return { aggregate: stream, rejected: { code: "not_found", message: "No update is pending." } };
        const { update } = held;
        withdrawOnCommit(update, context);
        return { aggregate: stream, result: { updateId: update.updateId, toVersion: update.toVersion }, events: [cancelledEvent(update, "requested")] };
      },
    },

    async channelContext() {
      const versions = launcher.present() ? await launcher.request({ type: "versions?" }) : undefined;
      return { launcherProtocol: versions?.type === "versions" ? versions.launcherProtocol : null, failedVersions: readUpdateHistory(log).outcomes.failedVersions };
    },

    async follow(reading, settings) {
      blocked = reading.blocked;
      const { stage, target } = reading;
      if (stage === null || target === null || !launcher.present() || staging !== undefined || !channelReplaces(stage.version)) return null;
      const update = { updateId: randomUUID(), toVersion: stage.version, source: target.source };
      const unstaged = await stagingOf(update, () => fetchAndInstall(stage));
      if (unstaged !== null) return { reason: unstaged.reason === "no_launcher" ? "install" : unstaged.reason, message: unstaged.message };
      // The settings changed, or an update began, while it staged: the check the change began follows the settings instead.
      if (!sameTarget(settings, options.settings()) || underWay() !== undefined || !channelReplaces(stage.version)) return null;
      pendFromChannel(update);
      return null;
    },

    settingsChanging(before, after, context) {
      if (held.state !== "waiting" || held.update.source !== "channel" || !settingsWithdraw(held.update, before, after)) return;
      const { update } = held;
      log.append(stream, [cancelledEvent(update, "settings")], { tx: context.tx, actor: context.actor, commandId: context.commandId });
      withdrawOnCommit(update, context);
    },

    machineHolds(newest) {
      const { autoUpdate, pinnedVersion } = options.settings();
      const reasons: string[] = [];
      // A newest no check has read yet is not behind: whether the channel is read is the release channel's check.
      if ((!autoUpdate || pinnedVersion !== null) && newest !== null && newer(newest, harnessVersion)) {
        const off = pinnedVersion === null ? "Auto-update is off" : `Auto-update is off while ${pinnedVersion} is pinned`;
        reasons.push(`${off}, and this machine runs ${harnessVersion}, behind the channel's newest, ${newest}.`);
      }
      const overdue = pastCap();
      if (overdue !== undefined) reasons.push(overdue);
      if (blocked !== null) reasons.push(blocked.message);
      const failed = readUpdateHistory(log).outcomes.failedVersions.filter((version) => newer(version, harnessVersion));
      if (failed.length > 0) reasons.push(`The update to ${failed.join(" and ")} failed, and this machine runs ${harnessVersion}.`);
      return reasons.length === 0 ? true : { reason: reasons.join(" ") };
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
