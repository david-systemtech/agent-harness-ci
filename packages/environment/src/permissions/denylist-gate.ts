import { join } from "node:path";
import {
  describeDenylistMatch,
  hostOf,
  hostToken,
  matchDenylist,
  shellSubjects,
  type Denylist,
  type DenylistCall,
  type DenylistMatch,
} from "@agent-harness/contracts";
import type { GatedToolCall, RunDenylist } from "../adapter/contract.js";
import type { ToolGateRule } from "../adapter/seams.js";
import { resolvePath } from "./gate.js";

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

/** How deep and how wide a tool's input is read for what it touches. */
const INPUT_DEPTH = 8;
const INPUT_STRINGS = 500;

/** A URL: a scheme and `//`, any `file:` address, or a special scheme with fewer slashes (`http:/2852039166`), as the matcher reads one. */
const URL_PREFIX = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|file:|(?:https?|wss?|ftp):)/i;

/**
 * What a call of kind `other` touches, read from its input (what the
 * harness's own tool servers receive): every string value that is a URL or
 * that `hostToken` reads as a host (`db.internal:5432`) is a host, and every
 * one that is an absolute or `~` path is a path. Only whole values are read,
 * so a note that mentions a path in its text is not taken for one. Past
 * `INPUT_DEPTH` levels or `INPUT_STRINGS` strings the rest is not read, and
 * the call goes on as far as the denylist is concerned: that is logged when
 * a string was left unread, or a container too deep to open was not empty
 * (a number, a flag or null names nothing, within the limits or past them).
 */
const inputSubjects = (call: GatedToolCall): DenylistCall => {
  const paths: string[] = [];
  const hosts: string[] = [];
  let strings = 0;
  let cut = false;
  const walk = (value: unknown, depth: number): void => {
    // Past the string limit, once a string was left unread, nothing more can be read or cut.
    if (cut && strings >= INPUT_STRINGS) return;
    if (typeof value === "string") {
      if (depth > INPUT_DEPTH || strings >= INPUT_STRINGS) {
        cut = true;
        return;
      }
      strings++;
      const text = value.trim();
      if (URL_PREFIX.test(text)) hosts.push(text);
      // `~`, `~/…`, and `~name` or `~name/…`, which the matcher reads as the home directory for the environment's own user.
      else if (/^~[^\s/]*(?:\/|$)/.test(text) || text.startsWith("/")) paths.push(text);
      else if (hostToken(text) !== null && !/\s/.test(text)) hosts.push(text);
    } else if (value !== null && typeof value === "object") {
      const items: readonly unknown[] = Array.isArray(value) ? value : Object.values(value);
      if (depth > INPUT_DEPTH) {
        if (items.length > 0) cut = true;
        return;
      }
      for (const item of items) walk(item, depth + 1);
    }
  };
  walk(call.input, 0);
  if (cut) {
    console.warn(
      `The denylist read ${call.tool} (${call.toolCallId})'s input only to ${INPUT_DEPTH} levels and ${INPUT_STRINGS} strings; the rest was not matched.`,
    );
  }
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
      return inputSubjects(call);
  }
};

/**
 * The call with each address's host as the platform's own URL parser reads
 * it beside it, where it parses and reads another host than the matcher's
 * (a soft hyphen, the rest of UTS 46's mapping): the host the connection
 * would reach is matched whichever reading is right.
 */
export const withUrlHosts = (call: DenylistCall): DenylistCall => {
  const widened = (values: readonly string[] | undefined): string[] | undefined => {
    if (values === undefined) return undefined;
    const out = [...values];
    for (const value of values) {
      let hostname: string;
      try {
        hostname = new URL(value).hostname;
      } catch {
        continue;
      }
      if (hostname !== "" && hostname !== hostOf(value)) out.push(hostname);
    }
    return out;
  };
  const browserDomains = widened(call.browserDomains);
  const hosts = widened(call.hosts);
  return { ...call, ...(browserDomains !== undefined && { browserDomains }), ...(hosts !== undefined && { hosts }) };
};

/** Where the environment's matcher reads paths from, beside the run's workspace. */
export interface DenylistContext {
  /** The denylist as it is now. */
  readonly denylist: () => Denylist;
  /** The home directory `~` stands for. */
  readonly home: string;
  /** The directories the data directory's preset leaves out: where runs work, the containment directories (#133) and the scratch workspaces (#140). */
  readonly exempt: readonly string[];
  /** Follows symbolic links, null where it cannot say; preset: the file system's (`resolvePath`, the walk containment's rule shares). */
  readonly resolve?: (path: string) => string | null;
  /** The user whose home `home` is: `~name/` reads as it too. */
  readonly user?: string;
  /** Whether paths compare without regard to case: preset, on macOS and Windows. */
  readonly caseInsensitive?: boolean;
  /** Which calls the denylist reads at all; preset: `denylistReadsCall`, every one. */
  readonly readsCall?: (call: GatedToolCall) => boolean;
}

/**
 * Which calls the denylist reads: every one, a client tool's included. A
 * client tool (`mcp__client__*`, the completions surface's passthrough,
 * #139) runs on the caller's machine, not the environment's, so whether its
 * arguments should meet this environment's denylist is David's open
 * question; until he answers, the safe default reads them like any other
 * call's (#140). The one seam an exemption would go in: a predicate here,
 * which the rule consults before it matches anything.
 */
export const denylistReadsCall: (call: GatedToolCall) => boolean = () => true;

/** Every entry a call matches, and the paths whose links could not be followed. */
export interface DenylistReading {
  readonly matches: DenylistMatch[];
  readonly unresolvable: string[];
}

/**
 * Every entry a call matches, read against `cwd` (the run's workspace):
 * each address also as the platform's URL parser reads it, and a path whose
 * links cannot be followed matched as written and reported.
 */
export const readDenylistCall = (context: DenylistContext, call: DenylistCall, cwd: string): DenylistReading => {
  const unresolvable: string[] = [];
  // The paths the matcher hands it are absolute already, so the base is never read.
  const resolve = context.resolve ?? ((path: string) => resolvePath(path, "/"));
  const matches = matchDenylist(context.denylist(), withUrlHosts(call), {
    home: context.home,
    cwd,
    exempt: context.exempt,
    user: context.user,
    caseInsensitive: context.caseInsensitive ?? (process.platform === "darwin" || process.platform === "win32"),
    resolve: (path) => {
      const resolved = resolve(path);
      if (resolved !== null) return resolved;
      unresolvable.push(path);
      return path;
    },
  });
  return { matches, unresolvable };
};

/**
 * The denylist as a provider projects it onto its own deny rules on an
 * unattended run (#140; permissions spec, "Provider deny rules where they
 * must apply"): the enabled paths, `~` read as the home directory, since a
 * provider's sandbox reads its paths with no home of the environment's; the
 * directories the matcher leaves out, which the sandbox reads again; and
 * the enabled command patterns as written.
 */
export const providerDenylist = (denylist: Denylist, context: Pick<DenylistContext, "home" | "exempt">): RunDenylist => {
  const absolute = (pattern: string): string => (pattern === "~" ? context.home : pattern.startsWith("~/") ? join(context.home, pattern.slice(2)) : pattern);
  return {
    paths: denylist.paths.filter((entry) => entry.enabled).map(({ pattern }) => absolute(pattern)),
    exempt: [...context.exempt],
    commandPatterns: denylist.commandPatterns.filter((entry) => entry.enabled).map(({ pattern }) => pattern),
  };
};

/** What the model reads when a person denies a denylisted call and gives no message of their own. */
export const denylistDenial = (reason: string): string => `Denied: ${reason}, and the person declined it. Continue without it and say what you could not do.`;

/** What the model reads when a path's links loop or change while they are read, so the denylist cannot be checked. */
export const unresolvableDenial = (path: string): string =>
  `Denied: ${path} is a symbolic link that loops or changed while it was read, so where it leads cannot be checked against the denylist. Continue without it and say what you could not do.`;

/**
 * The rule: a call the denylist does not read (`readsCall`) and one that
 * matches nothing pass on (`null`); a match asks the run's person through
 * the broker, and the answer is the ruling: an allow passes the call on to
 * the provider's own evaluation, a deny is final, with the person's message
 * or a sentence naming the entry, or the rule's own when no person could
 * answer. A path whose links cannot be followed denies the
 * call outright, asking nobody (the gate records it, by `denylist`). The
 * prompt is closed when the provider gives up on the call (`signal`).
 */
export const denylistRule = (context: DenylistContext): ToolGateRule => ({
  decider: "denylist",
  check: async (call, run, signal) => {
    if (!(context.readsCall ?? denylistReadsCall)(call)) return null;
    const { matches, unresolvable } = readDenylistCall(context, denylistCall(call), run.workspace);
    const [lost] = unresolvable;
    if (lost !== undefined) return { decision: "deny", message: unresolvableDenial(lost) };
    const [first] = matches;
    if (first === undefined) return null;
    const named = describeDenylistMatch(first);
    const reason = matches.length === 1 ? named : `${named}, and ${matches.length - 1} more`;
    const decision = await run.ask(
      "denylist",
      { toolName: call.tool, toolCallId: call.toolCallId, input: call.input ?? null, summary: `${call.tool}: ${named}`, reason, denylist: matches },
      signal,
    );
    if (decision.decision === "allow") return { decision: "allow" };
    return { decision: "deny", message: decision.message ?? denylistDenial(reason) };
  },
});
