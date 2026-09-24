import { z } from "zod";
import { errorSchema } from "../errors.js";
import { commandParams, defineMethod } from "../method.js";
import { ContainmentAvailability, ContainmentLevel, SessionModeSetPayload } from "../permissions.js";
import { Mode } from "../permissions-modes.js";
import { PermissionSettingsPatch, PermissionSettingsValues } from "../permissions-settings.js";
import { ListedPrompt, PromptAnsweredPayload, PromptAnswerInput } from "../prompts.js";
import { SessionId } from "../sessions.js";

/**
 * The permissions methods (permissions spec, "Methods on the wire"): a
 * session's mode and the permission settings (#129), the parked prompts and
 * their answer (#130). The ceiling's method, `access.sessions.setCeiling`,
 * is in the `access` family (`methods/access.ts`). The denylist,
 * containment and review methods are #131 to #133's.
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
      .meta({ description: "How many entries each section of the denylist holds (#132 fills it)." }),
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
 * `mode` on plans only; anything else is `invalid_params`. Recorded as
 * `prompt.answered` with the caller as `decidedBy`, and handed to the run
 * once it has committed when the run still waits on it (`live`), or kept for
 * the session's next run, whose first message it becomes (`next-run`), when
 * a restart or a parked stop took the run. An answered prompt is `conflict`
 * with reason `already_answered`; an unknown one `not_found` (kind
 * `prompt`); one the live run no longer holds, `conflict` with reason
 * `prompt_not_open`. The result is the event's payload with the session.
 */
export const permissionsPromptsAnswer = defineMethod({
  name: "permissions.prompts.answer",
  scope: "runs:drive",
  kind: "command",
  params: commandParams({
    promptId: z.string().min(1).meta({ description: "The prompt to answer." }),
    ...PromptAnswerInput.shape,
  }),
  result: z.object({ sessionId: SessionId, ...PromptAnsweredPayload.shape }),
  errors: [],
});
