import { z } from "zod";
import { commandParams, defineMethod } from "../method.js";
import { AssetFormat, ReleasePlatform, ReleaseVersion, Sha256 } from "../release.js";
import { UpdateSettingsPatch, UpdateSettingsValues } from "../update-settings.js";
import { UpdateId, UpdatesStatus, UpdateWhen } from "../updates.js";

/**
 * The `updates.*` methods (launcher-update spec, "Settings, methods, notices
 * and flags"; ADR 0007), one scope each. Registered here with their shapes;
 * each handler is the launcher ticket's that builds it (`OWED_HANDLERS`).
 * Their refusals are the shared errors: `not_found`, `conflict` with a
 * `data.reason` (`UPDATE_CONFLICT_REASONS` for an update asked for), and
 * `forbidden` with `data.reason` `local` for what only a local client
 * session may ask.
 */

/** An update taken: its id, and the version it goes to. */
const UpdateTaken = z
  .object({ updateId: UpdateId, toVersion: z.string().min(1).meta({ description: "The target: the version the update goes to." }) })
  .meta({ description: "An update: its id, and the version it goes to." });

/**
 * What runs, who manages its updates, what the channel offers, the pending
 * update and the last outcome. With `hostUpdater: true` the call is the
 * host-side updater's poll, which the environment remembers as the manager's
 * `lastPoll`.
 */
export const updatesStatus = defineMethod({
  name: "updates.status",
  scope: "read",
  kind: "query",
  params: z.object({
    hostUpdater: z.literal(true).optional().meta({ description: "True from the host-side updater: the call is its poll, remembered as the manager's lastPoll." }),
  }),
  result: UpdatesStatus,
  errors: [],
});

/**
 * A check of the channel now, then the status. At most one a minute: a
 * repeat within a minute of the last check's start, whatever started it,
 * answers that check's result without reading the forge.
 */
export const updatesCheck = defineMethod({
  name: "updates.check",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: UpdatesStatus,
  errors: [],
});

/**
 * Update to `version` (the channel's newest, or the pin, when absent), from
 * the artefact at `artefactPath` when given (a local client session's only:
 * `forbidden` with reason `local` from any other; the environment preflights
 * it and downloads nothing), when idle or now. Answered with the update id
 * and its target. `not_found` when there is no such release or no artefact
 * for this platform; `conflict` with a reason of `UPDATE_CONFLICT_REASONS`.
 * Managed outside, it makes a pending update for the host-side updater.
 */
export const updatesApply = defineMethod({
  name: "updates.apply",
  scope: "admin",
  kind: "command",
  params: commandParams({
    version: ReleaseVersion.optional().meta({ description: "The version to update to; absent, the channel's newest, or the pinned version." }),
    artefactPath: z.string().min(1).optional().meta({
      description: "The path of an artefact of that version on the environment's machine, from a local client session only: the desktop's bundled one, or update apply's.",
    }),
    when: UpdateWhen,
  }),
  result: UpdateTaken,
  errors: [],
});

/**
 * Withdraw the pending update, appending `environment.update-cancelled`:
 * answered with the update withdrawn. `not_found` when none is pending;
 * `conflict` with reason `in_progress` once its drain has begun.
 */
export const updatesCancel = defineMethod({
  name: "updates.cancel",
  scope: "admin",
  kind: "command",
  params: commandParams({}),
  result: UpdateTaken,
  errors: [],
});

/**
 * Set some update settings, appending `settings.updated`: the one way to
 * write them (the generic `settings.update` refuses them). A value out of
 * its range is `invalid_params`; a pin with no such release or no artefact
 * for this platform is `not_found`, and one whose database schema is below
 * the database's `conflict` with reason `schema`; a pin whose release cannot
 * be read is `conflict` with the check's reason (`no_release_access`,
 * `unreachable`, `manifest`). Answered with all five.
 */
export const updatesSettingsSet = defineMethod({
  name: "updates.settings.set",
  scope: "admin",
  kind: "command",
  params: commandParams({ values: UpdateSettingsPatch }),
  result: z.object({ values: UpdateSettingsValues }),
  errors: [],
});

/**
 * The host-side updater begins the ready update it pulled the image of,
 * named by its id: the environment appends `environment.update-started` and
 * drains, and the drain ends at the updater's stop (#348). `conflict` with
 * reason `not_outside` under a launcher or outside a container, `in_progress`
 * when that update drains already, and `not_ready` when it is not the ready
 * one; `unavailable` while the environment drains for something else.
 */
export const updatesBegin = defineMethod({
  name: "updates.begin",
  scope: "admin",
  kind: "command",
  params: commandParams({ updateId: UpdateId.meta({ description: "The ready update whose image the host-side updater pulled." }) }),
  result: UpdateTaken,
  errors: [],
});

/**
 * The local environment resolves the desktop build for the platform and
 * format the desktop's shell reports, from the release it targets (its pin,
 * else its channel's newest), downloads and verifies it into its data
 * directory, and answers where it is; a build already staged there is
 * answered without a download (#354). `forbidden` with reason `local` to any
 * but a local client session; `not_found` with no release, or no such build
 * in it; `conflict` with the reason the release could not be read
 * (`no_release_access`, `unreachable`, `manifest`) or the build downloaded
 * (`no_release_access`, `artefact`).
 */
export const updatesDesktopStage = defineMethod({
  name: "updates.desktop.stage",
  scope: "admin",
  kind: "query",
  params: z.object({
    platform: ReleasePlatform,
    format: AssetFormat.meta({ description: "The format the desktop's shell installs: zip, nsis or pacman." }),
  }),
  result: z
    .object({
      path: z.string().min(1).meta({ description: "Where the verified build is, in the environment's data directory." }),
      version: ReleaseVersion,
      sha256: Sha256,
    })
    .meta({ description: "The staged desktop build: its path, version and SHA-256." }),
  errors: [],
});
