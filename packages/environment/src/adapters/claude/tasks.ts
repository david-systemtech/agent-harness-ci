import type { DelegatedWorkRow, DelegatedWorkStatus } from "@agent-harness/contracts";
import type { Clock } from "../../serve/clock.js";

/**
 * The delegated-work ledger (ported to the contracts' `DelegatedWorkRow`):
 * one row per task a run delegated (a
 * subagent, a background shell, a workflow), merged from five SDK messages.
 * `background_tasks_changed` is the level: the whole live set after each
 * change, and the only one that says a background task is gone when its
 * notification never comes. `task_started`, `task_progress`, `task_updated`
 * and `task_notification` are the edges, carrying the detail the level does
 * not. The ledger lives on the process, across turns; a turn emits the whole
 * ledger as `tasks.changed` after a change (replace, never merge).
 */

/** Settled rows kept for a pane to show, oldest dropped first; live rows are never dropped. */
export const SETTLED_LIMIT = 8;

const LIVE: ReadonlySet<DelegatedWorkStatus> = new Set(["pending", "running", "paused"]);

const statusOf = (raw: unknown): DelegatedWorkStatus | undefined => {
  switch (raw) {
    case "pending":
    case "running":
    case "paused":
    case "completed":
    case "failed":
      return raw;
    case "killed":
    case "stopped":
      return "stopped";
    default:
      return undefined;
  }
};

const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

type Message = Record<string, unknown>;

export class TaskLedger {
  readonly #clock: Pick<Clock, "now">;
  readonly #rows = new Map<string, DelegatedWorkRow>();
  /** Tasks the level has named: only these are settled by the level forgetting them (a foreground task never appears there). */
  readonly #fromLevel = new Set<string>();
  #dirty = false;

  constructor(clock: Pick<Clock, "now">) {
    this.#clock = clock;
  }

  /** Reads one SDK message; answers whether it changed the ledger. Anything reshaped reads as no news. */
  observe(message: unknown): boolean {
    if (message === null || typeof message !== "object") return false;
    const record = message as Message;
    if (record["type"] !== "system") return false;
    switch (record["subtype"]) {
      case "background_tasks_changed":
        return this.#level(record);
      case "task_started":
        return this.#started(record);
      case "task_progress":
        return this.#progress(record);
      case "task_updated":
        return this.#updated(record);
      case "task_notification":
        return this.#settled(record);
      default:
        return false;
    }
  }

  /** The rows for an event: marks the ledger clean. */
  snapshot(): DelegatedWorkRow[] {
    this.#dirty = false;
    return this.peek();
  }

  /** The rows, leaving a pending change pending. */
  peek(): DelegatedWorkRow[] {
    return [...this.#rows.values()];
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  get liveCount(): number {
    return [...this.#rows.values()].filter((row) => LIVE.has(row.status)).length;
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }

  #base(id: string): DelegatedWorkRow {
    return (
      this.#rows.get(id) ?? {
        taskId: id,
        kind: "task",
        description: "unnamed task",
        status: "running",
        startedAt: this.#now(),
        endedAt: null,
        subagentType: null,
        toolCallId: null,
        error: null,
      }
    );
  }

  /** Writes the row; when it settles a task, the settled rows past the cap go, oldest first, and the level index forgets what is gone. */
  #put(row: DelegatedWorkRow): true {
    this.#rows.set(row.taskId, row);
    this.#dirty = true;
    if (!LIVE.has(row.status)) this.#prune();
    return true;
  }

  #prune(): void {
    const settled = [...this.#rows.values()].filter((row) => !LIVE.has(row.status));
    for (const row of settled.slice(0, Math.max(0, settled.length - SETTLED_LIMIT))) {
      this.#rows.delete(row.taskId);
      this.#fromLevel.delete(row.taskId);
    }
  }

  #level(message: Message): boolean {
    const raw = message["tasks"];
    if (!Array.isArray(raw)) return false;
    let changed = false;
    const named = new Set<string>();
    for (const entry of raw) {
      if (entry === null || typeof entry !== "object") continue;
      const task = entry as Message;
      const id = text(task["task_id"]);
      if (id === undefined) continue;
      named.add(id);
      const existing = this.#rows.get(id);
      if (existing === undefined) {
        this.#put({ ...this.#base(id), kind: text(task["task_type"]) ?? "task", description: text(task["description"]) ?? "unnamed task" });
        changed = true;
      } else if (!LIVE.has(existing.status)) {
        this.#put({ ...existing, status: "running", endedAt: null });
        changed = true;
      }
    }
    for (const row of [...this.#rows.values()]) {
      if (named.has(row.taskId) || !LIVE.has(row.status) || !this.#fromLevel.has(row.taskId)) continue;
      this.#put({ ...row, status: "stopped", endedAt: this.#now() });
      changed = true;
    }
    for (const id of named) this.#fromLevel.add(id);
    return changed;
  }

  #started(message: Message): boolean {
    const id = text(message["task_id"]);
    if (id === undefined) return false;
    const base = this.#base(id);
    return this.#put({
      ...base,
      kind: text(message["task_type"]) ?? base.kind,
      description: text(message["description"]) ?? base.description,
      subagentType: text(message["subagent_type"]) ?? base.subagentType,
      toolCallId: text(message["tool_use_id"]) ?? base.toolCallId,
    });
  }

  #progress(message: Message): boolean {
    const id = text(message["task_id"]);
    if (id === undefined) return false;
    const base = this.#base(id);
    return this.#put({
      ...base,
      description: text(message["description"]) ?? base.description,
      subagentType: text(message["subagent_type"]) ?? base.subagentType,
      toolCallId: text(message["tool_use_id"]) ?? base.toolCallId,
    });
  }

  #updated(message: Message): boolean {
    const id = text(message["task_id"]);
    const patch = message["patch"];
    if (id === undefined || patch === null || typeof patch !== "object") return false;
    const existing = this.#rows.get(id);
    if (existing === undefined) return false;
    const fields = patch as Message;
    const status = statusOf(fields["status"]);
    return this.#put({
      ...existing,
      ...(status !== undefined && { status }),
      description: text(fields["description"]) ?? existing.description,
      error: text(fields["error"]) ?? existing.error,
      // A live status revives a settled row, its end cleared as the level's revival clears it; a settled one keeps the first end.
      ...(status !== undefined && { endedAt: LIVE.has(status) ? null : (existing.endedAt ?? this.#now()) }),
    });
  }

  #settled(message: Message): boolean {
    const id = text(message["task_id"]);
    if (id === undefined) return false;
    const base = this.#base(id);
    this.#put({
      ...base,
      status: statusOf(message["status"]) ?? "completed",
      endedAt: this.#now(),
      toolCallId: text(message["tool_use_id"]) ?? base.toolCallId,
    });
    return true;
  }
}
