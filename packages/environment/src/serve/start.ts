import { webOriginPolicy } from "../web/origin-policy.js";
import { webAttention } from "../web/attention.js";
import { externalWebOrigin, serveWebClient } from "./web-client.js";
import { forwardedClientAddress } from "./client-address.js";
import { reconcileImportedSessions } from "../sessions/import-dedupe.js";
import { validatorUpdateMethods } from "../banks/validator-update.js";
import { migrationMethods } from "../banks/migrate.js";
import { splitMethods } from "../banks/split.js";
import { bankInstructionsLayer, connectBankMemory } from "../banks/bank-layer.js";
import { bankDraftsProjector, listBankDrafts } from "../banks/draft-store.js";
import { createMemoryOperations } from "../banks/memory-operations.js";
import { memoryMethods } from "../banks/memory-methods.js";
import { createMemoryToolServers } from "../banks/memory-server.js";
import { readFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve as absolutePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOOTSTRAP_PATH,
  CATALOGUE,
  ContractError,
  DATABASE_FILE,
  DISCOVERY_PATH,
  ENVIRONMENT_STREAM_KIND,
  GIT_CREDENTIAL_PATH,
  HEALTH_PATH,
  OPENAI_PATH_PREFIX,
  PAIR_PATH,
  PROTOCOL_VERSION,
  SESSION_STREAM_KIND,
  STEP_REGISTRY,
  UPDATE_PATH,
  WIRE_PATH,
  describeDenylistMatch,
  formatHostPort,
  pairingLink,
  pairingPreset,
  parkedPromptTtlMs,
  type AuthPolicy,
  type CapabilityFlags,
  type Catalogue,
  type ContainmentReport,
  type DiscoveryDocument,
  type DrainTrigger,
  type EnvironmentBinding,
  type EnvironmentReadiness,
  type EnvironmentStatus,
  type HealthDocument,
  type MintedPairing,
  type ReleaseChannel,
  type ReleaseSource,
  type ToolCommandEntry,
} from "@agent-harness/contracts";
import { SYSTEM, createAccessLog } from "../auth/access-log.js";
import { accessMethods } from "../auth/access-methods.js";
import { createBootstrapGrant } from "../auth/bootstrap.js";
import { describeBankStep } from "../banks/describe.js";
import { createBankCredentials } from "../banks/credentials.js";
import { createBankService, type BankService } from "../banks/bank-service.js";
import { PROVIDER_NAMES as KEY_MANAGER_NAMES } from "../key-managers/provider.js";
import { BANKS_DIRECTORY, bankCheckouts } from "../banks/attachments.js";
import { banksProjector, listBanks } from "../banks/bank-store.js";
import { createBankMoveSource } from "../banks/move-source.js";
import { bankMethods } from "../banks/methods.js";
import { banksSection } from "../banks/orientation.js";
import { createBankSyncer } from "../banks/syncer.js";
import { bankRecords } from "../banks/records.js";
import { systemResolver, type Resolver } from "../browser/address-rules.js";
import type { ExtractionHooks } from "../browser/extraction.js";
import { findHeadlessExecutable, isExecutableFile } from "../browser/headless-executable.js";
import { spawnBrowser, type BrowserLauncher } from "../browser/headless-launch.js";
import { resolveRunBrowser, type HeadlessAvailabilitySeam } from "../browser/run-browser.js";
import { chooseChrome } from "../browser/chrome-choice.js";
import { browserAllowance } from "../browser/denylist.js";
import { createBrowserToolServers, type PageDrivers } from "../browser/tool-server.js";
import { systemDialer, type Dialer } from "../browser/web-fetch.js";
import { createWebReader } from "../browser/web-read.js";
import {
  SWEEP_INTERVAL_MS,
  createClientSessions,
  socketSessions,
  type ClientSessionIssuer,
  type ClientSessions,
} from "../auth/client-sessions.js";
import { createPairings, pairRoute, type Pairings } from "../auth/pairings.js";
import { createRateLimiter } from "../auth/rate-limit.js";
import { formatActor, openEventLog, type EventLog, type Projector, type Tx } from "../event-log/event-log.js";
import type { Adapter } from "../adapter/contract.js";
import { createClaudeAdapter } from "../adapters/claude/index.js";
import { createPassthrough } from "../completions/passthrough.js";
import { createCompletionsSurface } from "../completions/surface.js";
import { createAdapterHost } from "../adapter/host.js";
import { createImportedHistory } from "../carry-over/history.js";
import { createProcessEnvironments, type InjectionSeam, type ProcessEnvironments } from "../adapter/process-environment.js";
import { readSessionFacts } from "../runs/run-reads.js";
import { composeInstructions, type OrientationSeam } from "../instructions/composer.js";
import { instructionMethods } from "../instructions/methods.js";
import { environmentSection } from "../instructions/environment-section.js";
import { createOrientationRenderer, type OrientationSection } from "../instructions/orientation.js";
import { sessionInstructionsLayer, sessionInstructionsMethods } from "../instructions/session-instructions.js";
import { createInstructionStore, instructionsProjector, ownedInstructionsLayer } from "../instructions/store.js";
import { ACCOUNTS_DIRECTORY, createAccountService, type AccountService, type ConfiguredAccount } from "../accounts/account-service.js";
import { accountsProjector, listAccountStandings } from "../accounts/account-store.js";
import { accountsSection } from "../accounts/orientation.js";
import { accountMethods } from "../accounts/methods.js";
import type { SignInDirectorFactory } from "../accounts/signin-seam.js";
import { createSignInDirector } from "../accounts/signin-director.js";
import type { SignInSpawn } from "../accounts/signin-process.js";
import { CLAUDE_PROVIDER, type HostEnvironment } from "../adapters/claude/credentials.js";
import { bundledExecutable } from "../adapters/claude/executable.js";
import { claudeSignInProgram } from "../adapters/claude/signin.js";
import { readClaudeCodeVersion } from "../adapters/claude/version.js";
import { usageMethods } from "../accounts/usage-methods.js";
import { createUsagePool } from "../accounts/usage-pool.js";
import { processMethods } from "../adapter/processes-methods.js";
import { ATTACHMENTS_DIRECTORY, createAttachmentStage } from "../adapter/attachment-stage.js";
import { recoverCutRuns, recoverStagedAttachments } from "../adapter/recovery.js";
import { noToolServers, type InstructionComposer, type PolicySeam, type PromptAutoAnswer, type SkillSetSeam, type ToolGateRule, type ToolServerFactory } from "../adapter/seams.js";
import { autoAnswer } from "../permissions/auto-answer.js";
import { UNPROBED_REPORT, containmentFlags, containmentReport, failedProbeReport, presetContainmentDefault, withAdapters } from "../permissions/containment.js";
import { CONTAINMENT_DIRECTORY, containmentDirectories } from "../permissions/containment-directories.js";
import { probeContainment, type ContainmentProbe } from "../permissions/containment-probe.js";
import { coveredDirectories, coveredPaths, denylistRule, providerDenylist, readDenylistCall, type DenylistContext } from "../permissions/denylist-gate.js";
import { denylistMethods } from "../permissions/denylist-methods.js";
import { readDenylist, seedDenylist } from "../permissions/denylist-store.js";
import { permissionMethods, sessionModeClamp } from "../permissions/methods.js";
import { promptMethods } from "../permissions/prompt-methods.js";
import { startPromptNotices } from "../permissions/prompt-notices.js";
import { startReviewNotices } from "../permissions/review-notices.js";
import { permissionsProjector, readPermissionSettings, readStoredContainmentDefault } from "../permissions/permissions-store.js";
import { policySettings, resolvePolicy } from "../permissions/resolver.js";
import { reviewMethods } from "../permissions/review-methods.js";
import { createTtlSweeper } from "../permissions/ttl-sweeper.js";
import { createProviderTranscriptStore, type ProviderTranscriptStore } from "../provider-transcripts/store.js";
import { runMethods } from "../runs/run-methods.js";
import { startActorRunIn, type ActorRunRequest } from "../runs/actor-start.js";
import { RELEASE_SOURCE, channelSettingsOf, createReleaseChannel, type ChannelSettings } from "../updates/channel.js";
import { createChannelChecks } from "../updates/checks.js";
import { createUpdateCoordinator, UPDATES_ACTOR } from "../updates/coordinator.js";
import { createHostUpdaterPolls } from "../updates/host-updater.js";
import { updateMethods } from "../updates/methods.js";
import { writeStartingChannel } from "../updates/starting-channel.js";
import { createUpdateRoute } from "../updates/route.js";
import { runsProjector } from "../runs/runs-projector.js";
import { scrubDiagnosticOutput } from "../scrub/diagnostic-output.js";
import { createScrubRegistry, type ScrubRegistry } from "../scrub/registry.js";
import { createCompactionSweep } from "../sessions/compaction.js";
import { createDeletion } from "../sessions/deletion.js";
import { createForgeService, type ForgeService } from "../forge/forge-service.js";
import { forgeAccountsProjector } from "../forge/forge-store.js";
import { createCredentialRoute } from "../forge/credential-route.js";
import { forgeMethods } from "../forge/methods.js";
import { verifiedOrigins, type GitConfigEntry } from "../forge/git-helper.js";
import type { ForgeGitAnswer, ForgeGitRequest } from "../forge/harness-git.js";
import { managedGh } from "../forge/gh.js";
import type { ForgeFetch } from "../forge/providers.js";
import type { KeyManagerRegistry } from "../key-managers/registry.js";
import { createKeyManagerConnections, type KeyManagerConnections } from "../key-managers/connections.js";
import { officialOnePasswordSdk, type OnePasswordSdk } from "../key-managers/onepassword-sdk.js";
import { KEY_MANAGER_CLI_DIRECTORY } from "../key-managers/run-tokens.js";
import { keyManagerConnectionsProjector } from "../key-managers/connection-store.js";
import { settingsInjection } from "../key-managers/injection-setting.js";
import { keyManagerMethods } from "../key-managers/methods.js";
import { keyManagerMovesProjector } from "../key-managers/move-store.js";
import { createKeyManagerMoves, type MoveSource } from "../key-managers/moves.js";
import { createKeyManagerReferences } from "../key-managers/references.js";
import { keyManagersSection } from "../key-managers/orientation.js";
import { createKnownEnvironments, knownEnvironmentsMethods } from "../known-environments/known-environments.js";
import { otherEnvironmentsSection } from "../known-environments/orientation.js";
import { createEnvironmentLook, lookProjector, nameOfHostname, presetColour, presetIcon } from "../look/look.js";
import { managedToolsMethods } from "../managed-tools/methods.js";
import type { ReleaseOrigins } from "../managed-tools/latest.js";
import { createManagedTools, type ManagedTools } from "../managed-tools/registry.js";
import { createToolDoctor } from "../managed-tools/doctor.js";
import { createToolVerifier } from "../managed-tools/verify.js";
import { createToolRunner } from "../managed-tools/runner.js";
import type { PackageOwnerLookup } from "../managed-tools/package-owner.js";
import { createWebhookDeliveries } from "../routines/webhook-delivery.js";
import { followDeliveries, resumeDeliveries } from "../routines/delivery.js";
import { routineEndpointsProjector } from "../routines/endpoint-store.js";
import { createRoutineEndpoints } from "../routines/endpoints.js";
import { limitFiringDurations } from "../routines/firing-duration.js";
import { followFiringEnds, settleFirings } from "../routines/firing-end.js";
import { createFiringStarter } from "../routines/firing-start.js";
import { routineMethods } from "../routines/methods.js";
import { firingSkillsOfSession, routinesProjector } from "../routines/routine-store.js";
import { createRoutineScheduler } from "../routines/scheduler.js";
import { routineAccount } from "../routines/listing.js";
import { preCheckMethods } from "../routines/pre-check-methods.js";
import { createPreCheckRunner } from "../routines/pre-check.js";
import { prepareScriptsDirectory, scriptsDirectory } from "../routines/scripts-directory.js";
import { createRoutineWorkspaces } from "../routines/workspace.js";
import { forkRewindMethods } from "../sessions/fork-rewind.js";
import { groupMethods, createImportedGroup } from "../sessions/group-methods.js";
import { sessionMethods } from "../sessions/methods.js";
import { sessionListProjector } from "../sessions/session-list.js";
import { knownRepositoryIdentities, type Reader } from "../sessions/session-tables.js";
import { baseEnvironment } from "../terminals/shell.js";
import { createTerminalService, type ToolTerminals } from "../terminals/service.js";
import { createWorkspaceChecks } from "../checks/service.js";
import { checksProjector } from "../checks/store.js";
import type { TerminalsOptions } from "../terminals/terminals.js";
import { chromesProjector } from "../browser/chromes.js";
import { createBrowserService } from "../browser/service.js";
import { createBrowserRelay } from "../browser/relay.js";
import { EXTENSION_LISTENER_PORTS, type ExtensionListenerPorts } from "../browser/listener.js";
import { createAutoMemory } from "../workspace/auto-memory.js";
import { createAvailabilityWatcher, type AvailabilitySettings } from "../workspace/availability.js";
import { createCheckoutIndex, type CheckoutIndex } from "../workspace/checkout-index.js";
import { createIdentityPasses } from "../workspace/identity-passes.js";
import { setWorkspaceMethods } from "../workspace/set-workspace.js";
import { workspaceMethods } from "../workspace/methods.js";
import { createWorkspaceResolver, type WorkspaceResolver, type WorkspaceSettings } from "../workspace/resolver.js";
import { createReaper } from "../workspace/reaper.js";
import { workspaceRoots } from "../workspace/roots.js";
import { createSettleSweep } from "../sessions/settle-sweep.js";
import { fileChangeObserver } from "../file-undo/observer.js";
import { createFileUndo, type FileUndoHooks } from "../file-undo/undo.js";
import { createWorkspaceWrites } from "../file-undo/workspace-writes.js";
import { settingsMethods } from "../settings/methods.js";
import { skillChoicesProjector } from "../skills/choices.js";
import { skillsMethods } from "../skills/methods.js";
import { skillsCarryOver } from "../skills/carry-over.js";
import { createSkillProbes } from "../skills/probe.js";
import { createSkillSources, readSkillSources, readSkillSourceIdentities, skillSourcesProjector } from "../skills/sources.js";
import { createSkillSync } from "../skills/sync.js";
import { trustMethods } from "../trust/methods.js";
import { sourceAccountInventories } from "../state-import/inventory.js";
import { directoryInventory } from "../carry-over/directory-inventory.js";
import { createCarryOver } from "../carry-over/methods.js";
import { createImportCoordinator } from "../state-import/coordinator.js";
import { lastImportFailures } from "../state-import/last-failures.js";
import { stateImportProjector } from "../state-import/items.js";
import { followDeferredDefaults } from "../state-import/default-account.js";
import { stateImportMethods, type StateImportHooks } from "../state-import/methods.js";
import { detectSource, type SourceMachine } from "../state-import/source/folders.js";
import { createTrustStore, trustProjector } from "../trust/store.js";
import { GENERATIONS_DIRECTORY, SNAPSHOTS_DIRECTORY, createGenerations } from "../skills/generations.js";
import { createOwnDirectory, prepareOwnDirectory } from "../skills/own-directory.js";
import { skillReadinessMethods } from "../skills/readiness.js";
import { placeSkillSet, runSkillSets, skillSetReader } from "../skills/run-skill-set.js";
import { setupMethods } from "../setup/methods.js";
import { mintMethods } from "../setup/mint.js";
import { startSetupScheduler } from "../setup/scheduler.js";
import { createSetupService, type SetupSteps } from "../setup/service.js";
import { environmentDoneLines, environmentStateChecks, type StateChecksOptions } from "../setup/state-checks.js";
import { readSettings, settingsProjector } from "../settings/settings-store.js";
import type { SubscriptionHooks } from "../wire/subscriptions.js";
import { createWire } from "../wire/wire.js";
import { systemClock, type Clock } from "./clock.js";
import { createCloserStack } from "./closers.js";
import { defaultDataDirectory, prepareDataDirectory } from "./data-directory.js";
import { createHttpSurface, sendJson, type Address, type HttpRoutes } from "./http.js";
import { ensureSigningKey, loadOrCreateRecord } from "./identity.js";
import { LOOPBACK, bindChoiceOf, bindPlan, tailscaleDetector, type BoundInterface, type InterfaceDetector } from "./interfaces.js";
import { processLauncherChannel, type LauncherChannel } from "./launcher.js";
import { refuseMarkedRestore } from "./launcher-files.js";
import { processContainerDetector, type ContainerDetector } from "./container.js";
import { createLifecycle, type DrainOutcome } from "./lifecycle.js";
import { createMethodTable, type MethodTable } from "./methods.js";
import type { MemoryRunRegistry } from "./run-registry.js";
import { processUserCheck, refusePrivilegedUser, type UserCheck } from "./user.js";
import { createTrash } from "./trash.js";
import { clearCredentialAccess, credentialAccessReporter, watchCredentialAccess } from "./credential-access.js";
import { chooseVault, loadKeychainBinding } from "./keychain.js";
import { holdVault, type Vault } from "./vault.js";

/** The harness version the environment reports: its own package's, read from `src/` and `dist/` alike. */
export const HARNESS_VERSION: string = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

/**
 * The directory the harness's own code is installed in: the environment
 * package's. A managed tool found inside it, or inside the bundled binary's
 * package, is the harness's own and never a person's (ADR 0026).
 */
const HARNESS_DIRECTORY: string = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The built extension the environment carries and unpacks for Chrome (browser
 * spec; ADR 0024): the extension package's build beside the environment
 * package, as the workspace and the server artefact lay the packages out.
 * The workspace build writes it there (#549).
 */
export const EXTENSION_BUILD: string = join(HARNESS_DIRECTORY, "..", "extension", "dist");

/**
 * The port an environment listens on when none is given. A chosen default, not
 * decided on a ticket: saved connections need a stable port, and a second
 * environment on one machine passes its own.
 */
export const DEFAULT_PORT = 7433;

/** Where each repository's auto-memory directory lives in the data directory, shared by every account (ADR 0018). */
export const AUTO_MEMORY_DIRECTORY = "auto-memory";

/** The database file in the data directory, named where the launcher, which snapshots it, reads it too. */
export { DATABASE_FILE };

/**
 * The startup order the env spec fixes ("Lifecycle"), after the root refusal
 * that precedes them all. Readiness turns `ready` only after the last.
 */
export const STARTUP_STEPS = [
  "data-directory",
  "database",
  "projectors",
  "identity",
  "adapter-host",
  "listen",
  "prepared",
] as const;
export type StartupStep = (typeof STARTUP_STEPS)[number];

/** How far startup has got, for the test hooks. */
export interface StartupProgress {
  /** The listener's address, once the `listen` step has bound it. */
  readonly address: Address | undefined;
}

/** Test hooks: `beforeStep` runs, and is awaited, before each startup step; a throw fails that step. */
export interface StartupHooks {
  beforeStep?(step: StartupStep, progress: StartupProgress): void | Promise<void>;
}

/** A startup step failed. Everything opened before it was closed, and the wire never opened: `prepared` was never signalled, or never committed. */
export class StartupError extends Error {
  readonly step: StartupStep;

  constructor(step: StartupStep, cause: unknown) {
    super(`Startup failed at the ${step} step: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "StartupError";
    this.step = step;
  }
}

export interface EnvironmentOptions {
  /** The data directory; preset: the platform's user state directory (`defaultDataDirectory`). */
  readonly dataDir?: string;
  /**
   * The harness version the environment runs as: what discovery, health,
   * `prepared`, `environment.started` and `updates.status` report. Preset:
   * the package's (`HARNESS_VERSION`); a test starts one data directory as
   * two versions with it.
   */
  readonly harnessVersion?: string;
  /** The loopback port; preset `DEFAULT_PORT`; 0 picks a free one. */
  readonly port?: number;
  /** The name a new environment is created with; preset: the hostname's first label. An existing environment keeps its own. */
  readonly name?: string;
  /** The release channel a new environment starts on, its `updates.channel` written at the start that creates it (#846); preset: the setting's. An existing environment keeps its own. */
  readonly channel?: ReleaseChannel;
  /** The machine's hostname, whose first label names a new environment given no `name` (#323). Preset: `os.hostname()`; tests script it. */
  readonly hostname?: string;
  /**
   * The operating system the preset icon follows, outside a container (#323), the rule the scripts directory judges a
   * pre-check's script executable by, Windows's by its extension (#526), and where the headless browser's executable is
   * looked for (#555). Preset: `process.platform`; tests script it.
   */
  readonly platform?: NodeJS.Platform;
  /** The Node this environment runs on, which on Windows says whether it is the launcher's copy that no update moves (#1910). Preset: `process.execPath`. */
  readonly execPath?: string;
  /** The environment's own tailnet name, which the Host check accepts while the tailnet address is bound. Preset: the detector's. */
  readonly tailnetName?: string;
  /** Canonical HTTPS origin for web links, configured independently of the TLS proxy. */
  readonly webOrigin?: string;
  /** The header the proxy in front of `webOrigin` writes the client's address in (#1809). Preset: Tailscale Serve's `X-Forwarded-For`, with its `Tailscale-User-Login`; a named header reads no login. */
  readonly clientAddressHeader?: string;
  /** Override the packaged public bundle directory, for hosted verification. */
  readonly webClientDirectory?: string;
  /** The environment's own IANA time zone, which a routine that names none is saved in (#521). Preset: the process's. */
  readonly timeZone?: string;
  /** What is found to bind beside loopback. Preset: the `tailscale` CLI and the machine's network interfaces (`tailscaleDetector`); tests pass their own. */
  readonly interfaces?: InterfaceDetector;
  /** Bind the Tailscale address when one is found, over `network.bindTailnet` (#574), for tests and the service verbs. Preset: the key. */
  readonly bindTailnet?: boolean;
  /** Bind `lanAddress`, which must then be given, or no LAN address, over `network.bindLan` (#574), for tests and the service verbs. Preset: the key. */
  readonly bindLan?: boolean;
  /** The LAN address bound when `bindLan` is on: one the machine holds, else the start skips it (#773); never the wildcard address. */
  readonly lanAddress?: string;
  /** Preset: the running process's user (`processUserCheck`). */
  readonly user?: UserCheck;
  /** Preset: the IPC channel of a launcher that spawned the environment, else nothing (`processLauncherChannel`). */
  readonly launcher?: LauncherChannel;
  /**
   * Preset: the one the vault chooser picks (#364), which the start logs in
   * one line with why: the OS keychain on macOS and Windows under the
   * user's launch agent or logon task, where the binding loads and answers,
   * the file vault in the data directory otherwise. Every entry is registered
   * with the scrub registry while the environment holds it.
   */
  readonly vault?: Vault;
  /** Registered and caught up from their cursors in the `projectors` step, after the environment's own (the session list). */
  readonly projectors?: readonly Projector[];
  /**
   * The environment's time: timestamps, the ping interval, the auth timeout,
   * token expiry and the terminal UI sweep. Preset: `systemClock`; tests pass
   * a manual one.
   */
  readonly clock?: Clock;
  readonly hooks?: StartupHooks;
  /** Test seams for subscriptions: hold a catch-up, slow a socket down. */
  readonly subscriptionHooks?: SubscriptionHooks;
  /** The run registry the adapter host fills and the idle rule and the drain read, with the drain's admission gate. Preset: a fresh one. */
  readonly runs?: MemoryRunRegistry;
  /**
   * The scrub registry (ADR 0011): the values the environment holds as
   * secrets, its vault's entries among them from start, replaced with
   * `[redacted]` in every event payload as the log appends it and in every
   * line written to the process's standard error while the environment
   * runs. Preset: a fresh one.
   */
  readonly scrub?: ScrubRegistry;
  /** Whether this is a container; with no launcher present too, updates are managed outside. Preset: `processContainerDetector`. */
  readonly containerDetector?: ContainerDetector;
  /** The adapters the adapter host holds, one per provider. Preset: the Claude adapter, with auto memory under the data directory. */
  readonly adapters?: readonly Adapter[];
  /**
   * Accounts carried over from configuration (#119): adopted in place into
   * the account store, under their own ids, the first time the environment
   * starts with a store that has never held an account; ignored after. The
   * store is what runs go through. Preset: none.
   */
  readonly accounts?: readonly ConfiguredAccount[];
  /**
   * The sign-in director `accounts.add` hands a new account to and the
   * `accounts.signin.*` methods drive. Preset: the director (#135) over
   * Claude's sign-in program, run as `signInProcess` says.
   */
  readonly signIn?: SignInDirectorFactory;
  /**
   * How the preset director's sign-ins run (#135): the process spawner, the
   * environment a sign-in inherits before the scrub, the bundled binary, the
   * managed tool and the working directory. Preset: `node:child_process`,
   * this process's environment, the SDK's bundled binary, the Managed tools
   * registry's `claude` row (#373), the home directory.
   */
  readonly signInProcess?: {
    readonly spawn?: SignInSpawn;
    readonly hostEnv?: HostEnvironment;
    readonly bundled?: string | null;
    readonly managedTool?: () => string | null | Promise<string | null>;
    readonly cwd?: string;
  };
  /** How long an account's status or model probe may take. Preset: `PROBE_TIMEOUT_MS`. */
  readonly probeTimeoutMs?: number;
  /** How long a plan-usage read may take before the reading answers unavailable. Preset: `USAGE_READ_TIMEOUT_MS`. */
  readonly usageReadTimeoutMs?: number;
  /**
   * The idle time of a provider process, in minutes, read each time a wait
   * begins. Preset: the `providers.processIdleMinutes` setting as the
   * settings store holds it (its preset, 30, until it is set); a test passes
   * its own.
   */
  readonly processIdleMinutes?: () => number;
  /** A test's hold on a file restore of `files.undo`, around its rename (#1183); preset: none. */
  readonly fileUndoHooks?: FileUndoHooks;
  /** The adapter host's seams other workstreams fill; each has a preset (`adapter/seams.ts`). */
  readonly adapterSeams?: {
    readonly toolServers?: ToolServerFactory;
    /**
     * Composes each run's standing instructions; preset: the composer
     * (`instructions/composer.ts`) with the orientation block filled by the
     * OrientationRenderer (#380), and no other layer filled.
     */
    readonly instructions?: InstructionComposer;
    /** Resolves each run's skill set and each commands listing's (#495); preset: the empty set, until the materialiser (#496). */
    readonly skillSet?: SkillSetSeam;
    /** The broker's automatic answers; preset: the unattended and bypass rules (#131, `permissions/auto-answer.ts`). */
    readonly autoAnswer?: PromptAutoAnswer;
    /** Preset: the policy resolver on the environment's permission settings (#129) and its containment probe (#133). */
    readonly resolvePolicy?: PolicySeam;
    /** The tool gate's rules; preset: the denylist's (#132, `permissions/denylist-gate.ts`). */
    readonly gateRules?: readonly ToolGateRule[];
    /** Whether a holder's process environment is supplied at all (#307); preset: `allow`, until #91's setting answers it. */
    readonly injection?: InjectionSeam;
  };
  /**
   * Sections registered with the OrientationRenderer at start beside the
   * environment's own (#380), each in place of the environment's own of its
   * name (#381): tests register providers that throw, stall and overflow.
   * Preset: none.
   */
  readonly orientationSections?: readonly OrientationSection[];
  /**
   * The orientation block in place of the OrientationRenderer's (#505): what
   * the composer's user layer opens with and the Orientation row renders.
   * Tests give their own. Preset: the renderer's.
   */
  readonly orientation?: OrientationSeam;
  /**
   * The catalogue the suggested instructions are read from (#509): a copy's
   * newer version, its diff, a tick and a dismissal. Tests give one they
   * swap for one holding a newer version. Preset: this build's.
   */
  readonly catalogue?: () => Catalogue;
  /**
   * What this environment can enforce (#133), probed once as the adapter
   * host starts: its capability flags, the containment default's preset and
   * every run's containment follow from it. Preset: the probe of the running
   * machine (`containment-probe.ts`); tests script it.
   */
  readonly probeContainment?: () => Promise<ContainmentProbe>;
  /** How terminals start: the pty, the shell, the base environment. Preset: `node-pty`, the user's login shell, the clean base (`terminals/`). */
  readonly terminals?: Omit<TerminalsOptions, "clock" | "scrub" | "processEnvironment">;
  /**
   * The resolver `sessions.create` and the completions surface give a new
   * session its workspace through (#321). Preset: the environment's
   * (`workspace/resolver.ts`); tests script it.
   */
  readonly workspaceResolver?: WorkspaceResolver;
  /**
   * What the environment's resolver reads beyond its data directory (#325):
   * the workspace roots later workstreams declare beside the data
   * directory's scratch and worktrees, which are exempt from the denylist's
   * data-directory preset as they are; the home `~` stands for; whether a
   * directory can be read; how long git gets; and how the availability
   * watcher looks at a workspace (#328). Each has a preset.
   */
  readonly workspaces?: WorkspaceSettings & AvailabilitySettings;
  /**
   * The command line that runs the `agent-harness` binary before its verb
   * (#314): git names it, with `git-credential <slug>`, as its credential
   * helper. `serve` passes the launcher's `bin` shim under a launcher
   * (#338, #459), whose path outlives every version, else the one it runs
   * as. Absent, the harness's git fails on an origin a forge account covers.
   */
  readonly harnessCommand?: readonly string[];
  /**
   * The absolute paths `harnessCommand` reads as it runs, beyond its own
   * words (#705): the launcher's shim reads the service state and the
   * versions directory. Only whoever knows the command's layout can name
   * them, so `serve` passes them beside it. Where an enabled denied path
   * covers one, an unattended run's sandbox reads it again, as it does the
   * command's own directories. Preset none.
   */
  readonly harnessReads?: readonly string[];
  /**
   * Configuration the harness's git is given after its own on every
   * operation. Only tests give it: an `insteadOf` that sends a forge's
   * `https` URL to a local bare repository, so the source URL rule runs as
   * written (skills spec, "Testing Decisions"). Preset none.
   */
  readonly harnessGitConfig?: readonly GitConfigEntry[];
  /**
   * What the skills' probes, adds and syncs ask of the ForgeService's git
   * goes through this, handed the request and that git. Only tests give it:
   * to see each request, hold a sync's fetch in flight, or answer one as
   * stopped at its time (skills spec, "Testing Decisions"). Preset none.
   */
  readonly skillsGit?: (request: ForgeGitRequest, git: (request: ForgeGitRequest) => Promise<ForgeGitAnswer>) => Promise<ForgeGitAnswer>;
  /** Test boundary for observing or holding the BankService's harness git fetches. */
  readonly banksGit?: (request: ForgeGitRequest, git: (request: ForgeGitRequest) => Promise<ForgeGitAnswer>) => Promise<ForgeGitAnswer>;
  /**
   * The machine the state import's source reader looks at for a source data
   * folder and terminal-client state folder (#581): its environment
   * variables, platform and home. Preset: this process's; tests point it at
   * fixture folders (`machinePointedAt`).
   */
  readonly stateImportSource?: SourceMachine;
  /** Seams a test reaches the state import through: after its plan, and after each item it carried (#1165). Preset: none. */
  readonly stateImportHooks?: StateImportHooks;
  /**
   * The home whose `.agents/skills` Carry over's skills half reads beside
   * the adopted directory (#513), and whose `.claude.json` its inventory
   * counts the personal MCP servers of for an adopted `~/.claude` (#580).
   * Preset: this process's home; tests point it at a fixture.
   */
  readonly carryOverHome?: string;
  /** How the ForgeService reaches a forge (#310). Preset: the global `fetch`; tests route github.com's API to their fake forge. */
  readonly forgeFetch?: ForgeFetch;
  /** How long one call to a forge, and one verification of a forge account, may take (#311). Preset: `FORGE_CALL_TIMEOUT_MS`, ADR 0031's ten seconds. */
  readonly forgeTimeoutMs?: number;
  /**
   * How the Managed tools registry (#373) probes: where it reads the login
   * shell's PATH, which the forge's `gh` and the sign-in director's managed
   * tool are found on too; how it asks which system package owns a tool;
   * the environment its commands, and `gh`'s, start from; where it reads
   * each tool's latest version (#374). Preset: the user's login shell (the
   * machine and user Path on Windows), `dpkg -S` then `rpm -qf` on Linux,
   * this process's environment, the real release sources; tests put fake
   * tools on a PATH of their own, script the package owner and fake the
   * release sources on loopback.
   */
  readonly managedTools?: {
    readonly readPath?: () => Promise<string>;
    readonly packageOwner?: PackageOwnerLookup;
    readonly hostEnv?: HostEnvironment;
    readonly releaseOrigins?: Partial<ReleaseOrigins>;
    /** The closed command table `tools.run` runs and a row's Update is read from (#376). Preset: the contracts'; tests give one whose installer is a fake. */
    readonly commands?: readonly ToolCommandEntry[];
  };
  /** The key-manager registry's resolve seam the forge reads references through (#312). Preset: the environment's own over its connections (#370); tests may script one. */
  readonly keyManagers?: KeyManagerRegistry;
  /**
   * How long one verification of a key-manager connection, one certificate preview (#366), or one reference's read or a
   * path's list (#370) may take. Preset: `KEY_MANAGER_BUDGET_MS`, ADR 0031's ten seconds.
   */
  readonly keyManagerTimeoutMs?: number;
  /** The 1Password SDK the 1Password provider signs in through (#378). Preset: the official `@1password/sdk`; tests give a scripted double, so none reaches 1Password. */
  readonly onePasswordSdk?: OnePasswordSdk;
  /** Loads the official Bitwarden SDK; tests inject a scripted loader or a load failure. */
  readonly bitwardenSdk?: import("../key-managers/bitwarden-sdk.js").BitwardenSdkLoader;
  /**
   * The Move sources registered at start (#371): each owning service's
   * items holding a stored value. Preset: the forge's and routine webhook endpoints'; banks (#90) join it. Tests script one.
   */
  readonly moveSources?: readonly MoveSource[];
  /**
   * Reads the bundled Claude Code's version, which `updates.status` answers;
   * called once, the first time it is asked for. Preset: the bundled
   * binary's `--version` (`adapters/claude/version.ts`); tests script it.
   */
  readonly claudeCodeVersion?: () => Promise<string | null>;
  /**
   * Where the release channel is read (#346): an origin, its forge's kind
   * and the repository. Preset: `RELEASE_SOURCE`, compiled into the build;
   * tests name their fake release source.
   */
  readonly releaseSource?: ReleaseSource;
  /**
   * The launcher protocol this build's own launcher speaks, which a
   * handover to it brings (#347). Preset: `LAUNCHER_PROTOCOL`; a test raises
   * it to stand for a stepping stone whose launcher speaks a newer one.
   */
  readonly launcherProtocol?: number;
  /**
   * The steps `setup.check` runs and how their state checks answer (#308).
   * Preset: the step registry with this environment's own answers; a test
   * gives steps of its own whose checks answer when it says.
   */
  readonly setupSteps?: SetupSteps;
  /**
   * How `web_read` reaches the web (#546): the resolver each hop's name is
   * resolved through, how a connection to an address the address rules
   * checked is opened, and what a test observes of the extraction workers.
   * Preset: the system's resolver, a TCP connection to the checked address,
   * no hooks; tests resolve and dial to their loopback server.
   */
  readonly webRead?: {
    readonly resolve?: Resolver;
    readonly dial?: Dialer;
    readonly hooks?: ExtractionHooks;
  };
  /**
   * The extension's folder and its listener (#547): the built extension the
   * environment unpacks into `extension/current` for Chrome, and the ports
   * the listener tries. Preset: `EXTENSION_BUILD`, and 47615 then each next
   * free port up to 47634; a preferred port of 0 binds any free one, as tests do.
   * And whether the environment has a headless browser a run can drive, asked
   * at each run's start (#550); preset: the headless browser's own answer
   * (#555). And the page drivers the browser tools reach, by kind (#551),
   * each over its preset: a Chrome paired with this environment is driven by
   * its extension driver (#552), the headless browser by its driver (#555),
   * and the dock answers that it cannot be driven here yet.
   * And how the headless browser is found and started (#555): whether a path
   * is a file it can run (preset: one this process may execute), how a found
   * Chromium is launched (preset: a child process over a pipe), and how its
   * navigation policy resolves a name before navigating (preset: the system's
   * resolver). Tests launch the scripted CDP peer and resolve from a table.
   */
  readonly browser?: {
    readonly extensionSource?: string;
    readonly ports?: ExtensionListenerPorts;
    readonly headless?: HeadlessAvailabilitySeam;
    readonly drivers?: PageDrivers;
    readonly isExecutable?: (path: string) => boolean;
    readonly launch?: BrowserLauncher;
    readonly resolve?: Resolver;
  };
}

export type { ActorRunRequest };

/** A running environment. */
export interface EnvironmentHandle {
  readonly id: string;
  /** Its name now: the record's until `environment.rename` sets another (#323). */
  readonly name: string;
  readonly dataDir: string;
  /** Where the loopback listener is bound. */
  readonly address: Address;
  /** Every address a listener is bound to, loopback first, all on one port. */
  readonly addresses: readonly Address[];
  /** `local-only` when only loopback is bound, `tailnet` otherwise. */
  readonly authPolicy: AuthPolicy;
  readiness(): EnvironmentReadiness;
  /** What `environment.status` answers: readiness, idle or busy or draining, and whether updates are managed outside. */
  status(): EnvironmentStatus;
  /**
   * Starts the drain, or joins the one under way, and settles when it has
   * ended and the environment has closed. `serve` calls it on SIGTERM with
   * `signal`; `environment.drain` and the launcher's drain query start the
   * same drain.
   */
  drain(trigger: DrainTrigger): Promise<DrainOutcome>;
  /** Settles when a drain, whatever started it, has ended and the environment has closed: `serve` exits then. */
  readonly drained: Promise<DrainOutcome>;
  /**
   * The methods the wire dispatches into after its scope check: every
   * registry method, with its handler once one is registered. A feature that
   * starts after the environment registers its handlers here.
   */
  readonly methods: MethodTable;
  /** The listener's route table, behind the Host check. */
  readonly http: HttpRoutes;
  /** Issuing (by an in-process pairing) and revoking client sessions from the embedding process. */
  readonly clientSessions: ClientSessionIssuer;
  /**
   * Starts a run on a session for an actor that is no client session (a
   * routine, a bot, the completions surface), as `runs.start` does for a
   * client session: its policy resolved for that actor (#129; attended or
   * not, the unattended default), recorded, then launched once it has
   * committed, in a transaction of its own (`runs/actor-start.ts`, whose
   * in-transaction form a routine's firing starts its run through, #523).
   * The seam the tests of unattended runs (#131) start their runs through.
   * Throws the refusal `runs.start` would answer.
   */
  startRun(request: ActorRunRequest): { readonly runId: string; readonly messageId: string };
  /** How many WebSocket sockets are open on the wire. */
  sockets(): number;
  /** How many subscriptions are open on the wire, across every socket: a count for tests and diagnostics. */
  subscriptions(): number;
  /**
   * The event log: the one sink, whose committed events reach every
   * subscription to their stream. The environment opened it and closes it.
   */
  readonly log: EventLog;
  /**
   * The ForgeService (#310): the one way to a forge, which the banks,
   * skills, routines, the launcher, Set up and the state import call in
   * process, reading a forge account's credential per operation (#312).
   */
  readonly forge: ForgeService;
  readonly banks: BankService;
  /**
   * The key-manager connections (#365): the add the state import (ADR
   * 0036) and the bulk copy call in process, without a credential, and what
   * a test on a held clock waits on once it has moved the clock (`settled`,
   * #745).
   */
  readonly keyManagerConnections: KeyManagerConnections;
  /**
   * Tool terminals (#362): terminals the Managed tools registry owns rather
   * than a session, each running one command through the user's login
   * shell, streamed and answered through the terminal methods by its id,
   * and closed thirty minutes after its command exits. The registry's
   * runner (#376) opens them; the tests open them here.
   */
  readonly toolTerminals: ToolTerminals;
  /** Set up's in-process seams (#571). */
  readonly setup: {
    /** Settles once this start's pass (#571), run past the settle, has checked every registered step: what a routines start pass (#535) and a test wait on. */
    readonly startPass: Promise<void>;
  };
  /** The workspaces' in-process seams (#329). */
  readonly workspaces: {
    /** For a repository identity, the directory a session on it works from here, else scratch: what a routine's move (#92) and hand-off re-resolve through. */
    readonly checkoutIndex: CheckoutIndex;
    /** Settles once this start's resolved identity pass, run once the wire is open, has run: what a test waits on before reading what it left. */
    readonly identityPass: Promise<void>;
    /** Settles once this start's availability pass (#328), run once the wire is open, has looked at every session's workspace. */
    readonly availabilityPass: Promise<void>;
    /** Settles once every removal the reaper has taken up so far (#330), a purge's or the startup sweep's, is done: what a test waits on after a purge. */
    reaped(): Promise<void>;
    /**
     * Marks a session missing in the open transaction `tx`, right after the
     * `session.created` that recorded it with a directory that is gone: the
     * Carry over import's entry (#88; ADR 0021), as `system:workspaces`.
     */
    markMissing(tx: Tx, sessionId: string): void;
  };
  /**
   * The key-manager registry's resolve (#370): how the harness's services
   * read a reference for one operation, in process, with the connection's
   * login, the value registered for scrubbing until its release. The forge
   * reads through it; banks, routine endpoints and the skills check will.
   */
  readonly keyManagers: KeyManagerRegistry;
  /** Move stored tokens (#371). */
  readonly keyManagerMoves: {
    /** Settles once this start, past the gate, has tried again to delete every stored value a Move left behind. */
    readonly leftBehindDeleted: Promise<void>;
  };
  /**
   * Where the harness's services register what they put into every provider
   * process and terminal the environment starts (#307): the forge's (#315),
   * the key managers' (#91). None is registered by default.
   */
  readonly processEnvironments: Pick<ProcessEnvironments, "register">;
  /**
   * The pairing this start minted because the environment is a declared
   * container that no client has paired with yet (ADR 0025; #349): such a
   * container pairs from its own log, so `serve` prints it there, as `pair`
   * prints one. Minted with `pair`'s preset scopes and ceiling, at every
   * start until a code is first exchanged; undefined for any other start.
   */
  readonly startPairing: MintedPairing | undefined;
  /**
   * Stops the sweep, removes the bootstrap grant file, says `bye: draining`
   * to every socket and closes it (1001), stops listening, closes the event log, then closes the
   * launcher channel, each even when another fails. Idempotent; after a failure, calling it
   * again retries what did not close.
   */
  close(): Promise<void>;
}

/**
 * The host a pairing link names: the tailnet name when the tailnet address is
 * bound and has one, else the first address bound beyond loopback, else
 * loopback, which pairs a client on this machine only.
 */
const linkHost = (listening: readonly { readonly address: Address; readonly interface: BoundInterface }[], tailnetName: string | undefined): string => {
  const tailnet = listening.find((entry) => entry.interface === "tailnet");
  if (tailnet && tailnetName !== undefined) return tailnetName;
  const host = (listening.find((entry) => entry.interface !== "loopback") ?? listening[0])?.address.host ?? LOOPBACK;
  return formatHostPort(host);
};

/**
 * Whether `execPath` is the Windows launcher's copy of Node in `dataDir`,
 * `node\node.exe` (the cli's `serveNode`, #1910): the one Node whose path no
 * update changes, so its firewall answer holds. A foreground `serve`, or a
 * version the launcher ran on its own Node when the copy could not be made,
 * runs elsewhere. Windows paths compare without case.
 */
const onServeNode = (execPath: string, dataDir: string): boolean =>
  absolutePath(execPath).toLowerCase() === join(dataDir, "node", "node.exe").toLowerCase();

/**
 * The managed tool `claude` as a sign-in runs it: the path the registry
 * found, which on Windows is only an `.exe`, since a `.cmd` shim needs a
 * shell and a sign-in never runs one (claude-adapter spec).
 */
const signInExecutable = (path: string | null): string | null =>
  path === null || (process.platform === "win32" && !path.toLowerCase().endsWith(".exe")) ? null : path;

/**
 * The running user's name from the passwd database, which the denylist reads
 * `~<name>` as the home directory for. None for a uid with no entry (a
 * container's arbitrary `--user`), where `userInfo` throws on POSIX and no
 * shell expands a `~<name>` either.
 */
const passwdName = (): string | undefined => {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
};

/**
 * Starts an environment: refuses root before anything is created, then runs
 * the startup steps in order. Discovery and health are routed before the bind,
 * so they answer `starting` from the first byte; readiness is `ready` only
 * once `prepared` has been signalled and, under a launcher, committed. A
 * failed step closes what was opened, signals nothing, and rejects with a
 * `StartupError` naming the step.
 */
export const startEnvironment = async (options: EnvironmentOptions = {}): Promise<EnvironmentHandle> => {
  refusePrivilegedUser(options.user ?? processUserCheck());
  const webOrigin = externalWebOrigin(options.webOrigin);
  // Past the refusal, the environment does not run as root (ADR 0006): what `permissions.settings.get` answers as
  // `isRoot`, and the not-root line the Permissions and Your machines steps' checks read from it (#141).
  const isRoot = false;

  // Absolute once, here: a relative `--data-dir` would make the denylist's data-directory preset and its exemption relative paths (#132).
  const dataDir = absolutePath(options.dataDir ?? defaultDataDirectory());
  const harnessVersion = options.harnessVersion ?? HARNESS_VERSION;
  const clock: Clock = options.clock ?? systemClock;
  const now = () => clock.now();
  const scrub = options.scrub ?? createScrubRegistry();
  const launcher = options.launcher ?? processLauncherChannel();
  // The flags found as the environment starts (forge, containment); `self-update` is read as each document is sent, below.
  const capabilities: CapabilityFlags = [];
  // Set when the listeners are bound: local-only until then, which is what binding loopback alone means.
  let authPolicy: AuthPolicy = "local-only";
  // The name the Host check admits: set only once the tailnet address is bound.
  let tailnetName: string | undefined;
  // What the listeners bind beside loopback, for environment.status (#574): nothing until they are bound.
  let boundBeside: Pick<EnvironmentBinding, "tailnet" | "lan"> = { tailnet: null, lan: null };
  // A Tailscale address the machine holds that the start did not bind (#861): found at the listen step with the tailnet setting
  // off, or looked for again at each environment.status while no tailnet address is bound, so a Tailscale installed since shows.
  let tailnetFound: string | null = null;
  // What is found to bind beside loopback: the Tailscale address and name, and the LAN addresses, read as each is asked.
  const interfaces = options.interfaces ?? tailscaleDetector();

  let readiness: EnvironmentReadiness = "starting";
  // When this start was noted (`environment.started`): activity for the idle window, as a run's start is (#445).
  let startedAt: Date | undefined;
  let address: Address | undefined;
  const closers = createCloserStack();
  // Pushed first, so it is let go last: every line the environment writes to its standard error passes the scrub
  // registry, registered values and then shape rules, from here to the end of its close, and of a failed start's (ADR 0011).
  closers.push(scrubDiagnosticOutput((text) => scrub.scrubOutput(text)));
  // Pushed next, so it closes after everything else the environment opens, and only the scrub above is let go after it:
  // after the listener and the event log, and after a failed start too.
  closers.push(() => launcher.close());
  // Concurrent closes share one attempt; a close after a failed one retries what did not close.
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= closers.closeAll().finally(() => (closing = undefined)));

  const step = async <T>(name: StartupStep, work: () => T | Promise<T>): Promise<T> => {
    try {
      await options.hooks?.beforeStep?.(name, { address });
      return await work();
    } catch (error) {
      await closers.closeAll().catch((closeError: unknown) => console.error("Closing after a failed start failed:", closeError));
      throw new StartupError(name, error);
    }
  };

  // The data directory, and the own skills directory (#494) and the routines' scripts directory (#526) in it, made before
  // anything reads them.
  const { ownSkillsPath, scriptsPath } = await step("data-directory", () => {
    prepareDataDirectory(dataDir);
    return { ownSkillsPath: prepareOwnDirectory(dataDir), scriptsPath: prepareScriptsDirectory(dataDir) };
  });

  const log: EventLog = await step("database", () => {
    refuseMarkedRestore(dataDir);
    const opened = openEventLog({ path: join(dataDir, DATABASE_FILE), clock: now, scrub: (text) => scrub.scrub(text) });
    closers.push(() => opened.close());
    return opened;
  });

  await step("projectors", () => {
    for (const projector of [
      sessionListProjector,
      runsProjector,
      settingsProjector,
      permissionsProjector,
      accountsProjector,
      forgeAccountsProjector,
      banksProjector,
      bankDraftsProjector,
      keyManagerConnectionsProjector,
      keyManagerMovesProjector,
      routinesProjector,
      routineEndpointsProjector,
      lookProjector,
      trustProjector,
      instructionsProjector,
      skillChoicesProjector,
      skillSourcesProjector,
      chromesProjector,
      checksProjector,
      stateImportProjector,
      ...(options.projectors ?? []),
    ]) {
      log.registerProjector(projector);
    }
  });

  // Where pairing links point: set when the listeners are bound, before any request is served.
  let linkOrigin: string | undefined;
  // The permission settings (#129), read where they are used: inside a command, in its transaction.
  // What containment can enforce here: probed as the adapter host starts, before any client can ask (#133).
  let containment: ContainmentReport = UNPROBED_REPORT;
  const settingsPresets = () => ({ "permissions.containment.default": presetContainmentDefault(containment) }) as const;
  const permissionSettings = () => readPermissionSettings({ all: (sql, ...params) => log.read(sql, ...params) }, settingsPresets());

  // The bundled Claude binary, which runs, sign-ins and the status probe use; its package is the harness's own, never a managed tool.
  const signInProcess = options.signInProcess ?? {};
  const bundled = signInProcess.bundled !== undefined ? signInProcess.bundled : bundledExecutable();
  // The record, the signing key and the auth tables: client sessions and pairings are read once, here, into memory.
  // The vault is taken hold of first, so every entry is registered for scrubbing before anything reads it (ADR 0011).
  // The forge accounts' store (#310) starts in this step too, after the client sessions whose labels a token handed over
  // from a client's gh records (#312): each stored token is registered with its Basic-auth form, and the vault entries of
  // forge accounts that are gone are deleted, before anything can read them. So do the key-manager connections (#365): each
  // credential the vault holds is registered, and the entries of connections that are gone deleted. They come first, since
  // the forge reads its references through their registry (#370), and the forge accounts holding a reference hold back a
  // connection's removal. The Managed tools registry (#373) is made here too, before the forge, whose gh reads its row.
  const { record, vault, clientSessions, pairings, accessLog, forge, keyManagerConnections, keyManagers, references, moves, managedTools } = await step("identity", async () => {
    const name = (options.name ?? nameOfHostname(options.hostname ?? hostname())).trim();
    if (!name) throw new Error("An environment's name cannot be empty.");
    const { record: loaded, created } = loadOrCreateRecord(dataDir, name, now);
    // The channel a new environment starts on (#846), at the start that creates it alone: a later start keeps the one set since.
    if (created && options.channel !== undefined) writeStartingChannel(log, loaded.id, options.channel);
    // A keychain read that waits on the person, as macOS asks them once an update brings a Node the stored key's access
    // list does not name, is said to the launcher, which pauses its trial's deadline, and to the window (#1689). Only
    // macOS asks: a slow Windows Credential Manager call is no prompt, and is not watched.
    clearCredentialAccess(dataDir);
    const reportCredentialAccess = credentialAccessReporter({ dataDir, version: harnessVersion, launcher, now });
    const loadBinding =
      process.platform === "darwin" ? async () => watchCredentialAccess(await loadKeychainBinding(), reportCredentialAccess) : loadKeychainBinding;
    const { vault: chosen, reason } =
      options.vault === undefined
        ? await chooseVault({ platform: process.platform, asService: launcher.present(), dataDir, environmentId: loaded.id, loadBinding })
        : { vault: options.vault, reason: undefined };
    const vault = await holdVault(chosen, scrub);
    // Logged once every entry is registered, so the scrub on standard error takes a value a keychain's error carried.
    if (reason !== undefined) console.error(reason);
    const key = await ensureSigningKey(vault);
    const access = createAccessLog(log, loaded.id);
    const loadedClientSessions: ClientSessions = createClientSessions({
      table: log.clientSessions,
      accessLog: access,
      key,
      environmentId: loaded.id,
      clock,
    });
    const loadedPairings: Pairings = createPairings({
      table: log.pairings,
      clientSessions: loadedClientSessions,
      accessLog: access,
      clock,
      link: (code) => {
        if (linkOrigin === undefined) throw new Error("A pairing link was asked for before the environment was bound.");
        return pairingLink(linkOrigin, code);
      },
      defaultCeiling: () => permissionSettings()["permissions.defaultCeiling"],
    });
    // The Managed tools registry (#373): its rows are read by the forge's gh and the sign-in director; it probes past the gate.
    const tools: ManagedTools = createManagedTools({
      log,
      clock,
      environmentId: loaded.id,
      dataDir,
      ownResources: [HARNESS_DIRECTORY, ...(bundled === null ? [] : [dirname(bundled)])],
      ...options.managedTools,
    });
    closers.push(() => tools.close());
    const connections = createKeyManagerConnections({
      ...(options.bitwardenSdk !== undefined && { bitwardenSdk: options.bitwardenSdk }),
      log,
      clock,
      environmentId: loaded.id,
      vault,
      scrub,
      ...(options.keyManagerTimeoutMs !== undefined && { budgetMs: options.keyManagerTimeoutMs }),
      // Asked only by a removal, once the wire is open and the forge made below.
      referenceHolders: (connectionId) => [...forgeService.referenceHolders(connectionId), ...endpoints.referenceHolders(connectionId), ...bankCredentials.referenceHolders(connectionId)],
      cliDirectory: join(dataDir, KEY_MANAGER_CLI_DIRECTORY),
      onePasswordSdk: options.onePasswordSdk ?? officialOnePasswordSdk(HARNESS_VERSION),
    });
    closers.push(() => connections.close());
    await connections.start();
    const keyManagerReferences = createKeyManagerReferences({
      connections,
      scrub,
      ...(options.keyManagerTimeoutMs !== undefined && { budgetMs: options.keyManagerTimeoutMs }),
    });
    const registry: KeyManagerRegistry = options.keyManagers ?? keyManagerReferences;
    const forgeService: ForgeService = createForgeService({
      log,
      clock,
      environmentId: loaded.id,
      vault,
      scrub,
      clientSessionLabel: (id) => loadedClientSessions.list({ live: false }).find((session) => session.id === id)?.label,
      ...(options.forgeFetch !== undefined && { fetch: options.forgeFetch }),
      ...(options.forgeTimeoutMs !== undefined && { callTimeoutMs: options.forgeTimeoutMs }),
      // The sessions' repositories, most recently used first, then the skill sources' (#498).
      knownRepositories: () => [...new Set([...knownRepositoryIdentities({ all: (sql, ...params) => log.read(sql, ...params) }), ...readSkillSourceIdentities(log)])],
      gh: managedGh({ row: () => tools.row("gh"), ...(options.managedTools?.hostEnv !== undefined && { hostEnv: options.managedTools.hostEnv }) }),
      keyManagers: registry,
      ...(options.harnessCommand !== undefined && { harnessCommand: options.harnessCommand }),
      ...(options.harnessGitConfig !== undefined && { gitConfig: options.harnessGitConfig }),
      // Where the credential helper asks: the loopback listener, bound after this step.
      address: () => address,
    });
    closers.push(() => forgeService.close());
    await forgeService.start();
    // Move stored tokens (#371): each owning service's items holding a stored value, the forge's first.
    const keyManagerMoves = createKeyManagerMoves({
      log,
      clock,
      environmentId: loaded.id,
      scrub,
      connections,
      registry,
      ...(options.keyManagerTimeoutMs !== undefined && { budgetMs: options.keyManagerTimeoutMs }),
    });
    for (const source of options.moveSources ?? [forgeService.moveSource]) keyManagerMoves.register(source);
    capabilities.push("forge", "keyManagers", "managedTools");
    return {
      record: loaded,
      vault,
      clientSessions: loadedClientSessions,
      pairings: loadedPairings,
      accessLog: access,
      forge: forgeService,
      keyManagerConnections: connections,
      keyManagers: registry,
      references: keyManagerReferences,
      moves: keyManagerMoves,
      managedTools: tools,
    };
  });

  const user = passwdName();
  const bankCredentials = createBankCredentials({ log, environmentId: record.id, forge, vault, references: keyManagers, scrub, command: options.harnessCommand, address: () => address, ...(options.harnessGitConfig !== undefined && { config: options.harnessGitConfig }) });
  await bankCredentials.start();
  if (options.moveSources === undefined) moves.register(createBankMoveSource(log, vault, bankCredentials));
  closers.push(() => bankCredentials.close());
  const bankService = createBankService({
    log, clock, environmentId: record.id, forge, dataDir, scrub, credentials: bankCredentials,
    creation: {
      dataDir, forge, scrub, localPersonName: user ?? "Personal", accounts: () => accounts.list(),
      keyManager: () => {
        const connection = keyManagerConnections.list().find((held) => held.basePath !== null);
        return connection == null ? null : { product: KEY_MANAGER_NAMES[connection.provider], path: connection.basePath! };
      },
    },
  });
  const bankSyncer = createBankSyncer({
    banks: bankService, clock,
    git: (request, bankId) => {
      const git = (request: ForgeGitRequest) => bankService.git(bankId, request);
      return options.banksGit?.(request, git) ?? git(request);
    },
  });
  // The host closes first, ending runs waiting on this syncer before its close releases their deadlines.
  closers.push(() => bankSyncer.close());

  // Where the denylist reads paths from (#132): the user's home for `~` (and for `~<the user's name>`), the file system's
  // links, and the directories inside the data directory where runs work, which the data directory's preset leaves out: the
  // containment directories (#133's) and every workspace root, the scratch workspaces a completions request runs in (#140,
  // now its every call is gated), the worktrees and any root a later workstream declares (#325), and the key-manager CLIs'
  // configuration, which an injected CLI reads (#368, David's decision on it).
  const roots = workspaceRoots(dataDir, options.workspaces?.roots);
  const denylistContext: Omit<DenylistContext, "denylist"> = {
    home: homedir(),
    environmentId: record.id,
    // And the skills a run reads (#496): the own directory, the sources' snapshots and the generations linking to them.
    exempt: [
      join(dataDir, CONTAINMENT_DIRECTORY),
      ...roots.all,
      join(dataDir, KEY_MANAGER_CLI_DIRECTORY),
      ownSkillsPath,
      join(dataDir, SNAPSHOTS_DIRECTORY),
      join(dataDir, GENERATIONS_DIRECTORY),
      join(dataDir, BANKS_DIRECTORY),
    ],
    ...(user !== undefined && { user }),
  };
  const readDenylistNow = () => readDenylist({ all: (sql, ...params) => log.read(sql, ...params) });
  // What git's credential helper is run from (#315): the absolute paths of the command git names (the launcher's shim, or
  // node and the entry it runs); and what it reads as it runs (#705), the shim's service state and versions directory.
  const helperPaths = (options.harnessCommand ?? []).filter((word) => isAbsolute(word));
  const helperReads = (options.harnessReads ?? []).filter((path) => isAbsolute(path));

  // Each repository's auto-memory directory (ADR 0018), which the Claude adapter points runs at, and which the identity passes
  // (#329) and sessions.setWorkspace (#328) carry to a session's new key, one carry at a time.
  const autoMemoryRoot = join(dataDir, AUTO_MEMORY_DIRECTORY);
  const autoMemory = createAutoMemory(autoMemoryRoot);
  closers.push(connectBankMemory(log, autoMemory));

  // The SDK session store (#137): the provider's transcripts beside the log, which every Claude run passes and resumes from.
  const providerStore: ProviderTranscriptStore = createProviderTranscriptStore({ log, clock });

  // Each session's scratch and temporary directories, under the data directory; removed once the session's purge commits, off the log's path.
  const sessionDirectories = containmentDirectories(join(dataDir, CONTAINMENT_DIRECTORY));
  closers.push(
    log.subscribe((event) => {
      if (event.streamKind !== SESSION_STREAM_KIND || event.type !== "session.purged") return;
      const sessionId = event.streamId;
      setImmediate(() => {
        sessionDirectories.remove(sessionId).catch((error: unknown) => console.error(`Removing the containment directories of the purged session ${sessionId} failed:`, error));
      });
    }),
  );

  // Client-tool passthrough (#139): the calls runs make to a completions caller's tools, parked until the caller answers,
  // and the `client` tool server the factory adds for a run whose request declared tools. Closed after the host, whose
  // close ends every run (and so lets go of what each left parked).
  const passthrough = createPassthrough({ log, clock });
  closers.push(() => passthrough.close());
  // The browser tool server on every run (#546): web_read, reading the internal hosts and the denylist as they are at each
  // call, so the one tool serves every run and a kept provider process the next. A redirect's address meets the
  // denylist's hosts section here, as the gate met the address the call named. Beside it the browser's verbs where a run's
  // resolved browser is not none (#551), each call driving the browser of its session's live run as the host holds it then.
  const browserTools = createBrowserToolServers({
    reader: createWebReader({
      clock,
      harnessVersion,
      rules: () => ({
        internalHosts: readSettings({ all: (sql, ...params) => log.read(sql, ...params) })["browser.internalHosts"],
        resolve: options.webRead?.resolve ?? systemResolver,
      }),
      denylisted: (url) => {
        const [match] = readDenylistCall({ ...denylistContext, denylist: readDenylistNow }, { hosts: [url] }, dataDir).matches;
        return match === undefined ? null : describeDenylistMatch(match);
      },
      dial: options.webRead?.dial ?? systemDialer,
      ...(options.webRead?.hooks !== undefined && { hooks: options.webRead.hooks }),
    }),
    environmentId: record.id,
    live: (sessionId) => host.live(sessionId),
    gate: (sessionId) => host.gate(sessionId),
    allowance: (sessionId, call) => {
      const live = host.live(sessionId);
      return live === null ? undefined : browserAllowance({ all: (sql, ...params) => log.read(sql, ...params) }, live.runId, call);
    },
    drivers: {
      // A Chrome paired with this environment is driven by it directly, whoever started the run, so the run keeps its
      // browser when its client closes (#552); another environment's goes through the browser relay (#554).
      chrome: ({ browser: chrome, sessionId, runId }) =>
        chrome.environmentId.toLowerCase() === record.id.toLowerCase()
          ? browser.driverOf(chrome.chromeId)
          : relay.driverOf({ environmentId: chrome.environmentId, chromeId: chrome.chromeId, sessionId, runId }),
      // The headless browser (#555): one driver for every session, a browser context each.
      headless: () => browser.headless.driver,
      dock: ({ sessionId, runId }) => relay.driverOf({ kind: "dock", sessionId, runId }),
      ...options.browser?.drivers,
    },
    // The agent's answer to the several-Chromes question, recorded on the session by the run's adapter (#552).
    chooseChrome: async (ask) => {
      const remote = ask.environmentId.toLowerCase() !== record.id.toLowerCase()
        ? await relay.chromesOf({ ...ask, chromeId: null })
        : undefined;
      if (remote !== undefined && !remote.ok) return remote;
      const live = host.live(ask.sessionId);
      if (live?.runId !== ask.runId) return { ok: false, reason: "This session's run changed before its Chrome could be chosen." };
      return chooseChrome(
        { log, environmentId: record.id, environmentName: () => remote?.environmentName ?? look.read().name, ...(remote !== undefined && { paired: remote.chromes }) },
        { ...ask, actor: formatActor({ kind: "adapter", id: live.descriptor.provider }) },
      );
    },
  });
  const detector = options.containerDetector ?? processContainerDetector();
  const inContainer = detector.inContainer();
  // The environment's own notices: environment.subscribe's stream, whose snapshot is the status and the look.
  const environmentStream = { kind: ENVIRONMENT_STREAM_KIND, id: record.id };
  // Its name, icon and colour (#323): the three commands' notices over the record's name and the presets, read where they
  // are shown, so a rename shows in the next discovery answer, the next hello, the next snapshot and the next run's
  // orientation block.
  const look = createEnvironmentLook({
    log,
    stream: environmentStream,
    presets: { name: record.name, icon: presetIcon(inContainer, options.platform ?? process.platform), colour: presetColour(record.id) },
  });

  // The injection seam is the process environment's; the rest are the host's.
  const { injection, ...hostSeams } = options.adapterSeams ?? {};
  const seamServers = hostSeams.toolServers ?? noToolServers;
  // A run's servers but the completions caller's own: the browser server (#546), then the seam's. Readiness's `mcp`
  // check asks this (#511), since the caller's tools are its request's alone.
  bankService.configureLanding({ forge, scrub,
    temporaryDirectory: (sessionId) => sessionDirectories.of(sessionId).temporaryDirectory });
  // Either bank worker can be queued behind the other: abort both before awaiting either.
  closers.push(async () => { await Promise.all([bankSyncer.close(), bankService.closeLanding()]); });
  // One set of memory operations behind the runs' tools and the CLI's bank verbs, so one queue's changes are serialized whoever asks.
  const memoryOperations = createMemoryOperations({ log, environmentId: record.id, scrub, promote: (bank, sessionId, drafts) => bankService.promote(bank.id, sessionId, drafts) });
  const memoryTools = createMemoryToolServers(memoryOperations);
  const runServers: ToolServerFactory = (scope) => [browserTools(scope), ...memoryTools(scope), ...seamServers(scope)];
  // What the client sessions report of their other connections (#382), dropped as each is revoked or expires.
  const knownEnvironments = createKnownEnvironments({ log, stream: environmentStream, environmentId: record.id, clock, clientSessions });
  closers.push(() => knownEnvironments.close());
  // Every run's orientation block (#380): this environment's section, its accounts' and the key managers' with the standing
  // rule (#381), the forges section where runs are given the forge's variables, and the other environments the clients
  // report (#382), each put in the block's order by its name. A section a test registers takes the place of the
  // environment's own of its name.
  const orientation = createOrientationRenderer({ clock });
  const givenSections = options.orientationSections ?? [];
  const ownSections: OrientationSection[] = [
    environmentSection({ name: () => look.read().name, platform: options.platform ?? process.platform, arch: process.arch, user }),
    accountsSection({ accounts: () => listAccountStandings({ all: (sql, ...params) => log.read(sql, ...params) }) }),
    keyManagersSection({ connections: () => keyManagerConnections.list(), tool: (name) => managedTools.known(name) }),
    ...(forge.orientation === undefined ? [] : [forge.orientation]),
    banksSection(() => listBanks({ all: (sql, ...params) => log.read(sql, ...params) })),
    otherEnvironmentsSection({ union: () => knownEnvironments.union() }),
  ];
  for (const section of [...ownSections.filter((own) => !givenSections.some((given) => given.name === own.name)), ...givenSections]) orientation.register(section);
  // The owned instructions (#505), after the block in the user layer while instructions.orientation is on.
  const orientationSeam = options.orientation ?? orientation.seam;
  const orientationOn = () => readSettings({ all: (sql, ...params) => log.read(sql, ...params) })["instructions.orientation"];
  const instructionStore = createInstructionStore(log);
  // The session's own instructions (#506) fill the session layer.
  const sessionLayer = sessionInstructionsLayer({ all: (sql, ...params) => log.read(sql, ...params) });
  const instructions =
    hostSeams.instructions ?? composeInstructions({ orientation: orientationSeam, orientationOn, owned: ownedInstructionsLayer(instructionStore), teamBank: bankInstructionsLayer(log, autoMemory), session: sessionLayer });
  // What the harness's services put into every provider process and terminal (#307): the forge's variables, git's helper and
  // the run-scoped secret (#315), when the environment has an agent-harness command for git to name as its helper. Whether a
  // holder gets them is the injection setting's answer, read as each holder is built (#367).
  const processEnvironments = createProcessEnvironments(injection ?? settingsInjection(() => readSettings({ all: (sql, ...params) => log.read(sql, ...params) })));
  if (forge.processEnvironment !== undefined) processEnvironments.register(forge.processEnvironment);
  // The injecting key-manager connections' blocks and each holder's run tokens (#368).
  processEnvironments.register(keyManagerConnections.processEnvironment);
  // The managed tools' verify commands (#375): each a holder of the process environment, with a run token of its own.
  const toolVerifier = createToolVerifier({ tools: managedTools, processEnvironments, connections: () => keyManagerConnections.list(), scrub, clock });
  closers.push(() => toolVerifier.close());
  // A tool's doctor (#374), run only when a client opens its detail, or Update is clicked (#376).
  const toolDoctor = createToolDoctor({ tools: managedTools, scrub, clock });
  closers.push(() => toolDoctor.close());

  // The trust gate's decisions (#500), each key read on the canonical host of a verified forge alias: what every run's trust is.
  const trustStore = createTrustStore({ log, forgeAccounts: () => verifiedOrigins(forge.list()) });

  // The data directory's trash (#494): what is removed of what a person wrote, kept thirty days.
  const trash = createTrash({ dataDir, clock });
  // The own skills directory (#494): read at each run's start and each commands listing, as the run's skill set is resolved,
  // and on skills.get, never watched.
  const ownSkills = createOwnDirectory({ log, environmentId: record.id, path: ownSkillsPath, trash });
  closers.push(() => ownSkills.close());
  // Carry over's skills half (#513): skills.carryOver, which carryOver.run runs with the skills tick and whose dry run its
  // inventory counts (#580). The home's .agents/skills is read beside the adopted directory, and its .claude.json too.
  const carryOverHome = options.carryOverHome ?? homedir();
  const carrySkills = skillsCarryOver({ own: ownSkills, environmentId: record.id, account: (id) => host.account(id), home: carryOverHome });
  // The probe (#497): a repository URL's skill folders, cloned through the ForgeService's git under the data directory and
  // kept thirty minutes for an add to reuse.
  const forgeGit = (request: ForgeGitRequest): Promise<ForgeGitAnswer> => forge.git(request);
  const { skillsGit } = options;
  const skillProbes = createSkillProbes({
    dataDir,
    clock,
    git: skillsGit === undefined ? forgeGit : (request) => skillsGit(request, forgeGit),
    forgeAccounts: () => verifiedOrigins(forge.list()),
    environmentName: () => look.read().name,
  });
  closers.push(() => skillProbes.close());
  // The skill sources (#498): a folder added from a probe's checkout, or a fetch, exported at its commit into a snapshot.
  const skillSources = createSkillSources({ log, environmentId: record.id, dataDir, clock, probes: skillProbes, forgeAccounts: () => verifiedOrigins(forge.list()) });
  // The syncer (#499): each unpinned source at start past the gate, every six hours staggered, on Pull now and at once
  // when unpinned; never before a run.
  const skillSync = createSkillSync({ log, environmentId: record.id, clock, sources: skillSources });
  // The materialiser (#496): each run's skill set as its fingerprint and generation, a generation kept while a live process
  // holds it or a resolution holds it current.
  const generations = createGenerations({ dataDir, clock });
  // The skill set as it is now, which a routine's skills are checked against: its attention, and its firing's start (#531).
  const readSkillSet = skillSetReader({ own: ownSkills, sources: skillSources, log });

  // A routine's result is delivered once its entry's end commits (#525): followed before the firings' ends, and closed after
  // them, so an end the recovery sweep or the host's close appends is delivered too.
  closers.push(followDeliveries({ log, clock: now, environmentId: record.id }));
  const webhookDeliveries = createWebhookDeliveries({
    log, clock, environmentId: record.id, name: () => look.read().name, scrub,
    endpoint: (name) => endpoints.resolve(name),
  });
  closers.push(() => webhookDeliveries.close());
  // A routine's firing ends as its run does (#523): followed from before the adapter host starts, so the recovery sweep's end
  // of a run a crash cut is heard, and closed after the host, so the ends the host's close appends are heard too.
  closers.push(followFiringEnds({ log, clock: now, environmentId: record.id }));

  // The environment's resolver of a new session's workspace (#321). Its identity rule reads this environment's forge accounts
  // with their verified aliases, at creation, in inspect (#329) and in a new session's instruction preview (#1072).
  const forgeAccounts = () => verifiedOrigins(forge.list());
  const environmentResolver = createWorkspaceResolver({ ...options.workspaces, log, dataDir, roots, forgeAccounts });
  // The environment's turns at a workspace's files (#1183): a file tool's capture and files.undo's restore take them.
  const workspaceWrites = createWorkspaceWrites();
  // The account store and the adapter host: the adapters, the accounts' sign-in states read through their probes, the run registry.
  const { host, accounts } = await step("adapter-host", async () => {
    // The denylist's presets on first start (#132), before any run can be gated.
    seedDenylist({ log, stream: accessLog.stream, dataDir });
    // First the recovery sweep: a run the log left without an end was cut by the last stop, and is ended before anything can read it.
    const recovered = recoverCutRuns({ log, clock });
    if (recovered.length > 0) console.error(`The recovery sweep ended ${recovered.length} run(s) a restart cut: ${recovered.join(", ")}.`);
    // Then the queued messages' attachment bytes, read back from the stage, so a message the sweep handed back keeps them (#185).
    const attachmentStage = createAttachmentStage(join(dataDir, ATTACHMENTS_DIRECTORY));
    const stagedAttachments = recoverStagedAttachments({ log, stage: attachmentStage });
    const adapters = options.adapters ?? [createClaudeAdapter({ clock, autoMemoryRoot, sessionStore: providerStore })];
    // The probe never fails a start: a probe that throws leaves nothing but off, and says why.
    let probed: ContainmentReport;
    try {
      probed = containmentReport(await (options.probeContainment ?? (() => probeContainment()))());
    } catch (error) {
      console.error("The containment probe failed; only off is offered:", error);
      probed = failedProbeReport(error);
    }
    // A workspace level needs an adapter that hands it to its provider's sandbox, as well as the machine (#133).
    containment = withAdapters(
      probed,
      adapters.map((adapter) => adapter.descriptor),
    );
    capabilities.push(...containmentFlags(containment));
    const settings = () => readSettings({ all: (sql, ...params) => log.read(sql, ...params) });
    // The sign-in director (#135): Claude accounts sign in through the bundled binary, else the managed tool `claude`, the
    // registry's row (#373).
    const signIn =
      options.signIn ??
      createSignInDirector({
        log,
        clock,
        environmentId: record.id,
        programs: {
          [CLAUDE_PROVIDER]: claudeSignInProgram({
            bundled,
            ...(signInProcess.hostEnv !== undefined && { hostEnv: signInProcess.hostEnv }),
            managedTool: signInProcess.managedTool ?? (async () => signInExecutable((await managedTools.row("claude")).path)),
          }),
        },
        ...(signInProcess.spawn !== undefined && { spawn: signInProcess.spawn }),
        ...(signInProcess.cwd !== undefined && { cwd: signInProcess.cwd }),
      });
    // The account store (#134): the configured accounts carried over once, then every account's status read, and read
    // again at most every fifteen minutes; its reads before the wire opens notice nothing.
    const store: AccountService = createAccountService({
      log,
      clock,
      adapters,
      environmentId: record.id,
      ownedRoot: join(dataDir, ACCOUNTS_DIRECTORY),
      configured: options.accounts ?? [],
      defaults: () => {
        const values = settings();
        return { account: values["accounts.defaultAccount"], modelFamily: values["accounts.defaultModelFamily"], effort: values["accounts.defaultEffort"] };
      },
      signIn,
      ...(options.probeTimeoutMs !== undefined && { probeTimeoutMs: options.probeTimeoutMs }),
    });
    closers.push(() => store.close());
    await store.start();
    const created = createAdapterHost({
      log,
      clock,
      scrub,
      attachmentStage,
      stagedAttachments,
      ...(options.runs !== undefined && { runs: options.runs }),
      adapters,
      accounts: store,
      // The policy resolver on the permission settings, and each client session's ceiling as it is now (#129).
      resolvePolicy: ({ actor, requested, accountModes, containment: level }) =>
        resolvePolicy({
          actor,
          requested,
          ceiling: actor.ceiling,
          accountModes,
          settings: policySettings(permissionSettings(), readStoredContainmentDefault({ all: (sql, ...params) => log.read(sql, ...params) })),
          containment: level,
          enforceable: containment,
        }),
      // Each run's browser (#550): the session's field by whether a person is present, the operator's switch as it is at the
      // run's start, and whether a headless browser is here, as the headless browser answers it (#555).
      resolveBrowser: (request) =>
        resolveRunBrowser(request, {
          allowRuns: settings()["browser.headless.allowRuns"],
          headless: options.browser?.headless?.() ?? browser.headless.availability(),
        }),
      containmentDirectories: sessionDirectories,
      processEnvironments,
      ceilingOf: (id) => clientSessions.ceiling(id),
      // A routine's skills for a run the environment starts for it after a restart, as its firing recorded them (#531).
      routineSkills: (sessionId) => firingSkillsOfSession({ all: (sql, ...params) => log.read(sql, ...params) }, sessionId),
      // The unattended and bypass rules, and the TTL a prompt that parks is fixed with (#131).
      autoAnswer,
      // The tool gate's rules (#132): the denylist, read as it is when each call is made.
      gateRules: [denylistRule({ ...denylistContext, denylist: readDenylistNow })],
      bankCheckouts: (scope) => bankCheckouts(bankService.entries().map(({ entry }) => entry), scope),
      // What an unattended run projects onto its provider's own rules (#140), read as it starts.
      // Projected onto an unattended run's sandbox: the directories git's credential helper is read from (#315), and the paths
      // it reads as it runs (#705), where the denylist covers them, are exempt too, so the sandbox lets the helper run.
      providerDenylist: () => {
        const denylist = readDenylistNow();
        const context = { ...denylistContext, denylist: () => denylist };
        const helper = [...coveredDirectories(context, helperPaths), ...coveredPaths(context, helperReads)];
        return providerDenylist(denylist, { ...denylistContext, exempt: [...denylistContext.exempt, ...helper] });
      },
      promptTtlMs: () => parkedPromptTtlMs(permissionSettings()["permissions.parkedPrompt.ttl"]),
      processIdleMinutes: options.processIdleMinutes ?? (() => settings()["providers.processIdleMinutes"]),
      // A run's trust, read once as it launches: its key and the decision recorded for it (#500).
      trust: (place) => trustStore.of(place),
      identityAt: (path) => environmentResolver.identityAt(path),
      // A run's skill set, resolved as it launches and at each commands listing, and its generation held by the processes
      // spawned under it (#496).
      skillSet: runSkillSets({ own: ownSkills, sources: skillSources, log, generations }),
      holdGeneration: generations.hold,
      ...hostSeams,
      instructions,
      beforeRun: bankSyncer.beforeRun,
      // The browser server (#546), the seam's servers, then the caller's own tools as the `client` server (#139).
      toolServers: (scope) => [...runServers(scope), ...passthrough.toolServers(scope)],
      // What each run's recognised file tools change, kept for files.undo (#1183).
      fileChanges: fileChangeObserver({ log, writes: workspaceWrites }),
    });
    // Closed before the event log, so a run the close ends has its end appended (drained when a drain's cap cut it), and
    // before the launcher's channel, so the launcher hears the environment go only once every provider process has
    // stopped, or has been killed after the stop timeout.
    closers.push(() => created.close(readiness === "draining" ? "drained" : "disposed"));
    return { host: created, accounts: store };
  });

  // Plan usage (#136): one reading per account, read through the host and kept six minutes, a run's plan.limit folded in
  // from the log, usage.updated on a change; heard from here on, before the wire opens.
  const usagePool = createUsagePool({
    log,
    clock,
    environmentId: record.id,
    accounts,
    host,
    ...(options.usageReadTimeoutMs !== undefined && { readTimeoutMs: options.usageReadTimeoutMs }),
  });
  closers.push(() => usagePool.close());

  // A container with no launcher: a host-side updater manages its updates, and it never updates itself (ADR 0007).
  const updatesManagedOutside = inContainer && !launcher.present();
  // Managed outside, the host-side updater's polls, the last kept in the data directory (#348).
  const hostUpdater = createHostUpdaterPolls({ clock, dataDir, managedOutside: updatesManagedOutside });
  // Under a launcher the environment can update itself to a client's version (ADR 0007); managed outside, while the
  // host-side updater polled in the last fifteen minutes (#348); under a foreground `serve` it cannot, and
  // `updates.status` says why. Read as discovery answers and as each hello is sent.
  const flags = (): CapabilityFlags => (launcher.present() || hostUpdater.selfUpdate() ? ["self-update", ...capabilities] : [...capabilities]);

  let allowsAdditionalOrigin: (origin: string) => boolean = () => false;
  const surface = createHttpSurface({ tailnetName: () => tailnetName ?? (webOrigin ? new URL(webOrigin).hostname : undefined), ...(webOrigin && { webOrigin }), webOriginAllowed: origin => allowsAdditionalOrigin(origin) });
  const origins = webOriginPolicy(log, surface, record.id);
  serveWebClient(surface, options.webClientDirectory, [], origins.connectOrigins);
  allowsAdditionalOrigin = origins.allows;
  const noStore = { "cache-control": "no-store" };
  surface.route("GET", DISCOVERY_PATH, (_request, response) => {
    const { name, icon, colour } = look.read();
    const document: DiscoveryDocument = {
      environmentId: record.id,
      environmentName: name,
      environmentIcon: icon,
      environmentColour: colour,
      harnessVersion,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: flags(),
      authPolicy,
      readiness,
    };
    sendJson(response, 200, document, noStore);
  });
  surface.route("GET", HEALTH_PATH, (_request, response) => {
    const health: HealthDocument = { status: readiness, version: harnessVersion };
    sendJson(response, 200, health, noStore);
  });

  // A prompt that parks, and its answer, are told to every client there (#130), as is a change to the Unattended review (#811);
  // stopped before the event log closes.
  closers.push(startPromptNotices({ log, stream: environmentStream }));
  closers.push(startReviewNotices({ log, stream: environmentStream }));
  // The reaper (#330): a purged session's workspace inside a workspace root goes once the purge commits, off the log's path,
  // when no other session names it; a worktree with work in it stays, noticed. Closed before the log, letting its work end.
  const reaper = createReaper({
    log,
    roots,
    stream: environmentStream,
    ...(options.workspaces?.gitTimeoutMs !== undefined && { gitTimeoutMs: options.workspaces.gitTimeoutMs }),
  });
  closers.push(() => reaper.close());
  // The purge: `sessions.purge` runs it at once, the minute sweep for every session past its grace period.
  const deletion = createDeletion({ log, transcripts: host.transcripts, providerStore, fileChanges: log.fileChanges, onPurged: (purged) => reaper.purged(purged) });
  // File undo (#1183): the newest change a run's file tool made, restored under the workspace's turn the captures take too.
  const fileUndo = createFileUndo({ log, host, writes: workspaceWrites, ...(options.fileUndoHooks !== undefined && { hooks: options.fileUndoHooks }) });
  capabilities.push("fileUndo");
  // An imported session's history, read from the adopted directory the first time a client opens it (#579).
  const importedHistory = createImportedHistory({ log, host });
  // The availability watcher (#328): a session's workspace found gone or back, marked on the list, by the run commands'
  // and terminals.open's looks and what the file and diff methods find; its passes start once the wire is open.
  const availability = createAvailabilityWatcher({
    log,
    clock,
    ...(options.workspaces?.isDirectory !== undefined && { isDirectory: options.workspaces.isDirectory }),
    ...(options.workspaces?.lookTimeoutMs !== undefined && { lookTimeoutMs: options.workspaces.lookTimeoutMs }),
  });
  // The terminals (#124): their output never enters the log; closed before the log is, and on a session's deletion. Each
  // holds its session's process environment as its runs' processes do (#307): the account its runs go through, a client's.
  const terminalService = createTerminalService({
    log,
    clock,
    scrub,
    availability,
    runPath: async () => (await managedTools.commandEnvironment())["PATH"] ?? "",
    ...options.terminals,
    processEnvironment: (sessionId) => {
      const session = readSessionFacts(log, { all: (sql, ...params) => log.read(sql, ...params) }, sessionId);
      return processEnvironments.of({ sessionId, accountId: host.account(session?.account ?? null)?.id ?? null, origin: "client", holder: "terminal", override: null });
    },
  });
  closers.push(() => terminalService.close());
  // Workspace checks (#1187): each directory's command, run in the session's terminals as terminals.run runs one; closed
  // before the terminals, so a check the stop cuts short is recorded interrupted. A check a crash cut is recorded as it starts.
  const workspaceChecks = createWorkspaceChecks({ log, clock, environmentId: record.id, terminals: terminalService.commands, scrub, canRun: (id) => clientSessions.list({ live: true }).some((client) => client.id === id && client.scopes.includes("terminal")) });
  closers.push(() => workspaceChecks.close());
  capabilities.push("workspaceChecks");
  // Install and Update in a tool terminal (#376): closed before the terminals, so a run the stop cuts short is recorded finished.
  const toolRunner = createToolRunner({
    tools: managedTools,
    toolTerminals: terminalService.tools,
    doctor: toolDoctor,
    verifier: toolVerifier,
    log,
    clock,
    environmentId: record.id,
    ...(options.managedTools?.commands !== undefined && { commands: options.managedTools.commands }),
  });
  closers.push(() => toolRunner.close());
  const lifecycle = createLifecycle({
    clock,
    runs: host.runs,
    log,
    stream: environmentStream,
    updatesManagedOutside,
    // The idle window (#342): how long nothing may start or end, and how long a parked prompt counts as busy.
    idleWindowMs: () => readSettings({ all: (sql, ...params) => log.read(sql, ...params) })["updates.idleWindowMinutes"] * 60_000,
    // A terminal whose shell runs a command holds the environment busy as a run does (#343).
    terminalRunning: () => terminalService.terminals.commandRunning(),
    // The start holds it busy for the window too (#445): the runs the stop before it cut are in the log, not the run registry.
    startedAt: () => startedAt,
    readiness: () => readiness,
    binding: () => ({
      ...boundBeside,
      tailnetFound,
      ...(interfaces.tailscaleInstalled !== undefined && { tailscaleInstalled: interfaces.tailscaleInstalled() }),
      // Windows Firewall asks once whether the environment's Node may accept connections (#1910), when it runs on the launcher's copy; the Reachability section says so beforehand.
      ...((options.platform ?? process.platform) === "win32" && onServeNode(options.execPath ?? process.execPath, dataDir) && { firewallAsksOnce: true as const }),
      lanAddresses: [...interfaces.lanAddresses()],
    }),
    lookAgain: async () => {
      if (boundBeside.tailnet === null) tailnetFound = (await interfaces.tailscaleAddress()) ?? null;
    },
    onDraining: () => {
      readiness = "draining";
      // New runs are refused before any process stops, so none starts on a process the drain is stopping.
      host.runs.refuseNewRuns();
      // Idle provider processes stop now, busy ones as their turns end; a failure here never stops the drain.
      try {
        host.drain();
      } catch (error) {
        console.error("Stopping the idle provider processes for the drain failed; the drain goes on:", error);
      }
    },
    // An update's drain that waited its runs out ends with bye: updating to every client and the launcher's switch (#343),
    // or, managed outside, at the host-side updater's stop (#348); one the environment's close cut short closes as any
    // drain does.
    close: async (ended) => {
      try {
        if (ended.trigger === "update" && ended.endedBy !== "closed") {
          await updates.afterDrain(() => wire.close({ reason: "updating", message: "The environment is updating to a new version and will be back shortly." }));
        }
      } finally {
        await close();
      }
    },
  });
  // The release channel (#346): read through the ForgeService with the forge account for the release origin, two minutes
  // after the start, hourly, on updates.check and once the settings the target follows change.
  const releaseSource = options.releaseSource ?? RELEASE_SOURCE;
  const releaseChannel = createReleaseChannel({
    forge,
    source: releaseSource,
    harnessVersion,
    databaseSchemaVersion: () => Number(log.read<{ user_version: number }>("PRAGMA user_version")[0]?.user_version ?? 0),
    ...(options.launcherProtocol !== undefined && { ownLauncherProtocol: options.launcherProtocol }),
  });
  const channelSettings = (): ChannelSettings => channelSettingsOf(readSettings({ all: (sql, ...params) => log.read(sql, ...params) }));
  // The update coordinator (#343, #347): what a check found staged, the pending update, read back from the log, its wait,
  // its drain and the switch.
  const updates = createUpdateCoordinator({
    log,
    clock,
    stream: environmentStream,
    dataDir,
    environmentName: look.read().name,
    harnessVersion,
    launcher,
    managedOutside: updatesManagedOutside,
    runs: host.runs,
    host,
    availability,
    activity: () => lifecycle.status().activity,
    deferralCapMs: () => readSettings({ all: (sql, ...params) => log.read(sql, ...params) })["updates.deferralCapHours"] * 60 * 60_000,
    settings: channelSettings,
    channel: releaseChannel,
    channelRead: (read, at) => channelChecks.readByRequest(read, at),
    drain: (cause) => void lifecycle.drain("update", cause),
  });
  const channelChecks = createChannelChecks({
    clock,
    dataDir,
    channel: releaseChannel,
    settings: channelSettings,
    context: () => updates.channelContext(),
    follow: (reading, settings) => updates.follow(reading, settings),
    // A check that changed the newest or the last check updates.status shows (#1795): a client reads it again, a desktop checks its build.
    said: (payload) => void log.append(environmentStream, [{ type: "environment.channel-checked", payload }], { actor: UPDATES_ACTOR }),
  });
  // The shelf's sweep (#117): started once the environment is ready; a settings change runs it from the change's commit.
  const settleSweep = createSettleSweep({ log, clock });
  // A new session's workspace, from the request `sessions.create` or the completions surface makes (#321).
  const workspaceResolver = options.workspaceResolver ?? environmentResolver;
  // A routine's firing starts through the resolver and the actor start (#523); closed before the host, letting its starts end.
  // For a repository identity, where a session on it works here (#329): a routine's import re-resolves through it (#528).
  const checkoutIndex = createCheckoutIndex({ log, availability });
  // The scripts routines' pre-checks run (#526), which the OS user places, and what runs a pre-check: a script there, run
  // uncontained as the environment's own process, or a URL whose every host meets the denylist's hosts.
  const scripts = scriptsDirectory(scriptsPath, { platform: options.platform ?? process.platform, env: process.env });
  const denylistedHost = (url: string): boolean => readDenylistCall({ ...denylistContext, denylist: readDenylistNow }, { hosts: [url] }, dataDir).matches.length > 0;
  const preChecks = createPreCheckRunner({
    scripts, clock, directoryRules: environmentResolver, denylisted: denylistedHost, scrub,
    baseEnvironment: () => baseEnvironment(),
    processEnvironment: (subject) => processEnvironments.of({
      sessionId: null,
      accountId: routineAccount(subject.account, { reader: { all: (sql, ...params) => log.read(sql, ...params) }, accounts })?.id ?? null,
      origin: "routine",
      holder: "pre-check",
      override: subject.routine === null || subject.injection === "inherit"
        ? null
        : { answer: subject.injection, level: { kind: "routine", id: subject.routine.id } },
    }),
  });
  const firings = createFiringStarter({
    log,
    clock: now,
    environmentId: record.id,
    environmentName: () => look.read().name,
    host,
    accounts,
    resolver: workspaceResolver,
    preChecks,
    readSkillSet,
  });
  closers.push(() => firings.close());
  // A firing's live run is interrupted at its maximum duration (#524): followed once the host has started, and closed before it.
  closers.push(limitFiringDurations({ log, clock, host }));
  // The extension's folder and its listener (#547), and the paired Chromes (#548): bound and made once the start is
  // committed, below.
  const browser = createBrowserService({
    log,
    clock,
    stream: environmentStream,
    environmentId: record.id,
    name: () => look.read().name,
    harnessVersion,
    dataDir,
    extensionSource: options.browser?.extensionSource ?? EXTENSION_BUILD,
    ports: options.browser?.ports ?? EXTENSION_LISTENER_PORTS,
    vault,
    // The headless browser (#555): an endpoint, else a Chromium it launches, never in a container the install declared.
    headless: {
      declaredContainer: detector.declared?.() ?? false,
      find: (named) =>
        findHeadlessExecutable(named, {
          platform: options.platform ?? process.platform,
          env: process.env,
          home: homedir(),
          isExecutable: options.browser?.isExecutable ?? isExecutableFile,
        }),
      launch: options.browser?.launch ?? spawnBrowser,
      resolve: options.browser?.resolve ?? systemResolver,
    },
  });
  // Set up's health checks (ADR 0031; #141, #308): each registered step's, on this environment, each result kept in the
  // result cache beside the log and a change noticed on the environment stream (#569), which the `setup` flag offers.
  // The state import's source reader (#581): what it finds is read on each ask, by stateImport.detect and Carry over's check.
  const stateImportSource = options.stateImportSource ?? { env: process.env, platform: process.platform, home: homedir() };
  // The environment's one state import at a time (#1165), which serves stateImport.run (its flag is offered after setup's).
  const stateImports = createImportCoordinator();
  // The BankRegistry and the BankService's verification (#1025): what the Memory bank step reads, and the banks.* methods.
  capabilities.push("banks");
  const banks = bankRecords(bankService);
  // One local preview for the Instructions row and its health check, even when the orientation switch is off.
  // Read the injection setting directly; health never decides a provider process or materialises its skills.
  const orientationInjection = settingsInjection(() => readSettings({ all: (sql, ...params) => log.read(sql, ...params) }));
  const readOrientation = async () => {
    const accountId = accounts.defaultId();
    return accountId === null ? null : orientationSeam(host.orientationScope(accountId, { kind: "scratch", path: roots.scratch }, orientationInjection({ sessionId: null, accountId, origin: "client", holder: "provider-process", override: null })));
  };
  const stateCheckOptions: StateChecksOptions = {
    log,
    orientation: readOrientation,
    skills: { sources: () => readSkillSources(log).map((source) => skillSources.view(source)), ownPath: ownSkillsPath, clock },
    adapters: host.adapters,
    detectStateImport: () => detectSource(stateImportSource),
    stateImport: {
      environmentId: record.id,
      underWay: () => stateImports.underWay()?.importId ?? null,
    },
    containment,
    isRoot,
    dataDir,
    releaseChannel: (request) => channelChecks.releaseChannelHolds(request),
    // A client's ask reads the channel again first (#1848), so the step is behind as that read found it.
    updates: async (request) => {
      await channelChecks.readAsAsked(request);
      return updates.machineHolds(channelChecks.status().newest, look.read().name);
    },
    hostUpdater: () => hostUpdater.holds(),
    forge,
    keyManagerConnections,
    managedTools,
    clock,
    look: () => look.read(),
    accounts: () => accounts.list(),
    status: () => lifecycle.status(),
    lanAddresses: () => interfaces.lanAddresses(),
    banks,
    browser,
    version: harnessVersion,
  };
  const setupSteps: SetupSteps = options.setupSteps ?? {
    steps: STEP_REGISTRY,
    stateChecks: environmentStateChecks(stateCheckOptions),
    doneLines: environmentDoneLines(stateCheckOptions),
    // The LLM steps' own sides (#584): the Memory bank step's describe session works in a worktree of a bank (#586).
    llmSteps: { "memory-bank": describeBankStep({ banks, clock, dataDir }) },
  };
  const setup = createSetupService({ log, clock, presets: settingsPresets(), stream: environmentStream, steps: setupSteps });
  capabilities.push("setup");
  capabilities.push("stateImport");
  /** A client session's label, which sentences and records name it by; undefined for one never issued. */
  const clientSessionLabel = (id: string): string | undefined => clientSessions.list({ live: false }).find((session) => session.id === id)?.label;
  // The browser relay (#554): a verb on a Chrome paired with another environment goes to the client session that started
  // the session's latest client-started run, as a client.call it answers with client.answer, while it holds an open socket.
  const relay = createBrowserRelay({ log, clock, stream: environmentStream, connected: (clientSessionId) => wire.holds(clientSessionId), clientLabel: clientSessionLabel, scrub: (text) => scrub.scrub(text) });
  closers.push(() => relay.close());
  // The routines' webhook endpoints (#522): each pasted secret in the vault, each URL's host checked against the denylist's
  // hosts as it is at the set, and a test's payload naming the environment as it is named now.
  const endpoints = createRoutineEndpoints({
    log,
    clock,
    stream: environmentStream,
    environmentId: record.id,
    name: () => look.read().name,
    vault,
    denylisted: denylistedHost,
    connectionLabel: (id) => keyManagerConnections.readable(id)?.record.label ?? null,
    keyManagers,
    scrub,
  });
  const attention = await webAttention({ log, vault, clock, environmentId: record.id, webOrigin: () => webOrigin, endpoints });
  closers.push(attention.close);
  if (options.moveSources === undefined) moves.register(endpoints.moveSource);
  // The environment's accounts now, each with its adapter's descriptor: what the Instructions and Skills panes say of each one's channel.
  const listedAccounts = () => accounts.list().map(({ id, label, provider }) => ({ id, label, provider, descriptor: accounts.facts(id)?.descriptor ?? null }));
  // Read only listed directories: source use selects Accounts, and the shared inventory previews them before adoption.
  const listImportSessions = (directory: string) => {
    const adapter = host.adapters.get("claude");
    if (adapter?.listSessions === undefined) throw new Error("The Claude adapter cannot list source use.");
    return adapter.listSessions({ id: "state-import-preview", directory });
  };
  const sharedCarrySources = () => accounts.list().filter((account) => account.provider === "claude" && account.directory.kind === "adopted").map((account) => ({
    directory: account.directory.path,
    sourceId: log.read<{ source_id: string }>("SELECT source_id FROM state_import_items WHERE kind = 'account' AND target_id = ? AND source_directory = ? ORDER BY source_id LIMIT 1", account.id, account.directory.path)[0]?.source_id ?? account.id,
  }));
  const importInventory = sourceAccountInventories({
    log, accounts, machine: stateImportSource, coordinator: stateImports, listSessions: listImportSessions,
    inventory: directoryInventory({ log, sharedSources: sharedCarrySources, adapters: host.adapters, looks: { look: (path) => availability.look(path), identityAt: (path) => environmentResolver.identityAt(path) }, autoMemory, skills: carrySkills, home: carryOverHome }),
  });
  const skillHandlers = skillsMethods({
    log,
    trust: (place) => trustStore.of(place),
    nativeRoots: (accountId) => accountId === null ? [] : host.account(accountId)?.descriptor.nativeSkillRoots ?? [],
    environmentId: record.id,
    own: ownSkills,
    defaultAccountId: () => accounts.defaultId(),
    accounts: listedAccounts,
    carryOver: carrySkills,
    probe: skillProbes.probe,
    sources: skillSources,
    sync: skillSync,
  });
  const carryOver = createCarryOver({ log, sharedSources: sharedCarrySources, environmentId: record.id, host, availability, identityAt: (path) => environmentResolver.identityAt(path), autoMemory, skills: carrySkills, home: carryOverHome, stateImportInventory: importInventory, coordinator: stateImports });
  const routineHandlers = routineMethods({
    log,
    clock: now,
    environmentId: record.id,
    environmentName: () => look.read().name,
    timeZone: options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    accounts,
    ceilingOf: (id) => clientSessions.ceiling(id),
    firings,
    workspaces: createRoutineWorkspaces({ directoryRules: environmentResolver, checkoutIndex }),
    scripts,
    denylisted: denylistedHost,
    readSkillSet,
  });

  // The owned instructions' methods (#505), whose create command the state import carries each instruction through (#1165).
  const instructionHandlers = instructionMethods({
    host,
    log,
    environmentId: record.id,
    store: instructionStore,
    accounts: listedAccounts,
    orientationOn,
    catalogue: options.catalogue ?? (() => CATALOGUE),
    // The Orientation row's block: as the first run of a new session of the default account, started from a client, is handed it.
    orientation: readOrientation,
  });
  const settingsHandlers = settingsMethods({ log, environmentId: record.id, onChange: (keys) => settleSweep.settingsChanged(keys), presets: settingsPresets() });
  closers.push(followDeferredDefaults({ log, accounts, environmentId: record.id, onChange: () => settleSweep.settingsChanged(["accounts.defaultAccount"]) }));
  const sessionHandlers = sessionMethods({
      log,
      clock: now,
      deletion,
      resolver: workspaceResolver,
      // An imported session's history, appended the first time a client opens it (#579).
      beforeOpen: importedHistory.beforeOpen,
      validateRunParameters: host.validateSessionInput,
      clampSessionMode: sessionModeClamp({ host, ceilingOf: (id) => clientSessions.ceiling(id) }),
    });
  const table = createMethodTable({
    ...origins.handlers, ...attention.handlers,
    ...lifecycle.handlers,
    // The snapshot, sent when replay from the cursor is out of bounds: the status now, the look (#323), and every step's cached
    // result (#569).
    "environment.subscribe": () => ({ stream: environmentStream, snapshot: () => ({ status: lifecycle.status(), environment: look.read(), setup: setup.cached(), stateImportFailures: lastImportFailures(log, record.id) }) }),
    ...look.handlers,
    ...knownEnvironmentsMethods(knownEnvironments),
    // The rebuild joins the command's transaction, so it and the receipt commit together.
    "environment.rebuildProjections": () => ({
      aggregate: environmentStream,
      result: { projectors: [...log.rebuildProjections()], sequence: log.head() },
    }),
    // The generic settings (#117), on the environment's settings stream.
    ...settingsHandlers,
    ...accessMethods({ pairings, clientSessions, accessLog }),
    ...sessionHandlers,
    // A missing session given another workspace (#328), from a request the create's resolver serves.
    ...setWorkspaceMethods({ log, host, resolver: workspaceResolver, availability, autoMemory }),
    ...groupMethods({ log, clock: now }),
    // Fork, rewind and the subagent transcript (#137), beside the session commands.
    ...forkRewindMethods({
      log,
      host,
      clock,
      store: providerStore,
      validateRunParameters: host.validateSessionInput,
      clampSessionMode: sessionModeClamp({ host, ceilingOf: (id) => clientSessions.ceiling(id) }),
    }),
    ...runMethods({ log, host, ceilingOf: (id) => clientSessions.ceiling(id), availability, beforeContinuation: (sessionId) => importedHistory.beforeContinuation(sessionId) }),
    ...permissionMethods({ log, host, accessLog, clock, environmentId: record.id, ceilingOf: (id) => clientSessions.ceiling(id), containment, isRoot }),
    ...promptMethods({ log, host, environmentId: record.id }),
    ...reviewMethods({ log, environmentId: record.id }),
    ...denylistMethods({ log, accessLog, environmentId: record.id, dataDir, context: denylistContext }),
    ...setupMethods(setup),
    // An LLM step's minted session (#584): created and started as sessions.create and runs.start would, in process.
    ...mintMethods({ log, host, resolver: workspaceResolver, steps: setupSteps, ceilingOf: (id) => clientSessions.ceiling(id) }),
    ...processMethods({ log, host }),
    ...accountMethods({ accounts, host }),
    ...instructionHandlers,
    ...sessionInstructionsMethods(log),
    ...forgeMethods(forge),
    ...bankMethods(bankService, bankCredentials, bankSyncer),
    ...splitMethods(bankService, record.id),
    ...migrationMethods(bankService, record.id, forge),
    ...validatorUpdateMethods(bankService, record.id),
    ...memoryMethods(memoryOperations, () => accounts.defaultId()),
    "banks.drafts.list": async ({ sessionId, bankId }) => {
      const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
      const session = readSessionFacts(log, reader, sessionId);
      if (session === null || session.deleted) {
        throw new ContractError({ code: "not_found", message: `No session ${sessionId} is on this environment.`, data: { kind: "session", sessionId } });
      }
      return { queues: listBankDrafts(reader, sessionId, bankId) };
    },
    ...keyManagerMethods(keyManagerConnections, references, moves, managedTools, options.keyManagerTimeoutMs),
    ...managedToolsMethods(managedTools, toolDoctor, toolVerifier, toolRunner),
    // The routine store's commands and list (#521), on each routine's own stream; run now and the history (#523).
    ...routineHandlers,
    ...preCheckMethods({ log, clock: now, scripts, preChecks }),
    ...endpoints.handlers,
    ...usageMethods({ pool: usagePool, accounts, clock }),
    ...terminalService.handlers,
    ...fileUndo.handlers,
    ...workspaceChecks.handlers,
    // Browsing and inspecting the environment's directories (#331) read a path by the environment's own resolver.
    ...workspaceMethods({
      log,
      availability,
      directoryRules: environmentResolver,
      worktreesRoot: roots.worktrees,
      ...(options.workspaces?.gitTimeoutMs !== undefined && { gitTimeoutMs: options.workspaces.gitTimeoutMs }),
    }),
    // The skill set (#494): skills.get, and the own directory's create and remove.
    // Carry over's skills half (#513): an adopted account's skills and commands, and the machine's ~/.agents/skills, copied
    // into the own directory, a checkout among them offered as a source. The choices (#501), on the skills stream.
    ...skillHandlers,
    // Readiness (#510): each member of the set a run would have, checked in its workspace against its sidecar or the
    // overlay, a tool on the PATH runs get, which is the host environment's.
    ...skillReadinessMethods({
      scopeOf: (target) => host.previewScope(target),
      account: (id) => host.account(id),
      place: placeSkillSet({ own: ownSkills, sources: skillSources, log }),
      hostEnv: options.managedTools?.hostEnv ?? process.env,
      clock,
      keyManagers,
      toolServers: runServers,
      forgeAccounts: () => forge.list(),
    }),
    // The extension's folder and its listener (#547), browser.status; pairing and the paired Chromes (#548).
    ...browser.handlers,
    // The browser relay's answers (#554): client.answer.
    ...relay.handlers,
    // The trust gate (#500): trust.get and trust.list, trust.decide and trust.revoke.
    ...trustMethods({
      log,
      environmentId: record.id,
      store: trustStore,
      clientSessionLabel,
    }),
    // Carry over's session import (#578): an adopted account's sessions counted and imported, each working directory looked
    // at through the availability watcher and given the identity the environment's resolver finds there. Its memory, copied
    // into the auto memory's directories in the queue key changes take, the skills tick and the rest of the inventory (#580).
    ...carryOver.methods,
    // The state import's detection (#581) and its run (#1165), behind the stateImport flag.
    ...stateImportMethods({
      reconcileSessions: reconcileImportedSessions(log, deletion),
      machine: stateImportSource,
      log,
      environmentId: record.id,
      createGroup: createImportedGroup(log, now),
      setDraft: sessionHandlers["sessions.setDraft"],
      setGroup: sessionHandlers["sessions.setGroup"],
      archive: sessionHandlers["sessions.archive"],
      pin: sessionHandlers["sessions.pin"],
      coordinator: stateImports,
      sources: skillSources,
      forgeAccounts: () => verifiedOrigins(forge.list()),
      setAlwaysOn: skillHandlers["skills.setAlwaysOn"],
      knownSkillNames: async () => {
        const [own, sources] = await Promise.all([ownSkills.read(), skillSources.read()]);
        return new Set([...own, ...sources.members].flatMap((member) => member.name !== null && member.problems.length === 0 ? [member.name] : []));
      },
      accounts,
      listSessions: listImportSessions,
      carryOver,
      createInstruction: instructionHandlers["instructions.create"],
      banks: bankService,
      directoryRules: environmentResolver,
      timeZone: options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      checkRoutineImport: routineHandlers["routines.checkImport"],
      importRoutine: routineHandlers["routines.import"],
      forge,
      managers: keyManagerConnections,
      getSettings: settingsHandlers["settings.get"],
      updateSettings: settingsHandlers["settings.update"],
      ...(options.stateImportHooks !== undefined && { hooks: options.stateImportHooks }),
    }),
    // What runs, who manages its updates and what is installed, and the update settings (#342).
    ...updateMethods({
      log,
      dataDir,
      environmentId: record.id,
      harnessVersion,
      launcher,
      managedOutside: updatesManagedOutside,
      hostUpdater,
      coordinator: updates,
      releaseSource,
      channel: releaseChannel,
      checks: channelChecks,
      claudeCodeVersion: options.claudeCodeVersion ?? (() => readClaudeCodeVersion({ executable: bundledExecutable() })),
    }),
  });

  // The two exchanges and the wire are routed before the bind; all three refuse work until the gate below.
  // Each knows a client behind the web origin's proxy by the address the proxy forwarded (#1809).
  const clientAddress = forwardedClientAddress(webOrigin, options.clientAddressHeader);
  const grant = createBootstrapGrant({
    dataDir,
    clientSessions,
    atomically: accessLog.atomically,
    rateLimiter: createRateLimiter({ clock }),
    clientAddress,
    readiness: () => readiness,
  });
  surface.route("POST", BOOTSTRAP_PATH, grant.exchange);
  surface.route(
    "POST",
    PAIR_PATH,
    pairRoute({ pairings, atomically: accessLog.atomically, rateLimiter: createRateLimiter({ clock }), clientAddress, readiness: () => readiness }),
  );
  // The credential route (#314): what git's credential helper asks, over loopback, with a run-scoped secret; no client session.
  surface.route("POST", GIT_CREDENTIAL_PATH, createCredentialRoute({ forge, clock, clientAddress, banks: bankCredentials }));
  // The update route (#353): updates.apply over HTTP for a client whose protocol the wire refuses; a client session's token, no exchange.
  surface.route("POST", UPDATE_PATH, createUpdateRoute({ log, clientSessions, methods: table, readiness: () => readiness }));
  // The completions surface (#138): OpenAI's routes under /v1/ on the wire's port, for programs' client sessions.
  const completions = createCompletionsSurface({
    log,
    host,
    clock,
    clientSessions,
    readiness: () => readiness,
    // The account store (#134): every account it holds, by its label, with what the host would run it with.
    catalogue: {
      accounts: () =>
        accounts.list().flatMap((record) => {
          const facts = accounts.facts(record.id);
          return facts === null ? [] : [{ id: record.id, label: record.label, provider: record.provider, signedIn: facts.signedIn, models: facts.models }];
        }),
      defaultAccountId: () => accounts.defaultId(),
    },
    methods: table,
    passthrough,
    resolver: workspaceResolver,
  });
  surface.prefix(OPENAI_PATH_PREFIX, completions.handle);
  const wire = createWire({
    environment: { id: record.id, look: () => look.read() },
    capabilities: flags,
    clientSessions: socketSessions(clientSessions, accessLog.atomically),
    methods: table,
    clock,
    clientAddress,
    log,
    ...(options.subscriptionHooks !== undefined && { subscriptionHooks: options.subscriptionHooks }),
  });
  surface.upgrade(WIRE_PATH, wire.upgrade);

  const bound = await step("listen", async () => {
    const tailscaleAddress = await interfaces.tailscaleAddress();
    // The binding keys as this start finds them (#574), which the start options override.
    const values = readSettings({ all: (sql, ...params) => log.read(sql, ...params) });
    const choice = bindChoiceOf({ bindTailnet: values["network.bindTailnet"], bindLan: values["network.bindLan"] }, options);
    const { binds, skipped } = bindPlan({ tailscaleAddress, ...choice, lanAddresses: interfaces.lanAddresses() });
    if (skipped !== undefined) console.error(skipped);
    closers.push(() => surface.close());
    // Loopback first: its port, chosen when 0 is asked for, is every other listener's.
    const listening: { address: Address; interface: BoundInterface }[] = [];
    for (const bind of binds) {
      const port = listening[0]?.address.port ?? options.port ?? DEFAULT_PORT;
      listening.push({ address: await surface.listen(bind.host, port), interface: bind.interface });
    }
    const [loopback] = listening;
    if (!loopback) throw new Error("No listener was bound.");
    address = loopback.address;
    authPolicy = listening.length > 1 ? "tailnet" : "local-only";
    if (listening.some((entry) => entry.interface === "tailnet")) tailnetName = options.tailnetName ?? (await interfaces.tailnetName());
    const boundOn = (which: BoundInterface) => listening.find((entry) => entry.interface === which)?.address.host ?? null;
    const tailnet = boundOn("tailnet");
    boundBeside = { tailnet: tailnet === null ? null : { address: tailnet, name: tailnetName ?? null }, lan: boundOn("lan") };
    tailnetFound = tailnet === null ? (tailscaleAddress ?? null) : null;
    linkOrigin = webOrigin ?? `http://${linkHost(listening, tailnetName)}:${loopback.address.port}`;
    // Closed before the listeners, so no socket holds their close open.
    closers.push(() => wire.close());
    closers.push(() => grant.remove());
    grant.issue(loopback.address);
    return { address: loopback.address, addresses: listening.map((entry) => entry.address) };
  });

  // Closed before the wire and the listeners: an answer still open ends with a final chunk, never a bare close.
  closers.push(() => completions.close());

  // Under a launcher this waits for its `committed`: until then readiness stays `starting` and the wire serves no request,
  // so a trial the launcher rolls back never served a person. With no launcher it does not wait.
  await step("prepared", () => launcher.prepared(harnessVersion));
  // The extension's listener bound and its folder made (#547), past the gate, so a trial the launcher rolls back never
  // replaced the folder Chrome loads; before readiness turns `ready`, so a reader that finds it ready finds the folder
  // whole (#1804: the Windows smoke read it in between), and a first client's browser.status finds them.
  closers.push(() => browser.close());
  await browser.start();
  // What the workspace roots hold that no session names (a crash between a create's `prepare` and its commit left it), read
  // at once, past the gate and before anything can make a workspace; swept below, before the wire opens (#330).
  const strays = reaper.strays();
  readiness = "ready";
  // Only a start the launcher committed is noted, and before the wire opens, so a first subscriber finds it.
  try {
    const [started] = log.append(
      environmentStream,
      [{ type: "environment.started", payload: { harnessVersion, protocolVersion: PROTOCOL_VERSION } }],
      { actor: formatActor({ kind: "system", id: "lifecycle" }) },
    ).events;
    startedAt = started && new Date(started.occurredAt);
  } catch (error) {
    await closers.closeAll().catch((closeError: unknown) => console.error("Closing after a failed start failed:", closeError));
    throw new StartupError("prepared", error);
  }
  // The settle (#344, #345): the update that began last gets its outcome from the version this start runs, and each run it cut
  // its mark and, where it can go on, its continuation, before any client can read the stream. Each cut run's workspace is
  // looked at first through the availability watcher, one at a time within its bound (#691): a dead mount holds the wire's
  // opening two bounds at most, never the event loop.
  await updates.settle();
  settleFirings({ log, clock: now, environmentId: record.id });
  resumeDeliveries({ log, clock: now, environmentId: record.id });
  webhookDeliveries.start();
  // Deleted sessions whose grace period ran out while the environment was down go before any client can read them.
  try {
    deletion.purgeDue(clock.now());
  } catch (error) {
    console.error("The startup purge failed; the minute sweep will try again:", error);
  }
  // The startup sweep of the workspace roots (#330), after the removals those purges set off: each stray by the reaper's rules,
  // a worktree it keeps logged, not noticed.
  await reaper.sweep(strays);
  // File restores a stop cut, recognised before any client can retry them (#1183).
  await fileUndo.recover();
  // Then the SDK session store's rows under a purged session's key: a mirror write that raced its purge (#137).
  try {
    providerStore.sweepOrphans();
  } catch (error) {
    console.error("The session store's orphan sweep failed; the next start will try again:", error);
  }
  // The containment directories of sessions that are gone (purged while a removal failed, or before a crash), in the background.
  sessionDirectories
    .sweep((sessionId) => log.read("SELECT 1 FROM sessions WHERE id = ?", sessionId).length > 0)
    .catch((error: unknown) => console.error("Sweeping the containment directories of sessions that are gone failed:", error));
  // The shelf's sweep (#117): a pass now, before the wire opens, then every five minutes.
  closers.push(settleSweep.start());
  // The TTL's sweeper (#131): the prompts that expired while the environment was down now, before the wire opens, then every minute.
  closers.push(createTtlSweeper({ log, host, clock }).start());
  // Transcript compaction (#123): a pass now, before the wire opens, then once a day.
  closers.push(createCompactionSweep({ log, clock }).start());
  // The trash (#494): what turned thirty days old while the environment was down now, in the background, then hourly.
  closers.push(trash.start());
  // The skill-set generations (#496): what a start before this one left now, in the background, then hourly; each sweep
  // followed by the snapshots' (#499), which keeps those the generations left link into. Its stop waits for a sweep in
  // flight, so the snapshots' sweep never reads the log after it closes.
  closers.push(generations.start(() => skillSources.sweepSnapshots()));
  // Set up's own checks (#571): every registered step now, past the settle and before the wire opens, so a first client
  // finds what the checks that answer at once found; then each step on its cadence and a second after its triggers, with
  // no client needed. The routines scheduler's start pass (#535) runs after this one's.
  const setupScheduler = startSetupScheduler({ log, clock, steps: setupSteps.steps, setup });
  closers.push(() => setupScheduler.stop());
  // The routines' scheduler (#527): its start pass applies the missed rule to what came due while the environment was down,
  // then arms its timer and its check, firing with no client needed; stopped before the firing starter closes.
  const routineScheduler = createRoutineScheduler({ log, clock, environmentId: record.id, firings });
  closers.push(() => routineScheduler.stop());
  routineScheduler.start();
  // A check of the release channel appends nothing, yet changes what Your machines' release channel and updates checks
  // answer: each that ends triggers the step, so on a new machine it reads done a second after the channel's first read (#679).
  closers.push(channelChecks.onChecked(() => setupScheduler.trigger("your-machines")));
  // The vault entries of webhook endpoints that are gone deleted (#522), before a client can set one again.
  await endpoints.start();
  // The helper can answer startup fetches only after the internal listener is ready.
  bankSyncer.start();
  wire.open();
  launcher.onQuery((query) => lifecycle.answer(query));
  // A declared container pairs from its own log (ADR 0025, #349): until a client first pairs, each start mints a code
  // for `serve` to print there, my own client's, as the install script prints (#577). A failed mint costs only the
  // print; `pair --preset own-client` in the container mints one all the same.
  let startPairing: MintedPairing | undefined;
  if (detector.declared?.() === true && !pairings.everExchanged()) {
    const { scopes, ceiling } = pairingPreset("own-client");
    try {
      startPairing = accessLog.atomically((tx) => pairings.create(tx, { scopes, ceiling }, SYSTEM.owner));
    } catch (error) {
      console.error("Minting the pairing a declared container prints at its start failed; run pair in the container for one:", error);
    }
  }
  // The identity passes (#329): sessions with no identity resolved again, past the gate, four git processes at a time, each
  // workspace looked at first through the availability watcher, within its bound (#699); and every identity on a verified
  // alias's host moved to its canonical host, from here on, as a forge account is added or verified.
  const identityPasses = createIdentityPasses({
    log,
    forgeAccounts,
    autoMemory,
    availability,
    ...(options.workspaces?.gitTimeoutMs !== undefined && { gitTimeoutMs: options.workspaces.gitTimeoutMs }),
  }).start();
  closers.push(() => identityPasses.stop());
  // The availability watcher's pass (#328): every session's workspace looked at now, past the gate, then hourly.
  const availabilityPasses = availability.start();
  closers.push(() => availabilityPasses.stop());
  // The managed tools' probe (#373): now, past the gate; again on a client's refresh, at most every fifteen minutes.
  managedTools.start();
  // The forge accounts' verifications (#311): each now, past the gate, then every fifteen minutes.
  forge.startVerifying();
  // The skill sources' syncs (#499): every unpinned source now, past the gate with the wire open, then staggered every six
  // hours. Stopped before the log closes: a sync the close cuts records nothing, and the next start syncs it again. The
  // stop stops each sync's git and waits for the sync to end, so nothing it would write under the data directory outlives
  // the close (#1014), and before the probes' close, so no clone runs into their folder as they go.
  closers.push(skillSync.start());
  // A session's pull requests (#317): found at each run's end, and kept current on their cadence from now.
  closers.push(forge.links.start());
  // The key-manager connections' sign-ins (#365): every connection with a credential, now, past the gate; then their
  // verifications (#366), on the clock, and every fifteen minutes.
  keyManagerConnections.startSigningInAndVerifying();
  // The stored values a Move left behind, its delete having failed (#371): deleted again, now, past the gate.
  const leftBehindDeleted = moves.deleteLeftBehind();
  // The pending update's wait: every run-registry change, every minute, and its deferral cap (#343).
  closers.push(updates.start());
  // The release channel's checks: two minutes from now, then hourly (#346).
  closers.push(channelChecks.start());
  // The minute sweep: expired pairings, idle `tui` local client sessions, receipts past their 30 days, and
  // deleted sessions past their grace period, each part tried even when one before it fails, and named when it does.
  const sweep = clock.setInterval(() => {
    const parts: readonly (readonly [string, () => unknown])[] = [
      [
        "The client session and pairing sweep",
        () =>
          accessLog.atomically((tx) => {
            clientSessions.sweep(tx);
            pairings.sweep(tx);
          }),
      ],
      ["The receipt prune", () => log.pruneReceipts(clock.now())],
      ["The purge sweep", () => deletion.purgeDue(clock.now())],
    ];
    for (const [name, part] of parts) {
      try {
        part();
      } catch (error) {
        console.error(`${name} failed:`, error);
      }
    }
  }, SWEEP_INTERVAL_MS);
  closers.push(() => sweep.cancel());
  // Runs first when the environment closes: a drain still waiting for runs stops waiting and ends `closed`.
  closers.push(() => lifecycle.stopWaiting());

  return {
    id: record.id,
    get name() {
      return look.read().name;
    },
    dataDir,
    address: bound.address,
    addresses: bound.addresses,
    authPolicy,
    readiness: () => readiness,
    status: () => lifecycle.status(),
    drain: (trigger) => {
      // A signal is also the host-side updater's `docker compose stop`, which ends an update's drain managed outside (#348).
      if (trigger === "signal") updates.stopRequested();
      return lifecycle.drain(trigger).outcome;
    },
    drained: lifecycle.drained,
    methods: table,
    http: { route: (method, path, handler) => surface.route(method, path, handler) },
    clientSessions: {
      issue(request) {
        const { code } = accessLog.atomically((tx) => pairings.create(tx, { scopes: request.scopes, ceiling: request.ceiling }, SYSTEM.owner));
        const exchanged = accessLog.atomically((tx) => pairings.exchange(tx, code, { kind: request.kind, label: request.label }));
        if (!exchanged.ok) throw new Error(`The in-process pairing was refused: ${exchanged.refusal}.`);
        return exchanged.credential;
      },
      revoke: (id) => accessLog.atomically((tx) => clientSessions.revoke(tx, id, "requested", SYSTEM.owner))?.changed === true,
    },
    startRun(request) {
      const started = log.atomically((tx) => startActorRunIn(log, host, tx, request));
      if (started.rejected !== undefined) throw new ContractError(started.rejected);
      return { runId: started.runId, messageId: started.messageId };
    },
    sockets: () => wire.sockets(),
    subscriptions: () => wire.subscriptions(),
    log,
    forge,
    banks: bankService,
    keyManagerConnections,
    keyManagers,
    keyManagerMoves: { leftBehindDeleted },
    toolTerminals: terminalService.tools,
    processEnvironments,
    startPairing,
    setup: { startPass: setupScheduler.startPass },
    workspaces: {
      checkoutIndex,
      identityPass: identityPasses.resolved,
      availabilityPass: availabilityPasses.pass,
      reaped: () => reaper.settled(),
      markMissing: (tx, sessionId) => availability.markMissing(tx, sessionId.toLowerCase()),
    },
    close,
  };
};
