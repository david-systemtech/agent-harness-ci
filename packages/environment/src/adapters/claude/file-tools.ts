import type { PostToolUseFailureHookInput, PostToolUseHookInput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { FileChangeObserver, FileToolCall } from "../../adapter/contract.js";
import { CLAUDE_FILE_TOOLS, claudeToolAccess } from "./gate-access.js";
import type { FileToolHooks } from "./options.js";

/**
 * The Claude process's observation of the recognised file tools (#1182;
 * switch-over spec, "File undo"): the hooks that tell the run's
 * `FileChangeObserver` of a file tool's call the gate let through, and then
 * how it ended. The pinned CLI evaluates a call in this order: its input
 * checks, the `PreToolUse` hooks, its own permission evaluation (the mode,
 * the rules, `canUseTool`), the tool, then `PostToolUse` when the tool
 * succeeded or `PostToolUseFailure` when it threw; a call refused before the
 * tool runs has neither. Each hook waits on the observer, so a capture
 * finishes before the tool writes and after it has written.
 *
 * A call is announced by its tool use id and paired by it: one with no id is
 * not observed, since nothing could pair it. The announced `FileToolCall` is
 * what the call ends with, on the observer that was told of it, though a
 * later run on the kept process has another. What the observer throws is
 * logged: it never stops a call the gate let through, nor answers a hook.
 */

/** How many announced calls are kept waiting for their end: a call the provider refused after the gate never ends. */
const ANNOUNCED_KEPT = 1024;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A recognised file tool's call as a tool hook names it, or null for any other call and for one naming no path or no id. */
const fileToolCall = (input: PreToolUseHookInput | PostToolUseHookInput | PostToolUseFailureHookInput): FileToolCall | null => {
  if (!CLAUDE_FILE_TOOLS.includes(input.tool_name) || input.tool_use_id === "") return null;
  const access = claudeToolAccess(input.tool_name, isRecord(input.tool_input) ? input.tool_input : {});
  if (access.kind !== "write" || access.paths.length === 0) return null;
  return { toolCallId: input.tool_use_id, tool: input.tool_name, paths: access.paths, cwd: input.cwd };
};

const samePaths = (one: readonly string[], other: readonly string[]): boolean => one.length === other.length && one.every((path, index) => path === other[index]);

/** An announced call waiting for its end, with the observer told of it. */
interface Announced {
  readonly call: FileToolCall;
  readonly observer: FileChangeObserver;
}

export class FileToolObservation {
  /** The run's observer now: the process's current run context's. */
  readonly #observer: () => FileChangeObserver | undefined;
  readonly #diagnostic: (message: string) => void;
  /** Announced calls by tool use id, oldest first, at most `ANNOUNCED_KEPT`. */
  readonly #announced = new Map<string, Announced>();

  constructor(observer: () => FileChangeObserver | undefined, diagnostic: (message: string) => void) {
    this.#observer = observer;
    this.#diagnostic = diagnostic;
  }

  /** The hooks the run's options compose with the gate (`options.ts`). */
  readonly hooks: FileToolHooks = {
    before: async (input, _toolUseID, { signal }) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const observer = this.#observer();
      const call = fileToolCall(input);
      if (observer === undefined || call === null) return {};
      // Announced again (the CLI asked its hooks twice): the earlier announcement ends, and the capture is taken again.
      const earlier = this.#take(call.toolCallId);
      if (earlier !== undefined) this.#fail(earlier);
      this.#announce({ call, observer });
      try {
        await observer.before(call, signal);
      } catch (error) {
        this.#diagnostic(`capturing the files ${call.tool} call ${call.toolCallId} writes failed; the call goes on: ${describe(error)}`);
      }
      return {};
    },
    completed: async (input, _toolUseID, { signal }) => {
      if (input.hook_event_name !== "PostToolUse") return {};
      const announced = this.#take(input.tool_use_id);
      if (announced === undefined) return {};
      const ran = fileToolCall(input);
      // Another hook or a person's answer rewrote the call after it was announced: what was captured is not what it changed.
      if (ran === null || !samePaths(ran.paths, announced.call.paths)) {
        this.#fail(announced);
        return {};
      }
      try {
        await announced.observer.completed(announced.call, signal);
      } catch (error) {
        this.#diagnostic(`recording what ${announced.call.tool} call ${announced.call.toolCallId} changed failed: ${describe(error)}`);
      }
      return {};
    },
    failed: async (input) => {
      if (input.hook_event_name !== "PostToolUseFailure") return {};
      const announced = this.#take(input.tool_use_id);
      if (announced !== undefined) this.#fail(announced);
      return {};
    },
  };

  /** The process ended: no announced call can end now, so each has failed. */
  abandon(): void {
    const waiting = [...this.#announced.values()];
    this.#announced.clear();
    for (const announced of waiting) this.#fail(announced);
  }

  #announce(announced: Announced): void {
    this.#announced.set(announced.call.toolCallId, announced);
    for (const [id, oldest] of this.#announced) {
      if (this.#announced.size <= ANNOUNCED_KEPT) break;
      this.#announced.delete(id);
      this.#fail(oldest);
    }
  }

  #take(toolUseID: string): Announced | undefined {
    const announced = this.#announced.get(toolUseID);
    this.#announced.delete(toolUseID);
    return announced;
  }

  #fail(announced: Announced): void {
    try {
      announced.observer.failed(announced.call);
    } catch (error) {
      this.#diagnostic(`the observer threw on hearing that ${announced.call.tool} call ${announced.call.toolCallId} failed: ${describe(error)}`);
    }
  }
}
