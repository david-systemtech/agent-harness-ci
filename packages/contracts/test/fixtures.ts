/**
 * Instances the contract tests share: a valid and a malformed frame of every
 * kind, and a valid and an invalid instance of every exported schema. A frame
 * kind without fixtures does not compile, and a registered method without
 * them makes this module throw; any other exported schema without fixtures
 * fails the schema-export test. The export and the codec are never tested on
 * less than the whole package.
 */
import { FRAME_TYPES, SHARED_ERROR_CODES, methodPath, methods, type FrameType } from "../src/index.js";

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

/** A copy of `value` without its `key`. */
const without = (value: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

const envelopeWithoutCommandId = without(validEnvelope, "commandId");

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
      environmentName: "SYSTEM-SERVER",
      clientSessionId: "cs-1",
      scopes: ["read", "sessions:write", "runs:drive", "terminal", "admin"],
      ceiling: "bypassPermissions",
      serverTime: at,
    },
  ],
  request: [
    { type: "request", id: "1", method: "environment.status", params: {} },
    { type: "request", id: "2", method: "access.sessions.revoke", params: { commandId: uuid, clientSessionId: "cs-2" } },
  ],
  response: [
    { type: "response", id: "1", result: { state: "idle" } },
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
    { valid: validFrames[kind], invalid: malformedJson(kind) },
  ]),
);

const methodErrorFixtures: Fixtures = {
  valid: Object.values(sharedErrors),
  invalid: [
    { code: "no_such_error", message: "m", data: {} },
    { code: "forbidden", message: "m", data: { scope: "everything" } },
    { code: "internal", message: "m" },
  ],
};

/** Params and result instances for every registered method. */
const methodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "environment.status": {
    params: { valid: [{}], invalid: [[], "status"] },
    result: {
      valid: [
        { state: "idle", reason: null, parkedPromptBusyUntil: null, updatesManagedOutside: false },
        { state: "busy", reason: "a run is parked on a prompt", parkedPromptBusyUntil: at, updatesManagedOutside: true },
      ],
      invalid: [
        { state: "asleep", reason: null, parkedPromptBusyUntil: null, updatesManagedOutside: false },
        { state: "idle", parkedPromptBusyUntil: null, updatesManagedOutside: false },
      ],
    },
  },
  "environment.subscribe": {
    params: { valid: [{ afterSequence: 0 }, { afterSequence: 1200 }], invalid: [{}, { afterSequence: -1 }] },
    result: {
      valid: [{ status: { state: "draining", reason: "update to 0.2.0", parkedPromptBusyUntil: null, updatesManagedOutside: false } }],
      invalid: [{}, { status: { state: "idle" } }],
    },
  },
  "environment.drain": {
    params: { valid: [{ commandId: uuid }], invalid: [{}, { commandId: "1" }] },
    result: { valid: [{ drainingSince: at }], invalid: [{}, { drainingSince: 5 }] },
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
      invalid: [{ scopes: ["read"] }, { commandId: uuid, scopes: [] }, { commandId: uuid, scopes: ["read", "read"] }],
    },
    result: {
      valid: [
        {
          code: "K7Q-2MX",
          link: "agent-harness://pair#K7Q-2MX",
          expiresAt: at,
          scopes: ["read", "admin"],
          ceiling: "auto",
        },
      ],
      invalid: [{ code: "K7Q-2MX", link: "agent-harness://pair#K7Q-2MX", expiresAt: at, scopes: ["read"] }],
    },
  },
  "access.sessions.list": {
    params: { valid: [{}], invalid: [null] },
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
              scopes: ["read", "admin"],
              ceiling: "auto",
            },
          ],
        },
      ],
      invalid: [{}, { sessions: [{ id: "cs-1", kind: "phone" }] }],
    },
  },
  "access.sessions.revoke": {
    params: { valid: [{ commandId: uuid, clientSessionId: "cs-2" }], invalid: [{ commandId: uuid }, { clientSessionId: "cs-2" }] },
    result: { valid: [{ revokedAt: at }], invalid: [{ revokedAt: "later" }] },
  },
  "access.log.list": {
    params: {
      valid: [{}, { afterSequence: 10, limit: 100 }],
      invalid: [{ limit: 0 }, { limit: 1001 }, { afterSequence: -1 }],
    },
    result: { valid: [{ events: [] }, { events: [validEnvelope] }], invalid: [{ events: [{}] }, {}] },
  },
};

const methodSchemaFixtures = Object.fromEntries(
  methods.flatMap((method): [string, Fixtures][] => {
    const own = methodFixtures[method.name];
    if (!own) throw new Error(`No fixtures for the registered method ${method.name}.`);
    return [
      [methodPath(method.name, "params"), own.params],
      [methodPath(method.name, "result"), own.result],
      [methodPath(method.name, "error"), methodErrorFixtures],
    ];
  }),
);

/** A valid and an invalid instance of every file the JSON Schema export writes. */
export const schemaFixtures: Record<string, Fixtures> = {
  "protocol-version.json": { valid: [1, 2], invalid: [0, 1.5, "1"] },
  "capability-flag.json": { valid: ["terminal"], invalid: ["", 1] },
  "capability-flags.json": { valid: [[], ["terminal", "environment.subscribe"]], invalid: [["a", "a"], [1], "a"] },
  "scope.json": { valid: ["read", "sessions:write", "runs:drive", "terminal", "admin"], invalid: ["write", "READ", ""] },
  "scope-set.json": { valid: [["read"], ["read", "admin"]], invalid: [[], ["read", "read"], ["write"]] },
  "ceiling.json": { valid: ["auto", "acceptEdits"], invalid: ["", 3] },
  "client-kind.json": { valid: ["desktop", "tui", "web", "program"], invalid: ["phone", "Desktop"] },
  "command-id.json": { valid: [uuid], invalid: ["not-a-uuid", "", 7] },
  "client-session-id.json": { valid: ["cs-1"], invalid: ["", 1] },
  "request-id.json": { valid: ["1", "a7"], invalid: ["", 1] },
  "subscription-id.json": { valid: ["sub-1"], invalid: ["", null] },
  "sequence.json": { valid: [0, 42], invalid: [-1, 1.5, "3"] },
  "timestamp.json": {
    valid: ["2026-09-24T01:02:03Z", at],
    invalid: ["2026-09-24", "2026-09-24T01:02:03+01:00", "yesterday"],
  },
  "actor.json": {
    valid: [validActor, { kind: "system", id: "maintenance" }, { kind: "routine", id: "r-1" }, { kind: "adapter", id: "claude" }],
    invalid: [{ kind: "user", id: "david" }, { kind: "routine" }, { kind: "system", id: "" }],
  },
  "event-envelope.json": {
    valid: [validEnvelope, { ...validEnvelope, commandId: null, causationId: uuid, correlationId: null }],
    invalid: [envelopeWithoutCommandId, { ...validEnvelope, sequence: 0 }, { ...validEnvelope, payload: [] }],
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
  "frames/end-reason.json": { valid: ["unsubscribed", "overflow", "revoked", "closed"], invalid: ["draining", ""] },
  "frames/bye-reason.json": {
    valid: ["unauthorized", "expired", "revoked", "protocol", "draining", "updating"],
    invalid: ["closed", "overflow"],
  },
  "frames/frame.json": {
    valid: FRAME_TYPES.flatMap((kind) => validFrames[kind]),
    invalid: [...FRAME_TYPES.flatMap(malformedJson), { type: "nonsense" }, {}],
  },
  ...methodSchemaFixtures,
};
