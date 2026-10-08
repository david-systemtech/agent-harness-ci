import {
  ContractError,
  ENVIRONMENT_ADDRESS_VARIABLE,
  RUN_SECRET_VARIABLE,
  formatHostPort,
  invalidParams,
  normaliseRemote,
  type ForgeAccountMissingError,
  type ForgeAccountRecord,
  type ForgeOrigin,
} from "@agent-harness/contracts";
import type { ScrubRegistry } from "../scrub/registry.js";
import type { Address } from "../serve/http.js";
import { UNTRANSLATED, runGit, type GitAnswer } from "../workspace/git.js";
import { credentialHelper, gitConfigVariables, helperChain, servedOrigins, servingAccount, type GitConfigEntry } from "./git-helper.js";
import { forgeAccountMissing } from "./missing-origins.js";
import type { RunSecret, RunSecrets } from "./run-secrets.js";

/**
 * The harness's own git on a forge (forge spec, "The helper and the
 * credential route" and "No forge account"; ADR 0020): a clone, a fetch or a
 * push for a bank checkout, a skill source or a new repository's first push.
 * git is given the canonical origin's URL, never a configured remote, and
 * never a prompt: `GIT_TERMINAL_PROMPT=0` and an empty `GIT_ASKPASS`, which
 * stops git asking an askpass the machine's configuration names. A caller
 * may ask for an ssh or scp repository no forge account covers to be
 * reached over ssh as written instead, with the user's own keys and agent
 * and ssh in batch mode (`sshAsWritten`: a skill source's probe).
 *
 * On an origin a forge account serves, process-only configuration resets
 * the machine's helper chain for each origin the forge account is served on
 * and names the credential helper, with a run-scoped secret minted for this
 * operation and void when it ends. On an origin none covers, the chain is
 * reset with no helper, so git reads anonymously; when the forge asks for a
 * credential all the same, the operation is refused `forge_account_missing`
 * and the origin is recorded as missing; one it answers clears a missing
 * record naming the same operation (#1891).
 *
 * git's standard error, which it answers, passes the scrub registry's
 * `scrubOutput` while the operation's secret is still registered: registered
 * values, then shape rules (key-managers spec, "Where it applies").
 */

/** How long a harness git operation may take before git is stopped (a chosen default): a clone of a large bank takes minutes. */
export const FORGE_GIT_TIMEOUT_MS = 5 * 60_000;

/** The most of git's standard output kept: these operations write their progress to standard error. */
const OUTPUT_BYTES = 1024 * 1024;

/**
 * What git does: clone a repository into `directory` under the working
 * directory, of `depth` commits (all when absent) of `branch` (the remote's
 * default when absent), or fetch (of `depth` commits, all when absent) or
 * push `refspecs` in the repository there.
 */
export type ForgeGitCommand =
  | { readonly operation: "clone"; readonly directory: string; readonly depth?: number; readonly branch?: string }
  | { readonly operation: "fetch"; readonly refspecs: readonly string[]; readonly depth?: number }
  | { readonly operation: "push"; readonly refspecs: readonly string[] };

export type ForgeGitRequest = ForgeGitCommand & {
  /** The repository, as any remote git takes (https, http, ssh, scp-like): only its origin and path are kept. */
  readonly repository: string;
  /** Where git runs: the directory a clone goes under, or the repository fetched into or pushed from. */
  readonly cwd: string;
  /** What the operation is for, in a few words (`clone a bank`): a missing origin's record names it. */
  readonly purpose: string;
  /** How long git may take; preset `FORGE_GIT_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Stops git when it aborts: a skill source's sync the environment's close cuts. */
  readonly signal?: AbortSignal;
  /**
   * An ssh or scp repository on a host no forge account covers is reached
   * over ssh as written, with the user's own keys and agent, ssh in batch
   * mode so it never prompts (skills spec, the probe). Absent, such a
   * repository is read anonymously over https on its host.
   */
  readonly sshAsWritten?: boolean;
};

export type ForgeGitAnswer =
  /** git ran: what it answered, having succeeded or not. */
  | { readonly outcome: "ran"; readonly git: GitAnswer }
  /** The forge asked for a credential on an origin no forge account covers. */
  | { readonly outcome: "refused"; readonly error: ForgeAccountMissingError };

export interface HarnessGitOptions {
  /** The forge accounts the environment holds now. */
  readonly accounts: () => readonly ForgeAccountRecord[];
  readonly secrets: RunSecrets;
  /** A BankService operation's fallback grant, bound by its owner to this bank's origin alone. */
  readonly fallback?: { readonly slug: string; readonly mint: () => RunSecret };
  /** The scrub registry git's standard error passes before it is answered. */
  readonly scrub: Pick<ScrubRegistry, "scrubOutput">;
  /** The command line that runs `agent-harness` before its verb, which git names as its helper; undefined when the environment was given none. */
  readonly command: readonly string[] | undefined;
  /** The environment's loopback address, where the helper asks; undefined until the environment listens. */
  readonly address: () => Address | undefined;
  /** Records that `operation` was refused on `origin` for want of a forge account. */
  readonly originMissing: (origin: ForgeOrigin, operation: string) => void;
  /** Hears that `operation` ran on `origin` anonymously, which clears a missing record naming it. */
  readonly originAnswered: (origin: ForgeOrigin, operation: string) => void;
  /** Configuration every operation is given after its own: a test's `insteadOf`, which sends a forge's URL to a local repository. Preset none. */
  readonly config?: readonly GitConfigEntry[];
}

/** The ssh git runs for a repository reached over ssh: batch mode, so a passphrase, password or unknown host key fails rather than prompts. */
const BATCH_SSH_COMMAND = "ssh -o BatchMode=yes";

/** What git says, untranslated, when it wanted a credential and could neither ask a helper nor prompt. */
const PROMPT_REFUSED = /terminal prompts disabled/;

/** git's arguments for `command` against `url`, which `--` keeps from being read as an option. */
const argumentsOf = (command: ForgeGitCommand, url: string): string[] => {
  if (command.operation === "push") return ["push", "--", url, ...command.refspecs];
  const depth = command.depth === undefined ? [] : [`--depth=${command.depth}`];
  if (command.operation === "fetch") return ["fetch", ...depth, "--", url, ...command.refspecs];
  const branch = command.branch === undefined ? [] : [`--branch=${command.branch}`];
  return ["clone", ...depth, ...branch, "--", url, command.directory];
};

/** The harness's git operation on a forge, as the ForgeService offers it. */
export const createHarnessGit =
  (options: HarnessGitOptions) =>
  async (request: ForgeGitRequest): Promise<ForgeGitAnswer> => {
    const remote = normaliseRemote(request.repository);
    if (remote === null || remote.path === null) {
      const message = "The repository names no repository on a forge: give its https, http, ssh or scp-like URL.";
      throw new ContractError(invalidParams([{ code: "custom", path: ["repository"], message }], message));
    }
    const account = servingAccount(remote, options.accounts());
    const origin = account?.origin ?? remote.origin;
    const overSsh = account === null && remote.sshDerived && request.sshAsWritten === true;
    const url = overSsh ? request.repository.trim() : `${origin}/${remote.path}.git`;

    let entries = helperChain([origin], null);
    let helperVariables: Record<string, string> = {};
    let release = (): void => undefined;
    if (account !== null || options.fallback !== undefined) {
      const address = options.address();
      if (options.command === undefined || address === undefined) throw new Error("The harness's git has no agent-harness command or address to name as git's credential helper.");
      const secret = account === null ? options.fallback!.mint() : options.secrets.mint([account.id], `git: ${request.purpose}`);
      release = secret.release;
      entries = helperChain(account === null ? [origin] : servedOrigins(account), credentialHelper(options.command, account?.slug ?? options.fallback!.slug));
      helperVariables = { [ENVIRONMENT_ADDRESS_VARIABLE]: formatHostPort(address.host, address.port), [RUN_SECRET_VARIABLE]: secret.value };
    }

    let git: GitAnswer;
    try {
      const ran = await runGit(request.cwd, argumentsOf(request, url), {
        maxBytes: OUTPUT_BYTES,
        timeoutMs: request.timeoutMs ?? FORGE_GIT_TIMEOUT_MS,
        ...(request.signal !== undefined && { signal: request.signal }),
        env: {
          ...UNTRANSLATED,
          ...gitConfigVariables([...entries, ...(options.config ?? [])]),
          ...helperVariables,
          ...(overSsh && { GIT_SSH_COMMAND: BATCH_SSH_COMMAND }),
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
        },
      });
      git = { ...ran, stderr: options.scrub.scrubOutput(ran.stderr) };
    } finally {
      release();
    }
    if (account === null && options.fallback === undefined) {
      if (git.ok) options.originAnswered(origin, request.purpose);
      else if (PROMPT_REFUSED.test(git.stderr)) {
        options.originMissing(origin, request.purpose);
        return { outcome: "refused", error: forgeAccountMissing(origin, "it asked for a credential") };
      }
    }
    return { outcome: "ran", git };
  };
