import { z } from "zod";
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
} from "./primitives.js";
import { EnvironmentNotice, EnvironmentNoticeType } from "./notices.js";
import { methods } from "./registry.js";
import { Ceiling, Scope, ScopeSet } from "./scopes.js";

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

/** Where the export writes one of a method's documents, under `schema/`. */
export const methodPath = (name: string, part: "params" | "result" | "error"): string =>
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
  { path: "environment-id.json", title: "EnvironmentId", schema: EnvironmentId },
  { path: "client-session-id.json", title: "ClientSessionId", schema: ClientSessionId },
  { path: "request-id.json", title: "RequestId", schema: RequestId },
  { path: "subscription-id.json", title: "SubscriptionId", schema: SubscriptionId },
  { path: "sequence.json", title: "Sequence", schema: Sequence },
  { path: "timestamp.json", title: "Timestamp", schema: Timestamp },
  { path: "json-object.json", title: "JsonObject", schema: JsonObject },
  { path: "environment-readiness.json", title: "EnvironmentReadiness", schema: EnvironmentReadiness },
  { path: "auth-policy.json", title: "AuthPolicy", schema: AuthPolicy },
  { path: "discovery-document.json", title: "DiscoveryDocument", schema: DiscoveryDocument },
  { path: "health-document.json", title: "HealthDocument", schema: HealthDocument },
  { path: "bootstrap/kind.json", title: "BootstrapKind", schema: BootstrapKind },
  { path: "bootstrap/grant.json", title: "BootstrapGrant", schema: BootstrapGrant },
  { path: "bootstrap/request.json", title: "BootstrapRequest", schema: BootstrapRequest },
  { path: "bootstrap/error.json", title: "BootstrapError", schema: BootstrapError },
  { path: "client-session-credential.json", title: "ClientSessionCredential", schema: ClientSessionCredential },
  { path: "actor.json", title: "Actor", schema: Actor },
  { path: "event-envelope.json", title: "EventEnvelope", schema: EventEnvelope },
  { path: "notices/environment-notice-type.json", title: "EnvironmentNoticeType", schema: EnvironmentNoticeType },
  { path: "notices/environment-notice.json", title: "EnvironmentNotice", schema: EnvironmentNotice },
  { path: "errors/error-code.json", title: "ErrorCode", schema: ErrorCode },
  { path: "errors/schema-issue.json", title: "SchemaIssue", schema: SchemaIssue },
  { path: "errors/wire-error.json", title: "WireError", schema: WireError },
  { path: "errors/shared-error.json", title: "SharedError", schema: SharedError },
  ...SHARED_ERRORS.map((member) => {
    const code = member.shape.code.value;
    return { path: `errors/${code}.json`, title: `${pascal(code)}Error`, schema: member };
  }),
  { path: "errors/rate_limited.json", title: "RateLimitedError", schema: RateLimitedError },
  { path: "frames/frame.json", title: "Frame", schema: Frame },
  ...FRAME_TYPES.map((kind) => ({ path: `frames/${kind}.json`, title: `${pascal(kind)}Frame`, schema: FRAME_SCHEMAS[kind] })),
  { path: "frames/end-reason.json", title: "EndReason", schema: EndReason },
  { path: "frames/bye-reason.json", title: "ByeReason", schema: ByeReason },
  ...methods.flatMap((method) => [
    { path: methodPath(method.name, "params"), title: `${method.name} params`, schema: method.params },
    { path: methodPath(method.name, "result"), title: `${method.name} result`, schema: method.result },
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
 * documents.
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
