import { lstatSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, parse, sep } from "node:path";
import {
  describeDenylistMatch,
  matchDenylist,
  shellSubjects,
  type Denylist,
  type DenylistCall,
  type DenylistMatch,
  type JsonObject,
} from "@agent-harness/contracts";
import type { GatedToolCall } from "../adapter/contract.js";
import type { ToolGateRule } from "../adapter/seams.js";

/**
 * The tool gate's denylist rule (#132; permissions spec, "The denylist",
 * "Enforcement in every mode, bypass included"; ADR 0006): every tool call
 * an adapter asks the gate about is read into what it touches, matched
 * against the denylist as it is when the call is made, and a match is handed
 * to the broker as a `denylist` prompt naming the section and entry. The
 * broker records it whatever happens next: on an attended run it parks for
 * the person, in every mode, bypass included, and their explicit allow lets
 * that one call on to the provider's own evaluation (the next identical
 * call asks again); on an unattended run the broker's rule denies it at
 * once, and past its TTL the sweeper does, each recorded as an opened and
 * answered pair and as the call's `tool.decision` by `denylist`. No mode,
 * rule or classifier answers a denylist prompt: only a person allows.
 */

/** Links followed in one path before it counts as a loop, as Linux's own limit. */
const MAX_LINKS = 40;

const componentsOf = (path: string): string[] => path.split(sep === "\\" ? /[\\/]/ : "/").filter((part) => part !== "");

/**
 * An absolute path as the file system resolves it: one component at a
 * time, each symbolic link followed where it stands, before any `..` after
 * it is applied, a link whose target is not there read with `readlink`, a
 * component that is not there taken as written. A loop of links answers the
 * path as given, which the matcher still reads as written.
 */
export const resolveLinks = (path: string): string => {
  const { root } = parse(path);
  const pending = componentsOf(path.slice(root.length));
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
    if (++links > MAX_LINKS) return path;
    const target = readlinkSync(next);
    if (isAbsolute(target)) current = parse(target).root;
    pending.unshift(...componentsOf(isAbsolute(target) ? target.slice(parse(target).root.length) : target));
  }
  return current;
};

/** How deep and how wide a tool's input is read for what it touches. */
const INPUT_DEPTH = 8;
const INPUT_STRINGS = 500;

const URL_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * What a call of kind `other` touches, read from its input (what the
 * harness's own tool servers receive): every string value that is a URL is
 * a host, and every one that is an absolute or `~` path is a path. Only
 * whole values are read, so a note that mentions a path in its text is not
 * taken for one.
 */
const inputSubjects = (input: JsonObject | undefined): DenylistCall => {
  const paths: string[] = [];
  const hosts: string[] = [];
  let strings = 0;
  const walk = (value: unknown, depth: number): void => {
    if (depth > INPUT_DEPTH || strings >= INPUT_STRINGS) return;
    if (typeof value === "string") {
      strings++;
      const text = value.trim();
      if (URL_PREFIX.test(text)) hosts.push(text);
      else if (text === "~" || text.startsWith("~/") || text.startsWith("/")) paths.push(text);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
    } else if (value !== null && typeof value === "object") {
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };
  walk(input, 0);
  return { paths, hosts };
};

/**
 * What a gated call touches, as the matcher reads it: the paths of a read or
 * a write; a shell command's whole line (its path-like tokens, URLs and hosts
 * the matcher reads from it); every URL of a fetch; a search's domains and
 * any URL in its query; a browser verb's addresses; and what a call of any
 * other kind was given.
 */
export const denylistCall = (call: GatedToolCall): DenylistCall => {
  const { access } = call;
  switch (access.kind) {
    case "read":
    case "write":
      return { paths: [...access.paths] };
    case "shell":
      return { commands: [access.command] };
    case "fetch":
      return { hosts: [...access.urls] };
    case "search":
      return { hosts: [...(access.domains ?? []), ...shellSubjects(access.query).urls] };
    case "browse":
      return { browserDomains: [...access.urls] };
    case "other":
      return inputSubjects(call.input);
  }
};

/** Where the environment's matcher reads paths from, beside the run's workspace. */
export interface DenylistContext {
  /** The denylist as it is now. */
  readonly denylist: () => Denylist;
  /** The home directory `~` stands for. */
  readonly home: string;
  /** The directories the data directory's preset leaves out: the containment directories the runs write in (#133). */
  readonly exempt: readonly string[];
  /** Follows symbolic links; preset: the file system's (`resolveLinks`). */
  readonly resolve?: (path: string) => string;
}

/** Every entry a call matches, read against `cwd` (the run's workspace). */
export const denylistMatches = (context: DenylistContext, call: DenylistCall, cwd: string): DenylistMatch[] =>
  matchDenylist(context.denylist(), call, { home: context.home, cwd, exempt: context.exempt, resolve: context.resolve ?? resolveLinks });

/** What the model reads when a person denies a denylisted call and gives no message of their own. */
export const denylistDenial = (reason: string): string => `Denied: ${reason}, and the person declined it. Continue without it and say what you could not do.`;

/**
 * The rule: no match passes the call on (`null`); a match asks the run's
 * person through the broker, and the answer is the ruling: an allow passes
 * the call on to the provider's own evaluation, a deny is final, with the
 * person's message or a sentence naming the entry, or the rule's own when no
 * person could answer.
 */
export const denylistRule =
  (context: DenylistContext): ToolGateRule =>
  async (call, run) => {
    const matches = denylistMatches(context, denylistCall(call), run.workspace);
    const [first] = matches;
    if (first === undefined) return null;
    const named = describeDenylistMatch(first);
    const reason = matches.length === 1 ? named : `${named}, and ${matches.length - 1} more`;
    const decision = await run.ask("denylist", {
      toolName: call.tool,
      toolCallId: call.toolCallId,
      input: call.input ?? null,
      summary: `${call.tool}: ${named}`,
      reason,
      denylist: matches,
    });
    if (decision.decision === "allow") return { decision: "allow" };
    return { decision: "deny", message: decision.message ?? denylistDenial(reason) };
  };
