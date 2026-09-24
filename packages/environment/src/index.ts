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
export { acceptAnyRunParameters, type RunParameters, type RunParametersCheck } from "./sessions/run-parameters.js";
export { SETTLE_SWEEP_ACTOR, SETTLE_SWEEP_INTERVAL_MS, createSettleSweep, type SettleSweep, type SweepOutcome } from "./sessions/settle-sweep.js";
export { settingsMethods, type SettingsMethodsOptions } from "./settings/methods.js";
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
export { processContainerDetector, type ContainerDetector, type ContainerProbe } from "./serve/container.js";
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
