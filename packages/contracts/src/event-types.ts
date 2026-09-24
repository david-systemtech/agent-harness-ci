import { z } from "zod";
import { ACCESS_EVENT_PAYLOADS, ACCESS_EVENT_TYPES, ACCESS_STREAM_KIND } from "./access-log.js";
import { ENVIRONMENT_NOTICE_TYPES, ENVIRONMENT_STREAM_KIND, EnvironmentNotice } from "./notices.js";
import { PERMISSION_SESSION_EVENT_TYPES } from "./permissions.js";
import { PROMPT_EVENT_TYPES } from "./prompts.js";
import { GROUP_EVENT_TYPES, GROUP_STREAM_KIND, SESSION_EVENT_TYPES, SESSION_STREAM_KIND } from "./sessions.js";
import { TRANSCRIPT_EVENT_TYPES } from "./transcript.js";
import { SETTINGS_EVENT_TYPES, SETTINGS_STREAM_KIND } from "./settings.js";

/**
 * The event-type table: every event type the environment's log carries, by
 * stream kind, each with its payload schema and its `list` flag. A flagged
 * type changes the session list (a summary or a group): the environment
 * writes the patch it made into the event's metadata under `LIST_PATCH_KEY`,
 * `sessions.subscribe` carries it, and a client applies the patch and never
 * re-derives a field from the payload. An event of a flagged type that
 * changes nothing a client lists (a deleted session ungrouped when its group
 * is deleted) carries no patch, and a client skips it. A flagged type names
 * its patch's schema; the contract test holds every flagged type to having one.
 */
export type EventTypeEntry =
  | {
      readonly list: true;
      readonly payload: z.ZodType;
      readonly patch: z.ZodType;
      /** Set when the type's name and flag are reserved here and its payload is the named workstream's to fix. */
      readonly reservedFor?: string;
    }
  | { readonly list: false; readonly payload: z.ZodType; readonly patch?: undefined; readonly reservedFor?: string };

/** Event types by name. */
export type EventTypeTable = Readonly<Record<string, EventTypeEntry>>;

/** A table of types none of which is `list`-flagged, each with the payload `payloadOf` names. */
const unlisted = <T extends string>(types: readonly T[], payloadOf: (type: T) => z.ZodType): Record<T, EventTypeEntry> => {
  const table = {} as Record<T, EventTypeEntry>;
  for (const type of types) table[type] = { list: false, payload: payloadOf(type) };
  return table;
};

/** The environment's notices: its own stream, never in the session list. */
const environmentEventTypes = unlisted(ENVIRONMENT_NOTICE_TYPES, (type) => {
  const notice = EnvironmentNotice.options.find((option) => option.shape.type.value === type);
  if (!notice) throw new Error(`The environment notice ${type} has no schema.`);
  return notice.shape.payload;
});

/** The access log: who was let in and how, never in the session list. */
const accessEventTypes = unlisted(ACCESS_EVENT_TYPES, (type) => ACCESS_EVENT_PAYLOADS[type]);

/**
 * A session's stream: its organisation types (session-state), the prompt
 * types (a prompt opened and answered, #130), the transcript its runs leave
 * (the adapter's vocabulary), and the permission types (a run's resolved
 * policy, the session's mode), on the one stream so a purge takes them all.
 */
const sessionEventTypes = { ...SESSION_EVENT_TYPES, ...PROMPT_EVENT_TYPES, ...TRANSCRIPT_EVENT_TYPES, ...PERMISSION_SESSION_EVENT_TYPES } as const;

/** Every event type, by the kind of stream it goes on. */
export const EVENT_TYPES = {
  [ENVIRONMENT_STREAM_KIND]: environmentEventTypes,
  [ACCESS_STREAM_KIND]: accessEventTypes,
  [SESSION_STREAM_KIND]: sessionEventTypes,
  [GROUP_STREAM_KIND]: GROUP_EVENT_TYPES,
  [SETTINGS_STREAM_KIND]: SETTINGS_EVENT_TYPES,
} as const satisfies Readonly<Record<string, EventTypeTable>>;

export type SessionEventType = keyof typeof sessionEventTypes;

/** The event types of the `session` stream. */
export const SessionEventType = z.enum(Object.keys(sessionEventTypes) as [SessionEventType, ...SessionEventType[]]).meta({
  description:
    "The event types of a session stream: the session.* organisation events, the forge workstream's pull-request events, the prompt events prompt.opened and prompt.answered, the transcript vocabulary a run leaves (run.started to run.ended), and the permission types run.policy.resolved and session.mode.set.",
});

/** The stream kinds the table knows. */
export type StreamKind = keyof typeof EVENT_TYPES;

/** The entry for `type` on a stream of `kind`; undefined for a type the table does not register there. */
export const eventTypeEntry = (kind: string, type: string): EventTypeEntry | undefined => {
  const table: EventTypeTable | undefined = Object.hasOwn(EVENT_TYPES, kind) ? EVENT_TYPES[kind as StreamKind] : undefined;
  return table !== undefined && Object.hasOwn(table, type) ? table[type] : undefined;
};

/** Whether `type` on a stream of `kind` is `list`-flagged: it changes the session list and carries a patch. */
export const isListEvent = (kind: string, type: string): boolean => eventTypeEntry(kind, type)?.list === true;

/** The `list`-flagged types of the stream kinds `kinds`, in the table's order. */
export const listEventTypes = (kinds: readonly StreamKind[]): string[] =>
  kinds.flatMap((kind) => Object.entries(EVENT_TYPES[kind] as EventTypeTable).flatMap(([type, entry]) => (entry.list ? [type] : [])));
