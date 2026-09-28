import { z } from "zod";
import { Action, ActionCondition, ActionContext } from "./actions.js";
import { ACCESS_EVENT_PAYLOADS, ACCESS_EVENT_TYPES, AccessEventType, ClientSessionOrigin, RevocationReason } from "./access-log.js";
import {
  ACCOUNT_EVENT_TYPES,
  AccountCatalogue,
  AccountChange,
  AccountDirectory,
  AccountDirectoryKind,
  AccountEventType,
  AccountId,
  AccountLabel,
  AccountRecord,
  AccountRemovalReason,
  AccountStatus,
  AccountStatusState,
  AccountUpdatedPayload,
  AmbientProbe,
  CommandEntry,
  DefaultAccount,
  DefaultEffort,
  DefaultModelFamily,
  ModelEntry,
  SignIn,
  SignInCode,
  SignInExecutableChosenPayload,
  SignInExecutableSource,
  SignInFallback,
  SignInStart,
  SignInState,
} from "./accounts.js";
import { BootstrapError, BootstrapGrant, BootstrapKind, BootstrapRequest, ClientSessionCredential } from "./bootstrap.js";
import { AuthPolicy, DiscoveryDocument, EnvironmentReadiness, HealthDocument } from "./discovery.js";
import { Actor, EventEnvelope } from "./envelope.js";
import {
  ErrorCode,
  RateLimitedError,
  SHARED_ERRORS,
  SchemaIssue,
  SharedError,
  WireError,
} from "./errors.js";
import { CapabilityFlag, CapabilityFlags, LauncherProtocol, PROTOCOL_VERSION, ProtocolVersion } from "./flags.js";
import { ForgeKind, ForgeOrigin, ForgeSlug } from "./forge.js";
import {
  FORGE_EVENT_PAYLOADS,
  ForgeAccountId,
  ForgeAccountRecord,
  ForgeAlias,
  ForgeCapabilities,
  ForgeCapability,
  ForgeCapabilityName,
  ForgeCapabilityState,
  ForgeCopiedFrom,
  ForgeCredentialInput,
  ForgeCredentialSource,
  ForgeIdentity,
  ForgeProblem,
  ForgeProblemKind,
  ForgeToken,
  ForgeTokenInformation,
  ForgeTokenKind,
  ForgeVariables,
  ForgeVaultEntry,
  StoredTokenProvenance,
} from "./forge-accounts.js";
import { EnvironmentColour } from "./environment-colours.js";
import { Theme, ThemeName, ThemeSeed } from "./theme.js";
import { ByeReason, EndReason, FRAME_SCHEMAS, FRAME_TYPES, Frame } from "./frames.js";
import {
  ClientKind,
  ClientSessionId,
  CommandId,
  EnvironmentId,
  RequestId,
  Sequence,
  SubscriptionId,
  Timestamp,
  JsonObject,
  PairingId,
} from "./primitives.js";
import { BusyReason, DrainStarted, DrainTrigger, EnvironmentActivity, EnvironmentStatus } from "./lifecycle.js";
import {
  PairError,
  PairRequest,
  PairingExpiredError,
  PairingInvalidError,
  PairingUsedError,
  ProtocolMismatchError,
} from "./pairing.js";
import { EnvironmentNotice, EnvironmentNoticeType } from "./notices.js";
import { AccountUsage, HandoffBasis, HandoffReason, HandoffRecommendation, HandoffTrigger, UsageUpdatedPayload, UsageVerdict, UsageWindow } from "./usage.js";
import {
  AutoSettleAfterIdle,
  AutoSettleOnMerge,
  IdleSpan,
  IdleSpanUnit,
  SETTINGS_EVENT_TYPES,
  SettingsEventType,
  SettingsKeyName,
  SettingsPatch,
  SettingsValues,
  TranscriptCompactAfterDays,
} from "./settings.js";
import { isCommand } from "./method.js";
import {
  AssetFormat,
  ReleaseAsset,
  ReleaseAssetKind,
  ReleaseImage,
  ReleaseManifest,
  ReleasePlatform,
  ReleaseVersion,
  Sha256,
} from "./release.js";
import { UpdateAnswer, UpdateError, UpdateRequest } from "./update-route.js";
import {
  AutoUpdate,
  DeferralCapHours,
  IdleWindowMinutes,
  PinnedVersion,
  ReleaseChannel,
  UpdateSettingsPatch,
  UpdateSettingsValues,
} from "./update-settings.js";
import {
  PendingUpdate,
  UpdateBlockedReason,
  UpdateCancelCause,
  UpdateCancelledPayload,
  UpdateCause,
  UpdateCheck,
  UpdateCheckFailure,
  UpdateConflictReason,
  UpdateFailedPayload,
  UpdateFailureStage,
  UpdateId,
  UpdateManager,
  UpdateOutcome,
  UpdatePendingPayload,
  UpdateSource,
  UpdateStartedPayload,
  UpdateState,
  UpdateWaitsOn,
  UpdateWhen,
  UpdatesStatus,
} from "./updates.js";
import { RegisteredStepId, SetupAction, StepResult, StepState } from "./setup.js";
import { CommandReceipt } from "./receipt.js";
import {
  ActivityState,
  DeletedSessionSummary,
  GROUP_EVENT_TYPES,
  GeneratedTitleSource,
  Group,
  GroupEventType,
  GroupId,
  GroupName,
  GroupPatch,
  Draft,
  StoredDraft,
  ProviderTranscriptOutcome,
  PullRequest,
  PullRequestState,
  SESSION_EVENT_TYPES,
  SessionActivity,
  SessionId,
  SessionListSnapshot,
  SessionSummary,
  SettledBy,
  SettledOverride,
  SummaryPatch,
  Tag,
  TitleSource,
  UnsettleReason,
  UnsnoozeReason,
  UserTitle,
  Workspace,
  WorkspaceRequest,
  WorkspaceStatus,
} from "./sessions.js";
import { SessionEventType, type EventTypeEntry } from "./event-types.js";
import {
  AccountIdentity,
  AdapterCapabilities,
  AdapterCapabilityFlag,
  AuthStatus,
  CredentialSpec,
  DelegatedWorkRow,
  DelegatedWorkStatus,
  InstructionChannel,
  InstructionChannelKind,
  MessageDelivery,
  MessageId,
  ProviderId,
  QueueHolder,
  RunId,
  RunSuggestion,
  SendResponse,
} from "./adapter.js";
import { AttachmentInput } from "./methods/runs.js";
import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatContentPart,
  ChatMessage,
  ChatRole,
  ChatTool,
  ChatToolCall,
  ChatToolCallDelta,
  ChatToolChoice,
  ChatToolFunction,
  CompletionFinishReason,
  CompletionUsage,
  CompletionsActivity,
  CompletionsAnswerExtension,
  CompletionsClamp,
  CompletionsErrorBody,
  CompletionsErrorDetail,
  CompletionsExtension,
  CompletionsModel,
  CompletionsModelList,
  CompletionsRunEnd,
} from "./completions.js";
import { ProcessHold, ProcessHoldKind, ProcessIdleMinutes, ProcessState, ProcessStopReason, ProviderProcess } from "./methods/providers.js";
import {
  AttachmentKind,
  AttachmentRecord,
  InterruptCause,
  ModelUsage,
  RunEndReason,
  RunError,
  RunMode,
  RunOrigin,
  RunState,
  RunSummary,
  SessionSnapshot,
  StandingRewind,
  TRANSCRIPT_EVENT_TYPES,
  ToolStatus,
  TranscriptItem,
  UpdateInterruptOutcome,
  UpdateInterruptReason,
} from "./transcript.js";
import { OrderKey } from "./ordering.js";
import { methods } from "./registry.js";
import { Ceiling, Scope, ScopeSet } from "./scopes.js";
import {
  FilesListSource,
  SessionDiffChange,
  SessionDiffFile,
  TERMINAL_EXITED_TYPE,
  TERMINAL_OUTPUT_TYPE,
  TerminalColumns,
  TerminalEnvironment,
  TerminalExitCause,
  TerminalExitedPayload,
  TerminalId,
  TerminalInfo,
  TerminalOutputPayload,
  TerminalRows,
  TerminalSnapshot,
  WorkspacePath,
} from "./terminals.js";
import { ContainmentUnavailableError } from "./methods/permissions.js";
import { IdentityMismatchError, VerificationFailedError } from "./methods/forge.js";
import {
  ClampReason,
  ContainmentAvailability,
  ContainmentCause,
  ContainmentContainer,
  ContainmentLevel,
  ContainmentMechanism,
  ContainmentReport,
  ContainmentResolution,
  ModeResolution,
  PERMISSION_SESSION_EVENT_TYPES,
  ReviewActor,
  ReviewCounts,
  ReviewDenial,
  ReviewRun,
  RunActorKind,
  RunPolicy,
  ToolDecider,
} from "./permissions.js";
import { Mode, ModeAvailability } from "./permissions-modes.js";
import { Denylist, DenylistEntry, DenylistInput, DenylistMatch, DenylistSection, DenylistTestKind } from "./denylist.js";
import {
  AutoDecider,
  DecidedBy,
  ListedPrompt,
  ParkedPrompt,
  PROMPT_EVENT_TYPES,
  PromptAnswerInput,
  PromptDecisionValue,
  PromptDelivery,
  PromptKind,
  PromptQuestion,
  PromptQuestionOption,
} from "./prompts.js";
import { ParkedPromptTtl, PermissionSettingsPatch, PermissionSettingsValues, SettingsArea, TtlUnit, UnattendedMode } from "./permissions-settings.js";
import { REPOSITORY_IDENTITY_CASES } from "./repository-identity.js";

/**
 * The JSON Schema export: every schema in the package as a draft 2020-12
 * document, so a client in another language can be written from the export
 * alone (ADR 0001). `scripts/export-schemas.ts` writes it to `schema/`, where
 * it is committed; CI regenerates it and fails on any difference.
 */

export const JSON_SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";

/** One exported document: where it is written, its title and the schema it is made from. */
export interface ExportedSchema {
  readonly path: string;
  readonly title: string;
  readonly schema: z.ZodType;
}

const pascal = (words: string): string =>
  words
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");

/**
 * The session and group event types whose payloads are fixed, each with its
 * payload, the prompt types, the transcript vocabulary and the permission
 * types among them; a type reserved by name for a workstream that has not
 * fixed its payload yet would be left out.
 */
export const publishedEventPayloads = (): [string, z.ZodType][] =>
  Object.entries({ ...SESSION_EVENT_TYPES, ...PROMPT_EVENT_TYPES, ...TRANSCRIPT_EVENT_TYPES, ...PERMISSION_SESSION_EVENT_TYPES, ...GROUP_EVENT_TYPES } as Record<string, EventTypeEntry>).flatMap(([type, entry]) =>
    entry.reservedFor === undefined ? [[type, entry.payload] as [string, z.ZodType]] : [],
  );

/** Where the export writes one of a method's documents, under `schema/`. */
export const methodPath = (name: string, part: "params" | "result" | "response" | "error"): string =>
  `methods/${name}/${part}.json`;

/** Every schema the export writes, in a stable order. */
export const exportedSchemas = (): ExportedSchema[] => [
  { path: "protocol-version.json", title: "ProtocolVersion", schema: ProtocolVersion },
  { path: "capability-flag.json", title: "CapabilityFlag", schema: CapabilityFlag },
  { path: "capability-flags.json", title: "CapabilityFlags", schema: CapabilityFlags },
  { path: "scope.json", title: "Scope", schema: Scope },
  { path: "scope-set.json", title: "ScopeSet", schema: ScopeSet },
  { path: "ceiling.json", title: "Ceiling", schema: Ceiling },
  { path: "client-kind.json", title: "ClientKind", schema: ClientKind },
  { path: "command-id.json", title: "CommandId", schema: CommandId },
  { path: "command-receipt.json", title: "CommandReceipt", schema: CommandReceipt },
  { path: "environment-id.json", title: "EnvironmentId", schema: EnvironmentId },
  { path: "client-session-id.json", title: "ClientSessionId", schema: ClientSessionId },
  { path: "pairing-id.json", title: "PairingId", schema: PairingId },
  { path: "request-id.json", title: "RequestId", schema: RequestId },
  { path: "subscription-id.json", title: "SubscriptionId", schema: SubscriptionId },
  { path: "sequence.json", title: "Sequence", schema: Sequence },
  { path: "timestamp.json", title: "Timestamp", schema: Timestamp },
  { path: "json-object.json", title: "JsonObject", schema: JsonObject },
  { path: "environment-readiness.json", title: "EnvironmentReadiness", schema: EnvironmentReadiness },
  { path: "auth-policy.json", title: "AuthPolicy", schema: AuthPolicy },
  { path: "discovery-document.json", title: "DiscoveryDocument", schema: DiscoveryDocument },
  { path: "health-document.json", title: "HealthDocument", schema: HealthDocument },
  { path: "launcher-protocol.json", title: "LauncherProtocol", schema: LauncherProtocol },
  { path: "release/release-version.json", title: "ReleaseVersion", schema: ReleaseVersion },
  { path: "release/sha256.json", title: "Sha256", schema: Sha256 },
  { path: "release/asset-kind.json", title: "ReleaseAssetKind", schema: ReleaseAssetKind },
  { path: "release/platform.json", title: "ReleasePlatform", schema: ReleasePlatform },
  { path: "release/asset-format.json", title: "AssetFormat", schema: AssetFormat },
  { path: "release/asset.json", title: "ReleaseAsset", schema: ReleaseAsset },
  { path: "release/image.json", title: "ReleaseImage", schema: ReleaseImage },
  { path: "release/manifest.json", title: "ReleaseManifest", schema: ReleaseManifest },
  { path: "lifecycle/busy-reason.json", title: "BusyReason", schema: BusyReason },
  { path: "lifecycle/drain-trigger.json", title: "DrainTrigger", schema: DrainTrigger },
  { path: "lifecycle/drain-started.json", title: "DrainStarted", schema: DrainStarted },
  { path: "lifecycle/environment-activity.json", title: "EnvironmentActivity", schema: EnvironmentActivity },
  { path: "lifecycle/environment-status.json", title: "EnvironmentStatus", schema: EnvironmentStatus },
  { path: "bootstrap/kind.json", title: "BootstrapKind", schema: BootstrapKind },
  { path: "bootstrap/grant.json", title: "BootstrapGrant", schema: BootstrapGrant },
  { path: "bootstrap/request.json", title: "BootstrapRequest", schema: BootstrapRequest },
  { path: "bootstrap/error.json", title: "BootstrapError", schema: BootstrapError },
  { path: "client-session-credential.json", title: "ClientSessionCredential", schema: ClientSessionCredential },
  { path: "pair/request.json", title: "PairRequest", schema: PairRequest },
  { path: "pair/error.json", title: "PairError", schema: PairError },
  { path: "update/request.json", title: "UpdateRequest", schema: UpdateRequest },
  { path: "update/answer.json", title: "UpdateAnswer", schema: UpdateAnswer },
  { path: "update/error.json", title: "UpdateError", schema: UpdateError },
  { path: "access/event-type.json", title: "AccessEventType", schema: AccessEventType },
  { path: "access/client-session-origin.json", title: "ClientSessionOrigin", schema: ClientSessionOrigin },
  { path: "access/revocation-reason.json", title: "RevocationReason", schema: RevocationReason },
  ...ACCESS_EVENT_TYPES.map((type) => ({
    path: `access/events/${type}.json`,
    title: `${pascal(type)}Payload`,
    schema: ACCESS_EVENT_PAYLOADS[type],
  })),
  { path: "sessions/session-id.json", title: "SessionId", schema: SessionId },
  { path: "sessions/group-id.json", title: "GroupId", schema: GroupId },
  { path: "sessions/order-key.json", title: "OrderKey", schema: OrderKey },
  { path: "sessions/user-title.json", title: "UserTitle", schema: UserTitle },
  { path: "sessions/tag.json", title: "Tag", schema: Tag },
  { path: "sessions/draft.json", title: "Draft", schema: Draft },
  { path: "sessions/stored-draft.json", title: "StoredDraft", schema: StoredDraft },
  { path: "sessions/group-name.json", title: "GroupName", schema: GroupName },
  { path: "sessions/title-source.json", title: "TitleSource", schema: TitleSource },
  { path: "sessions/generated-title-source.json", title: "GeneratedTitleSource", schema: GeneratedTitleSource },
  { path: "sessions/settled-override.json", title: "SettledOverride", schema: SettledOverride },
  { path: "sessions/settled-by.json", title: "SettledBy", schema: SettledBy },
  { path: "sessions/unsettle-reason.json", title: "UnsettleReason", schema: UnsettleReason },
  { path: "sessions/unsnooze-reason.json", title: "UnsnoozeReason", schema: UnsnoozeReason },
  { path: "sessions/workspace.json", title: "Workspace", schema: Workspace },
  { path: "sessions/workspace-request.json", title: "WorkspaceRequest", schema: WorkspaceRequest },
  { path: "sessions/workspace-status.json", title: "WorkspaceStatus", schema: WorkspaceStatus },
  { path: "sessions/activity-state.json", title: "ActivityState", schema: ActivityState },
  { path: "sessions/session-activity.json", title: "SessionActivity", schema: SessionActivity },
  { path: "sessions/pull-request-state.json", title: "PullRequestState", schema: PullRequestState },
  { path: "sessions/pull-request.json", title: "PullRequest", schema: PullRequest },
  { path: "sessions/session-summary.json", title: "SessionSummary", schema: SessionSummary },
  { path: "sessions/provider-transcript-outcome.json", title: "ProviderTranscriptOutcome", schema: ProviderTranscriptOutcome },
  { path: "sessions/deleted-session-summary.json", title: "DeletedSessionSummary", schema: DeletedSessionSummary },
  { path: "sessions/group.json", title: "Group", schema: Group },
  { path: "sessions/summary-patch.json", title: "SummaryPatch", schema: SummaryPatch },
  { path: "sessions/group-patch.json", title: "GroupPatch", schema: GroupPatch },
  { path: "sessions/session-list-snapshot.json", title: "SessionListSnapshot", schema: SessionListSnapshot },
  { path: "sessions/session-event-type.json", title: "SessionEventType", schema: SessionEventType },
  { path: "sessions/group-event-type.json", title: "GroupEventType", schema: GroupEventType },
  ...publishedEventPayloads().map(([type, schema]) => ({ path: `sessions/events/${type}.json`, title: `${pascal(type)}Payload`, schema })),
  { path: "adapter/run-id.json", title: "RunId", schema: RunId },
  { path: "adapter/message-id.json", title: "MessageId", schema: MessageId },
  { path: "adapter/provider-id.json", title: "ProviderId", schema: ProviderId },
  { path: "adapter/account-identity.json", title: "AccountIdentity", schema: AccountIdentity },
  { path: "adapter/instruction-channel-kind.json", title: "InstructionChannelKind", schema: InstructionChannelKind },
  { path: "adapter/instruction-channel.json", title: "InstructionChannel", schema: InstructionChannel },
  { path: "adapter/capability-flag.json", title: "AdapterCapabilityFlag", schema: AdapterCapabilityFlag },
  { path: "adapter/capabilities.json", title: "AdapterCapabilities", schema: AdapterCapabilities },
  { path: "adapter/credential-spec.json", title: "CredentialSpec", schema: CredentialSpec },
  { path: "adapter/auth-status.json", title: "AuthStatus", schema: AuthStatus },
  { path: "adapter/message-delivery.json", title: "MessageDelivery", schema: MessageDelivery },
  { path: "adapter/queue-holder.json", title: "QueueHolder", schema: QueueHolder },
  { path: "adapter/send-response.json", title: "SendResponse", schema: SendResponse },
  { path: "adapter/delegated-work-status.json", title: "DelegatedWorkStatus", schema: DelegatedWorkStatus },
  { path: "adapter/delegated-work-row.json", title: "DelegatedWorkRow", schema: DelegatedWorkRow },
  { path: "adapter/run-suggestion.json", title: "RunSuggestion", schema: RunSuggestion },
  { path: "adapter/process-state.json", title: "ProcessState", schema: ProcessState },
  { path: "adapter/process-stop-reason.json", title: "ProcessStopReason", schema: ProcessStopReason },
  { path: "adapter/process-hold-kind.json", title: "ProcessHoldKind", schema: ProcessHoldKind },
  { path: "adapter/process-hold.json", title: "ProcessHold", schema: ProcessHold },
  { path: "adapter/provider-process.json", title: "ProviderProcess", schema: ProviderProcess },
  { path: "accounts/account-id.json", title: "AccountId", schema: AccountId },
  { path: "accounts/account-label.json", title: "AccountLabel", schema: AccountLabel },
  { path: "accounts/directory-kind.json", title: "AccountDirectoryKind", schema: AccountDirectoryKind },
  { path: "accounts/directory.json", title: "AccountDirectory", schema: AccountDirectory },
  { path: "accounts/status-state.json", title: "AccountStatusState", schema: AccountStatusState },
  { path: "accounts/status.json", title: "AccountStatus", schema: AccountStatus },
  { path: "accounts/account-record.json", title: "AccountRecord", schema: AccountRecord },
  { path: "accounts/removal-reason.json", title: "AccountRemovalReason", schema: AccountRemovalReason },
  { path: "accounts/event-type.json", title: "AccountEventType", schema: AccountEventType },
  ...Object.entries(ACCOUNT_EVENT_TYPES).map(([type, entry]) => ({
    path: `accounts/events/${type}.json`,
    title: `${pascal(type)}Payload`,
    schema: entry.payload as z.ZodType,
  })),
  { path: "accounts/change.json", title: "AccountChange", schema: AccountChange },
  { path: "accounts/account-updated.json", title: "AccountUpdatedPayload", schema: AccountUpdatedPayload },
  { path: "accounts/ambient-probe.json", title: "AmbientProbe", schema: AmbientProbe },
  { path: "accounts/model-entry.json", title: "ModelEntry", schema: ModelEntry },
  { path: "accounts/catalogue.json", title: "AccountCatalogue", schema: AccountCatalogue },
  { path: "accounts/command-entry.json", title: "CommandEntry", schema: CommandEntry },
  { path: "accounts/sign-in-start.json", title: "SignInStart", schema: SignInStart },
  { path: "accounts/sign-in-state.json", title: "SignInState", schema: SignInState },
  { path: "accounts/sign-in-fallback.json", title: "SignInFallback", schema: SignInFallback },
  { path: "accounts/sign-in.json", title: "SignIn", schema: SignIn },
  { path: "accounts/sign-in-code.json", title: "SignInCode", schema: SignInCode },
  { path: "accounts/sign-in-executable-source.json", title: "SignInExecutableSource", schema: SignInExecutableSource },
  { path: "accounts/sign-in-executable-chosen.json", title: "SignInExecutableChosenPayload", schema: SignInExecutableChosenPayload },
  { path: "forge/kind.json", title: "ForgeKind", schema: ForgeKind },
  { path: "forge/origin.json", title: "ForgeOrigin", schema: ForgeOrigin },
  { path: "forge/slug.json", title: "ForgeSlug", schema: ForgeSlug },
  { path: "forge/account-id.json", title: "ForgeAccountId", schema: ForgeAccountId },
  { path: "forge/identity.json", title: "ForgeIdentity", schema: ForgeIdentity },
  { path: "forge/alias.json", title: "ForgeAlias", schema: ForgeAlias },
  { path: "forge/stored-token-provenance.json", title: "StoredTokenProvenance", schema: StoredTokenProvenance },
  { path: "forge/vault-entry.json", title: "ForgeVaultEntry", schema: ForgeVaultEntry },
  { path: "forge/credential-source.json", title: "ForgeCredentialSource", schema: ForgeCredentialSource },
  { path: "forge/token.json", title: "ForgeToken", schema: ForgeToken },
  { path: "forge/credential-input.json", title: "ForgeCredentialInput", schema: ForgeCredentialInput },
  { path: "forge/capability-name.json", title: "ForgeCapabilityName", schema: ForgeCapabilityName },
  { path: "forge/capability-state.json", title: "ForgeCapabilityState", schema: ForgeCapabilityState },
  { path: "forge/capability.json", title: "ForgeCapability", schema: ForgeCapability },
  { path: "forge/capabilities.json", title: "ForgeCapabilities", schema: ForgeCapabilities },
  { path: "forge/problem-kind.json", title: "ForgeProblemKind", schema: ForgeProblemKind },
  { path: "forge/problem.json", title: "ForgeProblem", schema: ForgeProblem },
  { path: "forge/token-kind.json", title: "ForgeTokenKind", schema: ForgeTokenKind },
  { path: "forge/token-information.json", title: "ForgeTokenInformation", schema: ForgeTokenInformation },
  { path: "forge/copied-from.json", title: "ForgeCopiedFrom", schema: ForgeCopiedFrom },
  { path: "forge/variables.json", title: "ForgeVariables", schema: ForgeVariables },
  { path: "forge/account-record.json", title: "ForgeAccountRecord", schema: ForgeAccountRecord },
  ...Object.entries(FORGE_EVENT_PAYLOADS).map(([type, payload]) => ({
    path: `forge/events/${type}.json`,
    title: `${pascal(type)}Payload`,
    schema: payload as z.ZodType,
  })),
  { path: "theme/theme.json", title: "Theme", schema: Theme },
  { path: "theme/name.json", title: "ThemeName", schema: ThemeName },
  { path: "theme/seed.json", title: "ThemeSeed", schema: ThemeSeed },
  { path: "environment-colour.json", title: "EnvironmentColour", schema: EnvironmentColour },
  { path: "usage/verdict.json", title: "UsageVerdict", schema: UsageVerdict },
  { path: "usage/window.json", title: "UsageWindow", schema: UsageWindow },
  { path: "usage/account-usage.json", title: "AccountUsage", schema: AccountUsage },
  { path: "usage/usage-updated.json", title: "UsageUpdatedPayload", schema: UsageUpdatedPayload },
  { path: "usage/handoff-reason.json", title: "HandoffReason", schema: HandoffReason },
  { path: "usage/handoff-basis.json", title: "HandoffBasis", schema: HandoffBasis },
  { path: "usage/handoff-trigger.json", title: "HandoffTrigger", schema: HandoffTrigger },
  { path: "usage/handoff-recommendation.json", title: "HandoffRecommendation", schema: HandoffRecommendation },
  { path: "transcript/run-origin.json", title: "RunOrigin", schema: RunOrigin },
  { path: "transcript/run-end-reason.json", title: "RunEndReason", schema: RunEndReason },
  { path: "transcript/interrupt-cause.json", title: "InterruptCause", schema: InterruptCause },
  { path: "transcript/update-interrupt-outcome.json", title: "UpdateInterruptOutcome", schema: UpdateInterruptOutcome },
  { path: "transcript/update-interrupt-reason.json", title: "UpdateInterruptReason", schema: UpdateInterruptReason },
  { path: "transcript/attachment-kind.json", title: "AttachmentKind", schema: AttachmentKind },
  { path: "transcript/attachment-record.json", title: "AttachmentRecord", schema: AttachmentRecord },
  { path: "transcript/attachment-input.json", title: "AttachmentInput", schema: AttachmentInput },
  { path: "completions/extension.json", title: "CompletionsExtension", schema: CompletionsExtension },
  { path: "completions/chat-role.json", title: "ChatRole", schema: ChatRole },
  { path: "completions/content-part.json", title: "ChatContentPart", schema: ChatContentPart },
  { path: "completions/message.json", title: "ChatMessage", schema: ChatMessage },
  { path: "completions/tool-function.json", title: "ChatToolFunction", schema: ChatToolFunction },
  { path: "completions/tool.json", title: "ChatTool", schema: ChatTool },
  { path: "completions/tool-choice.json", title: "ChatToolChoice", schema: ChatToolChoice },
  { path: "completions/request.json", title: "ChatCompletionRequest", schema: ChatCompletionRequest },
  { path: "completions/tool-call.json", title: "ChatToolCall", schema: ChatToolCall },
  { path: "completions/tool-call-delta.json", title: "ChatToolCallDelta", schema: ChatToolCallDelta },
  { path: "completions/finish-reason.json", title: "CompletionFinishReason", schema: CompletionFinishReason },
  { path: "completions/clamp.json", title: "CompletionsClamp", schema: CompletionsClamp },
  { path: "completions/activity.json", title: "CompletionsActivity", schema: CompletionsActivity },
  { path: "completions/run-end.json", title: "CompletionsRunEnd", schema: CompletionsRunEnd },
  { path: "completions/answer-extension.json", title: "CompletionsAnswerExtension", schema: CompletionsAnswerExtension },
  { path: "completions/usage.json", title: "CompletionUsage", schema: CompletionUsage },
  { path: "completions/error-detail.json", title: "CompletionsErrorDetail", schema: CompletionsErrorDetail },
  { path: "completions/error-body.json", title: "CompletionsErrorBody", schema: CompletionsErrorBody },
  { path: "completions/chunk.json", title: "ChatCompletionChunk", schema: ChatCompletionChunk },
  { path: "completions/completion.json", title: "ChatCompletion", schema: ChatCompletion },
  { path: "completions/model.json", title: "CompletionsModel", schema: CompletionsModel },
  { path: "completions/model-list.json", title: "CompletionsModelList", schema: CompletionsModelList },
  { path: "transcript/run-mode.json", title: "RunMode", schema: RunMode },
  { path: "transcript/model-usage.json", title: "ModelUsage", schema: ModelUsage },
  { path: "transcript/run-error.json", title: "RunError", schema: RunError },
  { path: "transcript/run-state.json", title: "RunState", schema: RunState },
  { path: "transcript/tool-status.json", title: "ToolStatus", schema: ToolStatus },
  { path: "transcript/run-summary.json", title: "RunSummary", schema: RunSummary },
  { path: "transcript/transcript-item.json", title: "TranscriptItem", schema: TranscriptItem },
  { path: "transcript/parked-prompt.json", title: "ParkedPrompt", schema: ParkedPrompt },
  { path: "transcript/standing-rewind.json", title: "StandingRewind", schema: StandingRewind },
  { path: "transcript/session-snapshot.json", title: "SessionSnapshot", schema: SessionSnapshot },
  { path: "permissions/mode.json", title: "Mode", schema: Mode },
  { path: "permissions/mode-availability.json", title: "ModeAvailability", schema: ModeAvailability },
  { path: "permissions/run-actor-kind.json", title: "RunActorKind", schema: RunActorKind },
  { path: "permissions/clamp-reason.json", title: "ClampReason", schema: ClampReason },
  { path: "permissions/mode-resolution.json", title: "ModeResolution", schema: ModeResolution },
  { path: "permissions/containment-level.json", title: "ContainmentLevel", schema: ContainmentLevel },
  { path: "permissions/containment-cause.json", title: "ContainmentCause", schema: ContainmentCause },
  { path: "permissions/containment-availability.json", title: "ContainmentAvailability", schema: ContainmentAvailability },
  { path: "permissions/containment-mechanism.json", title: "ContainmentMechanism", schema: ContainmentMechanism },
  { path: "permissions/containment-container.json", title: "ContainmentContainer", schema: ContainmentContainer },
  { path: "permissions/containment-report.json", title: "ContainmentReport", schema: ContainmentReport },
  { path: "permissions/containment-resolution.json", title: "ContainmentResolution", schema: ContainmentResolution },
  { path: "permissions/tool-decider.json", title: "ToolDecider", schema: ToolDecider },
  { path: "permissions/run-policy.json", title: "RunPolicy", schema: RunPolicy },
  { path: "permissions/settings-area.json", title: "SettingsArea", schema: SettingsArea },
  { path: "permissions/unattended-mode.json", title: "UnattendedMode", schema: UnattendedMode },
  { path: "permissions/ttl-unit.json", title: "TtlUnit", schema: TtlUnit },
  { path: "permissions/parked-prompt-ttl.json", title: "ParkedPromptTtl", schema: ParkedPromptTtl },
  { path: "permissions/settings-values.json", title: "PermissionSettingsValues", schema: PermissionSettingsValues },
  { path: "permissions/settings-patch.json", title: "PermissionSettingsPatch", schema: PermissionSettingsPatch },
  { path: "permissions/prompt-kind.json", title: "PromptKind", schema: PromptKind },
  { path: "permissions/prompt-question-option.json", title: "PromptQuestionOption", schema: PromptQuestionOption },
  { path: "permissions/prompt-question.json", title: "PromptQuestion", schema: PromptQuestion },
  { path: "permissions/auto-decider.json", title: "AutoDecider", schema: AutoDecider },
  { path: "permissions/decided-by.json", title: "DecidedBy", schema: DecidedBy },
  { path: "permissions/prompt-delivery.json", title: "PromptDelivery", schema: PromptDelivery },
  { path: "permissions/prompt-decision.json", title: "PromptDecisionValue", schema: PromptDecisionValue },
  { path: "permissions/prompt-answer-input.json", title: "PromptAnswerInput", schema: PromptAnswerInput },
  { path: "permissions/denylist-section.json", title: "DenylistSection", schema: DenylistSection },
  { path: "permissions/denylist-entry.json", title: "DenylistEntry", schema: DenylistEntry },
  { path: "permissions/denylist.json", title: "Denylist", schema: Denylist },
  { path: "permissions/denylist-input.json", title: "DenylistInput", schema: DenylistInput },
  { path: "permissions/denylist-match.json", title: "DenylistMatch", schema: DenylistMatch },
  { path: "permissions/denylist-test-kind.json", title: "DenylistTestKind", schema: DenylistTestKind },
  { path: "permissions/listed-prompt.json", title: "ListedPrompt", schema: ListedPrompt },
  { path: "permissions/review-actor.json", title: "ReviewActor", schema: ReviewActor },
  { path: "permissions/review-counts.json", title: "ReviewCounts", schema: ReviewCounts },
  { path: "permissions/review-denial.json", title: "ReviewDenial", schema: ReviewDenial },
  { path: "permissions/review-run.json", title: "ReviewRun", schema: ReviewRun },
  { path: "terminals/terminal-id.json", title: "TerminalId", schema: TerminalId },
  { path: "terminals/terminal-columns.json", title: "TerminalColumns", schema: TerminalColumns },
  { path: "terminals/terminal-rows.json", title: "TerminalRows", schema: TerminalRows },
  { path: "terminals/terminal-environment.json", title: "TerminalEnvironment", schema: TerminalEnvironment },
  { path: "terminals/terminal-exit-cause.json", title: "TerminalExitCause", schema: TerminalExitCause },
  { path: "terminals/terminal-info.json", title: "TerminalInfo", schema: TerminalInfo },
  { path: "terminals/terminal-snapshot.json", title: "TerminalSnapshot", schema: TerminalSnapshot },
  { path: `terminals/events/${TERMINAL_OUTPUT_TYPE}.json`, title: "TerminalOutputPayload", schema: TerminalOutputPayload },
  { path: `terminals/events/${TERMINAL_EXITED_TYPE}.json`, title: "TerminalExitedPayload", schema: TerminalExitedPayload },
  { path: "files/workspace-path.json", title: "WorkspacePath", schema: WorkspacePath },
  { path: "files/files-list-source.json", title: "FilesListSource", schema: FilesListSource },
  { path: "diffs/session-diff-change.json", title: "SessionDiffChange", schema: SessionDiffChange },
  { path: "diffs/session-diff-file.json", title: "SessionDiffFile", schema: SessionDiffFile },
  { path: "actions/action-context.json", title: "ActionContext", schema: ActionContext },
  { path: "actions/action-condition.json", title: "ActionCondition", schema: ActionCondition },
  { path: "actions/action.json", title: "Action", schema: Action },
  { path: "actor.json", title: "Actor", schema: Actor },
  { path: "event-envelope.json", title: "EventEnvelope", schema: EventEnvelope },
  { path: "notices/environment-notice-type.json", title: "EnvironmentNoticeType", schema: EnvironmentNoticeType },
  { path: "notices/environment-notice.json", title: "EnvironmentNotice", schema: EnvironmentNotice },
  { path: "settings/settings-key.json", title: "SettingsKey", schema: SettingsKeyName },
  { path: "settings/idle-span-unit.json", title: "IdleSpanUnit", schema: IdleSpanUnit },
  { path: "settings/idle-span.json", title: "IdleSpan", schema: IdleSpan },
  { path: "settings/keys/sessions.autoSettleAfterIdle.json", title: "AutoSettleAfterIdle", schema: AutoSettleAfterIdle },
  { path: "settings/keys/sessions.autoSettleOnMerge.json", title: "AutoSettleOnMerge", schema: AutoSettleOnMerge },
  {
    path: "settings/keys/sessions.transcriptCompactAfterDays.json",
    title: "TranscriptCompactAfterDays",
    schema: TranscriptCompactAfterDays,
  },
  { path: "settings/keys/accounts.defaultAccount.json", title: "DefaultAccount", schema: DefaultAccount },
  { path: "settings/keys/accounts.defaultModelFamily.json", title: "DefaultModelFamily", schema: DefaultModelFamily },
  { path: "settings/keys/accounts.defaultEffort.json", title: "DefaultEffort", schema: DefaultEffort },
  { path: "settings/keys/providers.processIdleMinutes.json", title: "ProcessIdleMinutes", schema: ProcessIdleMinutes },
  { path: "settings/keys/updates.autoUpdate.json", title: "AutoUpdate", schema: AutoUpdate },
  { path: "settings/keys/updates.channel.json", title: "ReleaseChannel", schema: ReleaseChannel },
  { path: "settings/keys/updates.pinnedVersion.json", title: "PinnedVersion", schema: PinnedVersion },
  { path: "settings/keys/updates.idleWindowMinutes.json", title: "IdleWindowMinutes", schema: IdleWindowMinutes },
  { path: "settings/keys/updates.deferralCapHours.json", title: "DeferralCapHours", schema: DeferralCapHours },
  { path: "settings/settings-values.json", title: "SettingsValues", schema: SettingsValues },
  { path: "settings/settings-patch.json", title: "SettingsPatch", schema: SettingsPatch },
  { path: "settings/settings-event-type.json", title: "SettingsEventType", schema: SettingsEventType },
  { path: "updates/update-id.json", title: "UpdateId", schema: UpdateId },
  { path: "updates/update-source.json", title: "UpdateSource", schema: UpdateSource },
  { path: "updates/update-cause.json", title: "UpdateCause", schema: UpdateCause },
  { path: "updates/update-failure-stage.json", title: "UpdateFailureStage", schema: UpdateFailureStage },
  { path: "updates/update-cancel-cause.json", title: "UpdateCancelCause", schema: UpdateCancelCause },
  { path: "updates/events/environment.update-pending.json", title: "UpdatePendingPayload", schema: UpdatePendingPayload },
  { path: "updates/events/environment.update-started.json", title: "UpdateStartedPayload", schema: UpdateStartedPayload },
  { path: "updates/events/environment.update-failed.json", title: "UpdateFailedPayload", schema: UpdateFailedPayload },
  { path: "updates/events/environment.update-cancelled.json", title: "UpdateCancelledPayload", schema: UpdateCancelledPayload },
  { path: "updates/manager.json", title: "UpdateManager", schema: UpdateManager },
  { path: "updates/check-failure.json", title: "UpdateCheckFailure", schema: UpdateCheckFailure },
  { path: "updates/check.json", title: "UpdateCheck", schema: UpdateCheck },
  { path: "updates/update-state.json", title: "UpdateState", schema: UpdateState },
  { path: "updates/blocked-reason.json", title: "UpdateBlockedReason", schema: UpdateBlockedReason },
  { path: "updates/waits-on.json", title: "UpdateWaitsOn", schema: UpdateWaitsOn },
  { path: "updates/pending-update.json", title: "PendingUpdate", schema: PendingUpdate },
  { path: "updates/outcome.json", title: "UpdateOutcome", schema: UpdateOutcome },
  { path: "updates/status.json", title: "UpdatesStatus", schema: UpdatesStatus },
  { path: "updates/when.json", title: "UpdateWhen", schema: UpdateWhen },
  { path: "updates/conflict-reason.json", title: "UpdateConflictReason", schema: UpdateConflictReason },
  { path: "updates/settings-values.json", title: "UpdateSettingsValues", schema: UpdateSettingsValues },
  { path: "updates/settings-patch.json", title: "UpdateSettingsPatch", schema: UpdateSettingsPatch },
  { path: "setup/registered-step-id.json", title: "RegisteredStepId", schema: RegisteredStepId },
  { path: "setup/action.json", title: "SetupAction", schema: SetupAction },
  { path: "setup/step-state.json", title: "StepState", schema: StepState },
  { path: "setup/step-result.json", title: "StepResult", schema: StepResult },
  ...Object.entries(SETTINGS_EVENT_TYPES).map(([type, entry]) => ({
    path: `settings/events/${type}.json`,
    title: `${pascal(type)}Payload`,
    schema: entry.payload,
  })),
  { path: "errors/error-code.json", title: "ErrorCode", schema: ErrorCode },
  { path: "errors/schema-issue.json", title: "SchemaIssue", schema: SchemaIssue },
  { path: "errors/wire-error.json", title: "WireError", schema: WireError },
  { path: "errors/shared-error.json", title: "SharedError", schema: SharedError },
  ...SHARED_ERRORS.map((member) => {
    const code = member.shape.code.value;
    return { path: `errors/${code}.json`, title: `${pascal(code)}Error`, schema: member };
  }),
  { path: "errors/rate_limited.json", title: "RateLimitedError", schema: RateLimitedError },
  { path: "errors/pairing_invalid.json", title: "PairingInvalidError", schema: PairingInvalidError },
  { path: "errors/pairing_expired.json", title: "PairingExpiredError", schema: PairingExpiredError },
  { path: "errors/pairing_used.json", title: "PairingUsedError", schema: PairingUsedError },
  { path: "errors/protocol_mismatch.json", title: "ProtocolMismatchError", schema: ProtocolMismatchError },
  { path: "errors/containment_unavailable.json", title: "ContainmentUnavailableError", schema: ContainmentUnavailableError },
  { path: "errors/verification_failed.json", title: "VerificationFailedError", schema: VerificationFailedError },
  { path: "errors/identity_mismatch.json", title: "IdentityMismatchError", schema: IdentityMismatchError },
  { path: "frames/frame.json", title: "Frame", schema: Frame },
  ...FRAME_TYPES.map((kind) => ({ path: `frames/${kind}.json`, title: `${pascal(kind)}Frame`, schema: FRAME_SCHEMAS[kind] })),
  { path: "frames/end-reason.json", title: "EndReason", schema: EndReason },
  { path: "frames/bye-reason.json", title: "ByeReason", schema: ByeReason },
  ...methods.flatMap((method) => [
    { path: methodPath(method.name, "params"), title: `${method.name} params`, schema: method.params },
    { path: methodPath(method.name, "result"), title: `${method.name} result`, schema: method.result },
    ...(isCommand(method) ? [{ path: methodPath(method.name, "response"), title: `${method.name} response`, schema: method.response }] : []),
    { path: methodPath(method.name, "error"), title: `${method.name} error`, schema: method.error },
  ]),
];


/**
 * A table of cases published beside the schemas: a pure rule's inputs and
 * the answers the contracts give, for a client in another language to run
 * its own implementation of the rule against.
 */
export interface PublishedCaseTable {
  readonly path: string;
  readonly title: string;
  /** The rule, step by step, and what each case holds. */
  readonly description: string;
  readonly cases: readonly unknown[];
}

/** Every case table the export writes, in a stable order. */
export const publishedCaseTables = (): PublishedCaseTable[] => [
  {
    path: "cases/repository-identity.json",
    title: "Repository identity",
    description: [
      "The repository identity rule, repositoryIdentityOf in the contracts package (workspace-picker spec, \"Repository identity\").",
      "Each case gives a remote as git expands it, the environment's forge accounts (each its canonical origin and verified aliases) and the identity the rule answers, or null for none.",
      "The rule: parse https:// and http:// (userinfo dropped), ssh://[user@]host[:port]/path (and git+ssh://, ssh+git://), scp [user@]host:path whose host has a dot, is localhost or is a bracketed IPv6 literal, a bare host:port/path as https, and git://, reading ssh.github.com as github.com; anything else, a local path and file:// among them, is none.",
      "The host is lower-cased and its port dropped; a host that is no forge account's canonical host and a verified alias of exactly one account becomes that account's canonical host.",
      "The path drops a query, a fragment, empty segments and one trailing .git, and is lower-cased; under two segments it is none.",
      "The identity is https:// + host + / + path.",
    ].join(" "),
    cases: REPOSITORY_IDENTITY_CASES.map(({ note, remote, forgeAccounts = [], identity }) => ({ note, remote, forgeAccounts, identity })),
  },
];

/** The document for one exported schema: the schema as zod's decoder reads it, titled. */
const document = (entry: ExportedSchema): Record<string, unknown> => {
  const { $schema, ...rest } = z.toJSONSchema(entry.schema, { target: "draft-2020-12", io: "input" });
  return { $schema, title: entry.title, ...rest };
};

const GENERATED = "Generated by `pnpm --filter @agent-harness/contracts export-schemas`. Do not edit.";

/**
 * The manifest a client starts from: the protocol version, every document by
 * path and title, every case table by path and title, and every method with
 * its scope, kind, stream flag and documents; a command's include its
 * response, the receipt beside the result.
 */
const index = (entries: readonly ExportedSchema[], tables: readonly PublishedCaseTable[]) => ({
  $comment: GENERATED,
  protocolVersion: PROTOCOL_VERSION,
  schemas: entries.map(({ path, title }) => ({ path, title })),
  cases: tables.map(({ path, title }) => ({ path, title })),
  methods: methods.map((m) => ({
    name: m.name,
    scope: m.scope,
    kind: m.kind,
    /** The env spec's stream flag, kept beside the kind for a client that reads only it. */
    stream: m.kind === "stream",
    params: methodPath(m.name, "params"),
    result: methodPath(m.name, "result"),
    /** A command's response: its receipt, and its result when the request applied it. */
    ...(isCommand(m) && { response: methodPath(m.name, "response") }),
    error: methodPath(m.name, "error"),
  })),
});

const serialise = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Every file of the export, by path under `schema/`: one per schema, one per case table, and `index.json`. */
export const jsonSchemaFiles = (): Map<string, string> => {
  const entries = exportedSchemas();
  const tables = publishedCaseTables();
  const files = new Map<string, string>();
  for (const { path, content } of [
    ...entries.map((entry) => ({ path: entry.path, content: document(entry) })),
    ...tables.map(({ path, ...table }) => ({ path, content: { $comment: GENERATED, ...table } })),
  ]) {
    if (files.has(path)) throw new Error(`Two documents export to ${path}.`);
    files.set(path, serialise(content));
  }
  files.set("index.json", serialise(index(entries, tables)));
  return files;
};
