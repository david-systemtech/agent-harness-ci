import { z } from "zod";
import { EventEnvelope } from "./envelope.js";
import { ContractError, WireError, invalidParams } from "./errors.js";
import { CapabilityFlags, ProtocolVersion } from "./flags.js";
import { ClientKind, RequestId, Sequence, SubscriptionId, Timestamp } from "./primitives.js";
import { Ceiling, ScopeSet } from "./scopes.js";

/**
 * The wire: one WebSocket per client connection, one JSON text frame per
 * message, each an object whose `type` names its kind. Frames are decoded
 * tolerantly, so a field a reader does not know is dropped rather than
 * refused: adding an optional field never bumps the protocol version.
 */

/** A JSON object; params, results and snapshot payloads are objects so they can grow a field. */
const JsonObject = z.record(z.string(), z.unknown());

/** Why a subscription ended. */
export const END_REASONS = ["unsubscribed", "overflow", "revoked", "closed"] as const;
export const EndReason = z.enum(END_REASONS);
export type EndReason = z.infer<typeof EndReason>;

/** Why the environment is about to close the connection. */
export const BYE_REASONS = ["unauthorized", "expired", "revoked", "protocol", "draining", "updating"] as const;
export const ByeReason = z.enum(BYE_REASONS);
export type ByeReason = z.infer<typeof ByeReason>;

export const AuthFrame = z
  .object({
    type: z.literal("auth"),
    /** The client session token from `/api/pair` or `/api/bootstrap`; never in a URL. */
    token: z.string().min(1),
    protocolVersion: ProtocolVersion,
    clientKind: ClientKind,
    harnessVersion: z.string().min(1),
  })
  .meta({ description: "Client, first message: the client session token, the client's protocol version, kind and harness version." });
export type AuthFrame = z.infer<typeof AuthFrame>;

export const HelloFrame = z
  .object({
    type: z.literal("hello"),
    protocolVersion: ProtocolVersion,
    capabilities: CapabilityFlags,
    environmentId: z.uuid(),
    environmentName: z.string(),
    clientSessionId: z.string().min(1),
    scopes: ScopeSet,
    ceiling: Ceiling,
    serverTime: Timestamp,
  })
  .meta({ description: "Server, in reply to a valid auth: what the environment is and what this client session may do." });
export type HelloFrame = z.infer<typeof HelloFrame>;

export const RequestFrame = z
  .object({
    type: z.literal("request"),
    id: RequestId,
    /** A registered method name, `area.verb`; a stream method's request is a subscription. */
    method: z.string().min(1),
    /** The method's params, checked against its params schema after its scope. */
    params: JsonObject,
  })
  .meta({ description: "Client: call a method, or subscribe when the method is a stream." });
export type RequestFrame = z.infer<typeof RequestFrame>;

const ResultResponse = z.object({ type: z.literal("response"), id: RequestId, result: JsonObject });
const ErrorResponse = z.object({ type: z.literal("response"), id: RequestId, error: WireError });

export const ResponseFrame = z
  .union([ResultResponse, ErrorResponse])
  .meta({ description: "Server: a request's result, or its error." });
export type ResponseFrame = z.infer<typeof ResponseFrame>;

export const SubscribedFrame = z
  .object({ type: z.literal("subscribed"), id: RequestId, subscription: SubscriptionId })
  .meta({ description: "Server: the response to a stream request, naming the subscription its messages carry." });
export type SubscribedFrame = z.infer<typeof SubscribedFrame>;

export const SnapshotFrame = z
  .object({ type: z.literal("snapshot"), subscription: SubscriptionId, sequence: Sequence, payload: JsonObject })
  .meta({ description: "Server: at most one, first, when replay from the cursor is out of bounds; the state as of sequence." });
export type SnapshotFrame = z.infer<typeof SnapshotFrame>;

export const EventFrame = z
  .object({ type: z.literal("event"), subscription: SubscriptionId, sequence: Sequence, event: EventEnvelope })
  .meta({ description: "Server: one event of the subscription's stream." });
export type EventFrame = z.infer<typeof EventFrame>;

export const SynchronizedFrame = z
  .object({ type: z.literal("synchronized"), subscription: SubscriptionId, sequence: Sequence })
  .meta({ description: "Server: once, when catch-up is complete; live events follow." });
export type SynchronizedFrame = z.infer<typeof SynchronizedFrame>;

export const EndFrame = z
  .object({ type: z.literal("end"), subscription: SubscriptionId, reason: EndReason })
  .meta({ description: "Server: the subscription is over, and why." });
export type EndFrame = z.infer<typeof EndFrame>;

export const UnsubscribeFrame = z
  .object({ type: z.literal("unsubscribe"), subscription: SubscriptionId })
  .meta({ description: "Client: end a subscription; answered by end with reason unsubscribed." });
export type UnsubscribeFrame = z.infer<typeof UnsubscribeFrame>;

export const PingFrame = z
  .object({ type: z.literal("ping") })
  .meta({ description: "Server, every 15 seconds; a client arms its 45-second watchdog after the first." });
export type PingFrame = z.infer<typeof PingFrame>;

export const PongFrame = z.object({ type: z.literal("pong") }).meta({ description: "The answer to a ping." });
export type PongFrame = z.infer<typeof PongFrame>;

export const ByeFrame = z
  .object({
    type: z.literal("bye"),
    reason: ByeReason,
    /** The environment's own protocol version, sent with `protocol` so the client can name both. */
    protocolVersion: ProtocolVersion.optional(),
    /** A sentence for people. */
    message: z.string().optional(),
  })
  .meta({ description: "Server, before it closes the connection: why, so the client reconnects only when it should." });
export type ByeFrame = z.infer<typeof ByeFrame>;

/** Every frame kind, in the env spec's order. */
export const FRAME_TYPES = [
  "auth",
  "hello",
  "request",
  "response",
  "subscribed",
  "snapshot",
  "event",
  "synchronized",
  "end",
  "unsubscribe",
  "ping",
  "pong",
  "bye",
] as const;
export type FrameType = (typeof FRAME_TYPES)[number];

/** Each frame kind's schema, by its `type`. */
export const FRAME_SCHEMAS = {
  auth: AuthFrame,
  hello: HelloFrame,
  request: RequestFrame,
  response: ResponseFrame,
  subscribed: SubscribedFrame,
  snapshot: SnapshotFrame,
  event: EventFrame,
  synchronized: SynchronizedFrame,
  end: EndFrame,
  unsubscribe: UnsubscribeFrame,
  ping: PingFrame,
  pong: PongFrame,
  bye: ByeFrame,
} as const satisfies Record<FrameType, z.ZodType>;

/**
 * Any frame. A plain union rather than a discriminated one: `response` has two
 * forms under one `type`, which zod's discriminated union cannot hold.
 * `decodeFrame` dispatches on `type` itself, so its issues name the field.
 */
export const Frame = z
  .union([
    AuthFrame,
    HelloFrame,
    RequestFrame,
    ResponseFrame,
    SubscribedFrame,
    SnapshotFrame,
    EventFrame,
    SynchronizedFrame,
    EndFrame,
    UnsubscribeFrame,
    PingFrame,
    PongFrame,
    ByeFrame,
  ])
  .meta({ description: "Any frame on the wire, told apart by its type." });
export type Frame = z.infer<typeof Frame>;

const FrameKind = z.object({ type: z.enum(FRAME_TYPES) });

const malformed = (issues: readonly z.core.$ZodIssue[]): ContractError =>
  new ContractError(invalidParams(issues, "The frame is malformed."));

/** A frame as JSON text, one message per WebSocket frame. */
export const encodeFrame = (frame: z.input<typeof Frame>): string => JSON.stringify(frame);

/**
 * The frame in `text`. Throws a `ContractError` with code `invalid_params`,
 * carrying the schema's issues under `data.issues`, when the text is not JSON,
 * names no known kind, or does not match its kind's schema.
 */
export const decodeFrame = (text: string): Frame => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw malformed([
      { code: "custom", path: [], message: `The frame is not JSON: ${(error as Error).message}`, input: undefined },
    ]);
  }
  const kind = FrameKind.safeParse(json);
  if (!kind.success) throw malformed(kind.error.issues);
  const frame = FRAME_SCHEMAS[kind.data.type].safeParse(json);
  if (!frame.success) throw malformed(frame.error.issues);
  return frame.data;
};
