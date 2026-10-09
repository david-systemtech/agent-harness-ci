import {
  DEFAULT_TITLE,
  GROUP_STREAM_KIND,
  LIST_PATCH_KEY,
  SESSION_STREAM_KIND,
  SessionSummary,
  SessionBrowser,
  normaliseGroupName,
  type EventEnvelope,
  type Group,
  type GroupPatch,
  type SummaryPatch,
  type Workspace,
  type WorkspaceProblem,
  type WorkspaceRequest,
} from "@agent-harness/contracts";
import { uuidv4 } from "../ids.js";
import type { FakeAnswer, FakeWire } from "./fake-wire.js";
import type { ManualClock } from "./in-memory-platform.js";
import type { ScriptedFolders } from "./scripted-folders.js";

/**
 * The scripted environment's session list (`scripted-environment.ts`):
 * `sessions.subscribe` answered with a snapshot of the script's sessions
 * and groups and `synchronized`, and every organisation command a client
 * issues applied as the environment's deciders apply it, in short (a
 * missing session given another workspace, and a group renamed or deleted
 * with its sessions taken out of it, among them): the
 * event carrying its summary patch and the command's id on the list, then
 * the accepted receipt. A command the script rejects
 * changes nothing. A test holds a method's answers to see a command wait
 * for its receipt, and changes a session as another client or a run would.
 * The sessions are the script's own (`store`), which its session streams
 * (`sessions.subscribeSession`) read too; what the script emits on a
 * session's stream reaches the list through `publish`.
 */

export interface ScriptedList {
  /** The sessions the environment holds now, deleted ones left out. */
  summaries(): readonly SessionSummary[];
  groups(): readonly Group[];
  /** Holds every answer to `method` until the release is called. */
  hold(method: string): () => void;
  /** A change the environment made of its own accord (a run, another client): `fields` set on one session. */
  change(sessionId: string, fields: Partial<SessionSummary>): void;
  /** Sends `event` on the list's subscription, when the client holds one on an open socket. */
  publish(event: EventEnvelope): void;
}

/** The script's sessions, which the list reads and changes. */
export interface ScriptedStore {
  all(): readonly SessionSummary[];
  get(id: string): SessionSummary | undefined;
  /** Adds or replaces a session: one new to the environment gets its stream. */
  put(summary: SessionSummary): void;
  remove(id: string): void;
}

export interface ScriptedListOptions {
  readonly wire: FakeWire;
  readonly clock: ManualClock;
  readonly store: ScriptedStore;
  readonly groups: readonly Group[];
  /** The next sequence on the environment's log, taken. */
  readonly next: () => number;
  /** The environment's log's head: its latest sequence. */
  readonly head: () => number;
  /** The script's rejection of `method`, if it rejects it. */
  readonly refusal: (method: string) => FakeAnswer | undefined;
  /** The directories a create's `directory` request is refused in, by the path as recorded (`~` read as `SCRIPTED_HOME`), each with its problem: preset none. */
  readonly directories?: Readonly<Record<string, WorkspaceProblem>>;
  /** The environment's directories, which a `worktree` request is made from. */
  readonly folders: ScriptedFolders;
}

/** The home a scripted environment's `~` stands for. */
export const SCRIPTED_HOME = "/home/milo";

/** The commands the list applies; `sessions.listDeleted` is its one query beyond `sessions.list` and `groups.list`. */
export const LIST_COMMANDS = [
  "sessions.create",
  "sessions.rename",
  "sessions.archive",
  "sessions.unarchive",
  "sessions.pin",
  "sessions.unpin",
  "sessions.reorderPinned",
  "sessions.reorderActive",
  "sessions.tag",
  "sessions.untag",
  "sessions.setGroup",
  "sessions.settle",
  "sessions.unsettle",
  "sessions.snooze",
  "sessions.unsnooze",
  "sessions.delete",
  "sessions.restore",
  "sessions.setWorkspace",
  "sessions.setBrowser",
  "groups.create",
  "groups.rename",
  "groups.delete",
] as const;

const DELETION_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export const scriptedList = (options: ScriptedListOptions): ScriptedList => {
  const { wire, clock, store, next, head } = options;
  const gone = new Map<string, { readonly summary: SessionSummary; readonly deletedAt: string; readonly purgeAt: string }>();
  const kept = new Map(options.groups.map((g) => [g.id, g]));
  const held = new Map<string, (() => void)[]>();
  let subscription: string | undefined;
  let subscriptions = 0;

  /** Sends `event` on the list's subscription, when the client holds one on an open socket. */
  const publish = (event: EventEnvelope) => {
    if (subscription === undefined) return;
    try {
      wire.server.send({ type: "event", subscription, sequence: event.sequence, event });
    } catch {
      // No socket open: the next subscription's snapshot carries it.
    }
  };
  const envelope = (streamKind: string, streamId: string, type: string, patch: SummaryPatch | GroupPatch, commandId: string | null): EventEnvelope => ({
    sequence: next(),
    eventId: uuidv4(),
    streamKind,
    streamId,
    streamVersion: 1,
    type,
    occurredAt: clock.now().toISOString(),
    commandId,
    causationId: null,
    correlationId: null,
    actor: { kind: "client_session", id: "scripted" },
    payload: {},
    metadata: { [LIST_PATCH_KEY]: patch },
  });

  const accepted = (result: Record<string, unknown>): FakeAnswer => ({ result: { receipt: { status: "accepted", sequence: head(), changed: true }, result } });
  const rejected = (code: string, message: string, data: Record<string, unknown> = {}): FakeAnswer => ({
    result: { receipt: { status: "rejected", sequence: next(), changed: false, reason: code, error: { code, message, data } } },
  });
  const noSession = () => rejected("not_found", "No such session.", { kind: "session" });

  /**
   * The workspace a create's or a `sessions.setWorkspace`'s request gives,
   * as the environment's resolver gives it (#325): a directory as sent, `~`
   * read as `SCRIPTED_HOME`, unless the script refuses it; a worktree of
   * one of the script's repositories (`scripted-folders.ts`); scratch under
   * a data directory; another session's shared. Or the refusal.
   */
  const resolved = (request: WorkspaceRequest, id: string): { readonly workspace: Workspace; readonly repositoryIdentity: string | null } | FakeAnswer => {
    switch (request.kind) {
      case "directory": {
        const path = request.path === "~" ? SCRIPTED_HOME : request.path.replace(/^~[\\/]/, `${SCRIPTED_HOME}/`);
        const problem = options.directories?.[path];
        if (problem !== undefined) return rejected("conflict", `The scripted environment refuses ${path}: ${problem}.`, { reason: "workspace_unusable", problem, path });
        return { workspace: { kind: "directory", path }, repositoryIdentity: null };
      }
      case "scratch":
        return { workspace: { kind: "scratch", path: `/data/scratch/${id}` }, repositoryIdentity: null };
      case "session": {
        const source = store.get(request.sessionId.toLowerCase());
        return source ? { workspace: source.workspace, repositoryIdentity: source.repositoryIdentity } : rejected("not_found", "No such session.", { kind: "session", sessionId: request.sessionId });
      }
      case "worktree": {
        const made = options.folders.worktree(request, id);
        return "refused" in made ? rejected(made.refused.code, made.refused.message, made.refused.data) : made;
      }
    }
  };

  /** Sets `fields` on the session, publishing the patch; answers the summary as it now is. */
  const set = (id: string, fields: Partial<SessionSummary>, commandId: string | null, type: string): FakeAnswer => {
    const before = store.get(id);
    if (!before) return noSession();
    const changed = { ...fields, updatedAt: clock.now().toISOString() };
    const summary = SessionSummary.parse({ ...before, ...changed });
    store.put(summary);
    publish(envelope(SESSION_STREAM_KIND, id, type, { op: "set", sessionId: id, fields: changed }, commandId));
    return accepted({ summary });
  };
  const add = (summary: SessionSummary, commandId: string | null, type: string) => {
    store.put(summary);
    publish(envelope(SESSION_STREAM_KIND, summary.id, type, { op: "add", summary }, commandId));
  };

  const apply = (method: string, params: Record<string, unknown>): FakeAnswer => {
    const refused = options.refusal(method);
    if (refused) return refused;
    const commandId = typeof params["commandId"] === "string" ? params["commandId"] : null;
    const id = String(params["sessionId"] ?? "");
    const now = clock.now().toISOString();
    const session = store.get(id);
    const wake = { snoozedUntil: null, snoozedAt: null };
    switch (method) {
      case "sessions.create": {
        const place = resolved(params["workspace"] as WorkspaceRequest, String(params["id"]));
        if (!("workspace" in place)) return place;
        const summary = SessionSummary.parse({
          id: params["id"],
          createdAt: now,
          updatedAt: now,
          lastActivityAt: null,
          title: typeof params["title"] === "string" ? params["title"] : DEFAULT_TITLE,
          titleSource: typeof params["title"] === "string" ? "user" : "default",
          archivedAt: null,
          pinnedAt: null,
          pinOrderKey: null,
          activeOrderKey: null,
          tags: params["tags"] ?? [],
          groupId: params["groupId"] ?? null,
          settledAt: null,
          settledOverride: null,
          settledBy: null,
          unsettledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          workspace: place.workspace,
          repositoryIdentity: place.repositoryIdentity,
          workspaceMissingSince: null,
          activity: { state: "idle", since: now },
          parkedPromptCount: 0,
          accountId: params["account"] ?? null,
          model: params["model"] ?? null,
          runChoice: null,
          mode: params["mode"] ?? null,
          browser: (params["browser"] as { value?: unknown } | undefined)?.value ?? null,
          pullRequests: [],
          draft: null,
        });
        add(summary, commandId, "session.created");
        return accepted({ summary });
      }
      case "sessions.rename":
        return params["title"] === null
          ? set(id, { title: DEFAULT_TITLE, titleSource: "default" }, commandId, "session.title-set")
          : set(id, { title: String(params["title"]), titleSource: "user" }, commandId, "session.title-set");
      case "sessions.archive":
        return set(id, { archivedAt: now }, commandId, "session.archived");
      case "sessions.unarchive":
        return set(id, { archivedAt: null }, commandId, "session.unarchived");
      case "sessions.pin": {
        // A pin unsettles and wakes, and keeps the key it has when given none.
        const unsettle = session?.settledAt ? { settledAt: null, settledBy: null, settledOverride: "active" as const, unsettledAt: now } : {};
        const key = typeof params["orderKey"] === "string" ? params["orderKey"] : (session?.pinOrderKey ?? null);
        return set(id, { pinnedAt: session?.pinnedAt ?? now, pinOrderKey: key, ...unsettle, ...wake }, commandId, "session.pinned");
      }
      case "sessions.unpin":
        return set(id, { pinnedAt: null, pinOrderKey: null }, commandId, "session.unpinned");
      case "sessions.reorderPinned":
        if (session && session.pinnedAt === null) return rejected("conflict", "The session is not pinned.", { reason: "not_pinned" });
        return set(id, { pinOrderKey: String(params["orderKey"]) }, commandId, "session.pin-reordered");
      case "sessions.reorderActive":
        if (session && (session.pinnedAt !== null || session.settledAt !== null || session.archivedAt !== null)) {
          return rejected("conflict", "The session is not in the active list.", { reason: "not_active" });
        }
        return set(id, { activeOrderKey: String(params["orderKey"]) }, commandId, "session.active-reordered");
      case "sessions.tag": {
        const tag = String(params["tag"]).trim();
        const others = (session?.tags ?? []).filter((t) => t.toLowerCase() !== tag.toLowerCase());
        return set(id, { tags: [...others, tag].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())) }, commandId, "session.tagged");
      }
      case "sessions.untag":
        return set(id, { tags: (session?.tags ?? []).filter((t) => t.toLowerCase() !== String(params["tag"]).toLowerCase()) }, commandId, "session.untagged");
      case "sessions.setGroup": {
        const groupId = params["groupId"] === null ? null : String(params["groupId"]);
        if (groupId !== null && !kept.has(groupId)) return rejected("not_found", "No such group.", { kind: "group" });
        return set(id, { groupId }, commandId, "session.group-set");
      }
      case "sessions.settle":
        return set(
          id,
          { settledAt: now, settledBy: "user", settledOverride: "settled", pinnedAt: null, pinOrderKey: null, activeOrderKey: null, ...wake },
          commandId,
          "session.settled",
        );
      case "sessions.unsettle":
        return set(id, { settledAt: null, settledBy: null, settledOverride: "active", unsettledAt: now }, commandId, "session.unsettled");
      case "sessions.snooze":
        return set(id, { snoozedUntil: String(params["until"]), snoozedAt: now }, commandId, "session.snoozed");
      case "sessions.unsnooze":
        return set(id, wake, commandId, "session.unsnoozed");
      case "sessions.delete": {
        if (!session) return noSession();
        const purgeAt = new Date(clock.now().getTime() + DELETION_GRACE_MS).toISOString();
        store.remove(id);
        gone.set(id, { summary: session, deletedAt: now, purgeAt });
        publish(envelope(SESSION_STREAM_KIND, id, "session.deleted", { op: "remove", sessionId: id }, commandId));
        return accepted({ sessionId: id, deletedAt: now, purgeAt });
      }
      case "sessions.restore": {
        const deleted = gone.get(id);
        if (!deleted) return noSession();
        gone.delete(id);
        add(deleted.summary, commandId, "session.restored");
        return accepted({ summary: deleted.summary });
      }
      case "sessions.setBrowser":
        return set(id, { browser: SessionBrowser.nullable().parse(params["browser"]) }, commandId, "session.browser.set");
      case "sessions.setWorkspace": {
        // As the environment decides it (#328): only a missing session with no run live is given another workspace.
        if (!session) return noSession();
        if (session.activity.state !== "idle") return rejected("conflict", "A run of the session is live.", { reason: "run_active", sessionId: id });
        if (session.workspaceMissingSince === null) {
          return rejected("conflict", "The session's workspace is there.", { reason: "workspace_present", sessionId: id, path: session.workspace.path });
        }
        const place = resolved(params["workspace"] as WorkspaceRequest, id);
        if (!("workspace" in place)) return place;
        return set(id, { workspace: place.workspace, repositoryIdentity: place.repositoryIdentity, workspaceMissingSince: null }, commandId, "session.workspace-set");
      }
      case "groups.create": {
        const group: Group = { id: String(params["id"]), name: normaliseGroupName(String(params["name"])), orderKey: null, createdAt: now, updatedAt: now };
        if ([...kept.values()].some((g) => g.name.toLowerCase() === group.name.toLowerCase())) {
          return rejected("conflict", "A group has that name.", { reason: "name_taken" });
        }
        kept.set(group.id, group);
        publish(envelope(GROUP_STREAM_KIND, group.id, "group.created", { op: "add", group }, commandId));
        return accepted({ group });
      }
      case "groups.rename": {
        const group = kept.get(String(params["groupId"]));
        if (!group) return rejected("not_found", "No such group.", { kind: "group" });
        const name = normaliseGroupName(String(params["name"]));
        if ([...kept.values()].some((g) => g.id !== group.id && g.name.toLowerCase() === name.toLowerCase())) {
          return rejected("conflict", "A group has that name.", { reason: "name_taken" });
        }
        const renamed: Group = { ...group, name, updatedAt: now };
        kept.set(group.id, renamed);
        publish(envelope(GROUP_STREAM_KIND, group.id, "group.renamed", { op: "set", groupId: group.id, fields: { name, updatedAt: now } }, commandId));
        return accepted({ group: renamed });
      }
      case "groups.delete": {
        // Every member is taken out of it in the same stroke, one `session.group-set` each after the group's own event.
        const group = kept.get(String(params["groupId"]));
        if (!group) return rejected("not_found", "No such group.", { kind: "group" });
        kept.delete(group.id);
        publish(envelope(GROUP_STREAM_KIND, group.id, "group.deleted", { op: "remove", groupId: group.id }, commandId));
        for (const member of store.all().filter((summary) => summary.groupId === group.id)) set(member.id, { groupId: null }, commandId, "session.group-set");
        return accepted({ groupId: group.id });
      }
      default:
        return { error: { code: "not_found", message: `The scripted list has no method ${method}.`, data: {} } };
    }
  };

  for (const method of LIST_COMMANDS) {
    wire.answer(method, (params) => {
      const waiting = held.get(method);
      if (!waiting) return apply(method, params);
      return new Promise<FakeAnswer>((resolve) => waiting.push(() => resolve(apply(method, params))));
    });
  }
  wire.answer("sessions.list", () => ({ result: { sequence: head(), sessions: [...store.all()] } }));
  wire.answer("groups.list", () => ({ result: { groups: [...kept.values()] } }));
  wire.answer("sessions.listDeleted", () => ({
    result: { sessions: [...gone.values()].map(({ summary, deletedAt, purgeAt }) => ({ ...summary, deletedAt, purgeAt })) },
  }));
  wire.answer("sessions.get", (params) => {
    const found = store.get(String(params["sessionId"]));
    return found ? { result: { summary: found } } : { error: { code: "not_found", message: "No such session.", data: {} } };
  });
  // The subscription is answered frame by frame on the socket the request came on: subscribed, the snapshot, synchronized.
  wire.answer("sessions.subscribe", (_params, request) => {
    const id = `list-${++subscriptions}`;
    subscription = id;
    const at = head();
    wire.server.send({ type: "subscribed", id: request.id, subscription: id });
    wire.server.send({ type: "snapshot", subscription: id, sequence: at, payload: { sequence: at, sessions: [...store.all()], groups: [...kept.values()] } });
    wire.server.send({ type: "synchronized", subscription: id, sequence: at });
    return undefined;
  });

  return {
    summaries: () => [...store.all()],
    groups: () => [...kept.values()],
    hold(method) {
      held.set(method, held.get(method) ?? []);
      return () => {
        const waiting = held.get(method) ?? [];
        held.delete(method);
        for (const release of waiting) release();
      };
    },
    change(sessionId, fields) {
      set(sessionId, fields, null, "session.changed");
    },
    publish,
  };
};
