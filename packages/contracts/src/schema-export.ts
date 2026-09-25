import { z } from "zod";
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
  SignInStart,
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
import { CapabilityFlag, CapabilityFlags, PROTOCOL_VERSION, ProtocolVersion } from "./flags.js";
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
import { ProcessHold, ProcessHoldKind, ProcessIdleMinutes, ProcessState, ProcessStopReason, ProviderProcess } from "./methods/providers.js";
import {
  AttachmentKind,
  AttachmentRecord,
  InterruptCause,
  ModelUsage,
  ParkedPrompt,
  RunEndReason,
  RunError,
  RunMode,
  RunOrigin,
  RunState,
  RunSummary,
  SessionSnapshot,
  TRANSCRIPT_EVENT_TYPES,
  ToolStatus,
  TranscriptItem,
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
import {
  ClampReason,
  ContainmentAvailability,
  ContainmentLevel,
  ContainmentResolution,
  ModeResolution,
  PERMISSION_SESSION_EVENT_TYPES,
  RunActorKind,
  RunPolicy,
} from "./permissions.js";
import { Mode, ModeAvailability } from "./permissions-modes.js";
import { ParkedPromptTtl, PermissionSettingsPatch, PermissionSettingsValues, SettingsArea, TtlUnit, UnattendedMode } from "./permissions-settings.js";

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
 * payload, the transcript vocabulary and the permission types among them:
 * the reserved prompt types are left out until #130 fixes them.
 */
export const publishedEventPayloads = (): [string, z.ZodType][] =>
  Object.entries({ ...SESSION_EVENT_TYPES, ...TRANSCRIPT_EVENT_TYPES, ...PERMISSION_SESSION_EVENT_TYPES, ...GROUP_EVENT_TYPES } as Record<string, EventTypeEntry>).flatMap(([type, entry]) =>
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
  { path: "transcript/run-origin.json", title: "RunOrigin", schema: RunOrigin },
  { path: "transcript/run-end-reason.json", title: "RunEndReason", schema: RunEndReason },
  { path: "transcript/interrupt-cause.json", title: "InterruptCause", schema: InterruptCause },
  { path: "transcript/attachment-kind.json", title: "AttachmentKind", schema: AttachmentKind },
  { path: "transcript/attachment-record.json", title: "AttachmentRecord", schema: AttachmentRecord },
  { path: "transcript/attachment-input.json", title: "AttachmentInput", schema: AttachmentInput },
  { path: "transcript/run-mode.json", title: "RunMode", schema: RunMode },
  { path: "transcript/model-usage.json", title: "ModelUsage", schema: ModelUsage },
  { path: "transcript/run-error.json", title: "RunError", schema: RunError },
  { path: "transcript/run-state.json", title: "RunState", schema: RunState },
  { path: "transcript/tool-status.json", title: "ToolStatus", schema: ToolStatus },
  { path: "transcript/run-summary.json", title: "RunSummary", schema: RunSummary },
  { path: "transcript/transcript-item.json", title: "TranscriptItem", schema: TranscriptItem },
  { path: "transcript/parked-prompt.json", title: "ParkedPrompt", schema: ParkedPrompt },
  { path: "transcript/session-snapshot.json", title: "SessionSnapshot", schema: SessionSnapshot },
  { path: "permissions/mode.json", title: "Mode", schema: Mode },
  { path: "permissions/mode-availability.json", title: "ModeAvailability", schema: ModeAvailability },
  { path: "permissions/run-actor-kind.json", title: "RunActorKind", schema: RunActorKind },
  { path: "permissions/clamp-reason.json", title: "ClampReason", schema: ClampReason },
  { path: "permissions/mode-resolution.json", title: "ModeResolution", schema: ModeResolution },
  { path: "permissions/containment-level.json", title: "ContainmentLevel", schema: ContainmentLevel },
  { path: "permissions/containment-availability.json", title: "ContainmentAvailability", schema: ContainmentAvailability },
  { path: "permissions/containment-resolution.json", title: "ContainmentResolution", schema: ContainmentResolution },
  { path: "permissions/run-policy.json", title: "RunPolicy", schema: RunPolicy },
  { path: "permissions/settings-area.json", title: "SettingsArea", schema: SettingsArea },
  { path: "permissions/unattended-mode.json", title: "UnattendedMode", schema: UnattendedMode },
  { path: "permissions/ttl-unit.json", title: "TtlUnit", schema: TtlUnit },
  { path: "permissions/parked-prompt-ttl.json", title: "ParkedPromptTtl", schema: ParkedPromptTtl },
  { path: "permissions/settings-values.json", title: "PermissionSettingsValues", schema: PermissionSettingsValues },
  { path: "permissions/settings-patch.json", title: "PermissionSettingsPatch", schema: PermissionSettingsPatch },
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
  { path: "settings/settings-values.json", title: "SettingsValues", schema: SettingsValues },
  { path: "settings/settings-patch.json", title: "SettingsPatch", schema: SettingsPatch },
  { path: "settings/settings-event-type.json", title: "SettingsEventType", schema: SettingsEventType },
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


/** The document for one exported schema: the schema as zod's decoder reads it, titled. */
const document = (entry: ExportedSchema): Record<string, unknown> => {
  const { $schema, ...rest } = z.toJSONSchema(entry.schema, { target: "draft-2020-12", io: "input" });
  return { $schema, title: entry.title, ...rest };
};

/**
 * The manifest a client starts from: the protocol version, every document by
 * path and title, and every method with its scope, kind, stream flag and
 * documents; a command's include its response, the receipt beside the result.
 */
const index = (entries: readonly ExportedSchema[]) => ({
  $comment: "Generated by `pnpm --filter @agent-harness/contracts export-schemas`. Do not edit.",
  protocolVersion: PROTOCOL_VERSION,
  schemas: entries.map(({ path, title }) => ({ path, title })),
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

/** Every file of the export, by path under `schema/`: one per schema, and `index.json`. */
export const jsonSchemaFiles = (): Map<string, string> => {
  const entries = exportedSchemas();
  const files = new Map<string, string>();
  for (const entry of entries) {
    if (files.has(entry.path)) throw new Error(`Two schemas export to ${entry.path}.`);
    files.set(entry.path, serialise(document(entry)));
  }
  files.set("index.json", serialise(index(entries)));
  return files;
};
