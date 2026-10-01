import { randomUUID } from "node:crypto";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ContractError,
  READINESS_OVERLAY,
  invalidParams,
  normaliseRemote,
  overlayDeclaration,
  referenceLocator,
  type ForgeAccountRecord,
  type ParamsOf,
  type ReadinessCheck,
  type ReadinessCheckOf,
  type ReadinessDeclaration,
  type ReadinessDeclarer,
  type ReadinessFailure,
  type ReadinessOverlay,
  type ResultOf,
  type SkillReadiness,
} from "@agent-harness/contracts";
import type { InstructionTarget } from "../adapter/host.js";
import { noToolServers, type InstructionScope, type SkillSetScope, type ToolServerFactory } from "../adapter/seams.js";
import type { HostEnvironment } from "../adapters/claude/credentials.js";
import { servingAccount } from "../forge/git-helper.js";
import { noKeyManagerConnections, type KeyManagerRegistry } from "../key-managers/registry.js";
import { findOnPath } from "../managed-tools/detection.js";
import type { AccountFacts } from "../runs/run-decider.js";
import type { Clock } from "../serve/clock.js";
import type { MethodHandlers } from "../serve/methods.js";
import { runGit, type GitAnswer, type GitOptions } from "../workspace/git.js";
import { identityRemote } from "../workspace/identity.js";
import { isInside } from "../workspace/paths.js";
import { fingerprintOf, type PlacedMember, type PlacedSet } from "./generations.js";
import { readSidecar } from "./sidecar.js";

/**
 * Readiness (skills spec, "Readiness"; ADR 0009): `skills.readiness`
 * checks each member of the set a run would have against what it declares:
 * its sidecar, which wins whole, else the overlay's entry for its origin.
 * The five local kinds run on the environment in the workspace, paths from
 * the repository's root, else the workspace: `file`, `tool` (on the PATH a
 * run gets), `git` (`repository`, `merge-in-progress`, `changes-since`),
 * `skill` (in the account's set, on and, unless the check says otherwise,
 * one the model may invoke) and `provider` (the account's provider, or a
 * capability its adapter declares). Three ask something beyond the file
 * system (#511): `secret` resolves its reference through the key-manager
 * registry in process, never asking anyone for the value, and lets the
 * value go as soon as it is answered; `mcp` asks the tool-server factory for
 * the session's next run, or a new session's of the account and workspace;
 * git `forge-account` looks among the ForgeService's forge accounts for one
 * serving the repository's remote on its origin or a verified alias.
 *
 * Each check gets five seconds and the call ten, from when it is asked; a
 * check still running then fails as could not be checked in time. A
 * member's answer is kept sixty seconds per workspace, account and set
 * fingerprint, unless `refresh`; one with a check that ran out is not
 * kept, so the next read checks again. Readiness is advisory: nothing here
 * blocks an invocation or changes the set. All git goes through the
 * hardened runner, and reads refs and paths only: nothing is diffed, so no
 * filter or textconv the repository names runs.
 */

/** How long one check may take (a chosen default). */
export const READINESS_CHECK_BUDGET_MS = 5_000;
/** How long a whole `skills.readiness` call may take, from when it is asked (a chosen default). */
export const READINESS_CALL_BUDGET_MS = 10_000;
/** How long a member's answer is kept for its workspace, account and fingerprint (a chosen default). */
export const READINESS_CACHE_MS = 60_000;

/** The most of a file a `file` check reads for its headings. */
const MAX_FILE_BYTES = 1024 * 1024;
/** The most of a git answer read: a ref, a path, a line or two. */
const GIT_BYTES = 64 * 1024;

/** What a readiness read is checked under: the session (null for a new one), the account, the workspace and the trust. */
export type ReadinessScope = Pick<InstructionScope, "sessionId" | "accountId" | "workspace" | "trust">;

/** Git as the checks run it: the hardened runner's signature. */
export type ReadinessGit = (cwd: string, args: readonly string[], options: GitOptions) => Promise<GitAnswer>;

export interface SkillReadinessOptions {
  /** The scope a session's next run, or a new session's first, would have, refused as `instructions.preview` refuses it: the host's `previewScope`. */
  readonly scopeOf: (target: InstructionTarget) => Promise<ReadinessScope>;
  /** An account's adapter descriptor; null for one the environment does not hold. */
  readonly account: (id: string) => Pick<AccountFacts, "descriptor"> | null;
  /** The set placed for a scope (`run-skill-set.ts`): its members with where their files lie. */
  readonly place: (scope: SkillSetScope) => Promise<PlacedSet>;
  /** The environment a run starts from, whose PATH a `tool` check looks on. */
  readonly hostEnv: HostEnvironment;
  readonly clock: Clock;
  /** The key-manager registry's resolve seam a `secret` check reads its reference through (#312); preset: no key-manager connection, so every reference is unavailable. */
  readonly keyManagers?: KeyManagerRegistry;
  /** The ForgeService's forge accounts, which a git `forge-account` check looks for one serving the repository's remote among; preset: none. */
  readonly forgeAccounts?: () => readonly ForgeAccountRecord[];
  /**
   * The tool-server factory a run's servers come from, an `mcp` check's: the environment's own and the seam's, less a
   * completions request's client tools, which are that request's own. Preset: none.
   */
  readonly toolServers?: ToolServerFactory;
  /** Preset: the overlay the contracts ship. */
  readonly overlay?: ReadinessOverlay;
  /** Preset: the hardened runner. */
  readonly git?: ReadinessGit;
  /** Preset: this process's. */
  readonly platform?: NodeJS.Platform;
}

export interface SkillReadinessService {
  read(params: ParamsOf<"skills.readiness">): Promise<ResultOf<"skills.readiness">>;
}

/** Who holds a `secret` check's value for the moment it is held, as the scrub registry names owners. */
const READINESS_OWNER = "skills:readiness";

/** A check that failed, before it is paired with the check. */
type Failure = Pick<ReadinessFailure, "outcome" | "message">;

/** A check's outcome: null when it holds. */
type Outcome = Failure | null;

const failed = (message: string): Failure => ({ outcome: "failed", message });

const TIMED_OUT: Failure = { outcome: "timed-out", message: "It could not be checked in time." };

/** What a member declares, and where. */
interface Declared {
  readonly declaredBy: ReadinessDeclarer;
  readonly declaration: ReadinessDeclaration;
}

/** A list for people: `a`, `a or b`, `a, b or c`. */
const either = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1) ?? ""}`);

/** What git printed, less the newline that ends it. */
const printed = (answer: GitAnswer): string => answer.stdout.toString("utf8").replace(/\r?\n$/, "");

/** A ref as people read it: a branch without `refs/heads/`, a remote's without `refs/remotes/`. */
const shortRef = (ref: string): string => ref.replace(/^refs\/(?:heads|remotes)\//, "");

/** The text of an ATX heading line, or null for a line that is none. */
const headingOf = (line: string): { readonly level: number; readonly text: string } | null => {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(line);
  if (match === null) return null;
  const text = (match[2] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/, "");
  return { level: match[1]?.length ?? 1, text };
};

/** A heading's text as it is matched: white space collapsed, ignoring case. */
const headingKey = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The headings of a Markdown text that have content under them: a line
 * that is not blank and not itself a heading, before the next heading of
 * their level or above, so a subsection's lines are its parents' content
 * too. A `#` line inside a fenced code block is content, not a heading.
 */
const headingsWithContent = (text: string): ReadonlySet<string> => {
  const withContent = new Set<string>();
  // The headings whose sections the line lies in, outermost first.
  const open: { readonly level: number; readonly key: string }[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const heading = fence === null && marker === undefined ? headingOf(line) : null;
    if (heading !== null) {
      while ((open.at(-1)?.level ?? 0) >= heading.level) open.pop();
      open.push({ level: heading.level, key: headingKey(heading.text) });
      continue;
    }
    if (fence === null) fence = marker ?? null;
    else if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
    if (line.trim() !== "") for (const { key } of open) withContent.add(key);
  }
  return withContent;
};

/** Reads up to `MAX_FILE_BYTES` of the regular file at `path`; null when it is no file. */
const readText = async (path: string): Promise<string | null> => {
  // A file only: opening a pipe would wait for a writer.
  if (!(await stat(path)).isFile()) return null;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_FILE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
};

/** Whether anything is at `path`. */
const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

/** Where the workspace lies in git: in a repository at its root, in none, or on an environment with no git. */
type Repository = { readonly kind: "repository"; readonly root: string } | { readonly kind: "none" } | { readonly kind: "no-git" } | { readonly kind: "failed"; readonly message: string };

/** Makes `make`'s answer once, for the one call's checks to share. */
const once = <T>(make: () => Promise<T>): (() => Promise<T>) => {
  let made: Promise<T> | undefined;
  return () => (made ??= make());
};

/** As `once`, per key. */
const perKey = <T>(make: (key: string) => Promise<T>): ((key: string) => Promise<T>) => {
  const made = new Map<string, Promise<T>>();
  return (key) => {
    const value = made.get(key) ?? make(key);
    made.set(key, value);
    return value;
  };
};

export const createSkillReadiness = (options: SkillReadinessOptions): SkillReadinessService => {
  const { clock } = options;
  const overlay = options.overlay ?? READINESS_OVERLAY;
  const git = options.git ?? runGit;
  const platform = options.platform ?? process.platform;
  const keyManagers = options.keyManagers ?? noKeyManagerConnections;
  const toolServers = options.toolServers ?? noToolServers;
  const forgeAccounts = options.forgeAccounts ?? (() => []);
  const pathValue = options.hostEnv["PATH"] ?? options.hostEnv["Path"] ?? "";

  /** Answers kept per workspace, account and fingerprint: each member's, with when it was checked. */
  const kept = new Map<string, Map<string, { readonly at: number; readonly readiness: SkillReadiness }>>();

  /** Drops every answer older than the cache's sixty seconds, and each key left with none. */
  const prune = (now: number): void => {
    for (const [key, answers] of kept) {
      for (const [name, answer] of answers) if (now - answer.at >= READINESS_CACHE_MS) answers.delete(name);
      if (answers.size === 0) kept.delete(key);
    }
  };

  /** What `member` declares: its sidecar, which wins whole, else the overlay's entry for its origin; null for nothing. */
  const declarationOf = async (member: PlacedMember): Promise<Declared | null> => {
    if (member.kind === "skill") {
      const sidecar = await readSidecar(member.target);
      if (sidecar.kind === "declared") return { declaredBy: "sidecar", declaration: sidecar.declaration };
    }
    const declaration = overlayDeclaration(overlay, member.origin);
    return declaration === null ? null : { declaredBy: "overlay", declaration };
  };

  /** One call's checks: what they share is asked once, and each is bounded by its budget and the call's. */
  const evaluation = (scope: ReadinessScope, set: PlacedSet, descriptor: AccountFacts["descriptor"], callEndsAt: number) => {
    const workspace = scope.workspace.path;
    const gitIn = (args: readonly string[]): Promise<GitAnswer> => git(workspace, args, { maxBytes: GIT_BYTES, timeoutMs: READINESS_CHECK_BUDGET_MS });

    const repository = once(async (): Promise<Repository> => {
      const answer = await gitIn(["rev-parse", "--show-toplevel"]);
      if (answer.missing) return { kind: "no-git" };
      if (answer.timedOut) return { kind: "failed", message: "git did not answer in time." };
      return answer.ok ? { kind: "repository", root: printed(answer) } : { kind: "none" };
    });

    /** The folder paths are read from, as people read it: the repository's root, else the workspace. */
    const base = async (): Promise<{ readonly path: string; readonly where: string }> => {
      const found = await repository();
      return found.kind === "repository" ? { path: found.root, where: "the repository" } : { path: workspace, where: "the workspace" };
    };

    /** The repository's root, or why a git check cannot run. */
    const inRepository = async (): Promise<{ readonly root: string } | Failure> => {
      const found = await repository();
      if (found.kind === "repository") return { root: found.root };
      if (found.kind === "no-git") return failed("git is not installed on this environment.");
      if (found.kind === "failed") return failed(found.message);
      return failed("The workspace is not in a git repository.");
    };

    const file = async (check: ReadinessCheckOf<"file">): Promise<Outcome> => {
      const { path: root, where } = await base();
      let tree: string;
      try {
        tree = await realpath(root);
      } catch {
        return failed(`The workspace, ${workspace}, is not there.`);
      }
      const wanted = (check.headings ?? []).map(headingKey);
      for (const path of check.paths) {
        let found: string;
        try {
          found = await realpath(join(root, ...path.split("/")));
        } catch {
          continue;
        }
        if (!isInside(tree, found)) continue;
        if (wanted.length === 0) return null;
        const text = await readText(found).catch(() => null);
        if (text === null) continue;
        const headings = headingsWithContent(text);
        if (wanted.every((heading) => headings.has(heading))) return null;
      }
      if (check.headings === undefined) return failed(check.paths.length === 1 ? `${either(check.paths)} is not in ${where}.` : `None of ${either(check.paths)} is in ${where}.`);
      const named = check.headings.map((heading) => JSON.stringify(heading)).join(", ");
      return failed(`No ${either(check.paths)} in ${where} holds ${check.headings.length === 1 ? "the heading" : "the headings"} ${named} with content under it.`);
    };

    const tool = async (check: ReadinessCheckOf<"tool">): Promise<Outcome> =>
      findOnPath(check.command, pathValue, { platform, ownResources: [] }) === null ? failed(`${check.command} is not on the PATH a run on this environment gets.`) : null;

    /** The default branch: origin's HEAD as git last cached it, else main, else master; null for none. */
    const defaultBranch = once(async (): Promise<string | null> => {
      const origin = await gitIn(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
      if (origin.ok) return printed(origin);
      for (const branch of ["refs/heads/main", "refs/heads/master"]) if ((await gitIn(["rev-parse", "--verify", "--quiet", branch])).ok) return branch;
      return null;
    });

    /** A commit `spec` names, or null. */
    const commitOf = async (spec: string): Promise<string | null> => {
      const answer = await gitIn(["rev-parse", "--verify", "--quiet", `${spec}^{commit}`]);
      return answer.ok ? printed(answer) : null;
    };

    const changesSince = perKey(async (ref: string): Promise<Outcome> => {
      const named = ref === "" ? await defaultBranch() : ref;
      if (named === null) return failed("The repository has no default branch to compare with: origin's HEAD is not known, and there is no main or master.");
      const shown = shortRef(named);
      const [fixed, head] = await Promise.all([commitOf(named), commitOf("HEAD")]);
      if (fixed === null) return failed(`${shown} does not name a commit in the repository.`);
      if (head === null) return failed("The repository has no commit yet.");
      const base = await gitIn(["merge-base", fixed, head]);
      if (!base.ok) return failed(`HEAD shares no history with ${shown}.`);
      const trees = await gitIn(["rev-parse", `${printed(base)}^{tree}`, `${head}^{tree}`]);
      if (!trees.ok) return failed(`git could not read the trees of HEAD and its merge base with ${shown}.`);
      const [baseTree, headTree] = printed(trees).split(/\r?\n/);
      return baseTree === headTree ? failed(`HEAD holds no changes since its merge base with ${shown}.`) : null;
    });

    const mergeInProgress = once(async (): Promise<Outcome> => {
      const answer = await gitIn(["rev-parse", "--git-path", "MERGE_HEAD", "--git-path", "rebase-merge", "--git-path", "rebase-apply"]);
      if (!answer.ok) return failed("git could not say where the repository keeps its state.");
      for (const path of printed(answer).split(/\r?\n/)) if (path !== "" && (await exists(resolve(workspace, path)))) return null;
      return failed("No merge or rebase is in progress in the repository.");
    });

    /**
     * Whether a forge account here serves the repository's remote, the one its identity comes from, on its canonical
     * origin or a verified alias (ADR 0012, ADR 0020). The remote's URL is never shown: it can hold a token.
     */
    const forgeAccount = once(async (): Promise<Outcome> => {
      const answer = await gitIn(["remote", "--verbose"]);
      if (!answer.ok || answer.truncated) return failed("git could not list the repository's remotes.");
      const url = identityRemote(answer.stdout.toString("utf8"));
      if (url === undefined) return failed("The repository has no remote, so no forge account serves it.");
      const remote = normaliseRemote(url);
      if (remote === null) return failed("The repository's remote is a local path or a URL that names no forge.");
      return servingAccount(remote, forgeAccounts()) === null ? failed(`No forge account on this environment serves ${remote.origin}, where the repository's remote is.`) : null;
    });

    const gitCheck = async (check: ReadinessCheckOf<"git">): Promise<Outcome> => {
      const where = await inRepository();
      if (!("root" in where)) return where;
      if (check.condition === "repository") return null;
      if (check.condition === "forge-account") return forgeAccount();
      if (check.condition === "merge-in-progress") return mergeInProgress();
      return changesSince(check.ref ?? "");
    };

    const skill = async (check: ReadinessCheckOf<"skill">): Promise<Outcome> => {
      const member = set.members.find((candidate) => candidate.name === check.name);
      if (member === undefined) return failed(`No skill named ${check.name} is in this account's set, or it is switched off.`);
      if (check.modelInvocable !== false && member.invocation !== "model+slash") return failed(`${check.name} is slash-only: the model cannot call it.`);
      return null;
    };

    /** Resolves the reference in process, never asking anyone for its value, and lets the value go as soon as it is answered. */
    const secret = async (check: ReadinessCheckOf<"secret">): Promise<Outcome> => {
      const answer = await keyManagers.resolve({ reference: check.reference, owner: READINESS_OWNER, purpose: "readiness check" });
      if (answer.outcome === "resolved") {
        answer.release();
        return null;
      }
      return failed(`The key-manager reference ${referenceLocator(check.reference)} does not resolve (${answer.code}): ${answer.message}`);
    };

    /**
     * The names of the servers the factory gives the session's next run, or a new session's first under an id of its
     * own: a fresh run with no client tools and no browser resolved, as the browser server has one name whichever
     * browser it drives. Asked once for the call's checks; nothing is started or recorded.
     */
    const serverNames = once(async (): Promise<ReadonlySet<string>> => {
      const servers = toolServers({
        sessionId: scope.sessionId ?? randomUUID(),
        runId: randomUUID(),
        accountId: scope.accountId,
        workspace: scope.workspace,
        clientTools: [],
        browser: { kind: "none" },
      });
      return new Set(servers.map((server) => server.name));
    });

    const mcp = async (check: ReadinessCheckOf<"mcp">): Promise<Outcome> => {
      if ((await serverNames()).has(check.server)) return null;
      const run = scope.sessionId === null ? "A new session of this account in this workspace" : "The session's next run";
      return failed(`${run} is given no tool server named ${check.server}.`);
    };

    const provider = async (check: ReadinessCheckOf<"provider">): Promise<Outcome> => {
      if (check.providers?.includes(descriptor.provider) === true) return null;
      if (check.capability !== undefined && descriptor[check.capability] === true) return null;
      const reasons = [
        ...(check.providers === undefined ? [] : [`this account's provider, ${descriptor.provider}, is not ${either(check.providers)}`]),
        ...(check.capability === undefined ? [] : [`its adapter does not declare ${check.capability}`]),
      ];
      const sentence = reasons.join(", and ");
      return failed(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`);
    };

    const run = (check: ReadinessCheck): Promise<Outcome> => {
      switch (check.kind) {
        case "file":
          return file(check);
        case "tool":
          return tool(check);
        case "git":
          return gitCheck(check);
        case "skill":
          return skill(check);
        case "provider":
          return provider(check);
        case "secret":
          return secret(check);
        case "mcp":
          return mcp(check);
      }
    };

    /** Runs `check` within its five seconds and what is left of the call's ten; one that runs out has timed out. */
    const bounded = (check: ReadinessCheck): Promise<Outcome> => {
      const budget = Math.max(0, Math.min(READINESS_CHECK_BUDGET_MS, callEndsAt - clock.now().getTime()));
      return new Promise((settle) => {
        const timer = clock.setTimeout(() => settle(TIMED_OUT), budget);
        run(check).then(
          (outcome) => {
            timer.cancel();
            settle(outcome);
          },
          (error: unknown) => {
            timer.cancel();
            settle(failed(`It could not be checked: ${error instanceof Error ? error.message : String(error)}`));
          },
        );
      });
    };

    /** A member's readiness: ready, setup-needed with every failing check, or unsupported when a provider check fails. */
    return async (member: PlacedMember): Promise<SkillReadiness> => {
      const declared = await declarationOf(member);
      if (declared === null) return { name: member.name, state: "ready", declaredBy: null };
      const { declaredBy, declaration } = declared;
      const outcomes = await Promise.all(declaration.checks.map(bounded));
      const failing = declaration.checks.flatMap((check, index): ReadinessFailure[] => {
        const outcome = outcomes[index];
        return outcome === null || outcome === undefined ? [] : [{ check, ...outcome }];
      });
      if (failing.length === 0) return { name: member.name, state: "ready", declaredBy };
      const [first] = failing.filter((failure) => failure.check.kind === "provider");
      const shown = (first ?? failing[0]) as ReadinessFailure;
      return { name: member.name, state: first === undefined ? "setup-needed" : "unsupported", declaredBy, failing, why: shown.check.why ?? null, fix: shown.check.fix ?? null };
    };
  };

  return {
    async read({ sessionId, accountId, workspace, names, refresh }) {
      const callEndsAt = clock.now().getTime() + READINESS_CALL_BUDGET_MS;
      // The params' schema takes a session, or an account and a workspace, never both.
      const target: InstructionTarget | undefined =
        sessionId !== undefined ? { sessionId } : accountId !== undefined && workspace !== undefined ? { accountId, workspace } : undefined;
      if (target === undefined) {
        const message = "Name a session, or an account and a workspace.";
        throw new ContractError(invalidParams([{ code: "custom", path: [], message }], message));
      }
      const scope = await options.scopeOf(target);
      const facts = options.account(scope.accountId);
      if (facts === null) throw new ContractError({ code: "not_found", message: `No account ${scope.accountId} is on this environment.`, data: { kind: "account", accountId: scope.accountId } });
      const set = await options.place({ ...scope, nativeRoots: facts.descriptor.nativeSkillRoots });
      const key = JSON.stringify([scope.workspace.path, scope.accountId, fingerprintOf(set)]);
      prune(clock.now().getTime());
      const answers = kept.get(key) ?? new Map<string, { readonly at: number; readonly readiness: SkillReadiness }>();
      const check = evaluation(scope, set, facts.descriptor, callEndsAt);
      const wanted = names === undefined ? set.members : set.members.filter((member) => names.includes(member.name));
      const skills = await Promise.all(
        wanted.map(async (member) => {
          const held = answers.get(member.name);
          if (held !== undefined && refresh !== true) return held.readiness;
          const at = clock.now().getTime();
          const readiness = await check(member);
          // An answer with a check that ran out is not kept: the next read checks again.
          if (readiness.state === "ready" || readiness.failing.every((failure) => failure.outcome !== "timed-out")) answers.set(member.name, { at, readiness });
          else answers.delete(member.name);
          return readiness;
        }),
      );
      if (answers.size > 0) kept.set(key, answers);
      return { skills };
    },
  };
};

/** `skills.readiness` (`read`). */
export const skillReadinessMethods = (options: SkillReadinessOptions): MethodHandlers => {
  const readiness = createSkillReadiness(options);
  return { "skills.readiness": (params) => readiness.read(params) };
};
