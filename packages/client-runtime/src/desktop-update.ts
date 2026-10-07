import { INSTALL_RESERVE_BYTES, ReleaseVersion, compareReleaseVersions, type ReleaseSource, type UpdatesStatus } from "@agent-harness/contracts";
import { LOCAL_PLACEHOLDER_ID, type ConnectionRecord } from "./connections/records.js";
import { uuidv4 } from "./ids.js";
import { writable, type Observable } from "./observable.js";
import type { Clock, Timer } from "./platform.js";
import { CACHE_REFRESH_NOTICES, QUERY_REFRESH_NOTICES, type Requests } from "./requests.js";
import type { Shell, ShellApplyOutcome, ShellBundledServer, ShellStagedBuild } from "./shell.js";

/**
 * The desktop's update flow (launcher-update spec, "The desktop moves with
 * its local environment"; ADR 0007; #354). The desktop holds no forge token
 * and moves with its local environment, on that environment's channel.
 *
 * - **Its own build**, on a shell with `update`: checked at launch, once the
 *   local environment is ready, and hourly after, through that environment
 *   and never the forge; while that environment has not read its channel
 *   since it started, the desktop says it waits for that read, never that
 *   its build is the newest, and looks again every 30 seconds (#1753). It
 *   looks again at once, too, when what the environment runs or found may
 *   have changed: the environment ready again (the reconnect after its
 *   restart for an update) or one of its notices after which
 *   `updates.status` is read again (#1793). The
 *   release the desktop follows is the environment's pin, else its
 *   channel's newest as the environment's own check last found it
 *   (`updates.status`), or, while no newest is known and the last check has
 *   not succeeded, the environment's own version where newer than the desktop's build; when that is newer than the
 *   build the shell runs, `updates.desktop.stage` has the environment stage
 *   the build for the shell's platform and format in the background, and
 *   the runtime reports it ready: the renderer's "Restart to update" applies
 *   it now (`restart`), and it is handed to the shell as soon as it is
 *   staged for the desktop's next quit. A shell whose install cannot update
 *   itself (no format) is reported `unsupported` with the release page, and
 *   nothing is staged. A failure says which step failed: the check, the
 *   stage, the install, or a cleanup, which is never an unreachable release.
 * - **The server it carries**, on a shell with `installer.bundledServer`:
 *   once per start, when the local environment is first ready, a bundled
 *   server newer than the environment (and than an update it has pending)
 *   is handed to it with `updates.apply`, its version and path, under the
 *   idle rules, when auto-update is effective there and the version is not
 *   one whose update failed; otherwise it is offered, for the card to hand
 *   over (`applyBundledServer`).
 */

/** How often the desktop's build is checked after the check at launch, when nothing says what is newest changed. */
export const DESKTOP_CHECK_INTERVAL_MS = 60 * 60_000;

/**
 * How soon the desktop's build is checked again while the local environment
 * has not read its release channel yet: it reads it two minutes after its
 * start, and a desktop started inside them would otherwise wait an hour (#1753).
 */
export const DESKTOP_UNREAD_RECHECK_MS = 30_000;

/** How long a stage may take: the environment's download of a build may take its 15 minutes, and the release's reads around it. */
export const DESKTOP_DOWNLOAD_TIMEOUT_MS = 20 * 60_000;

/** Which step of the desktop's update failed: the check of what is newest, the stage, the install, or a cleanup after it. */
export type DesktopUpdateFailure = "check" | "stage" | "install" | "cleanup";

/** Where the desktop's own update is. `version` is the build the desktop runs. */
export type DesktopBuildView =
  /** Not checked yet, or the shell has no `update`. */
  | { readonly state: "unchecked" }
  | { readonly state: "checking"; readonly version: string }
  /** The local environment has not read its release channel since it started, so what is newest is not known yet; checked again shortly. */
  | { readonly state: "waiting"; readonly version: string }
  /** Nothing newer is published, or pinned, than the build the desktop runs. */
  | { readonly state: "current"; readonly version: string }
  /** The install cannot update itself: a new version is downloaded from the release page. */
  | { readonly state: "unsupported"; readonly version: string; readonly releasePage: string }
  /** The local environment is staging the build of `toVersion`. */
  | { readonly state: "staging"; readonly version: string; readonly toVersion: string }
  /** A restart will update: `staged` applies on "Restart to update", or at the next quit. */
  | { readonly state: "ready"; readonly version: string; readonly staged: ShellStagedBuild }
  | { readonly state: "applying"; readonly version: string; readonly staged: ShellStagedBuild }
  /**
   * A step failed, saying why; the build staged before, if any, stays to
   * apply. An install or cleanup that failed adds the release page, once a
   * check has read it, and the shell's command that installs the staged
   * build by hand, where the install has one.
   */
  | {
      readonly state: "failed";
      readonly version: string | null;
      readonly failure: DesktopUpdateFailure;
      readonly message: string;
      readonly staged: ShellStagedBuild | null;
      readonly byHand?: string;
      readonly releasePage?: string;
    };

/** Where the server artefact the desktop carries is, against the local environment. */
export type BundledServerView =
  /** Not looked at yet: the local environment has not been ready since the start, or the shell has no `installer.bundledServer`. */
  | { readonly state: "unchecked" }
  /** The desktop carries none, or none newer than the environment runs or has pending. */
  | { readonly state: "none" }
  /** Newer than the environment, which does not take it by itself: the card offers it. */
  | { readonly state: "offered"; readonly version: string; readonly environmentVersion: string }
  | { readonly state: "handing-over"; readonly version: string }
  /** The environment took it as its update `updateId`, which waits for idle there. */
  | { readonly state: "handed-over"; readonly version: string; readonly updateId: string }
  /** Handing it over, or looking at it, failed: the environment's refusal with its reason, or `shell` when the desktop could not say what it carries (its version then null). */
  | { readonly state: "failed"; readonly version: string | null; readonly reason: string; readonly message: string };

export interface DesktopUpdateView {
  readonly build: DesktopBuildView;
  readonly bundledServer: BundledServerView;
}

export interface DesktopUpdate {
  /** The desktop's own update and the server it carries, as the runtime has them now. */
  readonly view: Observable<DesktopUpdateView>;
  /** "Restart to update": the staged build applied now through the shell. Answers where the update is after; nothing happens unless a build is staged. */
  restart(): Promise<DesktopBuildView>;
  /**
   * The card's offer: the bundled server handed to the local environment,
   * under the idle rules, once it is looked at again and still newer than
   * the environment and its pending update. Answers where it is after;
   * nothing happens unless it is offered or failed.
   */
  applyBundledServer(): Promise<BundledServerView>;
}

export interface DesktopUpdateHost {
  readonly clock: Clock;
  readonly shell: Shell | undefined;
  /** Every connection: the local environment's is the one the flow asks. */
  readonly records: Observable<readonly ConnectionRecord[]>;
  /** A request answered within the request timeout. */
  readonly call: Requests["call"];
  /** A request answered within `DESKTOP_DOWNLOAD_TIMEOUT_MS`, for the stage, which downloads. */
  readonly stageCall: Requests["call"];
  readonly report: (error: unknown) => void;
}

/** The runtime's side of the flow: the view and the calls, and its start and stop. */
export interface DesktopUpdateFlow extends DesktopUpdate {
  /** Starts following the local environment: the check at its first ready, at each ready after, and hourly. */
  start(): void;
  /** A notice on the environment's own stream, heard as news: the local environment's update notices check the desktop's build again. */
  noticed(environmentId: string, type: string): void;
  /** Stops the hourly check and forgets the local environment. */
  close(): void;
}

/** Whether `a` is a release version newer than `b`; a version that is none is never newer. */
export const newerVersion = (a: string, b: string): boolean => ReleaseVersion.safeParse(a).success && ReleaseVersion.safeParse(b).success && compareReleaseVersions(a, b) > 0;

/** The page a release is downloaded from by hand, on the forge the local environment reads its releases from. */
const releasePageOf = (source: ReleaseSource): string => `${source.origin}/${source.repository}/releases`;

/** Why the shell did not apply a staged build. */
type ApplyFailure = Omit<Extract<ShellApplyOutcome, { readonly outcome: "failed" }>, "outcome">;

/** The local environment's notices after which what it runs or found newest may have changed, so the desktop's build is checked again (#1793). */
const STATUS_NOTICES: ReadonlySet<string> = new Set([...CACHE_REFRESH_NOTICES, ...(QUERY_REFRESH_NOTICES["updates.status"] ?? [])]);

/** The update states in which an environment has an update under way to a version. */
const PENDING_STATES: ReadonlySet<UpdatesStatus["pending"]["state"]> = new Set(["staging", "waiting", "ready", "draining", "switching"]);

export const createDesktopUpdate = (host: DesktopUpdateHost): DesktopUpdateFlow => {
  const update = host.shell?.update;
  const installer = host.shell?.installer?.bundledServer === undefined ? undefined : host.shell.installer;
  const view = writable<DesktopUpdateView>({ build: { state: "unchecked" }, bundledServer: { state: "unchecked" } });
  const setBuild = (build: DesktopBuildView) => view.update((held) => ({ ...held, build }));
  /**
   * Where a check has got to, or what it found. A build ready, or being
   * applied, stays as it is until a newer one is staged or it is applied:
   * it was handed over for the next quit, and a check that finds nothing
   * newer, or fails, changes nothing about it. A build whose install
   * failed stays failed until another build is staged: the same build
   * ready again would offer the restart that failed (#1692). Only a check
   * whose hand-over for the quit succeeds after one that failed sets it
   * ready, past this (#1707).
   */
  const showCheck = (build: DesktopBuildView): void => {
    const held = view.read().build;
    const applyFailure = build.state === "failed" && (build.failure === "install" || build.failure === "cleanup");
    if (held.state === "failed" && held.staged !== null && (held.failure === "install" || held.failure === "cleanup")) {
      if (!applyFailure && !(build.state === "ready" && build.staged.sha256 !== held.staged.sha256)) return;
    } else if ((held.state === "ready" || held.state === "applying") && build.state !== "ready" && !applyFailure) return;
    setBuild(build);
  };
  const setBundled = (bundledServer: BundledServerView) => view.update((held) => ({ ...held, bundledServer }));
  let stopRecords: (() => void) | undefined;
  let timer: Timer | undefined;
  let closed = false;
  /** A check is due: at the start, each hour after the last, and when what the local environment runs or found may have changed. */
  let due = true;
  let checking = false;
  /** A look again was asked while a check ran: the next starts when it ends. */
  let again = false;
  /** Whether the local environment was ready when the connections last changed. */
  let wasReady = false;
  /** The bundled server is looked at once per start. */
  let bundledLooked = false;
  /** The build last handed to the shell for the next quit. */
  let handedForQuit: ShellStagedBuild | undefined;
  /** The view the last failed hand-over for the next quit left, told apart from a failed restart of the same build. */
  let quitFailure: DesktopBuildView | undefined;
  /** The release page of the local environment's release source, as the last check read it. */
  let releasePage: string | undefined;

  /** The local environment's id while it is ready; undefined otherwise. */
  const readyLocal = (): string | undefined =>
    host.records.read().find((record) => record.kind === "local" && record.environmentId !== LOCAL_PLACEHOLDER_ID && record.enabled && record.phase === "ready")
      ?.environmentId;

  const failed = (version: string | null, failure: DesktopUpdateFailure, message: string, staged: ShellStagedBuild | null = null): DesktopBuildView => ({
    state: "failed",
    version,
    failure,
    message,
    staged,
  });

  /** The view of `staged` failing to apply, with what the person can do about it by hand. */
  const applyFailed = (version: string, failure: ApplyFailure, staged: ShellStagedBuild): DesktopBuildView => ({
    ...failed(version, failure.failure, failure.message, staged),
    ...(failure.byHand !== undefined && { byHand: failure.byHand }),
    ...(releasePage !== undefined && { releasePage }),
  });

  /** What the build last staged is, for a failure that leaves it to apply. */
  const stagedNow = (): ShellStagedBuild | null => {
    const build = view.read().build;
    return build.state === "ready" || build.state === "applying" || build.state === "failed" ? (build.staged ?? null) : null;
  };

  /** One check of the desktop's build through the local environment `environmentId`, to where it leaves the view. */
  const checkBuild = async (environmentId: string): Promise<DesktopBuildView> => {
    if (update === undefined) return { state: "unchecked" };
    let running;
    try {
      running = await update.current();
    } catch (error) {
      return failed(null, "check", `The desktop could not tell which build it runs: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { version } = running;
    // A look again while waiting for the environment's first read stays waiting until it finds something.
    if (view.read().build.state !== "waiting") showCheck({ state: "checking", version });
    const status = await host.call(environmentId, "updates.status", {});
    if (!status.ok) return failed(version, "check", `Could not ask the local environment for updates: ${status.error.message}`, stagedNow());
    releasePage = releasePageOf(status.result.releaseSource);
    if (running.format === null) return { state: "unsupported", version, releasePage };
    const settings = await host.call(environmentId, "settings.get", { keys: ["updates.pinnedVersion"] });
    if (!settings.ok) return failed(version, "check", `Could not read the local environment's update settings: ${settings.error.message}`, stagedNow());
    const pinned = settings.result.values["updates.pinnedVersion"] ?? null;
    const { newest, lastCheck, version: environmentVersion } = status.result;
    // The environment runs a release, so a build older than it is behind while the last check of the channel has not succeeded (#1753);
    // `updates.status` says only the last. After one that did, the newest is what a stage stages, even below the version running or none.
    // A failed check after a read that found no release follows the environment's version again, and its stage fails as the check would.
    const ahead = newest === null && lastCheck?.result !== "ok" && newerVersion(environmentVersion, version);
    const followed = pinned ?? (ahead ? environmentVersion : newest);
    if (followed === null) {
      if (lastCheck === null) return { state: "waiting", version };
      return lastCheck.result === "failed" ? failed(version, "check", lastCheck.message, stagedNow()) : { state: "current", version };
    }
    if (!newerVersion(followed, version)) return { state: "current", version };
    showCheck({ state: "staging", version, toVersion: followed });
    const stage = await host.stageCall(environmentId, "updates.desktop.stage", { platform: `${running.platform}-${running.arch}`, format: running.format });
    if (!stage.ok) return failed(version, "stage", `The local environment could not stage the desktop's ${followed} build: ${stage.error.message}`, stagedNow());
    const staged: ShellStagedBuild = { path: stage.result.path, version: stage.result.version, sha256: stage.result.sha256 };
    if (!newerVersion(staged.version, version)) return { state: "current", version };
    showCheck({ state: "ready", version, staged });
    if (handedForQuit?.path === staged.path && handedForQuit.sha256 === staged.sha256) return { state: "ready", version, staged };
    const outcome = await apply(staged, "quit");
    if (outcome !== null) return (quitFailure = applyFailed(version, outcome, staged));
    handedForQuit = staged;
    const ready: DesktopBuildView = { state: "ready", version, staged };
    // The hand-over that failed is now done, so its failure no longer holds the build; a restart that failed still does (#1707).
    if (view.read().build === quitFailure) setBuild(ready);
    return ready;
  };

  /** Applies `staged` through the shell: null once applied (or handed over for the quit), else what failed. */
  const apply = async (staged: ShellStagedBuild, when: "now" | "quit"): Promise<ApplyFailure | null> => {
    if (update === undefined) return { failure: "install", message: "This desktop's shell cannot update itself." };
    try {
      const outcome = await update.apply(staged, when);
      return outcome.outcome === "applied" ? null : outcome;
    } catch (error) {
      return { failure: "install", message: `The desktop could not apply ${staged.version}: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  /** The server artefact the desktop carries, as its shell says; a shell that cannot say is a failure, never a rejection. */
  const carried = async (): Promise<ShellBundledServer | null | Extract<BundledServerView, { readonly state: "failed" }>> => {
    try {
      return (await installer?.bundledServer()) ?? null;
    } catch (error) {
      return { state: "failed", version: null, reason: "shell", message: `The desktop could not say which server it carries: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  /**
   * The bundled server against the local environment `environmentId` as it
   * is now: none, offered, or handed over. `asked` is the card's call, which
   * hands over what would be offered; nothing else is skipped for it, so a
   * server no longer newer than the environment is never handed over.
   */
  const lookAtBundled = async (environmentId: string, asked: boolean): Promise<BundledServerView> => {
    if (installer === undefined) return { state: "unchecked" };
    const bundled = await carried();
    if (bundled === null) return { state: "none" };
    if ("state" in bundled) return bundled;
    const status = await host.call(environmentId, "updates.status", {});
    if (!status.ok) return { state: "failed", version: bundled.version, reason: status.error.code, message: status.error.message };
    const { version: environmentVersion, pending, failedVersions } = status.result;
    const pendingVersion = PENDING_STATES.has(pending.state) && "toVersion" in pending ? pending.toVersion : null;
    if (!newerVersion(bundled.version, environmentVersion) || (pendingVersion !== null && !newerVersion(bundled.version, pendingVersion))) return { state: "none" };
    const settings = await host.call(environmentId, "settings.get", { keys: ["updates.autoUpdate", "updates.pinnedVersion"] });
    if (!settings.ok) return { state: "failed", version: bundled.version, reason: settings.error.code, message: settings.error.message };
    const { "updates.autoUpdate": autoUpdate, "updates.pinnedVersion": pinned } = settings.result.values;
    // Auto-update effective, and not a version whose update failed there: that is never retaken automatically.
    const effective = autoUpdate === true && (pinned ?? null) === null && !failedVersions.includes(bundled.version);
    if (!effective && !asked) return { state: "offered", version: bundled.version, environmentVersion };
    if (bundled.refusal !== undefined) return { state: "failed", version: bundled.version, ...bundled.refusal };
    return handOver(environmentId, bundled.version, bundled.path);
  };

  /** Hands the bundled server of `version` at `path` to the local environment `environmentId` as its update, under the idle rules. */
  const handOver = async (environmentId: string, version: string, path: string): Promise<BundledServerView> => {
    setBundled({ state: "handing-over", version });
    const answer = await host.call(environmentId, "updates.apply", { commandId: uuidv4(), version, artefactPath: path, when: "idle" });
    if (!answer.ok) return bundledFailure(version, answer.error.code, answer.error);
    const { receipt, result } = answer.result;
    if (receipt.status === "rejected" || result === undefined) {
      const error = receipt.status === "rejected" ? receipt.error : undefined;
      const reason = typeof error?.data["reason"] === "string" ? error.data["reason"] : (error?.code ?? "refused");
      return bundledFailure(version, reason, error);
    }
    return { state: "handed-over", version, updateId: result.updateId };
  };

  /** Released environments return only the disk enum; the desktop can inspect their data volume without an environment upgrade. */
  const bundledFailure = async (version: string, reason: string, error: { readonly message: string; readonly data?: Readonly<Record<string, unknown>> } | undefined): Promise<BundledServerView> => {
    let message = error?.message ?? `The local environment did not take the bundled server ${version}.`;
    if (error?.data?.["reason"] === "install" && error.data["launcherReason"] === "disk") {
      const mib = (bytes: number) => `${(Math.floor(bytes / (1024 * 1024) * 10) / 10).toLocaleString("en-US")} MiB`;
      let space = `The available disk space could not be read; ${mib(INSTALL_RESERVE_BYTES)} reserve required.`;
      try {
        const reserve = await installer?.reserveSpace?.();
        if (reserve !== undefined) {
          space = `Currently ${mib(reserve.availableBytes)} available; ${mib(reserve.requiredBytes)} reserve required.`;
        }
      } catch {
        // A diagnostic failure must not replace the install refusal or prevent retry.
      }
      message = `Insufficient disk space to install ${version}. ${space} The existing environment remains running. Free space and retry.`;
    }
    return { state: "failed", version, reason, message };
  };

  /** Runs the check now, when one is due and the local environment is ready; the next is due an hour after it ends, or shortly while the environment has not read its channel. */
  const checkIfDue = (): void => {
    const environmentId = readyLocal();
    if (closed || checking || !due || environmentId === undefined || update === undefined) return;
    due = false;
    checking = true;
    let next = DESKTOP_CHECK_INTERVAL_MS;
    void checkBuild(environmentId)
      .then(
        (build) => {
          if (build.state === "waiting") next = DESKTOP_UNREAD_RECHECK_MS;
          showCheck(build);
        },
        (error: unknown) => host.report(error),
      )
      .finally(() => {
        checking = false;
        if (closed) return;
        if (again) {
          again = false;
          due = true;
          checkIfDue();
          return;
        }
        timer = host.clock.setTimeout(() => {
          due = true;
          checkIfDue();
        }, next);
      });
  };

  /** What the local environment runs or found newest may have changed (#1793): the build is checked now, or as soon as the check under way ends, not at the hour. */
  const lookAgain = (): void => {
    if (checking) {
      again = true;
      return;
    }
    timer?.cancel();
    due = true;
    checkIfDue();
  };

  /** Looks at the bundled server once, at the local environment's first ready. */
  const lookIfFirstReady = (): void => {
    const environmentId = readyLocal();
    if (closed || bundledLooked || environmentId === undefined || installer === undefined) return;
    bundledLooked = true;
    void lookAtBundled(environmentId, false).then(setBundled, (error: unknown) => host.report(error));
  };

  return {
    view,

    async restart() {
      const build = view.read().build;
      if ((build.state !== "ready" && build.state !== "failed") || build.staged === null) return build;
      const { staged } = build;
      const version = build.version ?? staged.version;
      setBuild({ state: "applying", version, staged });
      const outcome = await apply(staged, "now");
      if (outcome !== null) setBuild(applyFailed(version, outcome, staged));
      return view.read().build;
    },

    async applyBundledServer() {
      const held = view.read().bundledServer;
      const environmentId = readyLocal();
      if ((held.state !== "offered" && held.state !== "failed") || environmentId === undefined || installer === undefined) return held;
      setBundled(await lookAtBundled(environmentId, true));
      return view.read().bundledServer;
    },

    start() {
      if (stopRecords !== undefined || closed) return;
      wasReady = readyLocal() !== undefined;
      stopRecords = host.records.subscribe(() => {
        const ready = readyLocal() !== undefined;
        // Ready again, after its restart for an update or any reconnect: it may run another version, or have read its channel since.
        if (ready && !wasReady) lookAgain();
        else checkIfDue();
        wasReady = ready;
        lookIfFirstReady();
      });
      checkIfDue();
      lookIfFirstReady();
    },

    noticed(environmentId, type) {
      if (!closed && STATUS_NOTICES.has(type) && environmentId === readyLocal()) lookAgain();
    },

    close() {
      closed = true;
      stopRecords?.();
      timer?.cancel();
    },
  };
};
