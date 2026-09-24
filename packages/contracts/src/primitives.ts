import { z } from "zod";

/**
 * A set of `item`s as JSON has no set: an array whose items are unique. The
 * refinement is zod's half; `uniqueItems` is the same rule in the export.
 */
export const setOf = <T extends z.ZodType>(item: T) =>
  z
    .array(item)
    .refine((items) => new Set(items).size === items.length, { message: "Items must be unique" })
    .meta({ uniqueItems: true });

/** An instant, as an ISO 8601 UTC timestamp: `2026-09-24T01:02:03.456Z`. */
export const Timestamp = z.iso.datetime().meta({ description: "An instant as an ISO 8601 UTC timestamp." });
export type Timestamp = z.infer<typeof Timestamp>;

/**
 * A position in the event log's global sequence. Events start at 1; 0 is the
 * cursor before the first event.
 */
export const Sequence = z.int().nonnegative().meta({
  description: "A position in the event log's global sequence; 0 is the cursor before the first event.",
});
export type Sequence = z.infer<typeof Sequence>;

/**
 * The client-generated UUID every command takes, keying its receipt
 * with the actor so a retried command applies once.
 */
export const CommandId = z.uuid().meta({
  description: "The client-generated UUID every command takes; a retry with the same id applies once.",
});
export type CommandId = z.infer<typeof CommandId>;

/** A request's id, chosen by the client and echoed by its `response` or `subscribed`. */
export const RequestId = z
  .string()
  .min(1)
  .meta({ description: "A request's id, chosen by the client and echoed by its response." });
export type RequestId = z.infer<typeof RequestId>;

/** A subscription's id, chosen by the environment in `subscribed` and carried by every subscription message. */
export const SubscriptionId = z
  .string()
  .min(1)
  .meta({ description: "A subscription's id, chosen by the environment and carried by every subscription message." });
export type SubscriptionId = z.infer<typeof SubscriptionId>;

/**
 * A JSON object. Params, results, payloads, metadata and error data are
 * objects rather than any JSON value, so each can grow a field without a
 * protocol bump.
 */
export const JsonObject = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObject>;

/** An environment's persistent id: a UUID made on its first start and kept across address changes and re-installs. */
export const EnvironmentId = z.uuid().meta({
  description: "An environment's persistent id: a UUID made on its first start, kept across address changes.",
});
export type EnvironmentId = z.infer<typeof EnvironmentId>;

/** A client session's id: what `hello` names, what the access methods list and revoke. */
export const ClientSessionId = z
  .string()
  .min(1)
  .meta({ description: "A client session's id, as hello names it and the access methods list and revoke it." });
export type ClientSessionId = z.infer<typeof ClientSessionId>;

/** A pairing's id: what the access log names a pairing by, since the code itself is never written down. */
export const PairingId = z
  .string()
  .min(1)
  .meta({ description: "A pairing's id, as the access log names it; the code itself is never logged." });
export type PairingId = z.infer<typeof PairingId>;

/** The clients there are: `program` is a script or bot driving the environment through the wire. */
export const CLIENT_KINDS = ["desktop", "tui", "web", "program"] as const;
export const ClientKind = z.enum(CLIENT_KINDS).meta({
  description:
    "What kind of client a client session belongs to: the desktop window, the terminal UI, a browser tab, or a program (a script or bot driving the wire).",
});
export type ClientKind = z.infer<typeof ClientKind>;
