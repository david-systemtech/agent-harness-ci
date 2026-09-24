import { PROTOCOL_VERSION } from "@agent-harness/contracts";

/** The protocol version this client runtime speaks. */
export const CLIENT_PROTOCOL_VERSION: number = PROTOCOL_VERSION;

export { createRuntime, type Runtime } from "./runtime.js";
export { derived, writable, type Observable, type Writable } from "./observable.js";
export type {
  ClientIdentity,
  Clock,
  DocumentStore,
  GrantReader,
  HttpFetch,
  HttpRequest,
  HttpResponse,
  NetworkSignal,
  NetworkState,
  Platform,
  PlatformSocket,
  RuntimeClientKind,
  SecretStore,
  SocketHandlers,
  Timer,
  WebSocketFactory,
} from "./platform.js";
export { standardWebSocketFactory } from "./web-socket.js";
export {
  SHELL_MEMBERS,
  hasShellMember,
  type FileFilter,
  type Shell,
  type ShellClipboard,
  type ShellDialogs,
  type ShellInstaller,
  type ShellMember,
  type ShellNotification,
  type ShellSecrets,
  type ShellService,
  type ShellTray,
  type ShellUpdate,
  type ShellWebView,
  type ShellWindow,
} from "./shell.js";
export {
  BLOCKED_REASONS,
  PREFERENCE_KEYS,
  type BlockedReason,
  type ClientPreferences,
  type ConnectionKind,
  type ConnectionPhase,
  type ConnectionRecord,
  type EnvironmentDescriptor,
} from "./connections/records.js";
export type { ConnectionSeams, Connections } from "./connections/registry.js";
export type { SocketClosed } from "./connections/connection.js";
export {
  DEFAULT_ENVIRONMENT_PORT,
  parsePairingInput,
  type PairingFailure,
  type PairingFailureReason,
  type PairingInput,
  type PairingOptions,
  type PairingOutcome,
} from "./pairing.js";
export type { LocalFailureReason, LocalStatus } from "./bootstrap.js";
export {
  CAPABILITY_NAMES,
  type AbsentReason,
  type CapabilityAnswer,
  type CapabilityName,
} from "./capabilities.js";
export type { EnvironmentView } from "./projections/environments.js";
