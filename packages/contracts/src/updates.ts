import { z } from "zod";
import { ProtocolVersion } from "./flags.js";
import { INSTALL_REFUSALS, OUTCOME_STAGES } from "./launcher.js";
import { BusyReason } from "./lifecycle.js";
import { Timestamp } from "./primitives.js";
import { ReleaseImage, ReleaseVersion } from "./release.js";

/**
 * The update vocabulary (launcher-update spec, "The update coordinator" and
 * "Settings, methods, notices and flags"; ADR 0007): the update id, where an
 * update comes from and what moves it, and the notices each of its steps
 * appends to the environment's stream. The settings are `update-settings.ts`,
 * the release manifest `release.ts`, the methods `methods/updates.ts`, and
 * `POST /api/update` `update-route.ts`.
 *
 * Here too is the status document `updates.status` and `updates.check`
 * answer: what runs, who manages its updates, what the channel offers, the
 * pending update and the last outcome.
 */

/**
 * An update's id: a version 4 UUID the environment mints when it takes a
 * target (as staging begins, or as `updates.apply` asks). Every notice of
 * that update names it, as do the launcher's `switch?`, the database
 * snapshot and the outcome record; a newer release that replaces the target
 * gets a new one.
 */
export const UpdateId = z.uuidv4().meta({
  description:
    "An update's id: a version 4 UUID the environment mints when it takes a target, named by each of the update's notices, the launcher's switch, its database snapshot and its outcome record; a newer release replacing the target gets a new one.",
});
export type UpdateId = z.infer<typeof UpdateId>;

/** A version an update goes from or to, as the environment records it: the harness version, never empty. */
const RecordedVersion = z.string().min(1);

/**
 * Where a pending update comes from: its channel's newest release, the pinned
 * version, a request (`updates.apply` or `POST /api/update` by version), or
 * the artefact a desktop handed its local environment.
 */
export const UPDATE_SOURCES = ["channel", "pin", "request", "desktop"] as const;
export const UpdateSource = z.enum(UPDATE_SOURCES).meta({
  description:
    "Where a pending update comes from: channel (the channel's newest release, auto-update being on), pin (the pinned version), request (updates.apply or POST /api/update by version) or desktop (the artefact a desktop handed its local environment).",
});
export type UpdateSource = z.infer<typeof UpdateSource>;

/** What made a pending update drain: the environment was idle, the deferral cap passed, or `updates.apply` asked with `when: now`. */
export const UPDATE_CAUSES = ["idle", "cap", "requested"] as const;
export const UpdateCause = z.enum(UPDATE_CAUSES).meta({
  description:
    "What made a pending update drain: idle (nothing started or ended within the idle window), cap (the deferral cap passed while busy) or requested (updates.apply with when now). Managed outside, the cause that made the update ready is the one updates.begin records.",
});
export type UpdateCause = z.infer<typeof UpdateCause>;

/**
 * Where an update failed: the switch the launcher refused, or the stage of an
 * outcome record, the trial (the startup gate) or the crash-loop watch after
 * the commit.
 */
export const UPDATE_FAILURE_STAGES = ["switch", ...OUTCOME_STAGES] as const;
export const UpdateFailureStage = z.enum(UPDATE_FAILURE_STAGES).meta({
  description:
    "Where an update failed: switch (the launcher refused the switch, or a container's stop never came, and the same version runs on), trial (the new version did not pass its startup gate) or crash-loop (it exited three times within ten minutes of its commit).",
});
export type UpdateFailureStage = z.infer<typeof UpdateFailureStage>;

/** Why a pending update was withdrawn: `updates.cancel`, or the settings no longer call for a channel's update. */
export const UPDATE_CANCEL_CAUSES = ["requested", "settings"] as const;
export const UpdateCancelCause = z.enum(UPDATE_CANCEL_CAUSES).meta({
  description:
    "Why a pending update was withdrawn: requested (updates.cancel) or settings (auto-update was turned off, the channel changed, or a pin names another version, for an update the channel called for).",
});
export type UpdateCancelCause = z.infer<typeof UpdateCancelCause>;

/** `environment.update-pending`: an update is installed and waits for idle, the cap, or a request. */
export const UpdatePendingPayload = z
  .object({
    updateId: UpdateId,
    toVersion: RecordedVersion.meta({ description: "The version the update goes to." }),
    source: UpdateSource,
    since: Timestamp.meta({
      description: "When an update first became pending: kept when a newer release replaces the target, and across restarts, so frequent releases never reset the cap's clock.",
    }),
    deferUntil: Timestamp.meta({ description: "since plus the deferral cap: past it, busy work no longer holds the update." }),
  })
  .meta({ description: "An update is pending: its id, the version it goes to, where it comes from, since when, and when the deferral cap forces it." });
export type UpdatePendingPayload = z.infer<typeof UpdatePendingPayload>;

/** `environment.update-started`: in the tick that read the activity, a pending update began its drain. */
export const UpdateStartedPayload = z
  .object({
    updateId: UpdateId,
    fromVersion: RecordedVersion.meta({ description: "The version running when the update began." }),
    toVersion: RecordedVersion.meta({ description: "The version the update goes to." }),
    cause: UpdateCause,
  })
  .meta({ description: "An update began: the environment drains before the switch; from and to which version, and what made it go." });
export type UpdateStartedPayload = z.infer<typeof UpdateStartedPayload>;

/** `environment.update-failed`: an update did not take, and the version it went from runs. */
export const UpdateFailedPayload = z
  .object({
    updateId: UpdateId,
    fromVersion: RecordedVersion.meta({ description: "The version the update went from, which runs again." }),
    toVersion: RecordedVersion.meta({ description: "The version the update went to, which failed." }),
    stage: UpdateFailureStage,
    reason: z.string().min(1).meta({
      description: "A short code naming the failure: the launcher's refusal of the switch, the outcome record's reason (deadline for a trial that missed its gate), or unknown when no record was left.",
    }),
    rolledBack: z.boolean().meta({ description: "Whether the database snapshot was restored: true after a trial or a crash loop, false after a refused switch, which changed nothing." }),
  })
  .meta({ description: "An update failed and the environment runs the version it went from: at which stage, why, and whether it was rolled back." });
export type UpdateFailedPayload = z.infer<typeof UpdateFailedPayload>;

/** `environment.update-cancelled`: a pending update was withdrawn before it drained. */
export const UpdateCancelledPayload = z
  .object({
    updateId: UpdateId,
    toVersion: RecordedVersion.meta({ description: "The version the withdrawn update went to." }),
    cause: UpdateCancelCause,
  })
  .meta({ description: "A pending update was withdrawn before its drain: which, and why." });
export type UpdateCancelledPayload = z.infer<typeof UpdateCancelledPayload>;

// The status document.

/**
 * Who manages the environment's updates: its launcher (a native service),
 * a host-side updater outside it (a container with no launcher), or nobody
 * (a foreground `serve`), with why.
 */
export const UpdateManager = z
  .discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("launcher"), launcherVersion: RecordedVersion.meta({ description: "The version of the launcher running the environment." }) })
      .meta({ description: "The launcher of a native service manages updates: the environment stages them and the launcher switches." }),
    z
      .object({
        kind: z.literal("outside"),
        lastPoll: Timestamp.nullable().meta({ description: "When the host-side updater last polled updates.status; null before its first poll." }),
      })
      .meta({ description: "A host-side updater outside the container carries out the environment's plan: it pulls, recreates and rolls back." }),
    z
      .object({ kind: z.literal("none"), reason: z.string().min(1).meta({ description: "Why nothing manages updates, for people: serve runs in the foreground, with no launcher." }) })
      .meta({ description: "Nothing can update the environment: no launcher runs it and it is no container." }),
  ])
  .meta({ description: "Who manages the environment's updates: launcher with its version, outside with the host-side updater's last poll, or none with why." });
export type UpdateManager = z.infer<typeof UpdateManager>;

/**
 * Why a check of the channel failed, the staging of its target included:
 * no forge account for the release origin or its token refused, the forge
 * unreachable or failing, the release's manifest missing or not its schema,
 * this platform's artefact not downloaded or not matching its size and
 * SHA-256, or the launcher refusing to install it.
 */
export const UPDATE_CHECK_FAILURES = ["no_release_access", "unreachable", "manifest", "artefact", "install"] as const;
export const UpdateCheckFailure = z.enum(UPDATE_CHECK_FAILURES).meta({
  description:
    "Why a check failed: no_release_access (no forge account for the release origin, or its token was refused), unreachable (the forge did not answer, or failed), manifest (the release's manifest is missing or not its schema), artefact (this platform's artefact did not download, or does not match its size and SHA-256) or install (the launcher refused to install it). A failed check is tried again at the next.",
});
export type UpdateCheckFailure = z.infer<typeof UpdateCheckFailure>;

/** The last check of the channel, its target's staging included: when, and its result. A failure is state, never a notice. */
export const UpdateCheck = z
  .discriminatedUnion("result", [
    z.object({ at: Timestamp, result: z.literal("ok") }).meta({ description: "The check read the channel, and staged its target if it had one." }),
    z
      .object({
        at: Timestamp,
        result: z.literal("failed"),
        reason: UpdateCheckFailure,
        message: z.string().min(1).meta({ description: "What failed, for people." }),
      })
      .meta({ description: "The check failed: why, and what failed." }),
  ])
  .meta({ description: "The last check of the channel: when it ran, and whether it read the channel and staged its target or failed, with why." });
export type UpdateCheck = z.infer<typeof UpdateCheck>;

/**
 * Where the update coordinator is (launcher-update spec, "States"): nothing
 * to do, staging a target, waiting for idle or the cap, ready for the
 * host-side updater (managed outside, where a native environment would
 * drain), draining, switching, or blocked.
 */
export const UPDATE_STATES = ["current", "staging", "waiting", "ready", "draining", "switching", "blocked"] as const;
export const UpdateState = z.enum(UPDATE_STATES).meta({
  description:
    "Where the environment's update is: current (nothing to do), staging (downloading and installing its target), waiting (installed, for idle, the deferral cap or a request), ready (managed outside: for the host-side updater's updates.begin), draining, switching (the launcher is switching versions), or blocked (it cannot go on by itself, for the reason given).",
});
export type UpdateState = z.infer<typeof UpdateState>;

/** Why an update cannot go on by itself: the target needs a newer launcher, and no release the running one hosts leads there. */
export const UPDATE_BLOCKED_REASONS = ["launcher"] as const;
export const UpdateBlockedReason = z.enum(UPDATE_BLOCKED_REASONS).meta({
  description:
    "Why an update cannot go on by itself: launcher (the target needs a newer launcher than the running one and no stepping stone leads there; run service install from the target's release).",
});
export type UpdateBlockedReason = z.infer<typeof UpdateBlockedReason>;

/** What a waiting update waits on: the busy reason, and when it stops counting if nothing else happens. */
export const UpdateWaitsOn = z
  .object({
    reason: BusyReason,
    until: Timestamp.nullable().meta({ description: "When the reason stops counting if nothing else happens; null while a run is starting or running." }),
  })
  .meta({ description: "What a waiting update waits on: the reason the environment is busy, and until when." });
export type UpdateWaitsOn = z.infer<typeof UpdateWaitsOn>;

const pendingPart = {
  updateId: UpdateId,
  toVersion: RecordedVersion.meta({ description: "The version the update goes to." }),
  source: UpdateSource,
  since: Timestamp.meta({ description: "When an update first became pending, kept across a replaced target and restarts." }),
  deferUntil: Timestamp.meta({ description: "since plus the deferral cap: past it, busy work no longer holds the update." }),
  image: ReleaseImage.nullable().meta({ description: "Managed outside, the target's image the host-side updater pulls and checks; null for a native environment." }),
};

/** A state an update holds once it has a target installed or under way: the pending update's parts, and the state's own. */
const pendingState = <const S extends string, const X extends z.core.$ZodLooseShape>(state: S, description: string, shape: X) =>
  z.object({ state: z.literal(state), ...pendingPart, ...shape }).meta({ description });

/** The pending update with its state: which update, its target, and where it is. */
export const PendingUpdate = z
  .discriminatedUnion("state", [
    z.object({ state: z.literal("current") }).meta({ description: "Nothing to do: the environment runs its target, or has none." }),
    z
      .object({ state: z.literal("staging"), updateId: UpdateId, toVersion: RecordedVersion.meta({ description: "The version being staged." }), source: UpdateSource })
      .meta({ description: "The target is being downloaded, checked and installed; staging ignores idle." }),
    pendingState("waiting", "Installed, the update waits for idle, the deferral cap or a request: on what.", {
      waitsOn: UpdateWaitsOn.nullable().meta({ description: "What it waits on; null when nothing holds it and it drains at the next tick." }),
    }),
    pendingState("ready", "Managed outside, the update is ready: it waits for the host-side updater's updates.begin.", {}),
    pendingState("draining", "The environment drains for the update: new runs are refused, running ones are let finish up to the cap.", { cause: UpdateCause }),
    pendingState("switching", "The drain is done and the launcher is switching to the target.", { cause: UpdateCause }),
    z
      .object({ state: z.literal("blocked"), reason: UpdateBlockedReason, toVersion: ReleaseVersion.meta({ description: "The target that cannot be reached: service install from its release unblocks it." }) })
      .meta({ description: "The update cannot go on by itself: why, and its target." }),
  ])
  .meta({ description: "The pending update with its state: current, staging, waiting on what, ready, draining, switching, or blocked with why." });
export type PendingUpdate = z.infer<typeof PendingUpdate>;

const outcomePart = {
  updateId: UpdateId.nullable().meta({ description: "The update; null for one recorded before update ids." }),
  fromVersion: RecordedVersion.meta({ description: "The version the update went from." }),
  toVersion: RecordedVersion.meta({ description: "The version the update went to." }),
  at: Timestamp.meta({ description: "When the outcome was recorded." }),
};

/** How the last update ended: it took, or it failed and the version it went from runs. */
export const UpdateOutcome = z
  .discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("updated"), ...outcomePart }).meta({ description: "The update took: the environment runs its target." }),
    z
      .object({ outcome: z.literal("failed"), ...outcomePart, stage: UpdateFailureStage, reason: UpdateFailedPayload.shape.reason, rolledBack: UpdateFailedPayload.shape.rolledBack })
      .meta({ description: "The update failed: at which stage, why, and whether it was rolled back." }),
  ])
  .meta({ description: "How the last update ended: updated, or failed with its stage, reason and rollback." });
export type UpdateOutcome = z.infer<typeof UpdateOutcome>;

/** What `updates.status` and `updates.check` answer. */
export const UpdatesStatus = z
  .object({
    version: RecordedVersion.meta({ description: "The harness version running." }),
    protocolVersion: ProtocolVersion,
    bundledClaudeCodeVersion: z.string().min(1).nullable().meta({ description: "The version of Claude Code the running version bundles; null when it could not be read." }),
    manager: UpdateManager,
    newest: ReleaseVersion.nullable().meta({ description: "The channel's newest release as the last check that read it found it; null before one did." }),
    lastCheck: UpdateCheck.nullable().meta({ description: "The last check of the channel; null before the first." }),
    pending: PendingUpdate,
    lastOutcome: UpdateOutcome.nullable().meta({ description: "How the last update ended; null before any." }),
    failedVersions: z.array(RecordedVersion).meta({ description: "Versions whose update failed: never taken again automatically, though updates.apply may retry one." }),
    installed: z.array(RecordedVersion).meta({ description: "The versions installed, as the launcher lists them; empty with no launcher." }),
  })
  .meta({
    description:
      "The environment's updates: what runs, who manages its updates, the channel's newest and the last check, the pending update with its state, the last outcome, the versions that failed and those installed.",
  });
export type UpdatesStatus = z.infer<typeof UpdatesStatus>;

/** When `updates.apply` lets its update go: once the environment is idle (Update now), or at once (Drain and update now). */
export const UPDATE_WHENS = ["idle", "now"] as const;
export const UpdateWhen = z.enum(UPDATE_WHENS).meta({
  description: "When an asked-for update drains: idle (under the idle rules and the deferral cap, as Update now and a newer client's offer do) or now (at once, cutting running runs at the drain's cap).",
});
export type UpdateWhen = z.infer<typeof UpdateWhen>;

/**
 * Why an update is refused in `conflict` (its `data.reason`): the environment
 * is pinned to another version, already runs this one, the version's
 * database schema is below the database's, it needs a newer launcher than
 * the running one hosts, an update is draining or switching, the
 * environment cannot read the releases, the launcher refused to install the
 * version (`data.launcherReason` says why), or no launcher runs the
 * environment to switch it (#343).
 */
export const UPDATE_CONFLICT_REASONS = ["pinned", "current", "schema", "launcher", "in_progress", "no_release_access", "install", "no_launcher"] as const;
export const UpdateConflictReason = z.enum(UPDATE_CONFLICT_REASONS).meta({
  description:
    "Why an update was refused in conflict: pinned (another version is pinned), current (that version runs already), schema (its database schema is below the database's), launcher (it needs a newer launcher, with no stepping stone), in_progress (an update is draining or switching), no_release_access (no forge account can read the releases), install (the launcher refused to install the version: data.launcherReason says why) or no_launcher (no launcher runs the environment to switch its version: a foreground serve, or a container whose update no host-side updater takes).",
});
export type UpdateConflictReason = z.infer<typeof UpdateConflictReason>;

/** The launcher's reason for refusing the install of an update's version, carried as `data.launcherReason` beside the conflict reason `install`. */
export const UpdateInstallRefusal = z.enum(INSTALL_REFUSALS).meta({
  description:
    "Why the launcher refused to install the version: launcher-protocol (it needs a newer launcher protocol), incomplete (the unpacked artefact is not a whole version), preflight (its preflight failed or timed out), disk (too little free disk) or io (a write failed).",
});
export type UpdateInstallRefusal = z.infer<typeof UpdateInstallRefusal>;
