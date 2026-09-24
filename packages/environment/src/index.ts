import { PROTOCOL_VERSION } from "@agent-harness/contracts";

/** The protocol version this environment serves. */
export const ENVIRONMENT_PROTOCOL_VERSION: number = PROTOCOL_VERSION;

export {
  openEventLog,
  RECEIPT_RETENTION_MS,
  REPLAY_BOUND,
  type AppendOptions,
  type AppendResult,
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

export { defaultDataDirectory, prepareDataDirectory, type PlatformContext } from "./serve/data-directory.js";
export { isAllowedHost, type Address, type HttpRoutes, type RouteHandler } from "./serve/http.js";
export { RECORD_FILE, SIGNING_KEY, type EnvironmentRecord } from "./serve/identity.js";
export { PREPARED_MESSAGE, processLauncherChannel, type IpcProcess, type LauncherChannel } from "./serve/launcher.js";
export type { MethodHandler, MethodHandlers } from "./serve/methods.js";
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
