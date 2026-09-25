import { z } from "zod";
import { Denylist, DenylistEntry, DenylistInput, DenylistMatch, DenylistSection, DenylistTestKind } from "../denylist.js";
import { errorSchema } from "../errors.js";
import { commandParams, defineMethod } from "../method.js";
import { ContainmentAvailability, ContainmentLevel, ReviewRun, SessionModeSetPayload } from "../permissions.js";
import { Mode } from "../permissions-modes.js";
import { PermissionSettingsPatch, PermissionSettingsValues } from "../permissions-settings.js";
import { ListedPrompt, PromptAnsweredPayload, PromptAnswerInput } from "../prompts.js";
import { Sequence } from "../primitives.js";
import { SessionId } from "../sessions.js";

/**
 * The permissions methods (permissions spec, "Methods on the wire"): a
 * session's mode and the permission settings (#129), the parked prompts and
 * their answer (#130), the Unattended review (#131). The ceiling's method,
 * `access.sessions.setCeiling`, is in the `access` family
 * (`methods/access.ts`). The denylist (#132): its get, set, restorePresets
 * and test. Containment's methods are #133's.
 */

/**
 * Set a session's mode: clamped to the caller's ceiling and to the modes the
 * session's account has; a mode above them is lowered, not refused. Only
 * when no mode at or below the ceiling is available is it rejected
 * `conflict` with reason `mode_unavailable`. The session's next runs ask for
 * the effective mode, recorded as `session.mode.set`; the mode the session
 * has already appends nothing (the receipt says `changed: false`). A live
 * run gets it at once when its adapter can change a running run's mode
 * (`modeChange`), clamped to that run's own ceiling too, whether or not the
 * session's mode changed. The result is the event's payload with the session.
 */
export const permissionsModeSet = defineMethod({
  name: "permissions.mode.set",
  scope: "runs:drive",
  kind: "command",
  params: commandParams({ sessionId: SessionId, mode: Mode }),
  result: z.object({ sessionId: SessionId, ...SessionModeSetPayload.shape }),
  errors: [],
});

/** The permission settings' values, and what the environment can enforce. */
export const permissionsSettingsGet = defineMethod({
  name: "permissions.settings.get",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: z.object({
    values: PermissionSettingsValues,
    containment: z
      .object({ levels: z.array(ContainmentAvailability) })
      .meta({ description: "Each containment level and whether this environment can enforce it, with the reason when it cannot (#133 probes it)." }),
    isRoot: z.boolean().meta({ description: "Whether the environment runs as root: always false, since it refuses to (ADR 0006); present so an exception would be loud." }),
    denylist: z
      .object({
        browserDomains: z.int().nonnegative(),
        paths: z.int().nonnegative(),
        commandPatterns: z.int().nonnegative(),
        hosts: z.int().nonnegative(),
      })
      .meta({ description: "How many entries each section of the denylist holds, enabled or not." }),
  }),
  errors: [],
});

/** A containment level this environment cannot enforce was chosen as the default. */
export const ContainmentUnavailableError = errorSchema(
  "containment_unavailable",
  z.object({
    level: ContainmentLevel,
    reason: z.string().min(1).meta({ description: "Why the level cannot be enforced here." }),
  }),
).meta({ description: "The containment level cannot be enforced on this environment; data says which and why." });
export type ContainmentUnavailableError = z.infer<typeof ContainmentUnavailableError>;

/**
 * Set any subset of the permission settings. The first time the unattended
 * mode is set to `bypassPermissions`, `acknowledgeBypass: true` must come
 * with it, or the request is `invalid_params`; the environment then records
 * the acknowledgement's time and `bypass.acknowledged`. A value a key holds
 * already changes nothing. Answered with every value after it.
 */
export const permissionsSettingsSet = defineMethod({
  name: "permissions.settings.set",
  scope: "admin",
  kind: "command",
  params: commandParams({
    values: PermissionSettingsPatch,
    acknowledgeBypass: z.literal(true).optional().meta({
      description: "The bypass sentence was shown and accepted: required with the first setting of the unattended mode to bypassPermissions.",
    }),
  }),
  result: z.object({ values: PermissionSettingsValues }),
  errors: [ContainmentUnavailableError],
});

/**
 * Every parked prompt of the environment, or of one session: opened and not
 * yet answered, oldest first, a deleted session's left out. After a restart
 * the prompts parked before it are listed where they were (ADR 0007). A
 * session named that is not on the environment, or is deleted, is
 * `not_found` (kind `session`), as every query naming a session is.
 */
export const permissionsPromptsList = defineMethod({
  name: "permissions.prompts.list",
  scope: "read",
  kind: "query",
  params: z.object({
    sessionId: SessionId.optional().meta({ description: "One session's parked prompts; every session's when absent." }),
  }),
  result: z.object({ prompts: z.array(ListedPrompt).meta({ description: "The parked prompts, oldest first." }) }),
  errors: [],
});

/**
 * Answers a parked prompt, from any client session with `runs:drive`: its
 * own ceiling does not bound the answer (an environment belongs to one
 * person, ADR 0001). A plan's mode to continue in is clamped to the ceiling
 * of the run that asked (acceptEdits when absent); `remember` is taken on
 * `permission` prompts only, with an allow; `answers` on questions only;
 * `updatedInput` on `permission` prompts only; `mode` on approved plans
 * only; anything else is `invalid_params`. Recorded as
 * `prompt.answered` with the caller as `decidedBy`, and handed to the run
 * once it has committed when the run still waits on it (`live`), or kept for
 * the session's next run, whose first message it becomes (`next-run`), when
 * a restart or a parked stop took the run. An answered prompt is `conflict`
 * with reason `already_answered`; an unknown one `not_found` (kind
 * `prompt`); one the live run no longer holds, `conflict` with reason
 * `prompt_not_open`. A prompt's id is the adapter's, unique within its
 * session: an id parked in more than one session is `conflict` with reason
 * `ambiguous_prompt` (and the sessions) unless `sessionId` names one. The
 * result is the event's payload with the session.
 */
export const permissionsPromptsAnswer = defineMethod({
  name: "permissions.prompts.answer",
  scope: "runs:drive",
  kind: "command",
  params: commandParams({
    promptId: z.string().min(1).meta({ description: "The prompt to answer." }),
    sessionId: SessionId.optional().meta({
      description: "The session the prompt is in: needed only when its id is parked in more than one session (conflict ambiguous_prompt).",
    }),
    ...PromptAnswerInput.shape,
  }),
  result: z.object({ sessionId: SessionId, ...PromptAnsweredPayload.shape }),
  errors: [],
});

/**
 * The Unattended review (permissions spec, "The Unattended review view"):
 * the runs that qualify, newest first, whose latest tool decision is after
 * the environment-wide watermark. A run qualifies when it was unattended and
 * made a tool call, or was attended and had a call decided by the TTL, the
 * denylist or containment (a chosen default, so a person's own bypass runs do
 * not flood it). A deleted session's runs are left out. `head` is the log's
 * position as read: what `permissions.review.seen` takes to mark exactly
 * what was listed as seen. At most `limit` runs (preset 200), the newest.
 */
export const REVIEW_LIST_LIMIT = 200;

/** The most runs one review list may ask for. */
export const REVIEW_LIST_MAX = 1000;

export const permissionsReviewList = defineMethod({
  name: "permissions.review.list",
  scope: "read",
  kind: "query",
  params: z.object({
    limit: z
      .int()
      .min(1)
      .max(REVIEW_LIST_MAX)
      .optional()
      .meta({ description: `The most runs to list, the newest; ${REVIEW_LIST_LIMIT} when absent.` }),
  }),
  result: z.object({
    watermark: Sequence.meta({ description: "The position the review has been seen through; 0 when it never has." }),
    head: Sequence.meta({ description: "The log's position when the list was read." }),
    runs: z.array(ReviewRun).meta({ description: "The qualifying runs since the watermark, newest first." }),
  }),
  errors: [],
});

/**
 * Marks the Unattended review seen through a log position (the head when
 * none is named), moving the environment-wide watermark, recorded as
 * `review.seen` on the settings stream: a later list leaves out the runs
 * with nothing decided after it. It never moves back: a position at or
 * below the watermark changes nothing. A position past the log's head is
 * `invalid_params`. Clients hold no state (ADR 0003).
 */
export const permissionsReviewSeen = defineMethod({
  name: "permissions.review.seen",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({
    through: Sequence.optional().meta({ description: "The position to mark seen through: a list's head. The log's head when absent." }),
  }),
  result: z.object({ watermark: Sequence.meta({ description: "The watermark after the command." }) }),
  errors: [],
});

/** The denylist as the environment holds it: its four sections, presets and a person's entries, enabled and disabled. */
export const permissionsDenylistGet = defineMethod({
  name: "permissions.denylist.get",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: z.object({ denylist: Denylist }),
  errors: [],
});

/**
 * Replaces one section of the denylist, or several, or all four, with the
 * entries given, in their order: an entry with an id the section holds is
 * that entry, edited or not; one with a preset's id is that preset, put
 * back or edited; any other is new, its id minted when it has none. Two
 * entries of a section under one id, or a call naming no section, are
 * `invalid_params`. Each section that changed is one `denylist.changed` on
 * the access stream (added, removed, edited, and the section after); a
 * section given as it is changes nothing. Answered with the whole denylist
 * after. A tool call is gated by the denylist as it is when the call is made.
 */
export const permissionsDenylistSet = defineMethod({
  name: "permissions.denylist.set",
  scope: "admin",
  kind: "command",
  params: commandParams({ sections: DenylistInput }),
  result: z.object({ denylist: Denylist }),
  errors: [],
});

/**
 * Re-adds every preset the denylist no longer holds, by its id, at the end
 * of its section, enabled: a preset that was edited or disabled is left as
 * it is. Each section that changed is one `denylist.changed`. Answered with
 * the presets restored and the whole denylist after.
 */
export const permissionsDenylistRestorePresets = defineMethod({
  name: "permissions.denylist.restorePresets",
  scope: "admin",
  kind: "command",
  params: commandParams({}),
  result: z.object({
    restored: z.array(z.object({ section: DenylistSection, entry: DenylistEntry })).meta({
      description: "The presets put back, by section, in the order they were added.",
    }),
    denylist: Denylist,
  }),
  errors: [],
});

/**
 * Previews a match: a kind and a value in, every enabled entry it matches
 * out, in section order, with the pure matcher the tool gate rules with,
 * on this environment's file system (its home directory for `~` and for a
 * relative path, its symbolic links followed). No match is an empty list.
 */
export const permissionsDenylistTest = defineMethod({
  name: "permissions.denylist.test",
  scope: "read",
  kind: "query",
  params: z.object({
    kind: DenylistTestKind,
    value: z.string().min(1).max(8_192).meta({ description: "The address, path, command line or host to test." }),
  }),
  result: z.object({ matches: z.array(DenylistMatch).meta({ description: "Every enabled entry the value matches, in section order; empty for none." }) }),
  errors: [],
});
