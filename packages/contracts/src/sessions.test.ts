import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_TITLE,
  EVENT_TYPES,
  GROUP_EVENT_TYPES,
  GroupPatch,
  LIST_PATCH_KEY,
  OrderKey,
  SESSION_EVENT_TYPES,
  SUMMARY_FIELD_OWNERS,
  SUMMARY_KEYS,
  SessionSummary,
  SummaryPatch,
  Tag,
  UserTitle,
  isListEvent,
  listEventTypes,
  registry,
  type EventTypeTable,
} from "./index.js";

/**
 * The contract test of the session-state spec ("The contract test and the
 * lint"; ADR 0003): every summary field has an owner that exists, and every
 * `list`-flagged event type has a patch schema. The checks are plain
 * functions over the tables, so each failure they exist to catch is shown
 * failing on a table broken on purpose.
 */

/** Tables by stream kind, as `EVENT_TYPES` holds them. */
type EventTables = Readonly<Record<string, EventTypeTable>>;

/** An owner as a table may hold it, typed loosely so a broken table can be written. */
type LooseOwner = { readonly command: string } | { readonly event: string };

/** What is wrong with a field table: a summary key with no owner, a command not registered, an event type not flagged. */
const fieldTableProblems = (
  owners: Readonly<Record<string, LooseOwner>>,
  keys: readonly string[],
  methods: Readonly<Record<string, unknown>>,
  events: EventTables,
): string[] => {
  const problems: string[] = [];
  for (const key of keys) {
    const owner = Object.hasOwn(owners, key) ? owners[key] : undefined;
    if (owner === undefined) {
      problems.push(`${key}: no owner`);
      continue;
    }
    if ("command" in owner) {
      if (!Object.hasOwn(methods, owner.command)) problems.push(`${key}: the command ${owner.command} is not registered`);
      continue;
    }
    const flagged = Object.values(events).some((table) => Object.hasOwn(table, owner.event) && table[owner.event]?.list === true);
    if (!flagged) problems.push(`${key}: the event ${owner.event} is not list-flagged`);
  }
  for (const key of Object.keys(owners)) if (!keys.includes(key)) problems.push(`${key}: not a summary field`);
  return problems;
};

/** What is wrong with the event tables: a flagged type with no patch schema. */
const eventTableProblems = (events: EventTables): string[] =>
  Object.entries(events).flatMap(([kind, table]) =>
    Object.entries(table).flatMap(([type, entry]) =>
      entry.list && !(entry.patch instanceof z.ZodType) ? [`${kind} ${type}: list-flagged with no patch schema`] : [],
    ),
  );

const owners = SUMMARY_FIELD_OWNERS as Readonly<Record<string, LooseOwner>>;
const keys = SUMMARY_KEYS as readonly string[];

describe("the summary field table", () => {
  it("gives every summary field an owner that exists: a registered command, or a list-flagged event type", () => {
    expect(fieldTableProblems(owners, keys, registry, EVENT_TYPES)).toEqual([]);
    expect(Object.keys(SUMMARY_FIELD_OWNERS).sort()).toEqual([...keys].sort());
  });

  it("names the system-written fields' events: activity, pull requests and last activity among them", () => {
    expect(SUMMARY_FIELD_OWNERS.activity).toEqual({ event: "run.started" });
    expect(SUMMARY_FIELD_OWNERS.lastActivityAt).toEqual({ event: "run.started" });
    expect(SUMMARY_FIELD_OWNERS.parkedPromptCount).toEqual({ event: "prompt.opened" });
    expect(SUMMARY_FIELD_OWNERS.pullRequests).toEqual({ event: "session.pull-request-linked" });
    expect(SUMMARY_FIELD_OWNERS.title).toEqual({ command: "sessions.rename" });
  });

  it("fails when a summary field is missing from it", () => {
    const missing = Object.fromEntries(Object.entries(owners).filter(([key]) => key !== "tags"));
    expect(fieldTableProblems(missing, keys, registry, EVENT_TYPES)).toEqual(["tags: no owner"]);
  });

  it("fails when a field's command is not in the registry", () => {
    const broken = { ...owners, archivedAt: { command: "sessions.shelve" } };
    expect(fieldTableProblems(broken, keys, registry, EVENT_TYPES)).toEqual(["archivedAt: the command sessions.shelve is not registered"]);
    const unregistered = Object.fromEntries(Object.entries(registry).filter(([name]) => name !== "sessions.archive"));
    expect(fieldTableProblems(owners, keys, unregistered, EVENT_TYPES)).toEqual([
      "archivedAt: the command sessions.archive is not registered",
    ]);
  });

  it("fails when a field's event type is not list-flagged, or not registered at all", () => {
    const unflagged: EventTables = {
      ...EVENT_TYPES,
      session: { ...EVENT_TYPES.session, "run.started": { list: false, payload: z.object({}) } },
    };
    expect(fieldTableProblems(owners, keys, registry, unflagged)).toEqual([
      "lastActivityAt: the event run.started is not list-flagged",
      "activity: the event run.started is not list-flagged",
      "accountId: the event run.started is not list-flagged",
      "model: the event run.started is not list-flagged",
    ]);
    const unknown = { ...owners, pullRequests: { event: "session.pull-request-opened" } };
    expect(fieldTableProblems(unknown, keys, registry, EVENT_TYPES)).toEqual([
      "pullRequests: the event session.pull-request-opened is not list-flagged",
    ]);
    // An event of a stream kind that is never in the list does not own a field either.
    const accessOwned = { ...owners, model: { event: "pairing.created" } };
    expect(fieldTableProblems(accessOwned, keys, registry, EVENT_TYPES)).toEqual(["model: the event pairing.created is not list-flagged"]);
  });

  it("fails on an owner for a key the summary does not have", () => {
    expect(fieldTableProblems({ ...owners, colour: { command: "sessions.rename" } }, keys, registry, EVENT_TYPES)).toEqual([
      "colour: not a summary field",
    ]);
  });
});

describe("the event-type table", () => {
  it("gives every list-flagged type a patch schema", () => {
    expect(eventTableProblems(EVENT_TYPES)).toEqual([]);
  });

  it("fails on a list-flagged type without a patch schema", () => {
    const broken = {
      ...EVENT_TYPES,
      group: { ...EVENT_TYPES.group, "group.renamed": { list: true, payload: z.object({}) } },
    } as unknown as EventTables;
    expect(eventTableProblems(broken)).toEqual(["group group.renamed: list-flagged with no patch schema"]);
  });

  it("flags every session and group type, with the summary patch and the group patch", () => {
    for (const entry of Object.values(SESSION_EVENT_TYPES)) expect(entry).toMatchObject({ list: true, patch: SummaryPatch });
    for (const entry of Object.values(GROUP_EVENT_TYPES)) expect(entry).toMatchObject({ list: true, patch: GroupPatch });
  });

  it("flags nothing on the environment's and the access log's streams", () => {
    for (const kind of ["environment", "access"] as const) {
      for (const [type, entry] of Object.entries(EVENT_TYPES[kind])) expect(entry.list, type).toBe(false);
    }
    expect(isListEvent("access", "pairing.created")).toBe(false);
    expect(isListEvent("session", "session.created")).toBe(true);
    expect(isListEvent("group", "session.created")).toBe(false);
    expect(isListEvent("session", "toString")).toBe(false);
  });

  it("reserves the run, message and prompt names for their workstreams, flagged, with payloads left to them", () => {
    const reserved = Object.entries(SESSION_EVENT_TYPES).flatMap(([type, entry]) =>
      "reservedFor" in entry ? [[type, entry.reservedFor]] : [],
    );
    expect(reserved).toEqual([
      ["run.started", "the adapter workstream (#119)"],
      ["run.ended", "the adapter workstream (#119)"],
      ["message.sent", "the adapter workstream (#119)"],
      ["prompt.opened", "the permissions workstream (#130)"],
      ["prompt.answered", "the permissions workstream (#130)"],
    ]);
  });

  it("lists the flagged types the session list carries", () => {
    const types = listEventTypes(["session", "group"]);
    expect(types).toContain("session.created");
    expect(types).toContain("group.deleted");
    expect(types).toContain("run.started");
    expect(types).not.toContain("pairing.created");
    expect(listEventTypes(["access"])).toEqual([]);
  });
});

/** A summary as a fresh session has it. */
const fresh = {
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  createdAt: "2026-09-24T01:02:03.456Z",
  updatedAt: "2026-09-24T01:02:03.456Z",
  lastActivityAt: null,
  title: DEFAULT_TITLE,
  titleSource: "default",
  archivedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
  tags: [],
  groupId: null,
  settledAt: null,
  settledOverride: null,
  settledBy: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  workspace: { kind: "directory", path: "/work/repo" },
  repositoryIdentity: null,
  activity: { state: "idle", since: "2026-09-24T01:02:03.456Z" },
  parkedPromptCount: 0,
  accountId: null,
  model: null,
  pullRequests: [],
};

describe("the session summary", () => {
  it("holds identity, title, filing, shelf, place, activity and forge", () => {
    expect(SUMMARY_KEYS).toEqual([
      "id",
      "createdAt",
      "updatedAt",
      "lastActivityAt",
      "title",
      "titleSource",
      "archivedAt",
      "pinnedAt",
      "pinOrderKey",
      "activeOrderKey",
      "tags",
      "groupId",
      "settledAt",
      "settledOverride",
      "settledBy",
      "unsettledAt",
      "snoozedUntil",
      "snoozedAt",
      "workspace",
      "repositoryIdentity",
      "activity",
      "parkedPromptCount",
      "accountId",
      "model",
      "pullRequests",
    ]);
    expect(SessionSummary.parse(fresh)).toEqual(fresh);
    expect(SessionSummary.safeParse({ ...fresh, title: "" }).success).toBe(false);
    expect(SessionSummary.safeParse({ ...fresh, titleSource: "provider" }).success).toBe(false);
  });

  it("carries a patch as an added summary, a set of changed fields, or a removal, under one metadata key", () => {
    expect(LIST_PATCH_KEY).toBe("listPatch");
    expect(SummaryPatch.safeParse({ op: "add", summary: fresh }).success).toBe(true);
    expect(SummaryPatch.safeParse({ op: "set", sessionId: fresh.id, fields: { title: "Renamed", titleSource: "user" } }).success).toBe(true);
    expect(SummaryPatch.safeParse({ op: "set", sessionId: fresh.id, fields: { titleSource: "nobody" } }).success).toBe(false);
    expect(SummaryPatch.safeParse({ op: "remove", sessionId: fresh.id }).success).toBe(true);
    expect(SummaryPatch.safeParse({ op: "remove" }).success).toBe(false);
  });

  it("takes order keys over a to z that never end in a, titles of 1 to 200 characters and tags of 1 to 40", () => {
    for (const key of ["b", "an", "zzz", "aab"]) expect(OrderKey.safeParse(key).success, key).toBe(true);
    for (const key of ["", "a", "ba", "B", "b1"]) expect(OrderKey.safeParse(key).success, key).toBe(false);
    expect(UserTitle.safeParse("x".repeat(200)).success).toBe(true);
    for (const title of ["", "   ", "x".repeat(201)]) expect(UserTitle.safeParse(title).success, title).toBe(false);
    expect(Tag.safeParse("x".repeat(40)).success).toBe(true);
    for (const tag of ["", " ", "x".repeat(41), "a\tb", "a\u007f"]) expect(Tag.safeParse(tag).success, JSON.stringify(tag)).toBe(false);
  });
});
