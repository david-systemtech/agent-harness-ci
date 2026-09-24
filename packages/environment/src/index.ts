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
  type CommandReceipt,
  type EventEnvelope,
  type EventInput,
  type EventLog,
  type EventLogOptions,
  type JsonObject,
  type ProjectionDb,
  type Projector,
  type ReceiptRequest,
  type ReplayMeasure,
  type Snapshot,
  type SqlValue,
  type StreamRef,
} from "./event-log/event-log.js";

export {
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
export { RECORD_FILE, SIGNING_KEY, type EnvironmentRecord } from "./serve/identity.js";
export { PREPARED_MESSAGE, processLauncherChannel, type IpcProcess, type LauncherChannel } from "./serve/launcher.js";
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
