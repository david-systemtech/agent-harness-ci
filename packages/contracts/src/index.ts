/**
 * The product's name wherever code prints it. `agent-harness` is a placeholder
 * (ADR 0017): the rename is one find-and-replace, and this is the constant.
 */
export const PRODUCT_NAME = "agent-harness";

export * from "./envelope.js";
export * from "./errors.js";
export * from "./flags.js";
export * from "./frames.js";
export {
  METHOD_KINDS,
  commandParams,
  defineMethod,
  subscriptionParams,
  type ErrorMember,
  type Method,
  type MethodErrorUnion,
  type MethodKind,
  type MethodSpec,
} from "./method.js";
export {
  CLIENT_KINDS,
  ClientKind,
  ClientSessionId,
  CommandId,
  JsonObject,
  RequestId,
  Sequence,
  SubscriptionId,
  Timestamp,
} from "./primitives.js";
export * from "./registry.js";
export * from "./schema-export.js";
export * from "./scopes.js";
