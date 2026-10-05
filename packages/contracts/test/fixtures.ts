import { pushMethodFixtures } from "./push-fixtures.js";
import { attentionMethodFixtures, attentionSchemaFixtures } from "./attention-fixtures.js";
import { bankValidatorUpdateMethodFixtures, bankValidatorUpdateSchemaFixtures } from "./bank-validator-update-fixtures.js";
import { bankMigrationSchemaFixtures, bankMigrationMethodFixtures } from "./bank-migration-fixtures.js";
import { bankSplitSchemaFixtures, bankSplitMethodFixtures } from "./bank-split-fixtures.js";
import { memoryDraftSchemaFixtures, memoryDraftMethodFixtures } from "./memory-draft-fixtures.js";
/**
 * Instances the contract tests share: a valid and a malformed frame of every
 * kind, and a valid and an invalid instance of every exported schema. A frame
 * kind without fixtures does not compile, and a registered method without
 * them makes this module throw; any other exported schema without fixtures
 * fails the schema-export test. The export and the codec are never tested on
 * less than the whole package.
 */
import { BYPASS_SENTENCE, FRAME_TYPES, SHARED_ERROR_CODES, methodPath, methods, type FrameType } from "../src/index.js";
import { accountMethodFixtures, accountSchemaFixtures } from "./account-fixtures.js";
import { bankSchemaFixtures } from "./bank-fixtures.js";
import { bankRegistryMethodFixtures, bankRegistrySchemaFixtures } from "./bank-registry-fixtures.js";
import { browserMethodFixtures, browserSchemaFixtures } from "./browser-fixtures.js";
import { clientCallMethodFixtures, clientCallSchemaFixtures } from "./client-call-fixtures.js";
import { catalogueSchemaFixtures } from "./catalogue-fixtures.js";
import { completionsSchemaFixtures } from "./completions-fixtures.js";
import { forgeMethodFixtures, forgeSchemaFixtures } from "./forge-fixtures.js";
import { instructionMethodFixtures, instructionSchemaFixtures } from "./instruction-fixtures.js";
import { keyManagerMethodFixtures, keyManagerSchemaFixtures } from "./key-manager-fixtures.js";
import { knownEnvironmentMethodFixtures, knownEnvironmentSchemaFixtures, knownEnvironmentsNotice } from "./known-environment-fixtures.js";
import { lookMethodFixtures, lookSchemaFixtures, validLook } from "./look-fixtures.js";
import { managedToolMethodFixtures, managedToolSchemaFixtures, toolRunNotices, toolsUpdatedNotice } from "./managed-tool-fixtures.js";
import { invalidBindings, networkSchemaFixtures, validBindings } from "./network-fixtures.js";
import { permissionMethodFixtures, permissionSchemaFixtures } from "./permission-fixtures.js";
import { providerMethodFixtures, providerSchemaFixtures } from "./provider-fixtures.js";
import { readinessMethodFixtures, readinessSchemaFixtures } from "./readiness-fixtures.js";
import { routineMethodFixtures, routineSchemaFixtures } from "./routine-fixtures.js";
import { runMethodFixtures, runSchemaFixtures } from "./run-fixtures.js";
import { sessionMethodFixtures, sessionSchemaFixtures } from "./session-fixtures.js";
import { settingsMethodFixtures, settingsSchemaFixtures } from "./settings-fixtures.js";
import { settingsRowSchemaFixtures } from "./settings-row-fixtures.js";
import { forgeRejected, pendingRead, setupMethodFixtures, setupSchemaFixtures } from "./setup-fixtures.js";
import { skillMethodFixtures, skillSchemaFixtures } from "./skill-fixtures.js";
import { terminalMethodFixtures, terminalSchemaFixtures } from "./terminal-fixtures.js";
import { fileUndoMethodFixtures, fileUndoSchemaFixtures } from "./file-undo-fixtures.js";
import { checkMethodFixtures, checkSchemaFixtures, checksChangedNotice, checksFailuresResetNotice } from "./check-fixtures.js";
import { themeSchemaFixtures } from "./theme-fixtures.js";
import { trustMethodFixtures, trustSchemaFixtures } from "./trust-fixtures.js";
import { carryOverMethodFixtures, carryOverSchemaFixtures } from "./carry-over-fixtures.js";
import { stateImportCarried, stateImportMethodFixtures, stateImportSchemaFixtures } from "./state-import-fixtures.js";
import { updateMethodFixtures, updateSchemaFixtures } from "./update-fixtures.js";
import { usageMethodFixtures, usageSchemaFixtures } from "./usage-fixtures.js";
import { workspaceKept, workspaceMethodFixtures, workspaceSchemaFixtures } from "./workspace-fixtures.js";

const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";
const otherUuid = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const thirdUuid = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const at = "2026-09-24T01:02:03.456Z";

export const validActor = { kind: "client_session", id: "cs-1" };

export const validEnvelope = {
  sequence: 42,
  eventId: uuid,
  streamKind: "access",
  streamId: "access",
  streamVersion: 7,
  type: "pairing.created",
  occurredAt: at,
  commandId: otherUuid,
  causationId: null,
  correlationId: thirdUuid,
  actor: validActor,
  payload: { expiresAt: at },
  metadata: {},
};

/** The notice every start appends to the environment stream, as a whole event: a notice parses from its envelope. */
export const validEnvironmentStartedEvent = {
  ...validEnvelope,
  streamKind: "environment",
  streamId: uuid,
  type: "environment.started",
  commandId: null,
  correlationId: null,
  actor: { kind: "system", id: "lifecycle" },
  payload: { harnessVersion: "0.1.0", protocolVersion: 1 },
};

/** The discovery document of an environment that has not passed its startup gate. */
export const validDiscovery = {
  environmentId: uuid,
  environmentName: "SAMPLE-SERVER",
  harnessVersion: "0.1.0",
  protocolVersion: 1,
  capabilities: [],
  authPolicy: "local-only",
  readiness: "starting",
};

/** An exchange refused for coming too often. */
const validRateLimited = { code: "rate_limited", message: "Too many exchanges; try again in 6 seconds.", data: { retryAfterMs: 6000 } };

/** A bootstrap grant file's contents. */
const validGrant = { secret: "q9vXk0yZ3n0", address: { host: "127.0.0.1", port: 7433 } };

/** A local client session as the bootstrap exchange answers it. */
const validCredential = {
  token: "token-fixture-one",
  clientSessionId: "cs-1",
  scopes: ["read", "sessions:write", "runs:drive", "terminal", "admin"],
  ceiling: "bypassPermissions",
  expiresAt: at,
};

/** A copy of `value` without its `key`. */
export const without = (value: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

const envelopeWithoutCommandId = without(validEnvelope, "commandId");

/** A pairing exchange's body. */
const validPairRequest = { code: "K7Q2M-XH4RT", kind: "program", label: "nightly bot", protocolVersion: 1 };

/** The pairing exchange's own refusals, one instance each. */
const pairErrors = {
  pairing_invalid: { code: "pairing_invalid", message: "No such pairing code.", data: {} },
  pairing_expired: { code: "pairing_expired", message: "The pairing code has expired.", data: {} },
  pairing_used: { code: "pairing_used", message: "The pairing code has been used.", data: {} },
  protocol_mismatch: { code: "protocol_mismatch", message: "The client speaks protocol 2.", data: { protocolVersion: 1 } },
};

/** One valid payload for every access event type. */
const accessPayloads = {
  "pairing.created": { pairingId: "p-1", scopes: ["read", "admin"], ceiling: "auto", expiresAt: at },
  "pairing.exchanged": { pairingId: "p-1", clientSessionId: "cs-1" },
  "pairing.expired": { pairingId: "p-1" },
  "client-session.created": {
    clientSessionId: "cs-1",
    kind: "web",
    label: "phone browser",
    scopes: ["read"],
    ceiling: "plan",
    local: false,
    how: "pairing",
    pairingId: "p-1",
    expiresAt: at,
  },
  "client-session.refreshed": { clientSessionId: "cs-1", expiresAt: at },
  "client-session.revoked": { clientSessionId: "cs-1", reason: "requested" },
  "socket.opened": { clientSessionId: "cs-1", socketId: "s-1", remoteAddress: "100.101.102.103" },
  "socket.closed": { clientSessionId: "cs-1", socketId: "s-1" },
  "access.changed": { clientSessionId: "cs-1", from: { scopes: ["read"], ceiling: "plan" }, to: { scopes: ["read", "admin"], ceiling: "acceptEdits" } },
  "scope.granted": { clientSessionId: "cs-1", granted: ["admin"], scopes: ["read", "admin"] },
  "ceiling.changed": { clientSessionId: "cs-1", from: "plan", to: "auto" },
  "bypass.acknowledged": { setting: "permissions.unattended.mode", sentence: BYPASS_SENTENCE },
  "settings.changed": { area: "permissions", keys: ["permissions.parkedPrompt.ttl"], values: { "permissions.parkedPrompt.ttl": "never" } },
  "denylist.changed": {
    section: "paths",
    added: [{ id: "e-1", pattern: "/etc/shadow", note: "", preset: false, enabled: true }],
    removed: [],
    edited: [
      {
        before: { id: "preset:~/.ssh", pattern: "~/.ssh", note: "SSH keys.", preset: true, enabled: true },
        after: { id: "preset:~/.ssh", pattern: "~/.ssh", note: "SSH keys.", preset: true, enabled: false },
      },
    ],
    entries: [
      { id: "preset:~/.ssh", pattern: "~/.ssh", note: "SSH keys.", preset: true, enabled: false },
      { id: "e-1", pattern: "/etc/shadow", note: "", preset: false, enabled: true },
    ],
  },
};

/** An invalid payload for every access event type. */
const invalidAccessPayloads: Record<keyof typeof accessPayloads, readonly unknown[]> = {
  "pairing.created": [{ ...accessPayloads["pairing.created"], scopes: [] }, { pairingId: "p-1" }],
  "pairing.exchanged": [{ pairingId: "p-1" }, { pairingId: "", clientSessionId: "cs-1" }],
  "pairing.expired": [{}, { pairingId: 1 }],
  "client-session.created": [
    { ...accessPayloads["client-session.created"], how: "magic" },
    without(accessPayloads["client-session.created"], "pairingId"),
  ],
  "client-session.refreshed": [{ clientSessionId: "cs-1" }, { clientSessionId: "cs-1", expiresAt: "later" }],
  "client-session.revoked": [{ clientSessionId: "cs-1", reason: "because" }, { reason: "idle" }],
  "socket.opened": [{ clientSessionId: "cs-1", socketId: "s-1" }, { clientSessionId: "cs-1", socketId: "", remoteAddress: null }],
  "socket.closed": [{ clientSessionId: "cs-1" }, { socketId: "s-1" }],
  "access.changed": [{ clientSessionId: "cs-1", from: { scopes: [], ceiling: "plan" }, to: { scopes: ["read"], ceiling: "plan" } }, { clientSessionId: "cs-1" }],
  "scope.granted": [{ clientSessionId: "cs-1", granted: [], scopes: ["read"] }, { clientSessionId: "cs-1", scopes: ["read"] }],
  "ceiling.changed": [{ clientSessionId: "cs-1", from: "", to: "auto" }, { clientSessionId: "cs-1", to: "auto" }, { clientSessionId: "cs-1", from: "default", to: "auto" }],
  "bypass.acknowledged": [{ setting: "permissions.unattended.mode" }, { setting: "", sentence: BYPASS_SENTENCE }],
  "settings.changed": [
    { area: "sessions", keys: ["permissions.parkedPrompt.ttl"], values: {} },
    { area: "permissions", keys: [], values: {} },
    { area: "permissions", keys: ["permissions.parkedPrompt.ttl"], values: { "permissions.parkedPrompt.ttl": "forever" } },
    { area: "permissions", keys: ["permissions.other"], values: {} },
    { area: "permissions", keys: ["permissions.defaultCeiling"], values: { "permissions.defaultCeiling": "plan", other: 1 } },
  ],
  "denylist.changed": [
    { ...accessPayloads["denylist.changed"], section: "files" },
    without(accessPayloads["denylist.changed"], "entries"),
    { ...accessPayloads["denylist.changed"], added: [{ id: "e-1", pattern: "/etc/shadow" }] },
    { ...accessPayloads["denylist.changed"], edited: [{ before: null, after: null }] },
  ],
};


/** Every error the shared union holds, one instance each. */
export const sharedErrors = {
  unauthorized: { code: "unauthorized", message: "The token is not valid here.", data: {} },
  forbidden: { code: "forbidden", message: "This method needs the admin scope.", data: { scope: "admin" } },
  unavailable: { code: "unavailable", message: "The environment is starting.", data: { readiness: "starting" } },
  invalid_params: {
    code: "invalid_params",
    message: "The params do not match the method's schema.",
    data: { issues: [{ code: "invalid_type", expected: "string", path: ["label"], message: "Expected a string" }] },
  },
  not_found: { code: "not_found", message: "No such client session.", data: {} },
  conflict: { code: "conflict", message: "Already draining.", data: {} },
  internal: { code: "internal", message: "Something broke.", data: {} },
} satisfies Record<(typeof SHARED_ERROR_CODES)[number], unknown>;

/** At least one valid frame of every kind; `response` has both its forms. */
export const validFrames: Record<FrameType, readonly object[]> = {
  auth: [{ type: "auth", token: "opaque.token", protocolVersion: 1, clientKind: "tui", harnessVersion: "0.1.0" }],
  hello: [
    {
      type: "hello",
      protocolVersion: 1,
      capabilities: ["terminal", "environment.subscribe"],
      environmentId: uuid,
      environmentName: "SAMPLE-SERVER",
      clientSessionId: "cs-1",
      scopes: ["read", "sessions:write", "runs:drive", "terminal", "admin"],
      ceiling: "bypassPermissions",
      serverTime: at,
    },
    {
      type: "hello",
      protocolVersion: 1,
      capabilities: [],
      environmentId: uuid,
      environmentName: "LAB",
      environmentIcon: "server",
      environmentColour: "teal",
      clientSessionId: "cs-1",
      scopes: ["read"],
      ceiling: "plan",
      serverTime: at,
    },
  ],
  request: [
    { type: "request", id: "1", method: "environment.status", params: {} },
    { type: "request", id: "2", method: "access.sessions.revoke", params: { commandId: uuid, clientSessionId: "cs-2" } },
  ],
  response: [
    { type: "response", id: "1", result: { readiness: "ready" } },
    { type: "response", id: "2", error: sharedErrors.not_found },
  ],
  subscribed: [{ type: "subscribed", id: "3", subscription: "sub-1" }],
  snapshot: [{ type: "snapshot", subscription: "sub-1", sequence: 1200, payload: { sessions: [] } }],
  event: [{ type: "event", subscription: "sub-1", sequence: 42, event: validEnvelope }],
  synchronized: [{ type: "synchronized", subscription: "sub-1", sequence: 0 }],
  end: [
    { type: "end", subscription: "sub-1", reason: "unsubscribed" },
    { type: "end", subscription: "sub-1", reason: "overflow" },
  ],
  unsubscribe: [{ type: "unsubscribe", subscription: "sub-1" }],
  ping: [{ type: "ping" }],
  pong: [{ type: "pong" }],
  bye: [
    { type: "bye", reason: "draining" },
    { type: "bye", reason: "protocol", protocolVersion: 1, message: "The client speaks 2; this environment speaks 1." },
  ],
};

const json = (value: unknown): string => JSON.stringify(value);

/** An event frame whose sequence is not its event's: a rule the codec keeps and JSON Schema cannot say. */
const eventSequenceMismatch = json({ type: "event", subscription: "sub-1", sequence: 41, event: validEnvelope });

/** Malformed frames only the codec refuses; the exported schemas accept them, so they are no schema fixture. */
const beyondJsonSchema: ReadonlySet<string> = new Set([eventSequenceMismatch]);

/**
 * Malformed frame text of every kind, as it would arrive on the socket. A kind
 * with no fields (`ping`, `pong`) can only be malformed as text: cut short, or
 * not a JSON object.
 */
/**
 * Frames carrying a field the reader does not know. The codec drops the field and the export
 * tolerates it, so adding an optional field never bumps the protocol version (frames.ts); these
 * do not round-trip byte for byte, so they sit apart from `validFrames`.
 */
export const toleratedFrames: Partial<Record<FrameType, readonly object[]>> = {
  ping: [{ type: "ping", sentAt: at }],
  hello: [{ ...validFrames.hello[0], region: "manila" }],
  request: [{ type: "request", id: "1", method: "environment.status", params: {}, priority: "high" }],
};

export const malformedFrames: Record<FrameType, readonly string[]> = {
  auth: [
    json({ type: "auth", protocolVersion: 1, clientKind: "tui", harnessVersion: "0.1.0" }),
    json({ type: "auth", token: "t", protocolVersion: "1", clientKind: "tui", harnessVersion: "0.1.0" }),
    json({ type: "auth", token: "t", protocolVersion: 1, clientKind: "phone", harnessVersion: "0.1.0" }),
    json({ type: "auth", token: "", protocolVersion: 1, clientKind: "tui", harnessVersion: "0.1.0" }),
  ],
  hello: [
    json({ ...validFrames.hello[0], environmentId: "not-a-uuid" }),
    json({ ...validFrames.hello[0], scopes: ["read", "write"] }),
    json({ ...validFrames.hello[0], scopes: ["read", "read"] }),
    json({ ...validFrames.hello[0], scopes: [] }),
    json({ ...validFrames.hello[0], capabilities: "terminal" }),
    json({ ...validFrames.hello[0], serverTime: "yesterday" }),
  ],
  request: [
    json({ type: "request", method: "environment.status", params: {} }),
    json({ type: "request", id: "1", method: "environment.status" }),
    json({ type: "request", id: "1", method: "environment.status", params: [] }),
    json({ type: "request", id: "1", method: "", params: {} }),
  ],
  response: [
    json({ type: "response", id: "1" }),
    json({ type: "response", id: "1", result: "ok" }),
    json({ type: "response", id: "1", error: { code: "not_found", message: "gone" } }),
    json({ type: "response", result: {} }),
    json({ type: "response", id: "1", result: {}, error: sharedErrors.not_found }),
  ],
  subscribed: [json({ type: "subscribed", id: "3" }), json({ type: "subscribed", id: "3", subscription: 7 })],
  snapshot: [
    json({ type: "snapshot", subscription: "sub-1", payload: {} }),
    json({ type: "snapshot", subscription: "sub-1", sequence: -1, payload: {} }),
    json({ type: "snapshot", subscription: "sub-1", sequence: 3, payload: "state" }),
  ],
  event: [
    json({ type: "event", subscription: "sub-1", sequence: 42 }),
    json({ type: "event", subscription: "sub-1", sequence: 42, event: envelopeWithoutCommandId }),
    json({ type: "event", subscription: "sub-1", sequence: 1.5, event: validEnvelope }),
    json({ type: "event", subscription: "sub-1", sequence: 0, event: { ...validEnvelope, sequence: 0 } }),
    eventSequenceMismatch,
  ],
  synchronized: [json({ type: "synchronized", subscription: "sub-1" }), json({ type: "synchronized", sequence: 3 })],
  end: [
    json({ type: "end", subscription: "sub-1" }),
    json({ type: "end", subscription: "sub-1", reason: "draining" }),
  ],
  unsubscribe: [json({ type: "unsubscribe" }), json({ type: "unsubscribe", subscription: "" })],
  ping: ['{"type":"ping"', json([{ type: "ping" }]), json("ping")],
  pong: ['{"type":"pong"', json([{ type: "pong" }]), json("pong")],
  bye: [json({ type: "bye" }), json({ type: "bye", reason: "closed" }), json({ type: "bye", reason: "protocol", protocolVersion: 0 })],
};

/** The malformed frames that are at least JSON, for the schema fixtures. */
const malformedJson = (kind: FrameType): unknown[] =>
  malformedFrames[kind].flatMap((text) => {
    if (beyondJsonSchema.has(text)) return [];
    try {
      return [JSON.parse(text) as unknown];
    } catch {
      return [];
    }
  });

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const frameFixtures = Object.fromEntries(
  FRAME_TYPES.map((kind): [string, Fixtures] => [
    `frames/${kind}.json`,
    { valid: [...validFrames[kind], ...(toleratedFrames[kind] ?? [])], invalid: malformedJson(kind) },
  ]),
);

const methodErrorFixtures: Fixtures = {
  valid: [
    ...Object.values(sharedErrors),
    // #180: the scope is held, but the call would grant a ceiling above the caller's own.
    { code: "forbidden", message: "A pairing at bypassPermissions is above this client session's own ceiling.", data: { scope: "admin", reason: "ceiling", ceiling: "acceptEdits" } },
    // #335: the scope is held, but only a local client session may ask this.
    { code: "forbidden", message: "Only a local client session may name an artefact path.", data: { scope: "admin", reason: "local" } },
  ],
  invalid: [
    { code: "no_such_error", message: "m", data: {} },
    { code: "forbidden", message: "m", data: { scope: "everything" } },
    { code: "forbidden", message: "m", data: { scope: "admin", reason: "mode", ceiling: "acceptEdits" } },
    { code: "forbidden", message: "m", data: { scope: "admin", reason: "ceiling", ceiling: "dontAsk" } },
    { code: "internal", message: "m" },
  ],
};

/** Activity as `environment.status` reports it: idle, busy for each reason, draining. */
const validActivities = [
  { state: "idle" },
  { state: "busy", reason: "run-running" },
  { state: "busy", reason: "run-starting" },
  { state: "busy", reason: "terminal-running" },
  { state: "busy", reason: "parked-prompt", busyUntil: at },
  { state: "busy", reason: "recent-activity", busyUntil: at },
  { state: "draining", drainingSince: at },
];
const invalidActivities = [
  {},
  { state: "asleep" },
  { state: "busy" },
  { state: "busy", reason: "compiling" },
  { state: "busy", reason: "parked-prompt", busyUntil: "in ten minutes" },
  { state: "draining" },
];

const validStatuses = [
  { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false },
  { readiness: "ready", activity: { state: "busy", reason: "parked-prompt", busyUntil: at }, updatesManagedOutside: true },
  { readiness: "draining", activity: { state: "draining", drainingSince: at }, updatesManagedOutside: false },
  ...validBindings.map((binding) => ({ readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false, binding })),
];
const invalidStatuses = [
  {},
  { readiness: "ready" },
  { readiness: "idle", activity: { state: "idle" }, updatesManagedOutside: false },
  { readiness: "ready", activity: { state: "idle" } },
  { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: "no" },
  { readiness: "ready", activity: { state: "busy" }, updatesManagedOutside: false },
  ...invalidBindings.map((binding) => ({ readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false, binding })),
];

/** Params and result instances for every registered method. */
const methodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  ...attentionMethodFixtures, ...pushMethodFixtures,
  "web.origins.get": { params: { valid: [{}], invalid: [[]] }, result: { valid: [{ clientOrigins: [], connectOrigins: [] }], invalid: [{}] } },
  "web.origins.set": {
    params: { valid: [{ commandId: "0f8fad5b-d9cb-469f-a165-70867728950e", clientOrigins: ["https://client.example.test:8443"], connectOrigins: [] }], invalid: [{ commandId: "0f8fad5b-d9cb-469f-a165-70867728950e", clientOrigins: ["*"], connectOrigins: [] }, {}] },
    result: { valid: [{ clientOrigins: [], connectOrigins: [] }], invalid: [{}] },
  },
  "environment.status": {
    params: { valid: [{}], invalid: [[], "status"] },
    result: { valid: validStatuses, invalid: invalidStatuses },
  },
  "environment.subscribe": {
    params: { valid: [{ afterSequence: 0 }, { afterSequence: 1200 }], invalid: [{}, { afterSequence: -1 }] },
    result: {
      valid: [
        ...validStatuses.map((status) => ({ status })),
        { status: validStatuses[0], environment: validLook },
        { status: validStatuses[0], setup: [] },
        { status: validStatuses[0], setup: [forgeRejected] },
        { status: validStatuses[0], setup: [pendingRead] },
        { status: validStatuses[0], environment: validLook, setup: [forgeRejected] },
      ],
      invalid: [
        {},
        ...invalidStatuses.map((status) => ({ status })),
        { status: validStatuses[0], environment: { ...validLook, colour: "#008080" } },
        { status: validStatuses[0], environment: { name: "LAB" } },
        { status: validStatuses[0], setup: [{ ...forgeRejected, state: "checking" }] },
        { status: validStatuses[0], setup: forgeRejected },
      ],
    },
  },
  "environment.drain": {
    params: { valid: [{ commandId: uuid }], invalid: [{}, { commandId: "1" }] },
    result: {
      valid: [{ drainingSince: at, trigger: "command" }, { drainingSince: at, trigger: "signal" }],
      invalid: [{}, { drainingSince: at }, { drainingSince: 5, trigger: "command" }, { drainingSince: at, trigger: "cron" }],
    },
  },
  "environment.rebuildProjections": {
    params: { valid: [{ commandId: uuid }], invalid: [{}, { commandId: "not-a-uuid" }] },
    result: {
      valid: [{ projectors: ["sessions", "access"], sequence: 1200 }],
      invalid: [{ projectors: "sessions", sequence: 1200 }, { projectors: [] }],
    },
  },
  "access.pairings.create": {
    params: {
      valid: [{ commandId: uuid }, { commandId: uuid, scopes: ["read"], ceiling: "plan" }],
      invalid: [
        { scopes: ["read"] },
        { commandId: uuid, scopes: [] },
        { commandId: uuid, scopes: ["read", "read"] },
        { commandId: uuid, ceiling: "dontAsk" },
        { commandId: uuid, ceiling: "default" },
      ],
    },
    result: {
      valid: [
        {
          pairingId: "p-1",
          code: "K7Q2MXH4RT",
          link: "http://desk.tail1234.ts.net:7433/pair#K7Q2MXH4RT",
          expiresAt: at,
          scopes: ["read", "admin"],
          ceiling: "auto",
        },
      ],
      invalid: [
        { pairingId: "p-1", code: "K7Q2MXH4RT", link: "http://127.0.0.1:7433/pair#K7Q2MXH4RT", expiresAt: at, scopes: ["read"] },
        { pairingId: "p-1", code: "K7Q2MXH4RT", link: "not a link", expiresAt: at, scopes: ["read"], ceiling: "auto" },
        { code: "K7Q2MXH4RT", link: "http://127.0.0.1:7433/pair#K7Q2MXH4RT", expiresAt: at, scopes: ["read"], ceiling: "auto" },
      ],
    },
  },
  "access.sessions.list": {
    params: { valid: [{}, { live: true }], invalid: [null, { live: "yes" }] },
    result: {
      valid: [
        { sessions: [] },
        {
          sessions: [
            {
              id: "cs-1",
              kind: "desktop",
              label: "Mac",
              createdAt: at,
              lastSeenAt: null,
              expiresAt: at,
              revokedAt: null,
              scopes: ["read", "admin"],
              ceiling: "auto",
              local: false,
            },
            {
              id: "cs-2",
              kind: "program",
              label: "nightly bot",
              createdAt: at,
              lastSeenAt: at,
              expiresAt: at,
              revokedAt: at,
              scopes: ["read"],
              ceiling: "plan",
              local: false,
            },
          ],
        },
      ],
      invalid: [
        {},
        { sessions: [{ id: "cs-1", kind: "phone" }] },
        {
          sessions: [
            { id: "cs-1", kind: "tui", label: "t", createdAt: at, lastSeenAt: null, expiresAt: at, revokedAt: null, scopes: ["read"], ceiling: "auto" },
          ],
        },
      ],
    },
  },
  "access.sessions.revoke": {
    params: { valid: [{ commandId: uuid, clientSessionId: "cs-2" }], invalid: [{ commandId: uuid }, { clientSessionId: "cs-2" }] },
    result: { valid: [{ revokedAt: at }], invalid: [{ revokedAt: "later" }] },
  },
  "access.sessions.refresh": {
    params: { valid: [{ commandId: uuid }], invalid: [{}, { commandId: "again" }] },
    result: { valid: [validCredential], invalid: [without(validCredential, "token"), { ...validCredential, expiresAt: "soon" }] },
  },
  "access.log.list": {
    params: {
      valid: [{}, { afterSequence: 10, limit: 100 }],
      invalid: [{ limit: 0 }, { limit: 1001 }, { afterSequence: -1 }],
    },
    result: { valid: [{ events: [] }, { events: [validEnvelope] }], invalid: [{ events: [{}] }, {}] },
  },
  ...lookMethodFixtures,
  ...knownEnvironmentMethodFixtures,
  ...sessionMethodFixtures,
  ...runMethodFixtures,
  ...providerMethodFixtures,
  ...settingsMethodFixtures,
  ...setupMethodFixtures,
  ...permissionMethodFixtures,
  ...accountMethodFixtures,
  ...instructionMethodFixtures,
  ...forgeMethodFixtures,
  ...keyManagerMethodFixtures,
  ...managedToolMethodFixtures,
  ...usageMethodFixtures,
  ...terminalMethodFixtures,
  ...fileUndoMethodFixtures,
  ...checkMethodFixtures,
  ...workspaceMethodFixtures,
  ...updateMethodFixtures,
  ...routineMethodFixtures,
  ...skillMethodFixtures,
  ...readinessMethodFixtures,
  ...trustMethodFixtures,
  ...browserMethodFixtures,
  ...clientCallMethodFixtures,
  ...carryOverMethodFixtures,
  ...stateImportMethodFixtures,
  ...bankRegistryMethodFixtures,
  ...memoryDraftMethodFixtures,
  ...bankSplitMethodFixtures,
  ...bankMigrationMethodFixtures,
  ...bankValidatorUpdateMethodFixtures,
};

/** Receipts as a command's response carries them: accepted with a change, a no-op, and a rejection. */
export const validReceipts = {
  accepted: { status: "accepted", sequence: 42, changed: true },
  unchanged: { status: "accepted", sequence: 42, changed: false },
  rejected: {
    status: "rejected",
    sequence: 42,
    changed: false,
    reason: "not_found",
    error: { code: "not_found", message: "No client session is named cs-9.", data: {} },
  },
} as const;

const invalidReceipts = [
  { status: "accepted", sequence: 42 },
  { status: "accepted", sequence: -1, changed: true },
  { status: "rejected", sequence: 42, changed: false, reason: "not_found" },
  { status: "rejected", sequence: 42, changed: true, reason: "not_found", error: validReceipts.rejected.error },
  { status: "rejected", sequence: 42, changed: false, reason: "Not Found", error: validReceipts.rejected.error },
  { status: "pending", sequence: 42, changed: false },
];

/**
 * A command's response: every valid result beside an accepted receipt, and
 * the receipt alone for a retry and a rejection; a result without a receipt,
 * and an invalid result beside a valid receipt, are refused.
 */
const responseFixtures = (result: Fixtures): Fixtures => ({
  valid: [
    ...result.valid.map((valid) => ({ receipt: validReceipts.accepted, result: valid })),
    { receipt: validReceipts.unchanged },
    { receipt: validReceipts.rejected },
  ],
  invalid: [
    ...result.valid.map((valid) => ({ result: valid })),
    ...result.invalid.map((invalid) => ({ receipt: validReceipts.accepted, result: invalid })),
    ...invalidReceipts.map((receipt) => ({ receipt })),
  ],
});

const methodSchemaFixtures = Object.fromEntries(
  methods.flatMap((method): [string, Fixtures][] => {
    const own = methodFixtures[method.name];
    if (!own) throw new Error(`No fixtures for the registered method ${method.name}.`);
    return [
      [methodPath(method.name, "params"), own.params],
      [methodPath(method.name, "result"), own.result],
      ...(method.kind === "command" ? [[methodPath(method.name, "response"), responseFixtures(own.result)] as [string, Fixtures]] : []),
      [methodPath(method.name, "error"), methodErrorFixtures],
    ];
  }),
);

/** A valid and an invalid instance of every file the JSON Schema export writes. */
export const schemaFixtures: Record<string, Fixtures> = {
  "web/notices/origins.updated.json": { valid: [{}], invalid: [null, []] },
  ...attentionSchemaFixtures,
  "protocol-version.json": { valid: [1, 2], invalid: [0, 1.5, "1"] },
  "capability-flag.json": { valid: ["terminal"], invalid: ["", 1] },
  "capability-flags.json": { valid: [[], ["terminal", "environment.subscribe"]], invalid: [["a", "a"], [1], "a"] },
  "scope.json": { valid: ["read", "sessions:write", "runs:drive", "terminal", "admin"], invalid: ["write", "READ", ""] },
  "scope-set.json": { valid: [["read"], ["read", "admin"]], invalid: [[], ["read", "read"], ["write"]] },
  "ceiling.json": { valid: ["plan", "acceptEdits", "auto", "bypassPermissions"], invalid: ["", 3, "default", "dontAsk", "Plan"] },
  "client-kind.json": { valid: ["desktop", "tui", "web", "program"], invalid: ["phone", "Desktop"] },
  "command-id.json": { valid: [uuid], invalid: ["not-a-uuid", "", 7] },
  "command-receipt.json": { valid: Object.values(validReceipts), invalid: invalidReceipts },
  "environment-id.json": { valid: [uuid, otherUuid], invalid: ["not-a-uuid", "", 7] },
  "client-session-id.json": { valid: ["cs-1"], invalid: ["", 1] },
  "pairing-id.json": { valid: ["p-1"], invalid: ["", 1] },
  "json-object.json": { valid: [{}, { a: 1, nested: { b: [1, "two"] } }], invalid: [[], "x", 1, null] },
  "request-id.json": { valid: ["1", "a7"], invalid: ["", 1] },
  "subscription-id.json": { valid: ["sub-1"], invalid: ["", null] },
  "sequence.json": { valid: [0, 42], invalid: [-1, 1.5, "3"] },
  "timestamp.json": {
    valid: ["2026-09-24T01:02:03Z", at],
    invalid: ["2026-09-24", "2026-09-24T01:02:03+01:00", "yesterday"],
  },
  "bootstrap/kind.json": { valid: ["desktop", "tui"], invalid: ["web", "program", ""] },
  "bootstrap/grant.json": {
    valid: [validGrant],
    invalid: [
      without(validGrant, "secret"),
      { ...validGrant, secret: "" },
      { ...validGrant, address: { host: "127.0.0.1", port: 0 } },
      { ...validGrant, address: { host: "", port: 7433 } },
      { secret: "s", address: "127.0.0.1:7433" },
    ],
  },
  "bootstrap/request.json": {
    valid: [{ secret: "s3cret", kind: "desktop", label: "MacBook desktop" }, { secret: "s3cret", kind: "tui", label: "t" }],
    invalid: [
      { secret: "s3cret", kind: "web", label: "browser" },
      { secret: "", kind: "tui", label: "t" },
      { secret: "s3cret", kind: "tui", label: "" },
      { secret: "s3cret", kind: "tui", label: "x".repeat(201) },
      { kind: "tui", label: "t" },
    ],
  },
  "bootstrap/error.json": {
    valid: [
      sharedErrors.unauthorized,
      sharedErrors.invalid_params,
      sharedErrors.unavailable,
      sharedErrors.internal,
      validRateLimited,
    ],
    invalid: [sharedErrors.forbidden, sharedErrors.not_found, { code: "unauthorized", message: "m" }],
  },
  "errors/rate_limited.json": {
    valid: [validRateLimited, { ...validRateLimited, data: { retryAfterMs: 0 } }],
    invalid: [
      { ...validRateLimited, data: {} },
      { ...validRateLimited, data: { retryAfterMs: -1 } },
      { ...validRateLimited, data: { retryAfterMs: 1.5 } },
      { ...validRateLimited, code: "throttled" },
    ],
  },
  "client-session-credential.json": {
    valid: [validCredential],
    invalid: [
      without(validCredential, "token"),
      { ...validCredential, token: "" },
      { ...validCredential, scopes: [] },
      { ...validCredential, ceiling: "" },
      { ...validCredential, expiresAt: "in a month" },
    ],
  },
  "pair/request.json": {
    valid: [validPairRequest, { ...validPairRequest, code: "k7q2mxh4rt", kind: "web", protocolVersion: 2 }],
    invalid: [
      without(validPairRequest, "protocolVersion"),
      { ...validPairRequest, code: "" },
      { ...validPairRequest, code: "x".repeat(65) },
      { ...validPairRequest, kind: "phone" },
      { ...validPairRequest, label: "" },
      { ...validPairRequest, protocolVersion: 0 },
    ],
  },
  "pair/error.json": {
    valid: [...Object.values(pairErrors), sharedErrors.invalid_params, sharedErrors.unavailable, sharedErrors.internal, validRateLimited],
    invalid: [sharedErrors.unauthorized, sharedErrors.not_found, { code: "pairing_used", message: "m" }],
  },
  "pair/preset-id.json": { valid: ["own-client", "program", "custom"], invalid: ["own", "Custom", ""] },
  "pair/preset-choice.json": { valid: ["nothing", "ceiling", "scopes-and-ceiling"], invalid: ["scopes", ""] },
  "pair/preset.json": {
    valid: [
      { id: "own-client", name: "My own client", scopes: ["read", "sessions:write", "runs:drive", "terminal", "admin"], ceiling: "bypassPermissions", chooses: "nothing" },
      { id: "custom", name: "Custom", scopes: ["read"], ceiling: "plan", chooses: "scopes-and-ceiling" },
    ],
    invalid: [
      { id: "program", name: "", scopes: ["read"], ceiling: "acceptEdits", chooses: "ceiling" },
      { id: "program", name: "A program", scopes: [], ceiling: "acceptEdits", chooses: "ceiling" },
      { id: "program", name: "A program", scopes: ["read"], ceiling: "dontAsk", chooses: "ceiling" },
      { id: "program", name: "A program", scopes: ["read"], ceiling: "acceptEdits" },
    ],
  },
  ...Object.fromEntries(
    Object.entries(pairErrors).map(([code, error]): [string, Fixtures] => [
      `errors/${code}.json`,
      { valid: [error], invalid: [{ ...error, data: "x" }, { code, message: "m" }, { ...error, code: "other" }] },
    ]),
  ),
  "access/event-type.json": {
    valid: Object.keys(accessPayloads),
    invalid: ["connection.opened", "pairing.created ", ""],
  },
  "access/client-session-origin.json": { valid: ["bootstrap", "pairing"], invalid: ["login", ""] },
  "access/revocation-reason.json": { valid: ["requested", "replaced", "idle"], invalid: ["expired", ""] },
  ...Object.fromEntries(
    Object.entries(accessPayloads).map(([type, payload]): [string, Fixtures] => [
      `access/events/${type}.json`,
      { valid: [payload], invalid: invalidAccessPayloads[type as keyof typeof accessPayloads] },
    ]),
  ),
  "actor.json": {
    valid: [validActor, { kind: "system", id: "maintenance" }, { kind: "routine", id: "r-1" }, { kind: "adapter", id: "claude" }],
    invalid: [{ kind: "user", id: "david" }, { kind: "routine" }, { kind: "system", id: "" }],
  },
  "environment-readiness.json": { valid: ["starting", "ready", "draining"], invalid: ["idle", "Ready", ""] },
  "auth-policy.json": { valid: ["local-only", "tailnet"], invalid: ["unsafe-no-auth", "lan", ""] },
  "discovery-document.json": {
    valid: [
      validDiscovery,
      { ...validDiscovery, capabilities: ["terminal"], authPolicy: "tailnet", readiness: "ready" },
      { ...validDiscovery, environmentIcon: "nas", environmentColour: "amber" },
    ],
    invalid: [
      without(validDiscovery, "environmentId"),
      { ...validDiscovery, environmentId: "not-a-uuid" },
      { ...validDiscovery, readiness: "idle" },
      { ...validDiscovery, authPolicy: "unsafe-no-auth" },
      { ...validDiscovery, harnessVersion: "" },
      { ...validDiscovery, protocolVersion: 0 },
    ],
  },
  "health-document.json": {
    valid: [{ status: "starting", version: "0.1.0" }, { status: "ready", version: "0.0.0" }],
    invalid: [{ status: "ok", version: "0.1.0" }, { status: "ready" }, { version: "0.1.0" }],
  },
  "lifecycle/busy-reason.json": {
    valid: ["run-starting", "run-running", "terminal-running", "parked-prompt", "recent-activity"],
    invalid: ["idle", "parked", "terminal", ""],
  },
  "lifecycle/drain-trigger.json": { valid: ["command", "launcher", "signal", "update"], invalid: ["SIGTERM", "cron", ""] },
  "lifecycle/drain-started.json": {
    valid: [{ drainingSince: at, trigger: "command" }, { drainingSince: at, trigger: "signal" }],
    invalid: [{}, { drainingSince: at }, { trigger: "launcher" }, { drainingSince: "soon", trigger: "launcher" }],
  },
  "lifecycle/environment-activity.json": { valid: validActivities, invalid: invalidActivities },
  "lifecycle/environment-status.json": { valid: validStatuses, invalid: invalidStatuses },
  "event-envelope.json": {
    valid: [validEnvelope, { ...validEnvelope, commandId: null, causationId: uuid, correlationId: null }],
    invalid: [envelopeWithoutCommandId, { ...validEnvelope, sequence: 0 }, { ...validEnvelope, payload: [] }],
  },
  "notices/environment-notice-type.json": {
    valid: [
      "environment.started",
      "environment.updated",
      "environment.draining",
      "environment.update-pending",
      "environment.update-started",
      "environment.update-failed",
      "environment.update-cancelled",
      "environment.renamed",
      "environment.icon-set",
      "environment.colour-set",
      "environment.known-environments-updated",
      "account.updated",
      "signin.updated",
      "signin.executable-chosen",
      "prompt.parked",
      "prompt.resolved",
      "usage.updated",
      "denylist.updated",
      "review.updated",
      "settings.changed",
      "web.origins.updated",
      "setup.result-changed",
      "skills.updated",
      "trust.updated",
      "instructions.updated",
      "extension.seen",
      "carry-over.imported",
      "carry-over.memory-assigned",
      "state-import.finished",
      "checks.changed",
      "workspace.kept",
      "chrome.updated",
    ],
    invalid: ["environment.stopped", "session.created", "signin.started", "prompt.opened", "settings.updated", "setup.checked", "skills.source-added", "trust.granted", ""],
  },
  "notices/environment-notice.json": {
    valid: [
      { type: "environment.started", payload: { harnessVersion: "0.1.0", protocolVersion: 1 } },
      { type: "environment.updated", payload: { fromVersion: "0.1.0", toVersion: "0.2.0" } },
      { type: "environment.updated", payload: { fromVersion: "0.1.0", toVersion: "0.2.0", updateId: uuid } },
      { type: "environment.draining", payload: { drainingSince: at, trigger: "launcher" } },
      { type: "environment.draining", payload: { drainingSince: at, trigger: "update" } },
      { type: "environment.update-pending", payload: { updateId: uuid, toVersion: "0.2.0", source: "channel", since: at, deferUntil: at } },
      { type: "environment.update-started", payload: { updateId: uuid, fromVersion: "0.1.0", toVersion: "0.2.0", cause: "cap" } },
      { type: "environment.update-failed", payload: { updateId: uuid, fromVersion: "0.1.0", toVersion: "0.2.0", stage: "trial", reason: "deadline", rolledBack: true } },
      { type: "environment.update-cancelled", payload: { updateId: uuid, toVersion: "0.2.0", cause: "requested" } },
      { type: "environment.renamed", payload: { name: "LAB" } },
      { type: "environment.icon-set", payload: { icon: "nas" } },
      { type: "environment.colour-set", payload: { colour: "amber" } },
      knownEnvironmentsNotice.valid,
      { type: "account.updated", payload: { accountId: "claude-max", change: "status-changed", warning: null } },
      {
        type: "signin.updated",
        payload: {
          accountId: "claude-max",
          state: "awaiting-code",
          url: "https://claude.com/cai/oauth/authorize?code=true",
          startedAt: at,
          expiresAt: at,
          fallback: { posix: "CLAUDE_CONFIG_DIR='/x' claude auth login", powershell: "$env:CLAUDE_CONFIG_DIR = '/x'; & 'claude' auth login" },
          error: null,
        },
      },
      { type: "signin.executable-chosen", payload: { provider: "claude", source: "bundled", executable: "/opt/claude", bundled: "/opt/claude", detail: null } },
      {
        type: "prompt.parked",
        payload: { sessionId: otherUuid, runId: thirdUuid, promptId: "toolu_1", kind: "question", title: "Fix the receipts", summary: "Which library?" },
      },
      { type: "prompt.resolved", payload: { sessionId: otherUuid, runId: thirdUuid, promptId: "toolu_1", decision: "allow", decidedBy: "cs-1" } },
      { type: "usage.updated", payload: { accountId: "claude-max", identity: { provider: "claude", email: "david@example.com", organisation: null } } },
      { type: "denylist.updated", payload: { sections: ["paths", "hosts"] } },
      { type: "review.updated", payload: {} },
      { type: "settings.changed", payload: { keys: ["appearance.theme", "permissions.containment.default"] } },
      { type: "web.origins.updated", payload: {} },
      { type: "setup.result-changed", payload: forgeRejected },
      { type: "setup.result-changed", payload: pendingRead },
      { type: "skills.updated", payload: {} },
      { type: "trust.updated", payload: {} },
      { type: "instructions.updated", payload: {} },
      {
        type: "carry-over.imported",
        payload: { accountId: "claude-max", sessions: { listed: 3, imported: 2, archived: 1, missingDirectory: 1, held: 1 }, failed: [] },
      },
      {
        type: "carry-over.memory-assigned",
        payload: {
          accountId: "claude-max",
          repositoryIdentity: "https://git.systemtech.dev/david/agent-harness",
          copy: { folder: "-tmp-pad", path: "/home/david/.claude/projects/-tmp-pad/memory", key: "https://git.systemtech.dev/david/agent-harness", outcome: "copied", under: null, digest: `sha256:${"0".repeat(64)}` },
        },
      },
      {
        type: "state-import.finished",
        payload: { carried: stateImportCarried, reEnter: [], later: [], notCarried: [{ label: "Browser pairings", count: 1, step: "browser" }], failed: [] },
      },
      toolsUpdatedNotice.valid,
      ...toolRunNotices.valid,
      { type: "extension.seen", payload: { protocolVersion: 2, extensionVersion: "0.4.2" } },
      checksChangedNotice.valid,
      checksFailuresResetNotice.valid,
      { type: "workspace.kept", payload: workspaceKept },
      { type: "workspace.kept", payload: { ...workspaceKept, branch: null, reason: "git_failed" } },
      { type: "chrome.updated", payload: { chromeId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", name: "Work", change: "connected" } },
      { type: "environment.update-cancelled", payload: { updateId: uuid, toVersion: "0.2.0", cause: "superseded" } },
      validEnvironmentStartedEvent,
    ],
    invalid: [
      { type: "environment.started", payload: { harnessVersion: "", protocolVersion: 1 } },
      { type: "environment.started", payload: { harnessVersion: "0.1.0" } },
      { type: "environment.updated", payload: { toVersion: "0.2.0" } },
      { type: "environment.updated", payload: { fromVersion: "0.1.0", toVersion: "0.2.0", updateId: "u-1" } },
      { type: "environment.update-pending", payload: { updateId: uuid, toVersion: "0.2.0", source: "channel", since: at } },
      { type: "environment.update-started", payload: { updateId: uuid, fromVersion: "0.1.0", toVersion: "0.2.0", cause: "now" } },
      { type: "environment.update-failed", payload: { updateId: uuid, fromVersion: "0.1.0", toVersion: "0.2.0", stage: "trial", reason: "deadline" } },
      { type: "environment.update-cancelled", payload: { updateId: uuid, toVersion: "0.2.0", cause: "unknown" } },
      { type: "environment.renamed", payload: { name: "" } },
      { type: "environment.icon-set", payload: { icon: "phone" } },
      { type: "environment.colour-set", payload: { colour: "#ffbf00" } },
      knownEnvironmentsNotice.invalid,
      { type: "environment.draining", payload: { drainingSince: "soon", trigger: "signal" } },
      { type: "environment.draining", payload: { drainingSince: at } },
      { type: "environment.stopped", payload: {} },
      { type: "account.updated", payload: { accountId: "claude-max", change: "status-changed" } },
      { type: "signin.updated", payload: { accountId: "claude-max", state: "waiting" } },
      { type: "signin.executable-chosen", payload: { provider: "claude", source: "bundled" } },
      { type: "prompt.parked", payload: { sessionId: otherUuid, runId: thirdUuid, promptId: "toolu_1", kind: "tool", title: "t", summary: "s" } },
      { type: "prompt.resolved", payload: { sessionId: otherUuid, runId: thirdUuid, promptId: "toolu_1", decision: "allow" } },
      { type: "usage.updated", payload: { accountId: "claude-max" } },
      { type: "denylist.updated", payload: { sections: [] } },
      { type: "review.updated", payload: null },
      { type: "settings.changed", payload: { keys: [] } },
      { type: "settings.changed", payload: { values: { "appearance.theme": null } } },
      { type: "setup.result-changed", payload: { ...forgeRejected, checkedAt: undefined } },
      { type: "setup.result-changed", payload: { step: "forges" } },
      { type: "carry-over.imported", payload: { accountId: "claude-max", sessions: { listed: 1, imported: 1, archived: 0, missingDirectory: 0, held: 0 } } },
      { type: "carry-over.memory-assigned", payload: { accountId: "claude-max", repositoryIdentity: "https://git.systemtech.dev/david/agent-harness" } },
      { type: "state-import.finished", payload: { carried: stateImportCarried, reEnter: [], later: [], notCarried: [] } },
      toolsUpdatedNotice.invalid,
      ...toolRunNotices.invalid,
      { type: "extension.seen", payload: { protocolVersion: 2, extensionVersion: "" } },
      checksChangedNotice.invalid,
      checksFailuresResetNotice.invalid,
      { type: "workspace.kept", payload: { ...workspaceKept, reason: "dirty" } },
      { type: "chrome.updated", payload: { chromeId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", name: "Work", change: "proved" } },
      validEnvelope,
    ],
  },
  "errors/error-code.json": { valid: ["not_found", "ceiling_exceeded"], invalid: ["NotFound", "not-found", ""] },
  "errors/schema-issue.json": {
    valid: [{ code: "custom", path: [], message: "m" }, { code: "invalid_type", path: ["a", 0], message: "m", expected: "string" }],
    invalid: [{ code: "custom", message: "m" }, { code: "custom", path: [true], message: "m" }],
  },
  "errors/wire-error.json": {
    valid: [...Object.values(sharedErrors), { code: "ceiling_exceeded", message: "m", data: { ceiling: "auto" } }],
    invalid: [{ code: "Bad Code", message: "m", data: {} }, { code: "internal", message: "m" }, { code: "internal", data: {} }],
  },
  "errors/shared-error.json": methodErrorFixtures,
  ...Object.fromEntries(
    Object.entries(sharedErrors).map(([code, error]): [string, Fixtures] => [
      `errors/${code}.json`,
      { valid: [error], invalid: [{ ...error, data: "x" }, { code, message: "m" }, { ...error, code: "other" }] },
    ]),
  ),
  ...frameFixtures,
  "frames/end-reason.json": { valid: ["unsubscribed", "overflow", "revoked", "closed", "deleted"], invalid: ["draining", "purged", ""] },
  "frames/bye-reason.json": {
    valid: ["unauthorized", "expired", "revoked", "protocol", "draining", "updating"],
    invalid: ["closed", "overflow"],
  },
  "frames/frame.json": {
    valid: FRAME_TYPES.flatMap((kind) => validFrames[kind]),
    invalid: [...FRAME_TYPES.flatMap(malformedJson), { type: "nonsense" }, {}],
  },
  "actions/action-context.json": {
    valid: ["anywhere", "sidebar", "terminal", "asks", "confirm"],
    invalid: ["rail", "Anywhere", "", 1],
  },
  "actions/action-condition.json": {
    valid: ["composer.empty", "composer.atStart", "picker.queryEmpty", "transcript.finding"],
    invalid: ["composer", "empty", "composer.full", "", 1],
  },
  "actions/action.json": {
    valid: [
      {
        id: "composer.withdrawLast",
        context: "composer",
        keys: ["↑"],
        description: "Take the newest queued message back",
        status: "wired",
        when: "composer.empty",
        gui: { status: "wired", keys: ["↑"], when: "composer.empty" },
      },
      { id: "rail.pin", context: "sidebar", keys: ["p"], description: "Pin it to the top of its folder", status: "wired", gui: { status: "absent", reason: "The context menu." } },
      {
        id: "permission.rule.edit",
        context: "permission",
        keys: ["e"],
        description: "Edit the rule",
        status: "absent",
        reason: "Rules are per session.",
        gui: { status: "absent", reason: "Rules are per session." },
      },
      {
        id: "command.profile",
        context: "composer",
        keys: [],
        description: "Switch the account",
        usage: "/profile",
        aliasOf: "command.account",
        status: "wired",
        gui: { status: "wired", keys: [] },
      },
      { id: "app.interrupt", context: "anywhere", keys: ["Esc"], description: "Interrupt", status: "wired", gui: { status: "wired", keys: ["Esc"], off: true } },
      { id: "app.palette", context: "anywhere", keys: [], description: "Open the command palette", status: "absent", reason: "Only the GUI.", gui: { status: "wired", keys: ["Mod+K"] } },
      { id: "composer.readNow", context: "composer", keys: ["Ctrl+Enter"], description: "Read it now", status: "wired", gui: { status: "wired", keys: [] } },
    ],
    invalid: [
      { id: "rail.pin", context: "sidebar", keys: ["p"], description: "Pin it", status: "absent", gui: { status: "absent", reason: "The context menu." } },
      { id: "sidebar.pin", context: "sidebar", keys: ["p"], description: "Pin it", status: "wired", gui: { status: "absent", reason: "The context menu." } },
      { id: "rail", context: "sidebar", keys: ["p"], description: "Pin it", status: "wired", gui: { status: "absent", reason: "The context menu." } },
      { id: "rail.pin", context: "rail", keys: ["p"], description: "Pin it", status: "wired", gui: { status: "absent", reason: "The context menu." } },
      { id: "rail.pin", context: "sidebar", keys: [""], description: "Pin it", status: "wired", gui: { status: "absent", reason: "The context menu." } },
      { id: "rail.pin", context: "sidebar", keys: ["p"], description: "", status: "wired", gui: { status: "absent", reason: "The context menu." } },
      { id: "command.help", context: "composer", keys: [], description: "Help", usage: "help", status: "wired", gui: { status: "wired", keys: [] } },
      { id: "rail.pin", context: "sidebar", keys: ["p"], description: "Pin it", status: "planned", gui: { status: "absent", reason: "The context menu." } },
      { id: "composer.withdrawLast", context: "composer", keys: ["↑"], description: "Take it back", status: "wired", when: "composer.full", gui: { status: "wired", keys: ["↑"] } },
      // The GUI column: required, absent with a reason, wired keys that are names, a named condition, and off only as true.
      { id: "rail.pin", context: "sidebar", keys: ["p"], description: "Pin it", status: "wired" },
      { id: "rail.pin", context: "sidebar", keys: ["p"], description: "Pin it", status: "wired", gui: { status: "absent" } },
      { id: "rail.pin", context: "sidebar", keys: ["p"], description: "Pin it", status: "wired", gui: { status: "absent", reason: "" } },
      { id: "rail.pin", context: "sidebar", keys: ["p"], description: "Pin it", status: "wired", gui: { status: "wired", keys: [""] } },
      { id: "rail.pin", context: "sidebar", keys: ["p"], description: "Pin it", status: "wired", gui: { status: "wired" } },
      { id: "rail.pin", context: "sidebar", keys: ["p"], description: "Pin it", status: "wired", gui: { status: "wired", keys: ["p"], when: "rail.filtering" } },
      { id: "rail.pin", context: "sidebar", keys: ["p"], description: "Pin it", status: "wired", gui: { status: "wired", keys: ["p"], off: false } },
      { id: "rail.pin", context: "sidebar", keys: ["p"], description: "Pin it", status: "wired", gui: { status: "planned", keys: ["p"] } },
    ],
  },
  ...sessionSchemaFixtures,
  ...runSchemaFixtures,
  ...providerSchemaFixtures,
  ...settingsSchemaFixtures,
  ...settingsRowSchemaFixtures,
  ...setupSchemaFixtures,
  ...permissionSchemaFixtures,
  ...accountSchemaFixtures,
  ...instructionSchemaFixtures,
  ...forgeSchemaFixtures,
  ...keyManagerSchemaFixtures,
  ...managedToolSchemaFixtures,
  ...networkSchemaFixtures,
  ...skillSchemaFixtures,
  ...bankSchemaFixtures,
  ...bankRegistrySchemaFixtures,
  ...memoryDraftSchemaFixtures,
  ...bankSplitSchemaFixtures,
  ...bankMigrationSchemaFixtures,
  ...bankValidatorUpdateSchemaFixtures,
  ...readinessSchemaFixtures,
  ...catalogueSchemaFixtures,
  ...trustSchemaFixtures,
  ...carryOverSchemaFixtures,
  ...stateImportSchemaFixtures,
  ...themeSchemaFixtures,
  ...lookSchemaFixtures,
  ...knownEnvironmentSchemaFixtures,
  ...usageSchemaFixtures,
  ...terminalSchemaFixtures,
  ...fileUndoSchemaFixtures,
  ...checkSchemaFixtures,
  ...workspaceSchemaFixtures,
  ...completionsSchemaFixtures,
  ...updateSchemaFixtures,
  ...browserSchemaFixtures,
  ...clientCallSchemaFixtures,
  ...routineSchemaFixtures,
  ...methodSchemaFixtures,
};
