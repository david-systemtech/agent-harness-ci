import { lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import type { ToolDecisionPayload } from "@agent-harness/contracts";
import type { RunContainment, ToolAccess, ToolGate } from "../adapter/contract.js";
import { formatActor, type EventLog } from "../event-log/event-log.js";
import { sessionStream } from "../sessions/streams.js";

/**
 * The tool gate (permissions spec, "Modules": the tool gate) and its
 * containment rule: what a run's containment denies of a tool call that
 * does not pass through the provider's sandbox. At `workspace` a write
 * outside the workspace, the session's scratch directory and the session's
 * temporary directory, or one that names no path; at `workspace-no-network`
 * that, and every fetch and search. Shell commands are the sandbox's
 * (Claude's `sandbox` option, #140), reads are free at every level (the
 * denylist's paths are #132's), and `off` denies nothing. A denial is final:
 * the model is told why, and that asking again will not widen it.
 *
 * A path is read as the file system will read it: relative to the
 * workspace, `~` as the home directory, one component at a time, each
 * symbolic link followed where it stands, before any `..` after it is
 * applied (so `link/../file` is beside the link's target, not beside the
 * link), and a link whose target is not there yet read with `readlink`.
 */

/** Links followed in one path before it counts as a loop, as Linux's own limit. */
const MAX_LINKS = 40;

/** The components of `path` after its root. */
const componentsOf = (path: string): string[] => path.split(sep === "\\" ? /[\\/]/ : "/").filter((part) => part !== "");

/**
 * `path` as the file system resolves it: absolute, `~` expanded, every
 * symbolic link followed where it stands, a component that is not there
 * taken as written. Null when the links loop or a link cannot be read (gone
 * between the look and the read, say), since nothing can be written through
 * such a path and where it leads cannot be said.
 */
export const resolvePath = (path: string, base: string): string | null => {
  // Joined as text, never normalised, as a relative path is below: a `..` after a link must reach the walk.
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}${sep}${path.slice(2)}` : path;
  // Joined as text, never normalised: `..` is applied only once the component before it has been followed.
  const absolute = isAbsolute(expanded) ? expanded : `${base}${sep}${expanded}`;
  const { root } = parse(absolute);
  const pending = componentsOf(absolute.slice(root.length));
  let current = root;
  let links = 0;
  while (pending.length > 0) {
    const part = pending.shift() as string;
    if (part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    let link = false;
    try {
      link = lstatSync(next).isSymbolicLink();
    } catch {
      // Not there: taken as written, as is everything under it.
    }
    if (!link) {
      current = next;
      continue;
    }
    if (++links > MAX_LINKS) return null;
    let target: string;
    try {
      target = readlinkSync(next);
    } catch {
      // Gone since the look, or unreadable: where it leads cannot be said, so, as a loop, nothing is written through it.
      return null;
    }
    const targetRoot = parse(target).root;
    if (isAbsolute(target)) current = targetRoot;
    pending.unshift(...componentsOf(isAbsolute(target) ? target.slice(targetRoot.length) : target));
  }
  return current;
};

/** Whether `path` is `root` or lies under it. */
const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

const NOT_WIDENED = "Containment is a setting the user changes; asking again will not widen it. Continue without it and say what you could not do.";

/**
 * Why `access` is denied under `containment`, as the model is told it; null
 * when containment lets it through to the provider's own evaluation.
 * `workspace` is the directory relative paths are read against.
 */
export const containmentDenial = (containment: RunContainment, workspace: string, access: ToolAccess): string | null => {
  if (containment.level === "off") return null;
  if (access.kind === "write") {
    if (access.paths.length === 0) {
      return `Denied by containment (${containment.level}): the write names no path, so it cannot be shown to stay inside the directories this run may write in. ${NOT_WIDENED}`;
    }
    const roots = containment.writable.map((root) => resolvePath(root, workspace)).filter((root): root is string => root !== null);
    const outside = access.paths.find((path) => {
      const resolved = resolvePath(path, workspace);
      return resolved === null || !roots.some((root) => within(root, resolved));
    });
    if (outside === undefined) return null;
    const [workspaceRoot = workspace] = containment.writable;
    return (
      `Denied by containment (${containment.level}): this run may write only inside its workspace (${workspaceRoot}), ` +
      `the session's scratch directory (${containment.scratchDirectory}) and its temporary directory (${containment.temporaryDirectory}), ` +
      `and ${outside} is outside them. ${NOT_WIDENED}`
    );
  }
  if ((access.kind === "fetch" || access.kind === "search") && !containment.network) {
    const what = access.kind === "fetch" ? `fetching ${access.urls.join(", ")}` : "a web search";
    return `Denied by containment (${containment.level}): this run has no network, so ${what} cannot reach any host. ${NOT_WIDENED}`;
  }
  return null;
};

/** The tool gate's actor, for the decisions it records (`tool.decision`). */
export const GATE_ACTOR = formatActor({ kind: "system", id: "tool-gate" });

/** A run as the gate rules under it: its ids, its workspace and its containment. */
export interface GatedRun {
  readonly runId: string;
  readonly sessionId: string;
  readonly workspace: string;
  readonly containment: RunContainment;
}

export interface ToolGateOptions {
  readonly log: Pick<EventLog, "append">;
  /** The session's run live now, if any: a turn the provider opened on its own asks through the gate of the run it followed. */
  readonly liveRunOf: (sessionId: string) => GatedRun | undefined;
}

/**
 * The gate each run is handed (`RunContext.gate`). It rules under the
 * containment of the session's run live when it is asked, else of the run it
 * was handed to. A containment denial is final and asks nobody: no broker is
 * consulted, and the decision is recorded as `tool.decision` with
 * `decidedBy: containment`, appended when the gate rules, which may be before
 * the provider's report of the call reaches the log. A denial whose record
 * cannot be appended is still a denial. The gate records only its own
 * denials: every other decision is #131's to derive.
 */
export const createToolGate =
  (options: ToolGateOptions) =>
  (handedTo: GatedRun): ToolGate => ({
    check: async (call) => {
      const run = options.liveRunOf(handedTo.sessionId) ?? handedTo;
      const denial = containmentDenial(run.containment, run.workspace, call.access);
      if (denial === null) return { decision: "allow" };
      const payload: ToolDecisionPayload = {
        runId: run.runId,
        toolCallId: call.toolCallId,
        tool: call.tool,
        summary: call.summary,
        decision: "denied",
        decidedBy: "containment",
        promptId: null,
        reason: denial,
      };
      try {
        options.log.append(sessionStream(run.sessionId), [{ type: "tool.decision", payload }], { actor: GATE_ACTOR, correlationId: run.runId });
      } catch (error) {
        console.error(`Recording the gate's denial of ${call.tool} (${call.toolCallId}) in run ${run.runId} failed; it is denied all the same:`, error);
      }
      return { decision: "deny", message: denial };
    },
  });
