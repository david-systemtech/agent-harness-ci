import { randomUUID } from "node:crypto";
import { resolve as absolutePath } from "node:path";
import {
  DEFERRAL_CAP_HOURS,
  IDLE_WINDOW_MINUTES,
  PRODUCT_NAME,
  ReleaseVersion,
  UPDATE_SETTINGS,
  UpdateId,
  pastTimeWords,
  type ForgeAccountRecord,
  type PendingUpdate,
  type UpdateCheck,
  type UpdateManager,
  type UpdateOutcome,
  type UpdateSettingsKey,
  type UpdateSettingsPatch,
  type UpdateSettingsValues,
  type UpdateTarget,
  type UpdatesStatus,
} from "@agent-harness/contracts";
import { defaultDataDirectory, FORGE_DOWNLOAD_TIMEOUT_MS, UNPACK_TIMEOUT_MS, type Clock } from "@agent-harness/environment";
import { parseOptions, parsePort, UsageError } from "./args.js";
import { PREFLIGHT_TIMEOUT_MS } from "./launch/install.js";
import { LocalFailure, withLocalSession, type LocalTarget, type Net } from "./local-session.js";
import { SNAPSHOT_VERBS, UPDATE_SNAPSHOT_USAGE } from "./update-snapshot.js";

/**
 * The `update` verbs that reach the environment on this machine
 * (launcher-update spec, "Settings, methods, notices and flags": CLI verbs):
 * `update status`, the `updates.status` document as text or JSON;
 * `update apply`, an update asked for through `updates.apply` (#343: a
 * version and the path of its artefact on this machine; #347: a version
 * alone, which the environment downloads from its release; or the update
 * that waits, when idle or at once with `--now`); `update settings`, the five
 * update settings written from flags through `updates.settings.set`;
 * `update credential --stdin`, the release token given to the environment
 * as the optional forge account for its public GitHub release origin
 * (a higher rate limit; anonymous reads need none); and, for a
 * container's host-side updater through `docker compose exec` (#348),
 * `update status --host-updater`, its poll, and `update begin`, the start of
 * the ready update whose image it pulled. Each exchanges the
 * bootstrap grant for a local client session and revokes it after
 * (`local-session.ts`), as `pair` does. The updater's `update snapshot`,
 * `update restore` and `update discard` reach no environment
 * (`update-snapshot.ts`, #349).
 */

export const UPDATE_USAGE = [
  `${PRODUCT_NAME} update status [--json] [--host-updater] [--data-dir <path>] [--port <n>]`,
  `${PRODUCT_NAME} update apply [--version <version> [--path <artefact>]] [--now] [--data-dir <path>] [--port <n>]`,
  `${PRODUCT_NAME} update settings [--auto-update <on|off>] [--channel <stable|beta>] [--pinned-version <version|none>] [--idle-window-minutes <n>] [--deferral-cap-hours <n>] [--data-dir <path>] [--port <n>]`,
  `${PRODUCT_NAME} update credential --stdin [--data-dir <path>] [--port <n>]`,
  `${PRODUCT_NAME} update begin --update-id <id> [--data-dir <path>] [--port <n>]`,
  ...UPDATE_SNAPSHOT_USAGE,
] as const;

export interface UpdateContext {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Reads all of standard input: where `update credential` takes the token from. */
  readonly stdin: () => Promise<string>;
  readonly net: Net;
  /** What the wait on the environment runs on. */
  readonly clock: Pick<Clock, "setTimeout">;
}

/**
 * How long `update apply` waits on `updates.apply`, which the environment
 * answers only once the update is staged and installed, saying nothing
 * meanwhile: the release's download when no artefact is given (up to
 * `FORGE_DOWNLOAD_TIMEOUT_MS` once the forge answers), the artefact's unpack
 * (up to `UNPACK_TIMEOUT_MS`) and the launcher's install, its preflight's
 * `PREFLIGHT_TIMEOUT_MS` included, with a minute more for the reads and
 * flushes around them. The other verbs keep the route's wait.
 */
export const UPDATE_APPLY_WAIT_MS = FORGE_DOWNLOAD_TIMEOUT_MS + UNPACK_TIMEOUT_MS + PREFLIGHT_TIMEOUT_MS + 60_000;

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

/** How the environment's updates are managed; a host-side updater's last poll worded where the CLI runs, "2 h ago, at 16:24", as the clients word it (#1742). */
const managerLine = (manager: UpdateManager, now: Date): string => {
  switch (manager.kind) {
    case "launcher":
      return `managed by its launcher, version ${manager.launcherVersion}`;
    case "outside":
      return `managed outside, by a host-side updater; ${manager.lastPoll === null ? "it has not polled yet" : `last polled ${pastTimeWords(manager.lastPoll, now)}`}`;
    case "none":
      return `not managed: ${manager.reason}`;
  }
};

const checkLine = (check: UpdateCheck | null): string => {
  if (check === null) return "never";
  return check.result === "ok" ? `${check.at}, ok` : `${check.at}, failed (${check.reason}): ${check.message}`;
};

const targetLine = (target: UpdateTarget | null): string => (target === null ? "none" : `${target.version} (${target.source})`);

const pendingLine = (pending: PendingUpdate): string => {
  switch (pending.state) {
    case "current":
      return "none";
    case "staging":
      return `${pending.toVersion} (${pending.source}), staging`;
    case "blocked":
      return `${pending.toVersion}, blocked (${pending.reason}): ${pending.message}`;
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

/** The `updates.status` document, one line per part, as `update status` prints it at `now`; a list that is empty is left out. */
export const renderUpdatesStatus = (status: UpdatesStatus, now: Date): string =>
  [
    `Version: ${PRODUCT_NAME} ${status.version}, protocol ${status.protocolVersion}`,
    `Claude Code (bundled): ${status.bundledClaudeCodeVersion ?? "unknown"}`,
    `Updates: ${managerLine(status.manager, now)}`,
    ...(status.installed.length > 0 ? [`Installed: ${status.installed.join(", ")}`] : []),
    `Releases: ${status.releaseSource.origin}/${status.releaseSource.repository}`,
    `Channel's newest: ${status.newest ?? "not read yet"}`,
    `Last check: ${checkLine(status.lastCheck)}`,
    `Target: ${targetLine(status.target)}`,
    ...(status.passedOver === null ? [] : [`Passed over: ${status.passedOver.version} (${status.passedOver.source}, ${status.passedOver.reason}): ${status.passedOver.message}`]),
    `Pending update: ${pendingLine(status.pending)}`,
    `Last update: ${outcomeLine(status.lastOutcome)}`,
    ...(status.failedVersions.length > 0 ? [`Failed versions: ${status.failedVersions.join(", ")}`] : []),
    "",
  ].join("\n");

/** `update status`: the document as text, or as JSON with `--json`; with `--host-updater`, the call is the host-side updater's poll, which the environment remembers. */
const status = async (args: readonly string[], context: UpdateContext): Promise<number> => {
  const values = parseOptions(args, { ...TARGET_OPTIONS, json: { type: "boolean" }, "host-updater": { type: "boolean" } });
  const params = values["host-updater"] === true ? { hostUpdater: true as const } : {};
  const document = await withLocalSession(targetOf(values), context.net, `${PRODUCT_NAME} update status`, (call) => call("updates.status", params), {
    clock: context.clock,
  });
  context.stdout(values.json ? `${JSON.stringify(document, null, 2)}\n` : renderUpdatesStatus(document, new Date()));
  return 0;
};

/** `update settings`: the settings its flags name, through `updates.settings.set`; prints all five after. */
const settings = async (args: readonly string[], context: UpdateContext): Promise<number> => {
  const values = parseOptions(args, { ...TARGET_OPTIONS, ...SETTING_OPTIONS });
  const patch = settingsPatch(values);
  const answer = await withLocalSession(targetOf(values), context.net, `${PRODUCT_NAME} update settings`, (call) =>
    call("updates.settings.set", { commandId: randomUUID(), values: patch }),
    { clock: context.clock },
  );
  if (answer.receipt.status === "rejected") throw new LocalFailure(`The environment refused the update settings: ${answer.receipt.error.message}`);
  // A fresh command id always carries the result.
  if (answer.result === undefined) throw new LocalFailure("The environment answered the update settings without their values.");
  context.stdout(renderUpdateSettings(answer.result.values));
  return 0;
};

/**
 * `update apply`: asks for the update to `--version`, from the artefact at
 * `--path` (a path of this machine read from the working directory) or else
 * downloaded from its release (#347), or for the update that waits (else the
 * pin or the channel's newest) when neither is given; when the environment
 * is idle, or at once with `--now`. Says which update it took, and when it
 * goes.
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
    }, { timeoutMs: UPDATE_APPLY_WAIT_MS }),
    { clock: context.clock },
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

/** `update credential`'s flags; a usage error never quotes the argument refused, which may be the token given where it does not belong. */
const credentialOptions = (args: readonly string[]) => {
  try {
    return parseOptions(args, { ...TARGET_OPTIONS, stdin: { type: "boolean" } });
  } catch (error) {
    if (error instanceof UsageError) throw new UsageError("update credential takes --stdin, --data-dir and --port only; the token comes on standard input.");
    throw error;
  }
};

/** Whether `account` holds `origin`: its canonical origin, or one of its aliases. */
const holds = (account: ForgeAccountRecord, origin: string): boolean => account.origin === origin || account.aliases.some((alias) => alias.origin === origin);

/**
 * `update credential --stdin`: gives the environment its release access.
 * The token is read from standard input only, never from an argument, and
 * is never printed. Unless a forge account holds the environment's release
 * origin already, which it then names, sending nothing, the token is added
 * as the forge account for that origin through `forge.accounts.add`, which
 * hears from the forge before it stores anything.
 */
const credential = async (args: readonly string[], context: UpdateContext): Promise<number> => {
  const values = credentialOptions(args);
  if (values.stdin !== true) throw new UsageError("update credential reads the token from standard input only: pass --stdin and pipe the token in.");
  const token = (await context.stdin()).trim();
  if (token === "") throw new LocalFailure("No token came on standard input: pipe the release token in.");
  const said = await withLocalSession(targetOf(values), context.net, `${PRODUCT_NAME} update credential`, async (call) => {
    const { releaseSource } = await call("updates.status", {});
    const where = `${releaseSource.origin}, where its releases are published`;
    const held = (await call("forge.accounts.list", {})).accounts.find((account) => holds(account, releaseSource.origin));
    if (held !== undefined) return `The forge account ${held.slug} already covers ${where}; the token was not used. Change its credential in Set up, Forges.\n`;
    const answer = await call("forge.accounts.add", {
      commandId: randomUUID(),
      forgeAccountId: randomUUID(),
      url: releaseSource.origin,
      kind: releaseSource.kind,
      credential: { kind: "stored", provenance: "pasted", token },
    });
    if (answer.receipt.status === "rejected") {
      const { error } = answer.receipt;
      // Another command added one meanwhile.
      if (error.code === "conflict" && error.data["reason"] === "origin_held") return `A forge account already covers ${where}; the token was not used.\n`;
      throw new LocalFailure(`The environment refused the token: ${error.message}`);
    }
    // A fresh command id always carries the result.
    const added = answer.result?.account;
    if (added === undefined) throw new LocalFailure("The environment answered the token without the forge account it added.");
    const problem = added.problem === null ? "" : ` It has a problem: ${added.problem.message}`;
    return `Added the forge account ${added.slug} for ${where}: the environment reads its releases with it.${problem}\n`;
  }, { clock: context.clock });
  context.stdout(said);
  return 0;
};

/**
 * `update begin --update-id <id>`: the host-side updater, having pulled the
 * image of the ready update `<id>`, begins it through `updates.begin`: the
 * environment drains, and the drain ends when the container is stopped.
 */
const begin = async (args: readonly string[], context: UpdateContext): Promise<number> => {
  const values = parseOptions(args, { ...TARGET_OPTIONS, "update-id": { type: "string" } });
  const updateId = UpdateId.safeParse(values["update-id"]);
  if (!updateId.success) throw new UsageError(`update begin takes --update-id, the id of the ready update whose image was pulled; got ${values["update-id"] || "none"}.`);
  const answer = await withLocalSession(targetOf(values), context.net, `${PRODUCT_NAME} update begin`, (call) =>
    call("updates.begin", { commandId: randomUUID(), updateId: updateId.data }),
    { clock: context.clock },
  );
  if (answer.receipt.status === "rejected") throw new LocalFailure(`The environment refused to begin the update: ${answer.receipt.error.message}`);
  // A fresh command id always carries the result.
  if (answer.result === undefined) throw new LocalFailure("The environment answered the update's begin without saying which it began.");
  context.stdout(`Began the update to ${answer.result.toVersion} (update ${answer.result.updateId}): the environment is draining, and ends once the container is stopped.\n`);
  return 0;
};

/** The `update` verbs by name. */
const VERBS: Readonly<Record<string, (args: readonly string[], context: UpdateContext) => Promise<number>>> = { status, apply, settings, credential, begin, ...SNAPSHOT_VERBS };

/**
 * `update`: runs the verb `args` name. Exits 0 once done, 1 with a plain
 * sentence when no environment answers or it refuses, and 2 (the CLI's usage
 * error) on arguments it cannot parse.
 */
export const update = async (args: readonly string[], context: UpdateContext): Promise<number> => {
  const [verb, ...rest] = args;
  const run = verb === undefined || !Object.hasOwn(VERBS, verb) ? undefined : VERBS[verb];
  if (run === undefined) throw new UsageError(verb === undefined ? "update takes a verb: status, apply, settings, credential, begin, snapshot, restore or discard." : `Unknown update verb ${verb}.`);
  try {
    return await run(rest, context);
  } catch (error) {
    if (!(error instanceof LocalFailure)) throw error;
    context.stderr(`${error.message}\n`);
    return 1;
  }
};
