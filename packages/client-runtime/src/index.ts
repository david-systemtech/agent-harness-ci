/** The protocol version this client runtime speaks: the contracts' one integer. */
export { PROTOCOL_VERSION } from "@agent-harness/contracts";

export { createRuntime, type Runtime } from "./runtime.js";
export { derived, writable, type Observable, type Writable } from "./observable.js";
/** The id a client mints for a session or a group it creates (the contracts' `SessionId` and `GroupId` are version 4), and for a command (version 7). */
export { uuidv4, uuidv7 } from "./ids.js";
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
  type ShellApplyOutcome,
  type ShellApplyWhen,
  type ShellBundledServer,
  type ShellClipboard,
  type ShellContent,
  type ShellDeepLinks,
  type ShellDesktopBuild,
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
  type ShellStagedBuild,
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
export { KEY_MANAGER_NOTICE_ACTION } from "./projections/key-manager-notices.js";
export type { Forges, HandOverParams } from "./forges.js";
export type { KeyManagers } from "./key-managers.js";
export {
  INJECTION_WORDS,
  KEY_MANAGER_METHOD_WORDS,
  KEY_MANAGER_PROVIDER_WORDS,
  KEY_MANAGER_STATUS_ADVICE,
  KEY_MANAGER_STATUS_WORDS,
  POLICY_WRITES_WORDS,
  basePathWords,
  caWords,
  certificateFacts,
  cliRowOf,
  cliWords,
  injectsWords,
  listWords,
  methodWords,
  mintWords,
  originWords,
  overridesWith,
  policyWarning,
  statusWords,
  tokenWords,
} from "./key-managers/words.js";
export {
  KEY_MANAGER_ADDRESS_PRESETS,
  KEY_MANAGER_LABEL_PRESETS,
  addConnection,
  copyValue,
  moveItems,
  previewCertificate,
  removeConnection,
  setBasePath,
  setInjected,
  setPolicies,
  signInAgain,
  signOutConnection,
  ticksWith,
  updateConnection,
  verifyConnection,
  credentialOf,
  credentialTyped,
  formProblem,
  type CertificatePreview,
  type CopiedValue,
  type MoveFollowUp,
  type MoveLine,
  type MoveOptions,
  type ConnectionChanges,
  type ConnectionForm,
  type KeyManagerHands,
  type KeyManagerOutcome,
  type Removed,
  type TypedCredential,
} from "./key-managers/actions.js";
export type { CopyOutcome, CopyReport, CopySource, CopyTarget } from "./copies.js";
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
export {
  DESKTOP_CHECK_INTERVAL_MS,
  type BundledServerView,
  type DesktopBuildView,
  type DesktopUpdate,
  type DesktopUpdateFailure,
  type DesktopUpdateView,
} from "./desktop-update.js";
export { homeEnvironment, type EnvironmentView } from "./projections/environments.js";
export { KNOWN_DIRECTORY_LIMIT, type KnownDirectory } from "./projections/known-directories.js";
export type {
  AccountChip,
  AccountPresetReason,
  EnvironmentChip,
  EnvironmentOption,
  EnvironmentPresetReason,
  ModelChip,
  ModelPresetReason,
  NewSessionChips,
  NewSessionContext,
  NewSessionFocus,
  NewSessionView,
  WorkspaceChip,
  WorkspacePresetReason,
} from "./projections/new-session.js";
export {
  SETUP_AGE_TICK_MS,
  SETUP_CHECK_TIMEOUT_MS,
  SETUP_PENDING_MS,
  type SetupCounts,
  type SetupReach,
  type SetupResultView,
  type SetupStepView,
  type SetupView,
} from "./projections/setup.js";
export { SETUP_ACTION_WORDS, planSetupAction, restoreStep, type RestorableStep, type Restored, type SetupActionPlan } from "./setup/actions.js";
export { STEP_STATE_WORDS, checkedAgoWords, countsWords, lastGoodWords, rowHealth, setupReachWords, stepLine, worstState } from "./setup/checklist.js";
export {
  COMMAND_EXPIRY_MS,
  STOP_WAIT_MS,
  type AcceptedReceipt,
  type CommandParams,
  type Commands,
  type DispatchAnswer,
  type DispatchFailure,
  type DispatchFailureCode,
  type ForkAnswer,
  type ForkOptions,
  type RejectedReceipt,
  type RewindAnswer,
  type RewindOptions,
  type StartSessionAnswer,
  type StartSessionChoice,
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
  ForkedEntry,
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
  DOCUMENT_KIND_WORDS,
  documentFacts,
  documentKindOf,
  documentWritten,
  sessionDocuments,
  type DocumentKind,
  type DocumentTouch,
  type DocumentWrite,
  type SessionDocument,
} from "./projections/documents.js";
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
export { stopFirstOffer, type QueuedMessage, type SessionVerbs, type StopFirstOffer, type VerbAvailability, type VerbMethod, type VerbReason } from "./projections/verbs.js";
export type { Attention, AttentionEvent } from "./projections/attention.js";
export { CLIENT_CALL_ANSWER_METHOD, CLIENT_CALL_EVENT, type ClientCall, type ClientCallHandler, type ClientCalls } from "./projections/client-calls.js";
export type { AccountsAnswer, EnvironmentAnswer, ModelsAnswer, UsageGauge, UsageView } from "./projections/accounts.js";
export type { ModeChoice, ModePicker } from "./projections/modes.js";
export type {
  ByRepositoryHeading,
  HeadingMember,
  ListFreshness,
  MergedGroupHeading,
  NoRepositoryHeading,
  RepositoryHeading,
  SessionListView,
  SessionRow,
  SessionShelves,
} from "./projections/session-list.js";
export type { Freshness } from "./streams/stream.js";
export { SESSION_LINGER_MS, type SessionHandle, type SessionView } from "./streams/session-handles.js";
export {
  callsRowId,
  folded,
  forkedFrom,
  lastReply,
  liveRun,
  liveTasks,
  promptsIn,
  rewoundRowId,
  transcriptRows,
  undoableFold,
  type ForkedFrom,
  type TranscriptRow,
} from "./transcript/rows.js";
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
export {
  FORK_USAGE,
  REWIND_USAGE,
  forkAsked,
  messageBack,
  rewindAsked,
  tooFarBack,
  userMessagesOf,
  type ForkAsked,
  type RewindAsked,
} from "./composer/fork-rewind-commands.js";
export { shellLine } from "./composer/shell-line.js";
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
export {
  ONE_OFF_MAX_LINES,
  ONE_OFF_TIMEOUT_MS,
  clipOutput,
  closeTerminal,
  oneOffMessage,
  reusableTerminal,
  runOneOff,
  shownEnv,
  type OneOffDeps,
  type OneOffResult,
  type OneOffTarget,
} from "./terminals/one-off.js";
export { xtermFull, xtermScreen, xtermText, type TextScreen, type TextScreens, type Xterm } from "./terminals/text-screen.js";
export { TERMINAL_WRITE_CAP, nextWrite } from "./terminals/writes.js";
export { choiceRows, joinAnswers, noteOf, rowAnswer, ttlWords, type ChoiceRow, type RowOutcome } from "./prompts/card.js";
export { answerPrompt, type AnswerOutcome, type PromptTarget } from "./prompts/answer.js";
export {
  confirmationOf,
  describeKey,
  noKeysLine,
  parseTyped,
  rowKeys,
  saveSetting,
  valueWords,
  writerOf,
  type Parsed,
  type SaveOptions,
  type SettingSaved,
  type SettingsWriter,
} from "./settings/editor.js";
export { matchSettingsRows, parseSettingsLink, rowSteps, settingsDeepLink, settingsRowNamed, type SettingsLink } from "./settings/rows.js";
export {
  ACCOUNT_STATUS_WORDS,
  BETWEEN_ENVIRONMENTS,
  MODE_BADGE_WORDS,
  aboveCeilingWords,
  clampWords,
  containmentWords,
  elapsedClock,
  gaugeOf,
  identityWords,
  modelName,
  modelsOf,
  percent,
  pressureOf,
  readingWords,
  readingsOf,
  spendOf,
  startingAccount,
  windowLabel,
  windowOut,
  windowWords,
  workingWords,
  type Pressure,
  type Reading,
  type Spend,
} from "./status/words.js";
export {
  modeBadgeOf,
  sessionModeOf,
  statusOf,
  type Activity,
  type ContainmentBadge,
  type ModeBadge,
  type RunChoice,
  type StatusFacts,
  type StatusInput,
} from "./status/line.js";
export {
  adminCall,
  handOff,
  handedOffAlreadyWords,
  handingOffWords,
  setSessionContainment,
  setSessionMode,
  type AdminOutcome,
  type ContainmentSet,
  type HandOff,
  type ModeSet,
} from "./status/actions.js";
export {
  LABEL_RULE,
  addAccount,
  cancelSignIn,
  fallbackOf,
  followedSignIn,
  labelProblem,
  sendSignInCode,
  signInEnd,
  startSignIn,
  type AccountAdded,
  type AttendedSignIn,
} from "./status/sign-in.js";
