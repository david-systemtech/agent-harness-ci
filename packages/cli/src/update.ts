import { randomUUID } from "node:crypto";
import { resolve as absolutePath } from "node:path";
import {
  DEFERRAL_CAP_HOURS,
  IDLE_WINDOW_MINUTES,
  PRODUCT_NAME,
  ReleaseVersion,
  UPDATE_SETTINGS,
  type PendingUpdate,
  type UpdateCheck,
  type UpdateManager,
  type UpdateOutcome,
  type UpdateSettingsKey,
  type UpdateSettingsPatch,
  type UpdateSettingsValues,
  type UpdatesStatus,
} from "@agent-harness/contracts";
import { defaultDataDirectory } from "@agent-harness/environment";
import { parseOptions, parsePort, UsageError } from "./args.js";
import { LocalFailure, withLocalSession, type LocalTarget, type Net } from "./local-session.js";

/**
 * The `update` verbs that reach the environment on this machine
 * (launcher-update spec, "Settings, methods, notices and flags": CLI verbs):
 * `update status`, the `updates.status` document as text or JSON;
 * `update apply`, an update asked for through `updates.apply` (#343: a
 * version and the path of its artefact on this machine, or the update that
 * waits, when idle or at once with `--now`); and `update settings`, the five
 * update settings written from flags through `updates.settings.set`. Each
 * exchanges the bootstrap grant for a local client session and revokes it
 * after (`local-session.ts`), as `pair` does.
 */

export const UPDATE_USAGE = [
  `${PRODUCT_NAME} update status [--json] [--data-dir <path>] [--port <n>]`,
  `${PRODUCT_NAME} update apply [--version <version> [--path <artefact>]] [--now] [--data-dir <path>] [--port <n>]`,
  `${PRODUCT_NAME} update settings [--auto-update <on|off>] [--channel <stable|beta>] [--pinned-version <version|none>] [--idle-window-minutes <n>] [--deferral-cap-hours <n>] [--data-dir <path>] [--port <n>]`,
] as const;

export interface UpdateContext {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly net: Net;
}

/** Where the environment is: the flags every `update` verb takes. */
const TARGET_OPTIONS = { "data-dir": { type: "string" }, port: { type: "string" } } as const;

const targetOf = (values: { readonly "data-dir"?: string | undefined; readonly port?: string | undefined }): LocalTarget => ({
  dataDir: values["data-dir"] ?? defaultDataDirectory(),
  port: parsePort(values.port, 1),
});

/** A whole number as a flag gives it, or undefined for anything else. */
const wholeNumber = (text: string): number | undefined => (/^\d+$/.test(text) ? Number(text) : undefined);

/** The flag that sets each update setting: how its text reads as the key's value, checked against the key's schema after, and what it takes, for the usage error. */
const SETTING_FLAGS = {
  "auto-update": { key: "updates.autoUpdate", read: (text: string) => (text === "on" ? true : text === "off" ? false : undefined), takes: "on or off" },
  channel: { key: "updates.channel", read: (text: string) => text, takes: "stable or beta" },
  "pinned-version": { key: "updates.pinnedVersion", read: (text: string) => (text === "none" ? null : text), takes: "a release version without its v, such as 0.4.2, or none" },
  "idle-window-minutes": {
    key: "updates.idleWindowMinutes",
    read: wholeNumber,
    takes: `whole minutes from ${IDLE_WINDOW_MINUTES.min} to ${IDLE_WINDOW_MINUTES.max}`,
  },
  "deferral-cap-hours": {
    key: "updates.deferralCapHours",
    read: wholeNumber,
    takes: `whole hours from ${DEFERRAL_CAP_HOURS.min} to ${DEFERRAL_CAP_HOURS.max}`,
  },
} as const satisfies Record<string, { readonly key: UpdateSettingsKey; readonly read: (text: string) => unknown; readonly takes: string }>;

type SettingFlag = keyof typeof SETTING_FLAGS;
const SETTING_FLAG_NAMES = Object.keys(SETTING_FLAGS) as SettingFlag[];

/** The setting flags as the option parser takes them: each a string, read against its key after. */
const SETTING_OPTIONS = Object.fromEntries(SETTING_FLAG_NAMES.map((flag) => [flag, { type: "string" }])) as { readonly [F in SettingFlag]: { readonly type: "string" } };

/** The update settings the flags name, each checked against its key's schema; a usage error for a value its key does not take, or for no flag at all. */
const settingsPatch = (values: Partial<Record<SettingFlag, string>>): UpdateSettingsPatch => {
  const patch: Record<string, unknown> = {};
  for (const flag of SETTING_FLAG_NAMES) {
    const text = values[flag];
    if (text === undefined) continue;
    const { key, read, takes } = SETTING_FLAGS[flag];
    const parsed = UPDATE_SETTINGS[key].schema.safeParse(read(text));
    if (!parsed.success) throw new UsageError(`--${flag} takes ${takes}; got ${text === "" ? "nothing" : text}.`);
    patch[key] = parsed.data;
  }
  if (Object.keys(patch).length === 0) throw new UsageError(`update settings takes at least one of ${SETTING_FLAG_NAMES.map((flag) => `--${flag}`).join(", ")}.`);
  return patch as UpdateSettingsPatch;
};

/** The update settings, one line each, as `update settings` prints them. */
export const renderUpdateSettings = (values: UpdateSettingsValues): string =>
  [
    `Auto-update: ${values["updates.autoUpdate"] ? "on" : "off"}`,
    `Channel: ${values["updates.channel"]}`,
    `Pinned version: ${values["updates.pinnedVersion"] ?? "none"}`,
    `Idle window: ${values["updates.idleWindowMinutes"]} minutes`,
    `Deferral cap: ${values["updates.deferralCapHours"]} hours`,
    "",
  ].join("\n");

const managerLine = (manager: UpdateManager): string => {
  switch (manager.kind) {
    case "launcher":
      return `managed by its launcher, version ${manager.launcherVersion}`;
    case "outside":
      return `managed outside, by a host-side updater; ${manager.lastPoll === null ? "it has not polled yet" : `last polled at ${manager.lastPoll}`}`;
    case "none":
      return `not managed: ${manager.reason}`;
  }
};

const checkLine = (check: UpdateCheck | null): string => {
  if (check === null) return "never";
  return check.result === "ok" ? `${check.at}, ok` : `${check.at}, failed (${check.reason}): ${check.message}`;
};

const pendingLine = (pending: PendingUpdate): string => {
  switch (pending.state) {
    case "current":
      return "none";
    case "staging":
      return `${pending.toVersion} (${pending.source}), staging`;
    case "blocked":
      return `${pending.toVersion}, blocked (${pending.reason})`;
    case "waiting": {
      const on = pending.waitsOn === null ? "" : `; busy: ${pending.waitsOn.reason}${pending.waitsOn.until === null ? "" : ` until ${pending.waitsOn.until}`}`;
      return `${pending.toVersion} (${pending.source}), waiting since ${pending.since}, forced at ${pending.deferUntil}${on}`;
    }
    case "ready":
      return `${pending.toVersion} (${pending.source}), ready for the host-side updater since ${pending.since}`;
    case "draining":
    case "switching":
      return `${pending.toVersion} (${pending.source}), ${pending.state} (${pending.cause})`;
  }
};

const outcomeLine = (outcome: UpdateOutcome | null): string => {
  if (outcome === null) return "none";
  const move = `${outcome.fromVersion} to ${outcome.toVersion}`;
  if (outcome.outcome === "updated") return `${move}, updated at ${outcome.at}`;
  return `${move}, failed at ${outcome.at} (${outcome.stage}: ${outcome.reason})${outcome.rolledBack ? ", rolled back" : ""}`;
};

/** The `updates.status` document, one line per part, as `update status` prints it; a list that is empty is left out. */
export const renderUpdatesStatus = (status: UpdatesStatus): string =>
  [
    `Version: ${PRODUCT_NAME} ${status.version}, protocol ${status.protocolVersion}`,
    `Claude Code (bundled): ${status.bundledClaudeCodeVersion ?? "unknown"}`,
    `Updates: ${managerLine(status.manager)}`,
    ...(status.installed.length > 0 ? [`Installed: ${status.installed.join(", ")}`] : []),
    `Channel's newest: ${status.newest ?? "not read yet"}`,
    `Last check: ${checkLine(status.lastCheck)}`,
    `Pending update: ${pendingLine(status.pending)}`,
    `Last update: ${outcomeLine(status.lastOutcome)}`,
    ...(status.failedVersions.length > 0 ? [`Failed versions: ${status.failedVersions.join(", ")}`] : []),
    "",
  ].join("\n");

/** `update status`: the document as text, or as JSON with `--json`. */
const status = async (args: readonly string[], context: UpdateContext): Promise<number> => {
  const values = parseOptions(args, { ...TARGET_OPTIONS, json: { type: "boolean" } });
  const document = await withLocalSession(targetOf(values), context.net, `${PRODUCT_NAME} update status`, (call) => call("updates.status", {}));
  context.stdout(values.json ? `${JSON.stringify(document, null, 2)}\n` : renderUpdatesStatus(document));
  return 0;
};

/** `update settings`: the settings its flags name, through `updates.settings.set`; prints all five after. */
const settings = async (args: readonly string[], context: UpdateContext): Promise<number> => {
  const values = parseOptions(args, { ...TARGET_OPTIONS, ...SETTING_OPTIONS });
  const patch = settingsPatch(values);
  const answer = await withLocalSession(targetOf(values), context.net, `${PRODUCT_NAME} update settings`, (call) =>
    call("updates.settings.set", { commandId: randomUUID(), values: patch }),
  );
  if (answer.receipt.status === "rejected") throw new LocalFailure(`The environment refused the update settings: ${answer.receipt.error.message}`);
  // A fresh command id always carries the result.
  if (answer.result === undefined) throw new LocalFailure("The environment answered the update settings without their values.");
  context.stdout(renderUpdateSettings(answer.result.values));
  return 0;
};

/**
 * `update apply`: asks for the update to `--version` from the artefact at
 * `--path`, a path of this machine read from the working directory, or for
 * the update that waits when neither is given; when the environment is
 * idle, or at once with `--now`. Says which update it took, and when it goes.
 */
const apply = async (args: readonly string[], context: UpdateContext): Promise<number> => {
  const values = parseOptions(args, { ...TARGET_OPTIONS, version: { type: "string" }, path: { type: "string" }, now: { type: "boolean" } });
  const version = values.version === undefined ? undefined : ReleaseVersion.safeParse(values.version);
  if (version !== undefined && !version.success) throw new UsageError(`--version takes a release version without its v, such as 0.4.2; got ${values.version || "nothing"}.`);
  if (values.path !== undefined && version === undefined) throw new UsageError("--path takes the version its artefact holds: give --version too.");
  const when = values.now ? "now" : "idle";
  const answer = await withLocalSession(targetOf(values), context.net, `${PRODUCT_NAME} update apply`, (call) =>
    call("updates.apply", {
      commandId: randomUUID(),
      ...(version !== undefined && { version: version.data }),
      ...(values.path !== undefined && { artefactPath: absolutePath(values.path) }),
      when,
    }),
  );
  if (answer.receipt.status === "rejected") throw new LocalFailure(`The environment refused the update: ${answer.receipt.error.message}`);
  // A fresh command id always carries the result.
  if (answer.result === undefined) throw new LocalFailure("The environment answered the update without saying which it took.");
  const { updateId, toVersion } = answer.result;
  context.stdout(
    when === "now"
      ? `Updating to ${toVersion} (update ${updateId}) now: the environment is draining.\n`
      : `Updating to ${toVersion} (update ${updateId}) once the environment is idle, or at its deferral cap; update status says what it waits on.\n`,
  );
  return 0;
};

/** The `update` verbs by name. */
const VERBS: Readonly<Record<string, (args: readonly string[], context: UpdateContext) => Promise<number>>> = { status, apply, settings };

/**
 * `update`: runs the verb `args` name. Exits 0 once done, 1 with a plain
 * sentence when no environment answers or it refuses, and 2 (the CLI's usage
 * error) on arguments it cannot parse.
 */
export const update = async (args: readonly string[], context: UpdateContext): Promise<number> => {
  const [verb, ...rest] = args;
  const run = verb === undefined || !Object.hasOwn(VERBS, verb) ? undefined : VERBS[verb];
  if (run === undefined) throw new UsageError(verb === undefined ? "update takes a verb: status, apply or settings." : `Unknown update verb ${verb}.`);
  try {
    return await run(rest, context);
  } catch (error) {
    if (!(error instanceof LocalFailure)) throw error;
    context.stderr(`${error.message}\n`);
    return 1;
  }
};
