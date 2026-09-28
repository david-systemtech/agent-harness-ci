import { z } from "zod";
import { OUTCOME_STAGES } from "./launcher.js";
import { Timestamp } from "./primitives.js";

/**
 * The update vocabulary (launcher-update spec, "The update coordinator" and
 * "Settings, methods, notices and flags"; ADR 0007): the update id, where an
 * update comes from and what moves it, and the notices each of its steps
 * appends to the environment's stream. The settings are `update-settings.ts`,
 * the release manifest `release.ts`, the methods `methods/updates.ts`, and
 * `POST /api/update` `update-route.ts`.
 */

/**
 * An update's id: a version 4 UUID the environment mints when an update
 * becomes pending. Every notice of that update names it, as do the
 * launcher's `switch?`, the database snapshot and the outcome record; a newer
 * release that replaces the target gets a new one.
 */
export const UpdateId = z.uuidv4().meta({
  description:
    "An update's id: a version 4 UUID the environment mints when the update becomes pending, named by each of its notices, the launcher's switch, its database snapshot and its outcome record.",
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
