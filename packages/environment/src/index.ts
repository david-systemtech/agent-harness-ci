import { PROTOCOL_VERSION } from "@agent-harness/contracts";

/** The protocol version this environment serves. */
export const ENVIRONMENT_PROTOCOL_VERSION: number = PROTOCOL_VERSION;

export {
  formatActor,
  openEventLog,
  parseActor,
  RECEIPT_RETENTION_MS,
  REPLAY_BOUND,
  type AppendOptions,
  type AppendResult,
  type ClientSessionRow,
  type ClientSessionTable,
  type CommandKey,
  type CommandOutcome,
  type CommandRun,
  type EventEnvelope,
  type EventInput,
  type EventLog,
  type EventLogOptions,
  type JsonObject,
  selection,
  type Selection,
  type PairingRow,
  type PairingTable,
  type ProjectionContext,
  type ProjectionDb,
  type Projector,
  type ReplayMeasure,
  type Snapshot,
  type SqlValue,
  type StoredError,
  type StoredReceipt,
  type StreamKinds,
  type StreamRef,
  type StreamSelector,
} from "./event-log/event-log.js";
export { SESSION_LIST_PROJECTOR, sessionListProjector } from "./sessions/session-list.js";
export { SESSION_LIST_SELECTOR, sessionMethods, type SessionMethodsOptions } from "./sessions/methods.js";
export { groupMethods, type GroupMethodsOptions } from "./sessions/group-methods.js";
export { acceptAnyRunParameters, type RunParameters, type RunParametersCheck, type RunParametersVerdict } from "./sessions/run-parameters.js";
export {
  ADAPTER_EVENT_TYPES,
  PromptClosed,
  type AccountRef,
  type Adapter,
  type AdapterCredentialSpec,
  type AdapterDescriptor,
  type AdapterEvent,
  type AdapterEventType,
  type AdapterRun,
  type AttachmentData,
  type GateDecision,
  type GatedToolCall,
  type ModelCatalogue,
  type ModelOption,
  type PermissionBroker,
  type ProcessPort,
  type PromptDecision,
  type PromptKind,
  type PromptMessage,
  type PromptRequest,
  type ProviderCommand,
  type ProviderSessionInfo,
  type ProviderTurn,
  type RunContainment,
  type RunContext,
  type RunEnd,
  type ToolDenial,
  type RunInput,
  type RunTarget,
  type ToolAccess,
  type ToolGate,
  type ToolServer,
  type TranscriptEvent,
  type UsageReading,
  type UsageWindow,
} from "./adapter/contract.js";
export {
  HOST_ACTOR,
  createAdapterHost,
  type ActiveRun,
  type AdapterHost,
  type AdapterHostOptions,
  type StagedAttachments,
} from "./adapter/host.js";
export { PROCESS_STOP_TIMEOUT_MS, STOPPED_LISTED_MS, createProcessPool, type ProcessPool, type ProcessPoolOptions } from "./adapter/pool.js";
export { processMethods, type ProcessMethodsOptions } from "./adapter/processes-methods.js";
export { ATTACHMENTS_DIRECTORY, createAttachmentStage, type AttachmentStage } from "./adapter/attachment-stage.js";
export { recoverCutRuns, recoverStagedAttachments } from "./adapter/recovery.js";
export type { AccountFacts, LiveRunFacts, PlannedRun, QueuedSend, StartFacts } from "./runs/run-decider.js";
export { createAdapterRegistry, type AdapterRegistry } from "./adapter/registry.js";
export { createScopedAppend, type ScopedAppend } from "./adapter/scoped-append.js";
export {
  composeInstructions,
  noAutoAnswer,
  noToolServers,
  orientationPlaceholder,
  presetPolicy,
  type AutoAnswer,
  type AutoAnswerRequest,
  type InstructionComposer,
  type InstructionLayers,
  type InstructionScope,
  type PolicyRequest,
  type PolicySeam,
  type PromptAutoAnswer,
  type ToolServerFactory,
  type ToolServerScope,
} from "./adapter/seams.js";
export { capability, requireCapability, unsupported } from "./adapter/capabilities.js";
export {
  CLAUDE_DESCRIPTOR,
  CLAUDE_MODES,
  CLAUDE_PROVIDER,
  autoMemoryDirectory,
  claudeCredentials,
  createClaudeAdapter,
  parseClaudeStatus,
  type ClaudeAdapter,
  type ClaudeAdapterOptions,
} from "./adapters/claude/index.js";
export { claudeFallback, claudeSignInProgram, claudeVerificationUrl, findManagedClaude, type ClaudeSignInOptions } from "./adapters/claude/signin.js";
export { RUNS_PROJECTOR, runsProjector } from "./runs/runs-projector.js";
export {
  ATTENDED_DEFAULT_MODE,
  clampMode,
  resolvePolicy,
  type PolicyInput,
  type PolicyOutcome,
  type PolicySettings,
  type RunActor,
} from "./permissions/resolver.js";
export { PERMISSIONS_PROJECTOR, permissionsProjector } from "./permissions/permissions-store.js";
export { BYPASS_DENIAL, UNATTENDED_ANSWER, UNATTENDED_DENIAL, autoAnswer } from "./permissions/auto-answer.js";
export { TTL_ANSWER, TTL_DENIAL, TTL_SWEEP_INTERVAL_MS, createTtlSweeper, type TtlSweeper, type TtlSweeperOptions } from "./permissions/ttl-sweeper.js";
export {
  ADAPTER_REASON,
  PRESET_CONTAINMENT,
  UNPROBED_REPORT,
  containmentFlags,
  containmentReport,
  failedProbeReport,
  isEnforceable,
  presetContainmentDefault,
  resolveContainment,
  unenforceable,
  withAdapters,
} from "./permissions/containment.js";
export {
  CONTAINER_MARKER_VARIABLE,
  PROBE_COMMAND_TIMEOUT_MS,
  probeContainment,
  processProbeSystem,
  type CommandAnswer,
  type ContainmentProbe,
  type LevelProbe,
  type ProbeCause,
  type ProbeSystem,
} from "./permissions/containment-probe.js";
export {
  CONTAINMENT_DIRECTORY,
  containmentDirectories,
  runContainment,
  temporaryContainmentDirectories,
  type ContainmentDirectories,
  type SessionDirectories,
} from "./permissions/containment-directories.js";
export { GATE_ACTOR, containmentDenial, createToolGate, resolvePath, type GatedRun, type ToolGateOptions } from "./permissions/gate.js";
export { runMethods, type RunMethodsOptions } from "./runs/run-methods.js";
export { foldTranscript, type TranscriptParts } from "./runs/transcript.js";
export { SETTLE_SWEEP_ACTOR, SETTLE_SWEEP_INTERVAL_MS, createSettleSweep, type SettleSweep, type SweepOutcome } from "./sessions/settle-sweep.js";
export { settingsMethods, type SettingsMethodsOptions } from "./settings/methods.js";
export {
  ACCOUNTS_DIRECTORY,
  ACCOUNT_STORE_ACTOR,
  PROBE_TIMEOUT_MS,
  STATUS_READ_INTERVAL_MS,
  createAccountService,
  type AccountDefaults,
  type AccountService,
  type AccountServiceOptions,
  type ConfiguredAccount,
  type HostAccounts,
} from "./accounts/account-service.js";
export { ACCOUNTS_PROJECTOR, accountsProjector, listAccounts, readAccount, type StoredAccount } from "./accounts/account-store.js";
export { accountMethods, type AccountMethodsOptions } from "./accounts/methods.js";
export {
  signInUnavailable,
  type ProbeResult,
  type SignInDirector,
  type SignInDirectorFactory,
  type SignInOutcome,
  type SignInPort,
  type SignInProgram,
} from "./accounts/signin-seam.js";
export { EXECUTABLE_PROBE_TIMEOUT_MS, SIGN_IN_ACTOR, SIGN_IN_EXPIRY_MS, createSignInDirector, type SignInDirectorOptions } from "./accounts/signin-director.js";
export { createSpawnSignInProcess, spawnSignInProcess, type SignInChild, type SignInProcessOptions, type SignInSpawn } from "./accounts/signin-process.js";
export { SETTINGS_PROJECTOR, readSettings, settingsProjector } from "./settings/settings-store.js";

export { DEFAULT_LOG_PAGE } from "./auth/access-log.js";
export {
  DEFAULT_CEILING,
  SWEEP_INTERVAL_MS,
  TOKEN_LIFETIME_MS,
  TOP_CEILING,
  TUI_REVOKE_AFTER_MS,
  type ClientSessionIssuer,
  type IssueRequest,
  type VerifiedClientSession,
} from "./auth/client-sessions.js";
export { EXCHANGE_RATE } from "./auth/rate-limit.js";
export { systemClock, type Clock, type Timer } from "./serve/clock.js";
export { defaultDataDirectory, prepareDataDirectory, type PlatformContext } from "./serve/data-directory.js";
export { isAllowedHost, type Address, type HttpRoutes, type RouteHandler } from "./serve/http.js";
export {
  LOOPBACK,
  bindList,
  processRunner,
  tailscaleDetector,
  type BindChoice,
  type BoundInterface,
  type CommandRunner,
  type InterfaceDetector,
} from "./serve/interfaces.js";
export { RECORD_FILE, SIGNING_KEY, type EnvironmentRecord } from "./serve/identity.js";
export {
  PREPARED_MESSAGE,
  processLauncherChannel,
  type IpcProcess,
  type LauncherChannel,
  type LauncherQuery,
  type LauncherReply,
} from "./serve/launcher.js";
export {
  isDeclaredContainer,
  isDetectedContainer,
  processContainerDetector,
  type ContainerDetector,
  type ContainerProbe,
} from "./serve/container.js";
export { DRAIN_CAP_MS, type DrainOutcome } from "./serve/lifecycle.js";
export {
  IDLE_WINDOW_MS,
  PARKED_PROMPT_WINDOW_MS,
  activityOf,
  createRunRegistry,
  type MemoryRunRegistry,
  type RunRecord,
  type RunRegistry,
} from "./serve/run-registry.js";
export type { HandlerResult, MethodContext, MethodHandler, MethodHandlers, MethodTable, ServedMethod } from "./serve/methods.js";
export {
  DATABASE_FILE,
  DEFAULT_PORT,
  HARNESS_VERSION,
  STARTUP_STEPS,
  StartupError,
  startEnvironment,
  type ActorRunRequest,
  type EnvironmentHandle,
  type EnvironmentOptions,
  type StartupHooks,
  type StartupProgress,
  type StartupStep,
} from "./serve/start.js";
export {
  mandatoryLevel,
  PrivilegeCheckError,
  processUserCheck,
  refusePrivilegedUser,
  RootRefusedError,
  ROOT_REFUSAL,
  rootRefusal,
  type ProcessIdentity,
  type UserCheck,
} from "./serve/user.js";
export { fileVault, VAULT_FILE, type Vault } from "./serve/vault.js";
export { AUTH_TIMEOUT_MS, PING_INTERVAL_MS } from "./wire/wire.js";
export { toWireEnvelope } from "./wire/envelope.js";
export type { Outlet, StreamSource, SubscriptionHooks } from "./wire/subscriptions.js";
