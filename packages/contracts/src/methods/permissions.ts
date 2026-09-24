import { z } from "zod";
import { RunId } from "../adapter.js";
import { errorSchema } from "../errors.js";
import { commandParams, defineMethod } from "../method.js";
import { ContainmentAvailability, ContainmentLevel, ModeResolution } from "../permissions.js";
import { Mode } from "../permissions-modes.js";
import { PermissionSettingsPatch, PermissionSettingsValues } from "../permissions-settings.js";
import { SessionId } from "../sessions.js";

/**
 * The permissions methods of #129 (permissions spec, "Methods on the
 * wire"): a session's mode, and the permission settings. The ceiling's
 * method, `access.sessions.setCeiling`, is in the `access` family
 * (`methods/access.ts`). The denylist, prompts, containment and review
 * methods are #130 to #133's.
 */

/**
 * Set a session's mode: clamped to the caller's ceiling and to the modes the
 * session's account has, never refused for being above them. The session's
 * next runs start in the effective mode; a live run gets it at once when its
 * adapter can change a running run's mode (`modeChange`), clamped to that
 * run's own ceiling too.
 */
export const permissionsModeSet = defineMethod({
  name: "permissions.mode.set",
  scope: "runs:drive",
  kind: "command",
  params: commandParams({ sessionId: SessionId, mode: Mode }),
  result: z.object({
    sessionId: SessionId,
    mode: ModeResolution.extend({ requested: Mode }).meta({ description: "The mode asked for, the one the session got, the caller's ceiling, and the clamp." }),
    live: z
      .object({
        runId: RunId,
        mode: Mode.meta({ description: "The mode the live run was changed to: the effective mode, clamped to the run's own ceiling." }),
      })
      .nullable()
      .meta({ description: "The live run the mode was applied to at once; null when none was live or its adapter cannot, so it applies at the next run." }),
  }),
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
