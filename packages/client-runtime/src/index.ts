/** The protocol version this client runtime speaks: the contracts' one integer. */
export { PROTOCOL_VERSION } from "@agent-harness/contracts";

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
  type ShellService,
  type ShellTray,
  type ShellUpdate,
  type ShellWebView,
  type ShellWindow,
} from "./shell.js";
export {
  BLOCKED_REASONS,
  LOCAL_PLACEHOLDER_ID,
  PREFERENCE_KEYS,
  type BlockedReason,
  type ClientPreferences,
  type ConnectionKind,
  type ConnectionPhase,
  type ConnectionRecord,
  type EnvironmentDescriptor,
} from "./connections/records.js";
export type { Connections, RemoveResult } from "./connections/registry.js";
export type { ConnectionAction } from "./connections/state-machine.js";
export { NOTICE_LIMIT, type Notice, type NoticeAction, type NoticeKind } from "./notices.js";
export {
  parsePairingInput,
  type PairingFailure,
  type PairingFailureReason,
  type PairingInput,
  type PairingOptions,
  type PairingOutcome,
} from "./pairing.js";
export type { LocalFailureReason, LocalStatus } from "./bootstrap.js";
export type { AbsentReason, CapabilityAnswer, CapabilityName } from "./capabilities.js";
export type { EnvironmentView } from "./projections/environments.js";
export { REQUEST_TIMEOUT_MS, type RequestAnswer, type RequestFailure, type RequestFailureCode, type Requests } from "./requests.js";
export type {
  HeadingMember,
  ListFreshness,
  MergedGroupHeading,
  RepositoryHeading,
  SessionListView,
  SessionRow,
  SessionShelves,
} from "./projections/session-list.js";
export type { Freshness } from "./streams/stream.js";
export { SESSION_LINGER_MS, type SessionHandle, type SessionView } from "./streams/session-handles.js";
