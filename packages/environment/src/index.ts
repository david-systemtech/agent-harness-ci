import { PROTOCOL_VERSION } from "@agent-harness/contracts";

/** The protocol version this environment serves. */
export const ENVIRONMENT_PROTOCOL_VERSION: number = PROTOCOL_VERSION;

export {
  openEventLog,
  RECEIPT_RETENTION_MS,
  REPLAY_BOUND,
  type AppendOptions,
  type AppendResult,
  type CommandReceipt,
  type EventEnvelope,
  type EventInput,
  type EventLog,
  type EventLogOptions,
  type JsonObject,
  type ProjectionDb,
  type Projector,
  type ReceiptRequest,
  type ReplayMeasure,
  type Snapshot,
  type SqlValue,
  type StreamRef,
} from "./event-log/event-log.js";
