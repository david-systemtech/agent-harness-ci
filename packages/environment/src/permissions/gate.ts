import { lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import type { PromptKind, ToolDecider, ToolDecisionPayload } from "@agent-harness/contracts";
import type { GateDecision, PromptDecision, PromptDetail, RunContainment, ToolAccess, ToolGate } from "../adapter/contract.js";
import type { RuledRun, ToolGateRule } from "../adapter/seams.js";
import { summarise } from "./broker.js";
import { formatActor, type EventLog } from "../event-log/event-log.js";
import { recordToolDecision } from "./tool-decisions.js";

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

/** What the walk reads of the file system: whether a path is a symbolic link, and a link's target. */
export interface LinkReader {
  isLink(path: string): boolean;
  readlink(path: string): string;
}

const fileSystem: LinkReader = {
  isLink: (path) => {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      // Not there: taken as written, as is everything under it.
      return false;
    }
  },
  readlink: (path) => readlinkSync(path),
};

/**
 * `path` as the file system resolves it (the one walk the gate's rules
 * share, containment's and the denylist's; `reader` is the file system's
 * unless a test gives another): absolute, `~` expanded, every
 * symbolic link followed where it stands, a component that is not there
 * taken as written. Null when the links loop or a link cannot be read (gone
 * between the look and the read, say), since nothing can be written through
 * such a path and where it leads cannot be said.
 */
export const resolvePath = (path: string, base: string, reader: LinkReader = fileSystem): string | null => {
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
    if (!reader.isLink(next)) {
      current = next;
      continue;
    }
    if (++links > MAX_LINKS) return null;
    let target: string;
    try {
      target = reader.readlink(next);
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

/** The tool gate's actor, for the denials it records when no prompt's answer did (`tool.decision`). */
export const GATE_ACTOR = formatActor({ kind: "system", id: "tool-gate" });

/** What the model reads when the tool gate could not rule on a call (a rule failed): denied, since the gate fails closed. */
export const GATE_FAILED_MESSAGE = "Denied: the harness could not check this call against its rules, so it was not run. Continue without it and say what you could not do.";

/** A run as the gate rules under it: its ids, its workspace and its containment. */
export interface GatedRun {
  readonly runId: string;
  readonly sessionId: string;
  readonly workspace: string;
  readonly containment: RunContainment;
}

/** Containment's rule (#133), always the gate's first: a hard denial, asking nobody, recorded by `containment`. */
export const containmentRule: ToolGateRule = {
  decider: "containment",
  check: (call, run) => {
    const denial = containmentDenial(run.containment, run.workspace, call.access);
    return denial === null ? null : { decision: "deny", message: denial };
  },
};

export interface ToolGateOptions {
  readonly log: Pick<EventLog, "append" | "atomically" | "read">;
  /** The session's run live now, if any: a turn the provider opened on its own asks through the gate of the run it followed. */
  readonly liveRunOf: (sessionId: string) => GatedRun | undefined;
  /** The rules after containment's, in order (#132: the denylist's). Preset: none. */
  readonly rules?: readonly ToolGateRule[];
  /** How a rule asks the run's person: the broker, as a prompt of that run's (the host's). Preset: nobody can be asked, so the ask is denied. */
  readonly ask?: (run: GatedRun, kind: PromptKind, detail: PromptDetail, signal?: AbortSignal) => Promise<PromptDecision>;
}

const NOBODY_TO_ASK: PromptDecision = { decision: "deny", message: "Denied: nobody could be asked about this call. Continue without it and say what you could not do." };

/**
 * The gate each run is handed (`RunContext.gate`; the host's `gateFor`).
 * It rules under the session's run live when it is asked, else the run it
 * was handed to: containment's rule first, then the others in order. A deny
 * is final and the rules after it are not asked; an allow or null passes the
 * call on, past the last to the provider's own evaluation. A rule that
 * throws denies the call (the gate fails closed). A rule records nothing
 * itself: a denial it made without asking anyone is recorded as the call's
 * `tool.decision` by the rule's decider, through `recordToolDecision`
 * (#131), which records nothing for a call already decided, by the actor
 * `system:tool-gate`, when the gate rules, which may be before the
 * provider's report of the call reaches the log; a denial through `ask` is
 * the prompt's answer's to record (or, when a stop denied it in memory, the
 * prompt stays open, ADR 0007). A denial whose record cannot be appended is
 * still a denial. `signal` is the provider giving up on the call: an ask
 * then closes its prompt.
 */
export const createToolGate =
  (options: ToolGateOptions) =>
  (handedTo: GatedRun): ToolGate => ({
    check: async (call, signal) => {
      const gated = options.liveRunOf(handedTo.sessionId) ?? handedTo;
      // Whether the rule being asked put the call to a person: then the prompt's answer is the call's decision.
      let asked = false;
      const run: RuledRun = {
        ...gated,
        ask: (kind, detail, askSignal) => {
          asked = true;
          const cancel = askSignal ?? signal;
          return options.ask === undefined ? Promise.resolve(NOBODY_TO_ASK) : options.ask(gated, kind, detail, cancel);
        },
      };
      const record = (decider: ToolDecider, reason: string): void => {
        if (asked) return;
        const payload: ToolDecisionPayload = {
          runId: gated.runId,
          toolCallId: call.toolCallId,
          tool: call.tool,
          summary: summarise("permission", { toolName: call.tool, input: call.input ?? null, summary: call.summary }),
          decision: "denied",
          decidedBy: decider,
          promptId: null,
          reason,
        };
        try {
          options.log.atomically((tx) => recordToolDecision(options.log, tx, gated.sessionId, payload, { actor: GATE_ACTOR }));
        } catch (error) {
          console.error(`Recording the gate's denial of ${call.tool} (${call.toolCallId}) in run ${gated.runId} failed; it is denied all the same:`, error);
        }
      };
      for (const rule of [containmentRule, ...(options.rules ?? [])]) {
        asked = false;
        let ruling: GateDecision | null;
        try {
          ruling = await rule.check(call, run, signal);
        } catch (error) {
          console.error(`The tool gate could not rule on ${call.tool} (${call.toolCallId}) in run ${gated.runId}; it is denied:`, error);
          record(rule.decider, GATE_FAILED_MESSAGE);
          return { decision: "deny", message: GATE_FAILED_MESSAGE };
        }
        if (ruling?.decision === "deny") {
          record(rule.decider, ruling.message);
          return ruling;
        }
      }
      return { decision: "allow" };
    },
  });
