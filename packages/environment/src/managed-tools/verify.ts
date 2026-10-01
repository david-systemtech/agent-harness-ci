import {
  managedTool,
  type KeyManagerConnectionRecord,
  type KeyManagerProvider,
  type ManagedToolVerification,
  type VerifiableToolName,
} from "@agent-harness/contracts";
import type { InjectionDecision, ProcessEnvironmentScope, ProcessEnvironments } from "../adapter/process-environment.js";
import { parseGhAuthStatus } from "../forge/gh.js";
import { bwsArgs } from "../key-managers/bitwarden-block.js";
import { PROVIDER_NAMES } from "../key-managers/provider.js";
import type { ScrubRegistry } from "../scrub/registry.js";
import type { Clock } from "../serve/clock.js";
import type { ManagedTools } from "./registry.js";
import { runCommand, type CommandAnswer } from "./run.js";

/**
 * Verify commands (key-managers spec, "Managed tools"; ADR 0011, ADR 0026,
 * ADR 0028; #375): a CLI that is present is proved to work by running its
 * declared verify command where its row found it.
 *
 * - **A holder like any other** (#368): the command runs in the registry's
 *   command environment with the process environment's variables laid over
 *   it, the key managers' block among them with a run token minted for it,
 *   released (the token revoked) once the command has exited. It serves no
 *   session, account or run, so the injection setting, which decides what
 *   runs and their terminals are given, never denies it: it is the harness
 *   proving the CLI with what runs would get.
 * - **Nothing runs** for a tool its row finds not installed (`not-installed`)
 *   or, for a key-manager CLI, while no connection of its provider injects
 *   (`failed`, saying so).
 * - **`bao` and `vault`** run `token lookup` against the injecting OpenBao
 *   connection; a failure is followed by `status`, whose exit 2 is sealed
 *   and 1 unreachable, and any other answer leaves the lookup's own error.
 *   `gh` runs `gh auth status`. The Doppler, 1Password and Bitwarden
 *   commands run the same way, their providers' blocks joining with #377 to
 *   #379; `bws` is given the block's configuration file as `--config-file`,
 *   which it reads from no variable below 0.5.0 (#1123).
 * - **Only the fields wanted are read** from what a command printed (the
 *   run token's policies, the hosts and logins `gh` is signed in to), and
 *   the output is never kept, since `token lookup` prints the token. What
 *   is kept of standard error, the one line a failure is told by, passes
 *   the scrub registry's captured-output call first, while the run token is
 *   still registered.
 */

/** How long one verify command may take, on the environment's clock (ADR 0031's ten seconds). */
export const VERIFY_TIMEOUT_MS = 10_000;

/** A verify command as the process environment's suppliers see it: a holder serving no session, account or run. */
export const VERIFY_COMMAND_SCOPE: ProcessEnvironmentScope = { sessionId: null, accountId: null, origin: "client", holder: "verify-command", override: null };

/** A verify command's injection: given, whatever the setting says of runs. */
const VERIFY_COMMAND_INJECTION: InjectionDecision = { answer: "allow", level: { kind: "environment" } };

/** The longest line a reason keeps of what a command printed. */
const SAID_LENGTH = 300;

/** The longest reason, as the contract bounds it. */
const REASON_LENGTH = 1024;

export interface ToolVerifierOptions {
  /** The Managed tools registry: each tool's row, and the environment it runs a tool in. */
  readonly tools: Pick<ManagedTools, "row" | "commandEnvironment">;
  /** Where a verify command's variables come from, as every holder's do. */
  readonly processEnvironments: Pick<ProcessEnvironments, "of">;
  /** The key-manager connections as they stand: a key-manager CLI's command runs against its provider's injecting one. */
  readonly connections: () => readonly KeyManagerConnectionRecord[];
  readonly scrub: Pick<ScrubRegistry, "scrubOutput">;
  readonly clock: Clock;
  /** Preset `VERIFY_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Preset: this process's. */
  readonly platform?: NodeJS.Platform;
}

export interface ToolVerifier {
  /** Runs `tool`'s verify command now, and answers how it came out. */
  verify(tool: VerifiableToolName): Promise<ManagedToolVerification>;
  /** Kills every verify command under way: the environment's close. */
  close(): void;
}

/** A verify command's command, run where the tool's row found it in its holder's environment. */
type Run = (args: readonly string[]) => Promise<CommandAnswer>;

/** An OpenBao lookup's `policies` row, as its table prints it: `policies    [default reader]`. */
const POLICIES_ROW = /^policies\s+\[([^\]]*)\]\s*$/m;

/** A line of standard error saying what failed: OpenBao's error list (`* permission denied`), or `gh`'s failure mark (`X Failed to log in ...`). */
const FAILURE_MARK = /^(?:\*|X|✗)\s+/;

/** `text` as one line of at most `length` characters. */
const oneLine = (text: string, length: number): string => {
  const line = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return line.length <= length ? line : `${line.slice(0, length - 1)}…`;
};

export const createToolVerifier = (options: ToolVerifierOptions): ToolVerifier => {
  const { tools, clock, scrub } = options;
  const timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS;
  const platform = options.platform ?? process.platform;
  const closing = new AbortController();

  /**
   * What a command that did not pass said, as a reason ends it: `: ` and
   * the line of its standard error saying what failed (the marked lines, or
   * else its first), scrubbed before anything is cut from it; why it did not
   * finish; or nothing.
   */
  const said = (answer: CommandAnswer): string => {
    if (answer.outcome === "failed") return `: ${answer.why}`;
    if (answer.outcome === "missing") return "";
    const lines = scrub
      .scrubOutput(answer.stderr)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const marked = lines.filter((line) => FAILURE_MARK.test(line)).map((line) => line.replace(FAILURE_MARK, ""));
    const line = (marked.length > 0 ? marked.join("; ") : (lines[0] ?? "")).replace(/\.$/, "");
    return line === "" ? ` with exit code ${answer.code ?? "none"}` : `: ${oneLine(line, SAID_LENGTH)}`;
  };

  const passed = (tool: VerifiableToolName, reason: string): ManagedToolVerification => ({ tool, outcome: "passed", reason: oneLine(reason, REASON_LENGTH) });
  const failed = (tool: VerifiableToolName, reason: string): ManagedToolVerification => ({ tool, outcome: "failed", reason: oneLine(reason, REASON_LENGTH) });
  const nothingToReach = (tool: VerifiableToolName, provider: KeyManagerProvider): ManagedToolVerification =>
    failed(tool, `No ${PROVIDER_NAMES[provider]} connection injects on this environment, so ${tool} has nothing to reach: connect one in Set up, Key manager.`);
  const notInstalled = (tool: VerifiableToolName): ManagedToolVerification => ({ tool, outcome: "not-installed", reason: `${tool} is not installed on this environment.` });

  const passedWhen = (tool: VerifiableToolName, answer: CommandAnswer, reason: () => string, failure: string): ManagedToolVerification => {
    if (answer.outcome === "missing") return notInstalled(tool);
    if (answer.outcome === "exited" && answer.code === 0) return passed(tool, reason());
    return failed(tool, `${failure}${said(answer)}.`);
  };

  /** `token lookup` through `bao` or `vault`; a failure followed by `status`, whose exit 2 is sealed and 1 unreachable. */
  const verifyOpenBao = async (tool: VerifiableToolName, run: Run, args: readonly string[], connection: KeyManagerConnectionRecord): Promise<ManagedToolVerification> => {
    const where = `${PROVIDER_NAMES[connection.provider]} at ${connection.address}`;
    const lookup = await run(args);
    if (lookup.outcome === "missing") return notInstalled(tool);
    if (lookup.outcome === "exited" && lookup.code === 0) {
      const policies = POLICIES_ROW.exec(lookup.stdout)?.[1]?.split(/\s+/).filter((policy) => policy !== "") ?? [];
      return passed(tool, `${tool} looked up its run token at ${connection.address}${policies.length === 0 ? "" : `: policies ${policies.join(", ")}`}.`);
    }
    const status = await run(["status"]);
    if (status.outcome === "exited" && status.code === 2) return failed(tool, `${where} is sealed: unseal it, then verify again.`);
    if (status.outcome === "exited" && status.code === 1) return failed(tool, `${where} could not be reached${said(status)}.`);
    return failed(tool, `${tool} ${args.join(" ")} failed at ${connection.address}${said(lookup)}.`);
  };

  /** `gh auth status`: the hosts and logins it is signed in to. */
  const verifyGh = async (run: Run, args: readonly string[]): Promise<ManagedToolVerification> => {
    const answer = await run(args);
    return passedWhen(
      "gh",
      answer,
      () => {
        const accounts = answer.outcome === "exited" ? parseGhAuthStatus(`${answer.stdout}\n${answer.stderr}`) : [];
        return `gh ${args.join(" ")} passed${accounts.length === 0 ? "" : `: signed in to ${accounts.map((account) => `${account.host} as ${account.login}`).join(", ")}`}.`;
      },
      `gh ${args.join(" ")} failed`,
    );
  };

  const verify = async (tool: VerifiableToolName): Promise<ManagedToolVerification> => {
    const { verify: args, requiredFor } = managedTool(tool);
    if (args === null) throw new Error(`The Managed tools table gives ${tool} no verify command.`);
    const row = await tools.row(tool);
    const path = row.path;
    if (path === null) return notInstalled(tool);
    // A key-manager CLI's command runs against its provider's injecting connection; gh's against what gh holds.
    const connection = requiredFor.kind === "key-manager" ? (options.connections().find((each) => each.provider === requiredFor.provider && each.injects) ?? null) : null;
    if (requiredFor.kind === "key-manager" && connection === null) return nothingToReach(tool, requiredFor.provider);
    const base = await tools.commandEnvironment();
    const supplied = await options.processEnvironments.of(VERIFY_COMMAND_SCOPE, VERIFY_COMMAND_INJECTION).supply();
    try {
      const env = { ...base, ...supplied.variables };
      const run: Run = (argv) => runCommand(path, argv, { env, clock, timeoutMs, signal: closing.signal, platform });
      if (connection === null) return await verifyGh(run, args);
      if (connection.provider === "openbao") return await verifyOpenBao(tool, run, args, connection);
      // Doppler's, 1Password's and Bitwarden's: whether it exits 0, until their providers (#377 to #379) read more.
      const where = `${PROVIDER_NAMES[connection.provider]} at ${connection.address}`;
      let command = args;
      if (connection.provider === "bitwarden") {
        // bws is given the block's configuration file as an option, which below 0.5.0 it reads from no variable (#1123); a block not supplied, the connection gone meanwhile, has none.
        const configPath = supplied.variables.BWS_CONFIG_FILE;
        if (configPath === undefined) return nothingToReach(tool, connection.provider);
        command = bwsArgs(configPath, args);
      }
      return passedWhen(tool, await run(command), () => `${tool} ${args.join(" ")} passed against ${where}.`, `${tool} ${args.join(" ")} failed against ${where}`);
    } finally {
      // Once every command it ran has exited, and what is kept of their output was scrubbed while the run token was registered.
      supplied.release();
    }
  };

  return { verify, close: () => closing.abort() };
};
