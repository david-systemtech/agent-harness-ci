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
import type { Address } from "../serve/http.js";
import { UNTRANSLATED, runGit, type GitAnswer } from "../workspace/git.js";
import { credentialHelper, gitConfigVariables, helperChain, servedOrigins, servingAccount } from "./git-helper.js";
import { forgeAccountMissing } from "./missing-origins.js";
import type { RunSecrets } from "./run-secrets.js";

/**
 * The harness's own git on a forge (forge spec, "The helper and the
 * credential route" and "No forge account"; ADR 0020): a clone, a fetch or a
 * push for a bank checkout, a skill source or a new repository's first push.
 * git is given the canonical origin's URL, never a configured remote, and
 * never a prompt: `GIT_TERMINAL_PROMPT=0` and an empty `GIT_ASKPASS`, which
 * stops git asking an askpass the machine's configuration names.
 *
 * On an origin a forge account serves, process-only configuration resets
 * the machine's helper chain for each origin the forge account is served on
 * and names the credential helper, with a run-scoped secret minted for this
 * operation and void when it ends. On an origin none covers, the chain is
 * reset with no helper, so git reads anonymously; when the forge asks for a
 * credential all the same, the operation is refused `forge_account_missing`
 * and the origin is recorded as missing.
 */

/** How long a harness git operation may take before git is stopped (a chosen default): a clone of a large bank takes minutes. */
export const FORGE_GIT_TIMEOUT_MS = 5 * 60_000;

/** The most of git's standard output kept: these operations write their progress to standard error. */
const OUTPUT_BYTES = 1024 * 1024;

/** What git does: clone a repository into `directory` under the working directory, or fetch or push `refspecs` in the repository there. */
export type ForgeGitCommand =
  | { readonly operation: "clone"; readonly directory: string }
  | { readonly operation: "fetch" | "push"; readonly refspecs: readonly string[] };

export type ForgeGitRequest = ForgeGitCommand & {
  /** The repository, as any remote git takes (https, http, ssh, scp-like): only its origin and path are kept. */
  readonly repository: string;
  /** Where git runs: the directory a clone goes under, or the repository fetched into or pushed from. */
  readonly cwd: string;
  /** What the operation is for, in a few words (`clone a bank`): a missing origin's record names it. */
  readonly purpose: string;
  /** How long git may take; preset `FORGE_GIT_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
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
  /** The command line that runs `agent-harness` before its verb, which git names as its helper; undefined when the environment was given none. */
  readonly command: readonly string[] | undefined;
  /** The environment's loopback address, where the helper asks; undefined until the environment listens. */
  readonly address: () => Address | undefined;
  /** Records that `operation` was refused on `origin` for want of a forge account. */
  readonly originMissing: (origin: ForgeOrigin, operation: string) => void;
}

/** What git says, untranslated, when it wanted a credential and could neither ask a helper nor prompt. */
const PROMPT_REFUSED = /terminal prompts disabled/;

/** git's arguments for `command` against `url`, which `--` keeps from being read as an option. */
const argumentsOf = (command: ForgeGitCommand, url: string): string[] =>
  command.operation === "clone" ? ["clone", "--", url, command.directory] : [command.operation, "--", url, ...command.refspecs];

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
    const url = `${origin}/${remote.path}.git`;

    let entries = helperChain([origin], null);
    let helperVariables: Record<string, string> = {};
    let release = (): void => undefined;
    if (account !== null) {
      const address = options.address();
      if (options.command === undefined || address === undefined) throw new Error("The harness's git has no agent-harness command or address to name as git's credential helper.");
      const secret = options.secrets.mint([account.id], `git: ${request.purpose}`);
      release = secret.release;
      entries = helperChain(servedOrigins(account), credentialHelper(options.command, account.slug));
      helperVariables = { [ENVIRONMENT_ADDRESS_VARIABLE]: formatHostPort(address.host, address.port), [RUN_SECRET_VARIABLE]: secret.value };
    }

    let git: GitAnswer;
    try {
      git = await runGit(request.cwd, argumentsOf(request, url), {
        maxBytes: OUTPUT_BYTES,
        timeoutMs: request.timeoutMs ?? FORGE_GIT_TIMEOUT_MS,
        env: { ...UNTRANSLATED, ...gitConfigVariables(entries), ...helperVariables, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
      });
    } finally {
      release();
    }
    if (account === null && !git.ok && PROMPT_REFUSED.test(git.stderr)) {
      options.originMissing(origin, request.purpose);
      return { outcome: "refused", error: forgeAccountMissing(origin, "it asked for a credential") };
    }
    return { outcome: "ran", git };
  };
