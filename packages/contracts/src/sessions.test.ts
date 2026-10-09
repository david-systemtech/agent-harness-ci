import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_TITLE,
  EVENT_TYPES,
  GROUP_EVENT_TYPES,
  GroupId,
  GroupName,
  groupNameKey,
  GroupPatch,
  LIST_PATCH_KEY,
  MAX_DRAFT_LENGTH,
  MAX_TAGS,
  normaliseGroupName,
  OrderKey,
  SESSION_EVENT_TYPES,
  SUMMARY_FIELD_OWNERS,
  SUMMARY_KEYS,
  SessionId,
  SessionSummary,
  SummaryPatch,
  TRANSCRIPT_EVENT_TYPES,
  Tag,
  UserTitle,
  WORKSPACE_KINDS,
  WORKSPACE_PROBLEMS,
  Workspace,
  WorkspaceProblem,
  WorkspaceRequest,
  isListEvent,
  listEventTypes,
  registry,
  type EventTypeTable,
  type SummaryFieldOwner,
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
      const method = Object.hasOwn(methods, owner.command) ? (methods[owner.command] as { kind?: unknown }) : undefined;
      if (method === undefined) problems.push(`${key}: the command ${owner.command} is not registered`);
      else if (method.kind !== "command") problems.push(`${key}: ${owner.command} is a ${String(method.kind)}, not a command`);
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

  it("gives the run's fields to run.started, which carries the account and model, and flags the run's end and the generated title too", () => {
    for (const key of ["activity", "lastActivityAt", "accountId", "model"] as const) expect(SUMMARY_FIELD_OWNERS[key], key).toEqual({ event: "run.started" });
    expect(Object.keys(TRANSCRIPT_EVENT_TYPES["run.started"].payload.shape)).toEqual(expect.arrayContaining(["accountId", "model"]));
    expect(Object.keys(TRANSCRIPT_EVENT_TYPES["run.ended"].payload.shape)).not.toEqual(expect.arrayContaining(["accountId"]));
    for (const type of ["run.started", "run.ended", "session.title-generated"]) expect(isListEvent("session", type), type).toBe(true);
    expect(isListEvent("session", "message.sent")).toBe(false);
  });

  it("gives the draft to sessions.setDraft, an absolute setter, through one list-flagged session.draft-set", () => {
    expect(SUMMARY_FIELD_OWNERS.draft).toEqual({ command: "sessions.setDraft" });
    expect(registry["sessions.setDraft"]).toMatchObject({ kind: "command", scope: "sessions:write" });
    expect(isListEvent("session", "session.draft-set")).toBe(true);
  });

  it("gives the next run's model and effort to sessions.setModel at runs:drive, through one list-flagged session.model-set (#1961)", () => {
    expect(SUMMARY_FIELD_OWNERS.runChoice).toEqual({ command: "sessions.setModel" });
    expect(registry["sessions.setModel"]).toMatchObject({ kind: "command", scope: "runs:drive" });
    expect(Object.keys(registry["sessions.setModel"].params.shape)).toEqual(["commandId", "sessionId", "model", "effort"]);
    expect(Object.keys(registry["sessions.setModel"].result.shape)).toEqual(["summary"]);
    expect(isListEvent("session", "session.model-set")).toBe(true);
  });

  it("gives the shelf fields to settle, unsettle and snooze, each a command, their events list-flagged", () => {
    expect(
      Object.fromEntries((["settledAt", "settledOverride", "settledBy", "unsettledAt", "snoozedUntil", "snoozedAt"] as const).map((key) => [key, SUMMARY_FIELD_OWNERS[key]])),
    ).toEqual({
      settledAt: { command: "sessions.settle" },
      settledOverride: { command: "sessions.settle" },
      settledBy: { command: "sessions.settle" },
      unsettledAt: { command: "sessions.unsettle" },
      snoozedUntil: { command: "sessions.snooze" },
      snoozedAt: { command: "sessions.snooze" },
    });
    for (const name of ["sessions.settle", "sessions.unsettle", "sessions.snooze", "sessions.unsnooze"] as const) {
      expect(registry[name], name).toMatchObject({ kind: "command", scope: "sessions:write" });
    }
    for (const type of ["session.settled", "session.unsettled", "session.snoozed", "session.unsnoozed"]) expect(isListEvent("session", type), type).toBe(true);
  });

  it("gives the place to sessions.create and the missing mark to session.workspace-status-changed, list-flagged, which no transcript fold drops", () => {
    expect(SUMMARY_FIELD_OWNERS.workspace).toEqual({ command: "sessions.create" });
    expect(SUMMARY_FIELD_OWNERS.repositoryIdentity).toEqual({ command: "sessions.create" });
    expect(SUMMARY_FIELD_OWNERS.workspaceMissingSince).toEqual({ event: "session.workspace-status-changed" });
    expect(isListEvent("session", "session.workspace-status-changed")).toBe(true);
    expect(Object.hasOwn(TRANSCRIPT_EVENT_TYPES, "session.workspace-status-changed")).toBe(false);
    expect(SESSION_EVENT_TYPES["session.workspace-status-changed"].payload.safeParse({ status: "missing" }).success).toBe(true);
    expect(SESSION_EVENT_TYPES["session.workspace-status-changed"].payload.safeParse({ status: "moved" }).success).toBe(false);
  });

  it("keeps the place on sessions.create while sessions.setWorkspace, a sessions:write command, gives a missing session another with session.workspace-set, list-flagged, which no transcript fold drops", () => {
    // ADR 0003's field table: the command that first writes the place stays its owner (#328).
    expect(SUMMARY_FIELD_OWNERS.workspace).toEqual({ command: "sessions.create" });
    expect(SUMMARY_FIELD_OWNERS.repositoryIdentity).toEqual({ command: "sessions.create" });
    expect(registry["sessions.setWorkspace"]).toMatchObject({ kind: "command", scope: "sessions:write" });
    expect(registry["sessions.setWorkspace"].params.shape.workspace).toBe(WorkspaceRequest);
    expect(isListEvent("session", "session.workspace-set")).toBe(true);
    expect(Object.hasOwn(TRANSCRIPT_EVENT_TYPES, "session.workspace-set")).toBe(false);
    const payload = SESSION_EVENT_TYPES["session.workspace-set"].payload;
    // A recorded workspace, never a request: the environment resolved it.
    expect(payload.safeParse({ workspace: { kind: "scratch", path: "/data/scratch/s" }, repositoryIdentity: null }).success).toBe(true);
    expect(payload.safeParse({ workspace: { kind: "scratch" }, repositoryIdentity: null }).success).toBe(false);
  });

  it("gives the identity passes session.repository-identified, list-flagged, which no transcript fold drops, while the identity stays sessions.create's", () => {
    const payload = SESSION_EVENT_TYPES["session.repository-identified"].payload;
    expect(SUMMARY_FIELD_OWNERS.repositoryIdentity).toEqual({ command: "sessions.create" });
    expect(isListEvent("session", "session.repository-identified")).toBe(true);
    expect(Object.hasOwn(TRANSCRIPT_EVENT_TYPES, "session.repository-identified")).toBe(false);
    expect(payload.safeParse({ repositoryIdentity: "https://git.systemtech.dev/david/agent-harness", reason: "resolved" }).success).toBe(true);
    expect(payload.safeParse({ repositoryIdentity: "https://git.systemtech.dev/david/agent-harness", reason: "alias" }).success).toBe(true);
    expect(payload.safeParse({ repositoryIdentity: "https://git.systemtech.dev/david/agent-harness", reason: "moved" }).success).toBe(false);
    // An identity, as the rule gives one: never null, never a path of one segment.
    expect(payload.safeParse({ repositoryIdentity: null, reason: "resolved" }).success).toBe(false);
    expect(payload.safeParse({ repositoryIdentity: "https://git.systemtech.dev/agent-harness", reason: "resolved" }).success).toBe(false);
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

  it("fails when a field's owner is a registered method that is not a command, and does not compile one", () => {
    const query = { ...owners, groupId: { command: "sessions.list" } };
    expect(fieldTableProblems(query, keys, registry, EVENT_TYPES)).toEqual(["groupId: sessions.list is a query, not a command"]);
    // @ts-expect-error: a query is no owner; only a command-kind registry entry is.
    const owner: SummaryFieldOwner = { command: "sessions.list" };
    // @ts-expect-error: nor is a stream.
    const stream: SummaryFieldOwner = { command: "sessions.subscribe" };
    expect([owner, stream]).toHaveLength(2);
    for (const entry of Object.values(SUMMARY_FIELD_OWNERS)) {
      if ("command" in entry) expect(registry[entry.command].kind, entry.command).toBe("command");
    }
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

  it("flags every organisation and group type, with the summary patch and the group patch", () => {
    for (const [type, entry] of Object.entries(SESSION_EVENT_TYPES)) expect(entry, type).toMatchObject({ list: true, patch: SummaryPatch });
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

  it("reserves nothing now that #130 fixed the prompt payloads, flagged list; the run and message types are the transcript vocabulary's", () => {
    const reserved = Object.entries(EVENT_TYPES.session).flatMap(([type, entry]) =>
      "reservedFor" in entry ? [[type, entry.reservedFor, entry.list]] : [],
    );
    expect(reserved).toEqual([]);
    expect(isListEvent("session", "prompt.opened")).toBe(true);
    expect(isListEvent("session", "prompt.answered")).toBe(true);
    expect(isListEvent("session", "message.sent")).toBe(false);
    expect(isListEvent("session", "run.started")).toBe(true);
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
  workspaceMissingSince: null,
  activity: { state: "idle", since: "2026-09-24T01:02:03.456Z" },
  parkedPromptCount: 0,
  accountId: null,
  model: null,
  runChoice: null,
  mode: null,
  browser: null,
  pullRequests: [],
  draft: null,
};

describe("the workspace", () => {
  /** One recorded workspace of every kind this version knows. */
  const recorded = {
    directory: { kind: "directory", path: "/work/agent-harness" },
    worktree: { kind: "worktree", path: "/data/worktrees/agent-harness-3f2a/main", repository: "/work/agent-harness", branch: "main" },
    scratch: { kind: "scratch", path: "/data/scratch/7c9e6679-7425-40de-944b-e07fc1f90ae7" },
  } as const;

  it("is a union on kind whose every member carries an absolute path, as the environment's operating system writes it", () => {
    expect(Object.keys(recorded)).toEqual([...WORKSPACE_KINDS]);
    for (const workspace of Object.values(recorded)) {
      expect(Workspace.parse(workspace), workspace.kind).toEqual(workspace);
      const pathless = Object.fromEntries(Object.entries(workspace).filter(([key]) => key !== "path"));
      expect(Workspace.safeParse(pathless).success, `${workspace.kind} without a path`).toBe(false);
      expect(Workspace.safeParse({ ...workspace, path: "relative/dir" }).success, `${workspace.kind} with a relative path`).toBe(false);
    }
    for (const path of ["C:\\Users\\david\\work", "D:/work", "\\\\nas\\work"]) expect(Workspace.parse({ kind: "directory", path }), path).toEqual({ kind: "directory", path });
    expect(Workspace.safeParse({ kind: "worktree", path: "/data/worktrees/x", repository: "/work/agent-harness" }).success).toBe(false);
  });

  it("reads a kind this version does not know as a directory at its path, so a summary carrying one still reads", () => {
    expect(Workspace.parse({ kind: "bank", path: "/data/banks/meadowstudios", bank: "meadowstudios" })).toEqual({ kind: "directory", path: "/data/banks/meadowstudios" });
    const summary = SessionSummary.parse({ ...fresh, workspace: { kind: "bank", path: "/data/banks/meadowstudios" } });
    expect(summary.workspace).toEqual({ kind: "directory", path: "/data/banks/meadowstudios" });
    expect(SummaryPatch.parse({ op: "set", sessionId: fresh.id, fields: { workspace: { kind: "bank", path: "/b" } } })).toEqual({
      op: "set",
      sessionId: fresh.id,
      fields: { workspace: { kind: "directory", path: "/b" } },
    });
    // Without a path there is nothing a client could show.
    expect(Workspace.safeParse({ kind: "bank" }).success).toBe(false);
  });

  it("is asked for with a request: a directory as it is recorded or from the environment's home, a worktree, scratch or another session's", () => {
    expect(registry["sessions.create"].params.shape.workspace).toBe(WorkspaceRequest);
    expect(WorkspaceRequest.parse(recorded.directory)).toEqual(recorded.directory);
    expect(WorkspaceRequest.parse({ kind: "worktree", repository: "/work/agent-harness", newBranch: { base: "main" } })).toEqual({
      kind: "worktree",
      repository: "/work/agent-harness",
      newBranch: { base: "main" },
    });
    expect(WorkspaceRequest.parse({ kind: "scratch" })).toEqual({ kind: "scratch" });
    expect(WorkspaceRequest.parse({ kind: "session", sessionId: fresh.id })).toEqual({ kind: "session", sessionId: fresh.id });
    // A directory from the environment's home is asked for, never recorded: the environment expands it.
    expect(WorkspaceRequest.parse({ kind: "directory", path: "~/code" })).toEqual({ kind: "directory", path: "~/code" });
    expect(Workspace.safeParse({ kind: "directory", path: "~/code" }).success).toBe(false);
    expect(WorkspaceRequest.safeParse({ kind: "directory", path: "~milo/code" }).success).toBe(false);
    // No path of its own: a worktree's and a scratch directory's are the environment's to choose.
    expect(WorkspaceRequest.parse({ kind: "scratch", path: "/tmp/mine" })).toEqual({ kind: "scratch" });
  });

  it("says why a directory cannot be one in a closed set of problems, kept apart so a client can say which", () => {
    expect(WORKSPACE_PROBLEMS).toEqual(["does_not_exist", "not_a_directory", "not_readable", "reserved"]);
    for (const problem of WORKSPACE_PROBLEMS) expect(WorkspaceProblem.parse(problem)).toBe(problem);
    expect(WorkspaceProblem.safeParse("missing").success).toBe(false);
  });

  it("refuses a worktree request naming both an existing branch and a new one, at newBranch", () => {
    const both = WorkspaceRequest.safeParse({ kind: "worktree", repository: "/work/agent-harness", branch: "main", newBranch: { name: "fix" } });
    expect(both.success).toBe(false);
    expect(both.error?.issues).toEqual([expect.objectContaining({ path: ["newBranch"] })]);
  });
});

describe("the session summary", () => {
  it("holds identity, title, filing, shelf, place, activity, mode, browser and forge", () => {
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
      "workspaceMissingSince",
      "activity",
      "parkedPromptCount",
      "accountId",
      "model",
      "runChoice",
      "mode",
      "browser",
      "pullRequests",
      "draft",
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

  it("takes session and group ids that are version 4 UUIDs, and no other version", () => {
    expect(SessionId.safeParse(fresh.id).success).toBe(true);
    expect(GroupId.safeParse("1b4e28ba-2fa1-41d2-883f-0016d3cca427").success).toBe(true);
    // A version 1 UUID, and a version 7 one.
    for (const id of ["c232ab00-9414-11ec-b3c8-9f6bdeced846", "01920f3e-7c4a-7b8e-9f1a-2b3c4d5e6f70"]) {
      expect(SessionId.safeParse(id).success, id).toBe(false);
      expect(GroupId.safeParse(id).success, id).toBe(false);
    }
  });

  it("keys a group name trimmed, its white space collapsed and lowercased, as an environment and a client merging headings both fold it", () => {
    expect(normaliseGroupName("  Moon \t Gems\n\n and  friends ")).toBe("Moon Gems and friends");
    expect(groupNameKey("  MOON   gems ")).toBe("moon gems");
    expect(groupNameKey("Meadowstudios")).toBe(groupNameKey(" meadowSTUDIOS "));
  });

  it("measures titles, tags and group names after trimming: surrounding white space is not counted", () => {
    expect(UserTitle.safeParse(`  ${"x".repeat(200)}  `).success).toBe(true);
    expect(UserTitle.safeParse(` ${"x".repeat(201)} `).success).toBe(false);
    expect(UserTitle.safeParse(" a b ").success).toBe(true);
    expect(Tag.safeParse(`  ${"x".repeat(40)} `).success).toBe(true);
    expect(Tag.safeParse(` ${"x".repeat(41)}`).success).toBe(false);
    expect(Tag.safeParse(" a\tb ").success).toBe(false);
    expect(GroupName.safeParse(` ${"x".repeat(80)} `).success).toBe(true);
    expect(GroupName.safeParse("x".repeat(81)).success).toBe(false);
  });

  it("takes order keys over a to z that never end in a, titles of 1 to 200 characters and tags of 1 to 40", () => {
    for (const key of ["b", "an", "zzz", "aab"]) expect(OrderKey.safeParse(key).success, key).toBe(true);
    for (const key of ["", "a", "ba", "B", "b1"]) expect(OrderKey.safeParse(key).success, key).toBe(false);
    expect(UserTitle.safeParse("x".repeat(200)).success).toBe(true);
    for (const title of ["", "   ", "x".repeat(201)]) expect(UserTitle.safeParse(title).success, title).toBe(false);
    expect(Tag.safeParse("x".repeat(40)).success).toBe(true);
    expect(MAX_TAGS).toBe(64);
    for (const tag of ["", " ", "x".repeat(41), "a\tb", "a\u007f"]) expect(Tag.safeParse(tag).success, JSON.stringify(tag)).toBe(false);
  });

  it("carries a draft of any characters up to the limit, never empty in the summary, null for none", () => {
    for (const draft of [null, "Now look at the receipts", " ", "line one\nline two\ttabbed", "x".repeat(MAX_DRAFT_LENGTH)]) {
      expect(SessionSummary.safeParse({ ...fresh, draft }).success, JSON.stringify(draft)?.slice(0, 20)).toBe(true);
    }
    for (const draft of ["", "x".repeat(MAX_DRAFT_LENGTH + 1), 7]) {
      expect(SessionSummary.safeParse({ ...fresh, draft }).success, JSON.stringify(draft).slice(0, 20)).toBe(false);
    }
    // The command takes an empty string, which clears the draft like null.
    const params = registry["sessions.setDraft"].params;
    const target = { commandId: fresh.id, sessionId: fresh.id };
    for (const draft of [null, "", "x".repeat(MAX_DRAFT_LENGTH)]) expect(params.safeParse({ ...target, draft }).success).toBe(true);
    for (const draft of [undefined, "x".repeat(MAX_DRAFT_LENGTH + 1)]) expect(params.safeParse({ ...target, draft }).success).toBe(false);
  });
});
