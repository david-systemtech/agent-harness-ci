import { z } from "zod";
import { errorSchema } from "./errors.js";
import { ManagedToolAction, ManagedToolName, ManagedToolVerification, type ManagedToolInstallMethod } from "./managed-tools.js";
import { TerminalExitCause, TerminalId } from "./terminals.js";

/**
 * The closed command table (key-managers spec, "Managed tools"; ADR 0026;
 * #376): per tool, method and platform, the command that installs the tool
 * and the one that updates it, as fixed argument lists. `tools.run` runs
 * one in a tool terminal through the user's login shell, quoting each
 * argument as one word; nothing fetched ever becomes a command. A command
 * is steps, each run once the one before it has succeeded, and a step is
 * programs, each one's output piped into the next (a signing key into
 * `sudo gpg --dearmor`, a repository line into `sudo tee`), so no argument
 * is ever a shell operator.
 *
 * Install takes the first method available on the environment, in the
 * order Homebrew, WinGet, the vendor's apt or dnf repository, the vendor's
 * script: available when every program it `needs` is on the login shell's
 * PATH. Update takes the method the tool was installed by. Every other
 * method (manual, unknown, mise, asdf, Scoop, and pacman, apk and cargo,
 * which detection reads as manual) is Copy only: the harness answers the
 * vendor's documented command and runs nothing. `vault` is never installed,
 * being under the Business Source License: its row offers Install `bao`.
 */

/** The platforms the table has commands for, as Node names them. */
export const TOOL_COMMAND_PLATFORMS = ["darwin", "linux", "win32"] as const;
export const ToolCommandPlatform = z.enum(TOOL_COMMAND_PLATFORMS).meta({
  description: "A platform the command table has commands for, as Node names it: darwin (macOS), linux or win32 (Windows).",
});
export type ToolCommandPlatform = z.infer<typeof ToolCommandPlatform>;

/** The ways the harness installs or updates a tool. */
export const TOOL_COMMAND_METHODS = ["homebrew", "winget", "apt", "dnf", "script", "npm"] as const;
export const ToolCommandMethod = z.enum(TOOL_COMMAND_METHODS).meta({
  description:
    "A way the harness installs or updates a tool: homebrew; winget; apt or dnf, the vendor's repository added with its signing key; script, the vendor's install script (claude's native installer among them); npm, a global package, which it only updates.",
});
export type ToolCommandMethod = z.infer<typeof ToolCommandMethod>;

/** The order Install takes the methods in: the first available on the environment. */
export const TOOL_INSTALL_ORDER = ["homebrew", "winget", "apt", "dnf", "script"] as const satisfies readonly ToolCommandMethod[];

/** The tools the table installs or updates: every managed tool but `vault`. */
export const InstallableToolName = ManagedToolName.exclude(["vault"]).meta({
  description: "A managed tool the harness installs or updates: every one but vault, which it never installs, being under the Business Source License.",
});
export type InstallableToolName = z.infer<typeof InstallableToolName>;

/** One argument: a word the shell is given whole, whatever it holds, and never a control character, so never a line of its own. */
const ToolCommandArgument = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\p{Cc}]+$/u)
  .meta({ description: "One argument, given to the program as one word whatever it holds; never a control character." });

/** A program and its arguments. */
const ToolCommandProgram = z.array(ToolCommandArgument).min(1).max(24).meta({ description: "A program and its arguments, as a fixed list: the first is the program." });
export type ToolCommandProgram = z.infer<typeof ToolCommandProgram>;

/** One step: its programs, each one's output piped into the next. */
const ToolCommandStep = z.array(ToolCommandProgram).min(1).max(3).meta({ description: "One step of a command: its programs, each one's output piped into the next." });
export type ToolCommandStep = z.infer<typeof ToolCommandStep>;

/** A command: its steps, each run once the one before it has succeeded. */
export const ToolCommand = z.array(ToolCommandStep).min(1).max(12).meta({
  description: "An install or update command as fixed argument lists: its steps, each run once the one before it has succeeded; never a fetched string or a shell line.",
});
export type ToolCommand = z.infer<typeof ToolCommand>;

/** A program `needs` names: a file name looked up on the PATH. */
const ProgramName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);

/** One entry of the table: a tool's install and update commands by one method, on the platforms named. */
export const ToolCommandEntry = z
  .object({
    tool: InstallableToolName,
    method: ToolCommandMethod,
    platforms: z.array(ToolCommandPlatform).min(1).max(3).meta({ description: "The platforms the commands are for." }),
    needs: z
      .array(ProgramName)
      .max(4)
      .meta({ description: "The programs Install needs on the login shell's PATH: the package manager, sudo, the downloader. The method is available where every one is found." }),
    install: ToolCommand.nullable().meta({ description: "The install command; null for a method that only updates (npm, claude's own apt and dnf repositories)." }),
    update: ToolCommand.meta({ description: "The update command, for the tool installed by this method." }),
  })
  .meta({ description: "One entry of the closed command table: a tool's install and update commands by one method, on the platforms it names." });
export type ToolCommandEntry = z.infer<typeof ToolCommandEntry>;

/** `sudo apt-get update && sudo apt-get install --only-upgrade <package>`. */
const aptUpdate = (pkg: string): ToolCommand => [[["sudo", "apt-get", "update"]], [["sudo", "apt-get", "install", "--only-upgrade", pkg]]];

/** `sudo dnf upgrade <package>`. */
const dnfUpdate = (pkg: string): ToolCommand => [[["sudo", "dnf", "upgrade", pkg]]];

/** Writes `lines` to `file` under sudo: the repository files the vendors document, written as fixed text rather than fetched. */
const writeLines = (file: string, lines: readonly string[]): ToolCommandStep => [
  ["printf", "%s\\n", ...lines],
  ["sudo", "tee", file],
];

/** Where apt's keyrings for the vendors' repositories go. */
const KEYRINGS = "/etc/apt/keyrings";

/** Homebrew, on macOS and Linux: a formula, or a cask (`--cask`). */
const homebrew = (tool: InstallableToolName, name: string, cask = false): ToolCommandEntry => {
  const kind = cask ? ["--cask"] : [];
  return { tool, method: "homebrew", platforms: ["darwin", "linux"], needs: ["brew"], install: [[["brew", "install", ...kind, name]]], update: [[["brew", "upgrade", ...kind, name]]] };
};

/** WinGet, on Windows, by exact id. */
const winget = (tool: InstallableToolName, id: string): ToolCommandEntry => ({
  tool,
  method: "winget",
  platforms: ["win32"],
  needs: ["winget"],
  install: [[["winget", "install", "--exact", "--id", id]]],
  update: [[["winget", "upgrade", "--exact", "--id", id]]],
});

/**
 * The table, checked against the vendors' documents on 2026-09-30 (the
 * pull request for #376 records what each is): OpenBao's downloads page
 * and install guide, Doppler's `INSTALL.md`, 1Password's CLI guide, GitHub
 * CLI's `install_linux.md`, Claude Code's setup guide, Bitwarden's Secrets
 * Manager CLI guide, the Homebrew API and WinGet's manifests. A repository
 * file the vendor has fetched (Doppler's, GitHub CLI's `.repo`) is written
 * here as the fixed text it holds, and a signing key goes to its own
 * keyring (`signed-by`), as each vendor's apt instructions do.
 */
export const MANAGED_TOOL_COMMANDS: readonly ToolCommandEntry[] = [
  // claude in your terminal: Homebrew's cask, WinGet, the native installer (claude update), npm; its own apt and dnf repositories only update.
  homebrew("claude", "claude-code", true),
  winget("claude", "Anthropic.ClaudeCode"),
  {
    tool: "claude",
    method: "script",
    platforms: ["darwin", "linux"],
    needs: ["curl", "bash"],
    install: [[["curl", "-fsSL", "https://claude.ai/install.sh"], ["bash"]]],
    update: [[["claude", "update"]]],
  },
  { tool: "claude", method: "script", platforms: ["win32"], needs: ["powershell"], install: [[["irm", "https://claude.ai/install.ps1"], ["iex"]]], update: [[["claude", "update"]]] },
  { tool: "claude", method: "npm", platforms: ["darwin", "linux", "win32"], needs: ["npm"], install: null, update: [[["npm", "install", "-g", "@anthropic-ai/claude-code@latest"]]] },
  { tool: "claude", method: "apt", platforms: ["linux"], needs: ["apt-get", "sudo"], install: null, update: aptUpdate("claude-code") },
  { tool: "claude", method: "dnf", platforms: ["linux"], needs: ["dnf", "sudo"], install: null, update: dnfUpdate("claude-code") },

  // OpenBao: the formula openbao (bao is another program), WinGet, and pkgs.openbao.org's repositories.
  homebrew("bao", "openbao"),
  winget("bao", "OpenBao.OpenBao"),
  {
    tool: "bao",
    method: "apt",
    platforms: ["linux"],
    needs: ["apt-get", "sudo", "curl"],
    install: [
      [["sudo", "install", "-d", "-m", "0755", KEYRINGS]],
      [["sudo", "curl", "-fsSL", "-o", `${KEYRINGS}/openbao.asc`, "https://openbao.org/assets/openbao-gpg-pub-20240618.asc"]],
      [["sudo", "chmod", "go+r", `${KEYRINGS}/openbao.asc`]],
      writeLines("/etc/apt/sources.list.d/openbao.list", [`deb [signed-by=${KEYRINGS}/openbao.asc] https://pkgs.openbao.org/deb/ stable main`]),
      [["sudo", "apt-get", "update"]],
      [["sudo", "apt-get", "install", "openbao"]],
    ],
    update: aptUpdate("openbao"),
  },
  {
    tool: "bao",
    method: "dnf",
    platforms: ["linux"],
    needs: ["dnf", "sudo"],
    install: [
      writeLines("/etc/yum.repos.d/openbao.repo", [
        "[openbao]",
        "name=openbao",
        "baseurl=https://pkgs.openbao.org/rpm/$basearch",
        "repo_gpgcheck=0",
        "gpgcheck=1",
        "enabled=1",
        "gpgkey=https://openbao.org/assets/openbao-gpg-pub-20240618.asc",
        "sslverify=1",
        "sslcacert=/etc/pki/tls/certs/ca-bundle.crt",
        "metadata_expire=300",
      ]),
      [["sudo", "dnf", "install", "openbao"]],
    ],
    update: dnfUpdate("openbao"),
  },

  // Doppler: the formula, WinGet, packages.doppler.com's repositories, and its install.sh (it verifies the binary's signature with gnupg).
  homebrew("doppler", "doppler"),
  winget("doppler", "Doppler.doppler"),
  {
    tool: "doppler",
    method: "apt",
    platforms: ["linux"],
    needs: ["apt-get", "sudo", "curl"],
    install: [
      [["sudo", "install", "-d", "-m", "0755", KEYRINGS]],
      [["sudo", "curl", "-sLf", "--retry", "3", "--tlsv1.2", "--proto", "=https", "-o", `${KEYRINGS}/doppler.asc`, "https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key"]],
      [["sudo", "chmod", "go+r", `${KEYRINGS}/doppler.asc`]],
      writeLines("/etc/apt/sources.list.d/doppler-cli.list", [`deb [signed-by=${KEYRINGS}/doppler.asc] https://packages.doppler.com/public/cli/deb/debian any-version main`]),
      [["sudo", "apt-get", "update"]],
      [["sudo", "apt-get", "install", "doppler"]],
    ],
    update: aptUpdate("doppler"),
  },
  {
    tool: "doppler",
    method: "dnf",
    platforms: ["linux"],
    needs: ["dnf", "sudo"],
    install: [
      [["sudo", "rpm", "--import", "https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key"]],
      writeLines("/etc/yum.repos.d/doppler-cli.repo", [
        "[doppler-cli]",
        "name=doppler-cli",
        "baseurl=https://packages.doppler.com/public/cli/rpm/any-distro/any-version/$basearch",
        "repo_gpgcheck=1",
        "enabled=1",
        "skip_if_unavailable=1",
        "gpgkey=https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key",
        "gpgcheck=1",
        "sslverify=1",
        "sslcacert=/etc/pki/tls/certs/ca-bundle.crt",
        "metadata_expire=300",
        "type=rpm-md",
      ]),
      [["sudo", "dnf", "install", "doppler"]],
    ],
    update: dnfUpdate("doppler"),
  },
  {
    tool: "doppler",
    method: "script",
    platforms: ["darwin", "linux"],
    needs: ["curl", "sh", "gpg"],
    install: [[["curl", "-Ls", "--tlsv1.2", "--proto", "=https", "--retry", "3", "https://cli.doppler.com/install.sh"], ["sh"]]],
    update: [[["doppler", "update"]]],
  },

  // 1Password: the cask 1password-cli, WinGet, and its repositories (the apt one with the debsig policy its packages are checked by).
  homebrew("op", "1password-cli", true),
  winget("op", "AgileBits.1Password.CLI"),
  {
    tool: "op",
    method: "apt",
    platforms: ["linux"],
    needs: ["apt-get", "sudo", "curl", "gpg"],
    install: [
      [
        ["curl", "-fsSL", "https://downloads.1password.com/linux/keys/1password.asc"],
        ["sudo", "gpg", "--dearmor", "--yes", "--output", "/usr/share/keyrings/1password-archive-keyring.gpg"],
      ],
      [
        ["dpkg", "--print-architecture"],
        ["sed", "s|.*|deb [arch=& signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/& stable main|"],
        ["sudo", "tee", "/etc/apt/sources.list.d/1password.list"],
      ],
      [["sudo", "mkdir", "-p", "/etc/debsig/policies/AC2D62742012EA22"]],
      [
        ["curl", "-fsSL", "https://downloads.1password.com/linux/debian/debsig/1password.pol"],
        ["sudo", "tee", "/etc/debsig/policies/AC2D62742012EA22/1password.pol"],
      ],
      [["sudo", "mkdir", "-p", "/usr/share/debsig/keyrings/AC2D62742012EA22"]],
      [
        ["curl", "-fsSL", "https://downloads.1password.com/linux/keys/1password.asc"],
        ["sudo", "gpg", "--dearmor", "--yes", "--output", "/usr/share/debsig/keyrings/AC2D62742012EA22/debsig.gpg"],
      ],
      [["sudo", "apt-get", "update"]],
      [["sudo", "apt-get", "install", "1password-cli"]],
    ],
    update: aptUpdate("1password-cli"),
  },
  {
    tool: "op",
    method: "dnf",
    platforms: ["linux"],
    needs: ["dnf", "sudo"],
    install: [
      [["sudo", "rpm", "--import", "https://downloads.1password.com/linux/keys/1password.asc"]],
      writeLines("/etc/yum.repos.d/1password.repo", [
        "[1password]",
        "name=1Password Stable Channel",
        "baseurl=https://downloads.1password.com/linux/rpm/stable/$basearch",
        "enabled=1",
        "gpgcheck=1",
        "repo_gpgcheck=1",
        'gpgkey="https://downloads.1password.com/linux/keys/1password.asc"',
      ]),
      [["sudo", "dnf", "install", "1password-cli"]],
    ],
    update: dnfUpdate("1password-cli"),
  },

  // Bitwarden Secrets Manager: its install script, on every platform (it checks the release's checksum); on neither Homebrew nor WinGet.
  {
    tool: "bws",
    method: "script",
    platforms: ["darwin", "linux"],
    needs: ["curl", "sh"],
    install: [[["curl", "-fsSL", "https://bws.bitwarden.com/install"], ["sh"]]],
    update: [[["curl", "-fsSL", "https://bws.bitwarden.com/install"], ["sh"]]],
  },
  { tool: "bws", method: "script", platforms: ["win32"], needs: ["powershell"], install: [[["iwr", "https://bws.bitwarden.com/install"], ["iex"]]], update: [[["iwr", "https://bws.bitwarden.com/install"], ["iex"]]] },

  // GitHub CLI: the formula gh, WinGet, and cli.github.com's repositories.
  homebrew("gh", "gh"),
  winget("gh", "GitHub.cli"),
  {
    tool: "gh",
    method: "apt",
    platforms: ["linux"],
    needs: ["apt-get", "sudo", "curl"],
    install: [
      [["sudo", "install", "-d", "-m", "0755", KEYRINGS]],
      [["sudo", "curl", "-fsSL", "-o", `${KEYRINGS}/githubcli-archive-keyring.gpg`, "https://cli.github.com/packages/githubcli-archive-keyring.gpg"]],
      [["sudo", "chmod", "go+r", `${KEYRINGS}/githubcli-archive-keyring.gpg`]],
      [
        ["dpkg", "--print-architecture"],
        ["sed", `s|.*|deb [arch=& signed-by=${KEYRINGS}/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main|`],
        ["sudo", "tee", "/etc/apt/sources.list.d/github-cli.list"],
      ],
      [["sudo", "apt-get", "update"]],
      [["sudo", "apt-get", "install", "gh"]],
    ],
    update: aptUpdate("gh"),
  },
  {
    tool: "gh",
    method: "dnf",
    platforms: ["linux"],
    needs: ["dnf", "sudo"],
    install: [
      writeLines("/etc/yum.repos.d/gh-cli.repo", [
        "[gh-cli]",
        "name=packages for the GitHub CLI",
        "baseurl=https://cli.github.com/packages/rpm",
        "enabled=1",
        "gpgcheck=1",
        "gpgkey=https://cli.github.com/packages/githubcli-archive-keyring.asc",
      ]),
      [["sudo", "dnf", "install", "gh"]],
    ],
    update: dnfUpdate("gh"),
  },
];

/** The table's entry for `tool` by `method` on `platform`; null when it has none. */
export const toolCommandEntry = (
  tool: InstallableToolName,
  method: ToolCommandMethod,
  platform: ToolCommandPlatform,
  table: readonly ToolCommandEntry[] = MANAGED_TOOL_COMMANDS,
): ToolCommandEntry | null => table.find((each) => each.tool === tool && each.method === method && each.platforms.includes(platform)) ?? null;

/**
 * The entry Install runs for `tool` on `platform`: the first method, in
 * `TOOL_INSTALL_ORDER`, that installs it there and whose every program
 * `available` finds on the PATH; null when none is (and for `vault`,
 * which is never installed).
 */
export const installChoice = (
  tool: ManagedToolName,
  platform: ToolCommandPlatform,
  available: (program: string) => boolean,
  table: readonly ToolCommandEntry[] = MANAGED_TOOL_COMMANDS,
): ToolCommandEntry | null => {
  const installable = InstallableToolName.safeParse(tool);
  if (!installable.success) return null;
  for (const method of TOOL_INSTALL_ORDER) {
    const found = toolCommandEntry(installable.data, method, platform, table);
    if (found !== null && found.install !== null && found.needs.every(available)) return found;
  }
  return null;
};

/**
 * The table's method for a tool detection says was installed by `method`:
 * Homebrew, WinGet, apt, dnf and npm by their own; claude's native
 * installer is its vendor script. Null for the Copy-only methods: manual,
 * unknown, mise, asdf and Scoop.
 */
export const toolCommandMethodOf = (method: ManagedToolInstallMethod): ToolCommandMethod | null => {
  switch (method) {
    case "homebrew":
    case "winget":
    case "apt":
    case "dnf":
    case "npm":
      return method;
    case "native":
      return "script";
    case "manual":
    case "unknown":
    case "mise":
    case "asdf":
    case "scoop":
      return null;
  }
};

/** The tool whose Install a tool's row offers: `bao` for `vault`, which is never installed; any other tool its own. */
export const installedInstead = (tool: ManagedToolName): InstallableToolName => (tool === "vault" ? "bao" : tool);

/** What `tools.run` does: a row's Install or Update; Copy runs nothing. */
export const RunnableToolAction = ManagedToolAction.exclude(["copy"]).meta({
  description: "What tools.run does: install (a tool not installed) or update (one installed by a method the harness drives); a Copy-only row runs nothing.",
});
export type RunnableToolAction = z.infer<typeof RunnableToolAction>;

/** A command line as the login shell runs it, or as a person copies it. */
const CommandLine = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[^\r\n]+$/)
  .meta({ description: "A command line, each argument quoted as one word, steps joined by &&: as the user's login shell runs it, or as a person copies it." });

/**
 * `tools.run` refused a tool it cannot install or update here (#376): a
 * Copy-only row (manual, unknown, mise, asdf, Scoop), a tool no method
 * installs on this environment, or `vault`'s Update. It answers the
 * vendor's documented command, for a person to copy and run.
 */
export const ToolNotRunnableError = errorSchema(
  "tool_not_runnable",
  z.object({
    tool: ManagedToolName,
    action: RunnableToolAction,
    command: CommandLine.nullable().meta({
      description:
        "The vendor's documented command, to copy and run where the harness cannot: the vendor script's update for a tool it installed by hand, else the install the table has for this platform. Null when there is none: vault, which the harness never installs or updates.",
    }),
  }),
).meta({
  description:
    "The harness does not run this tool's install or update here: a Copy-only row (installed by hand, or by mise, asdf or Scoop, or not known how), a tool no method available on the environment installs, or vault, which is never installed; data.command is the vendor's documented command to copy.",
});
export type ToolNotRunnableError = z.infer<typeof ToolNotRunnableError>;

/** Why `tools.run` is refused in `conflict` (its `data.reason`). */
export const TOOL_RUN_CONFLICT_REASONS = ["tool_run_in_progress", "exists", "pty_unavailable"] as const;
export const ToolRunConflictReason = z.enum(TOOL_RUN_CONFLICT_REASONS).meta({
  description:
    "Why tools.run was refused in conflict: tool_run_in_progress (another tool run is under way on the environment, since package managers lock; data names its tool and terminal), exists (the terminal id was used on the environment already) or pty_unavailable (the environment cannot start a pseudo-terminal).",
});
export type ToolRunConflictReason = z.infer<typeof ToolRunConflictReason>;

/** The fields both run events name: the tool, the action, the method and the tool terminal. */
const runFields = {
  tool: InstallableToolName.meta({ description: "The tool installed or updated: bao for vault's Install." }),
  action: RunnableToolAction,
  method: ToolCommandMethod,
  terminalId: TerminalId.meta({ description: "The tool terminal the command runs in, so its id is never used again." }),
};

/** `tool.run-started`: a tool run began, by the client session the event names (#376). */
export const ToolRunStartedPayload = z
  .object({ ...runFields, command: CommandLine.meta({ description: "The command line the login shell runs." }) })
  .meta({ description: "tool.run-started: a client session began installing or updating a tool in a tool terminal: the tool, the action, the method, the terminal and the command line." });
export type ToolRunStartedPayload = z.infer<typeof ToolRunStartedPayload>;

/** `tool.run-finished`: a tool run's command exited, the tool was probed again and verified (#376). */
export const ToolRunFinishedPayload = z
  .object({
    ...runFields,
    exitCode: z.int().nullable().meta({ description: "The command's exit code: -1 when it could not start; null when the environment stopped before it exited." }),
    signal: z.int().nullable().meta({ description: "The signal that ended it, when one did." }),
    cause: TerminalExitCause.exclude(["deleted"]).meta({
      description: "Why it ended: exited on its own; closed (terminals.close, or the environment stopping); failed (it could not start).",
    }),
    verification: ManagedToolVerification.nullable().meta({
      description: "How the tool's verify command came out once the PATH was read again and the tool probed; null for claude, which has none, and when the environment stopped first.",
    }),
  })
  .meta({
    description:
      "tool.run-finished: a tool run ended: its exit code and why, once the login shell's PATH was read again, the tool probed (a changed row raising tools.updated) and verified.",
  });
export type ToolRunFinishedPayload = z.infer<typeof ToolRunFinishedPayload>;
