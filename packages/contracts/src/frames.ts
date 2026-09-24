import { z } from "zod";
import { EventEnvelope } from "./envelope.js";
import { ContractError, WireError, invalidParams, type IssueInput } from "./errors.js";
import { CapabilityFlags, ProtocolVersion } from "./flags.js";
import {
  ClientKind,
  ClientSessionId,
  EnvironmentId,
  JsonObject,
  RequestId,
  Sequence,
  SubscriptionId,
  Timestamp,
} from "./primitives.js";
import { Ceiling, ScopeSet } from "./scopes.js";

/**
 * The wire: one WebSocket per client connection, one JSON text frame per
 * message, each an object whose `type` names its kind. Frames are decoded
 * tolerantly, so a field a reader does not know is dropped rather than
 * refused: adding an optional field never bumps the protocol version.
 */

/** Where a client opens its one WebSocket. The path takes no query: a token never travels in a URL. */
export const WIRE_PATH = "/ws";

/** Why a subscription ended. */
export const END_REASONS = ["unsubscribed", "overflow", "revoked", "closed", "deleted"] as const;
export const EndReason = z.enum(END_REASONS).meta({
  description:
    "Why a subscription ended: the client unsubscribed; it fell too far behind (resubscribe from its cursor); its client session was revoked; the connection closed; or what it follows was deleted (a session's subscription, after delivering session.deleted).",
});
export type EndReason = z.infer<typeof EndReason>;

/** Why the environment is about to close the connection. */
export const BYE_REASONS = ["unauthorized", "expired", "revoked", "protocol", "draining", "updating"] as const;
export const ByeReason = z.enum(BYE_REASONS).meta({
  description:
    "Why the environment is closing the connection: the token is invalid, foreign or unknown; it expired; the client session was revoked; the protocol versions differ; or the environment is draining or updating.",
});
export type ByeReason = z.infer<typeof ByeReason>;

export const AuthFrame = z
  .object({
    type: z.literal("auth"),
    token: z.string().min(1).meta({
      description: "The client session token from /api/pair or /api/bootstrap. It never travels in a URL.",
    }),
    protocolVersion: ProtocolVersion,
    clientKind: ClientKind,
    harnessVersion: z.string().min(1),
  })
  .meta({
    description:
      "From the client, first: its client session token, protocol version, kind and harness version.",
  });
export type AuthFrame = z.infer<typeof AuthFrame>;

export const HelloFrame = z
  .object({
    type: z.literal("hello"),
    protocolVersion: ProtocolVersion,
    capabilities: CapabilityFlags,
    environmentId: EnvironmentId,
    environmentName: z.string(),
    clientSessionId: ClientSessionId,
    scopes: ScopeSet,
    ceiling: Ceiling,
    serverTime: Timestamp,
  })
  .meta({
    description:
      "From the environment, in reply to a valid auth: what the environment is and what this client session may do.",
  });
export type HelloFrame = z.infer<typeof HelloFrame>;

export const RequestFrame = z
  .object({
    type: z.literal("request"),
    id: RequestId,
    method: z.string().min(1).meta({
      description: "A registered method name, area.verb. A request on a stream method is a subscription.",
    }),
    params: JsonObject.meta({
      description: "The method's params, checked against its params schema after its scope.",
    }),
  })
  .meta({ description: "From the client: call a method, or subscribe when the method is a stream." });
export type RequestFrame = z.infer<typeof RequestFrame>;

/** A result response carries no error, and an error response no result: `never` exports as `not: {}`. */
const ResultResponse = z.object({
  type: z.literal("response"),
  id: RequestId,
  result: JsonObject,
  error: z.never().optional(),
});
const ErrorResponse = z.object({
  type: z.literal("response"),
  id: RequestId,
  error: WireError,
  result: z.never().optional(),
});

export const ResponseFrame = z
  .union([ResultResponse, ErrorResponse])
  .meta({ description: "From the environment: a request's result, or its error, never both." });
export type ResponseFrame = z.infer<typeof ResponseFrame>;

export const SubscribedFrame = z
  .object({ type: z.literal("subscribed"), id: RequestId, subscription: SubscriptionId })
  .meta({
    description: "From the environment: the response to a stream request, naming the subscription its messages carry.",
  });
export type SubscribedFrame = z.infer<typeof SubscribedFrame>;

export const SnapshotFrame = z
  .object({ type: z.literal("snapshot"), subscription: SubscriptionId, sequence: Sequence, payload: JsonObject })
  .meta({
    description:
      "From the environment: at most one, first: when replay from the cursor is out of bounds, the state as of the head; or, when the stream holds a snapshot standing in for events the cursor has not seen (a compacted session), that snapshot, with the events after it replayed next. The state as of sequence.",
  });
export type SnapshotFrame = z.infer<typeof SnapshotFrame>;

export const EventFrame = z
  .object({
    type: z.literal("event"),
    subscription: SubscriptionId,
    sequence: Sequence.min(1).meta({ description: "The event's global sequence; always equal to event.sequence." }),
    event: EventEnvelope,
  })
  .refine((frame) => frame.sequence === frame.event.sequence, {
    message: "The frame's sequence must equal its event's.",
    path: ["sequence"],
  })
  .meta({
    description:
      "From the environment: one event of the subscription's stream. sequence equals event.sequence, a rule the decoder keeps and this schema cannot state.",
  });
export type EventFrame = z.infer<typeof EventFrame>;

export const SynchronizedFrame = z
  .object({ type: z.literal("synchronized"), subscription: SubscriptionId, sequence: Sequence })
  .meta({ description: "From the environment: once, when catch-up is complete; live events follow." });
export type SynchronizedFrame = z.infer<typeof SynchronizedFrame>;

export const EndFrame = z
  .object({ type: z.literal("end"), subscription: SubscriptionId, reason: EndReason })
  .meta({ description: "From the environment: the subscription is over, and why." });
export type EndFrame = z.infer<typeof EndFrame>;

export const UnsubscribeFrame = z
  .object({ type: z.literal("unsubscribe"), subscription: SubscriptionId })
  .meta({ description: "From the client: end a subscription; answered by end with reason unsubscribed." });
export type UnsubscribeFrame = z.infer<typeof UnsubscribeFrame>;

export const PingFrame = z
  .object({ type: z.literal("ping") })
  .meta({
    description: "From the environment, every 15 seconds; the client arms its 45-second watchdog after the first.",
  });
export type PingFrame = z.infer<typeof PingFrame>;

export const PongFrame = z.object({ type: z.literal("pong") }).meta({ description: "The answer to a ping." });
export type PongFrame = z.infer<typeof PongFrame>;

export const ByeFrame = z
  .object({
    type: z.literal("bye"),
    reason: ByeReason,
    protocolVersion: ProtocolVersion.optional().meta({
      description: "The environment's own protocol version, sent with reason protocol so the client can name both.",
    }),
    message: z.string().optional().meta({ description: "A sentence for people." }),
  })
  .meta({
    description:
      "From the environment, before it closes the connection: why, so the client reconnects only when it should.",
  });
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

const malformed = (issues: readonly IssueInput[]): ContractError =>
  new ContractError(invalidParams(issues, "The frame is malformed."));

/** A frame as JSON text, one message per WebSocket frame. */
export const encodeFrame = (frame: z.input<typeof Frame>): string => JSON.stringify(frame);

/**
 * The protocol version `text` declares when it is an auth frame, read before
 * and apart from the frame's schema: a client of another version may shape
 * the rest of its auth differently, and must still be told `bye: protocol`.
 * Undefined for anything that is not a JSON object of type `auth` with a
 * positive integer `protocolVersion`.
 */
export const peekProtocolVersion = (text: string): number | undefined => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
  const { type, protocolVersion } = json as Record<string, unknown>;
  if (type !== "auth") return undefined;
  const version = ProtocolVersion.safeParse(protocolVersion);
  return version.success ? version.data : undefined;
};

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
    throw malformed([{ code: "custom", path: [], message: `The frame is not JSON: ${(error as Error).message}` }]);
  }
  const kind = FrameKind.safeParse(json);
  if (!kind.success) throw malformed(kind.error.issues);
  const frame = FRAME_SCHEMAS[kind.data.type].safeParse(json);
  if (!frame.success) throw malformed(frame.error.issues);
  return frame.data;
};
