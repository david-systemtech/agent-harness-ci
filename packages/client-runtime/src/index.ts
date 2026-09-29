/** The protocol version this client runtime speaks: the contracts' one integer. */
export { PROTOCOL_VERSION } from "@agent-harness/contracts";

export { createRuntime, type Runtime } from "./runtime.js";
export { derived, writable, type Observable, type Writable } from "./observable.js";
/** The id a client mints for a session or a group it creates (the contracts' `SessionId` and `GroupId` are version 4). */
export { uuidv4 } from "./ids.js";
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
  type ShellContent,
  type ShellDeepLinks,
  type ShellDialogs,
  type ShellFile,
  type ShellGh,
  type ShellInstaller,
  type ShellMember,
  type ShellNetwork,
  type ShellNotification,
  type ShellNotifications,
  type ShellPlatform,
  type ShellPreview,
  type ShellService,
  type ShellSystem,
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
export { NOTICE_LIMIT, type Notice, type NoticeAction, type NoticeKind, type NoticeSubject, type StepAction } from "./notices.js";
export { FORGE_NOTICE_ACTION } from "./projections/forge-notices.js";
export type { Forges, HandOverParams } from "./forges.js";
export type { CopyOutcome, CopyReport, CopyTarget } from "./copies.js";
export {
  pairingDeepLink,
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
export {
  COMMAND_EXPIRY_MS,
  type AcceptedReceipt,
  type CommandParams,
  type Commands,
  type DispatchAnswer,
  type DispatchFailure,
  type DispatchFailureCode,
  type RejectedReceipt,
  type RewindAnswer,
} from "./outbox/outbox.js";
export { DRAFT_DEBOUNCE_MS, type Drafts } from "./outbox/drafts.js";
export {
  CACHE_REFRESH_NOTICES,
  QUERY_REFRESH_NOTICES,
  REQUEST_CACHE_TTL_MS,
  REQUEST_TIMEOUT_MS,
  type CachedAnswer,
  type QueryMethodName,
  type RequestAnswer,
  type RequestFailure,
  type RequestFailureCode,
  type Requests,
} from "./requests.js";
export type {
  AssistantEntry,
  CommandEntry,
  OpaqueEntry,
  PromptEntry,
  PromptState,
  RewoundAt,
  RewoundEntry,
  SessionProjection,
  SessionTranscript,
  SubagentEntry,
  TasksEntry,
  ToolCallEntry,
  TranscriptEntry,
  UserMessageEntry,
} from "./projections/session.js";
export {
  COUNTDOWN_TICK_MS,
  adapterOf,
  type Countdown,
  type ParkedAsk,
  type RunState,
  type RunsProjection,
  type RunsView,
  type SessionRun,
  type SessionRunsView,
} from "./projections/runs.js";
export type { QueuedMessage, SessionVerbs, VerbAvailability, VerbMethod, VerbReason } from "./projections/verbs.js";
export type { Attention, AttentionEvent } from "./projections/attention.js";
export { CLIENT_CALL_ANSWER_METHOD, CLIENT_CALL_EVENT, type ClientCall, type ClientCallHandler, type ClientCalls } from "./projections/client-calls.js";
export type { AccountsAnswer, EnvironmentAnswer, ModelsAnswer, UsageGauge, UsageView } from "./projections/accounts.js";
export type { ModeChoice, ModePicker } from "./projections/modes.js";
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
export { callsRowId, folded, lastReply, liveRun, liveTasks, rewoundRowId, transcriptRows, undoableFold, type TranscriptRow } from "./transcript/rows.js";
export {
  TOOL_CATEGORIES,
  classifyTool,
  clockTime,
  describeActivity,
  endWords,
  formatDuration,
  formatTokens,
  formatUsd,
  oneLine,
  outputText,
  summarizeToolInput,
  turnFacts,
  type ActivityCounts,
  type ToolCategory,
} from "./transcript/format.js";
export { isLiveTask, sessionTasks, type SessionTask } from "./transcript/tasks.js";
export { subagentRows } from "./transcript/subagent.js";
export { TOOL_QUIET_MS, hear, nextQuietChange, quietFor, runningCalls, type Heard, type QuietCalls } from "./transcript/quiet.js";
export { MAX_ATTACHMENT_NAME, UNKNOWN_MEDIA_TYPE, attachmentFromBytes, mediaTypeOf, overLimit } from "./composer/attachments.js";
export { matchCommands } from "./composer/commands.js";
export { followDraft, type DraftSides, type DraftStep, type InStep } from "./composer/draft.js";
export { DEFAULT_MATCH_LIMIT, fuzzyMatch, mentionAt, replaceMention, type FileMatch, type FrecencyLike, type FuzzyMatchOptions, type Mention } from "./composer/mentions.js";
export {
  attachmentRefusal,
  attachmentRefused,
  interruptRun,
  isLive,
  liveRunIdOf,
  lockOf,
  readQueueNow,
  sendMessage,
  stopCall,
  withdrawQueued,
  type Lock,
  type OutgoingMessage,
  type SendOutcome,
} from "./composer/send.js";
export { browse, directoryOf, typedPath, type BrowseRow } from "./files/browse.js";
export { inWorkspace, isAbsolutePath, slashed } from "./files/paths.js";
export { DIFF_CUT_NOTE, binaryNote, fileMarks, formatBytes, outsideWorkspace, sessionDiffNote, workingTreeNote } from "./files/words.js";
export type { TerminalHandle, TerminalOutput, TerminalStatus, TerminalStreamView } from "./streams/terminals.js";
export { choiceRows, joinAnswers, noteOf, rowAnswer, ttlWords, type ChoiceRow, type RowOutcome } from "./prompts/card.js";
export { answerPrompt, type AnswerOutcome, type PromptTarget } from "./prompts/answer.js";
