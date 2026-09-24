import { Group, isCommand, isMethodName, registry, type CommandMethodName } from "@agent-harness/contracts";
import type { OverlayChange, Target } from "./rules.js";

/**
 * The outbox's entries and the document they are kept in
 * (docs/specs/client-runtime.md, "The offline outbox, receipts and
 * optimistic application"). One document per environment,
 * `outbox.<environmentId>`, holds the entries still to be answered, in the
 * order they were dispatched: commands, never organisation state as such
 * (ADR 0003). An entry is `queued` until it is sent, `in-flight` until its
 * receipt comes (through any number of sockets: a drop leaves it in flight,
 * to be sent again with its command id), and leaves the outbox
 * `acknowledged` or `rejected`.
 */

export const ENTRY_STATES = ["queued", "in-flight", "acknowledged", "rejected"] as const;
export type EntryState = (typeof ENTRY_STATES)[number];

export interface OutboxEntry {
  /** A UUIDv7 minted at dispatch and never again: every attempt sends it. */
  readonly commandId: string;
  readonly environmentId: string;
  readonly method: CommandMethodName;
  /** The command's params but its command id, checked against its schema at dispatch. */
  readonly params: Readonly<Record<string, unknown>>;
  /** The stream the command is about: a session or a group; null for one about neither (a run's interrupt). */
  readonly target: Target | null;
  /** When it was dispatched, on this client's clock: seven days on, it is dropped unsent. */
  readonly createdAt: string;
  /** How many times it has been sent. */
  readonly attempts: number;
  readonly state: EntryState;
  /** What its optimistic rule says it will change in the list, shown over the list until the environment says so; null when it has none. */
  readonly overlay: OverlayChange | null;
  /** The target's title (a group's name) when it was dispatched: what a notice names should the target be gone by its receipt. */
  readonly label: string | null;
}

/** The document an environment's outbox is kept in. */
export const outboxDocument = (environmentId: string): string => `outbox.${environmentId}`;

/** The document's format; one this build does not read is left as it is. */
export const OUTBOX_FORMAT = 1;

/** The entries waiting on their receipt, as the document holds them. */
export const encodeOutbox = (entries: readonly OutboxEntry[]): unknown => ({
  format: OUTBOX_FORMAT,
  entries: entries.filter((entry) => entry.state === "queued" || entry.state === "in-flight"),
});

export type DecodedOutbox =
  | { readonly readable: true; readonly entries: readonly OutboxEntry[]; readonly skipped: number }
  | { readonly readable: false; readonly why: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const readTarget = (value: unknown): Target | null | undefined => {
  if (value === null) return null;
  if (!isObject(value) || (value["kind"] !== "session" && value["kind"] !== "group") || typeof value["id"] !== "string") return undefined;
  return { kind: value["kind"], id: value["id"] };
};

const readOverlay = (value: unknown): OverlayChange | null | undefined => {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  const target = readTarget(value["target"]);
  if (!target) return undefined;
  if (value["op"] === "hide") return { target, op: "hide" };
  if (value["op"] === "set" && isObject(value["fields"])) return { target, op: "set", fields: value["fields"] };
  if (value["op"] === "add" && isObject(value["group"])) {
    const group = Group.safeParse(value["group"]);
    return group.success ? { target, op: "add", group: group.data } : undefined;
  }
  return undefined;
};

/** One stored entry, or undefined when it is not one this build can send. */
const readEntry = (value: unknown, environmentId: string): OutboxEntry | undefined => {
  if (!isObject(value)) return undefined;
  const { commandId, method, params, createdAt, attempts, state, label } = value;
  if (typeof commandId !== "string" || typeof method !== "string" || !isMethodName(method) || !isObject(params)) return undefined;
  const spec = registry[method];
  if (!isCommand(spec) || (spec.scope !== "sessions:write" && spec.scope !== "runs:drive")) return undefined;
  if (!spec.params.safeParse({ ...params, commandId }).success) return undefined;
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) return undefined;
  if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 0) return undefined;
  if (state !== "queued" && state !== "in-flight") return undefined;
  if (label !== null && typeof label !== "string") return undefined;
  const target = readTarget(value["target"]);
  const overlay = readOverlay(value["overlay"]);
  if (target === undefined || overlay === undefined) return undefined;
  return { commandId, environmentId, method: method as CommandMethodName, params, target, createdAt, attempts, state, overlay, label };
};

/** The document as entries; an entry this build cannot send is skipped and counted, a document in another form is not read. */
export const decodeOutbox = (value: unknown, environmentId: string): DecodedOutbox => {
  if (value === undefined) return { readable: true, entries: [], skipped: 0 };
  if (!isObject(value) || value["format"] !== OUTBOX_FORMAT || !Array.isArray(value["entries"])) {
    return { readable: false, why: `The outbox of ${environmentId} is not in a form this build reads (format ${JSON.stringify(isObject(value) ? value["format"] : undefined)}).` };
  }
  const entries: OutboxEntry[] = [];
  let skipped = 0;
  for (const stored of value["entries"]) {
    const entry = readEntry(stored, environmentId);
    if (entry) entries.push(entry);
    else skipped++;
  }
  return { readable: true, entries, skipped };
};
