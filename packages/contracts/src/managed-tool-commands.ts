import { z } from "zod";
import { errorSchema } from "./errors.js";
import { ManagedToolAction, ManagedToolName, ManagedToolVerification, ToolCommandLine, type ManagedToolInstallMethod } from "./managed-tools.js";
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
 * PATH. Update takes the method the tool was installed by: a package
 * manager's own upgrade (Homebrew, WinGet, Scoop, mise, asdf, npm, apt,
 * dnf), the vendor's self-update (`claude update`, `doppler update`), or
 * for a bare `bao` the vendor's release archive, checked against its
 * published checksums and put where the current binary is (#1833). A
 * method the table cannot drive (unknown; a file no dpkg or rpm owns in a
 * place pacman, apk, MacPorts, Nix, snap, cargo or Chocolatey may own,
 * which detection reads as manual; a tool npm installed into a Node that
 * Scoop, mise or asdf installed; a bare `op`, `gh` or `bws`) runs the
 * vendor's documented command in a tool terminal once a person presses
 * Enter, so nothing is run unseen. `vault` is never installed or updated,
 * being under the Business Source License: its row offers Install `bao`.
 */

/** The platforms the table has commands for, as Node names them. */
export const TOOL_COMMAND_PLATFORMS = ["darwin", "linux", "win32"] as const;
export const ToolCommandPlatform = z.enum(TOOL_COMMAND_PLATFORMS).meta({
  description: "A platform the command table has commands for, as Node names it: darwin (macOS), linux or win32 (Windows).",
});
export type ToolCommandPlatform = z.infer<typeof ToolCommandPlatform>;

/** The ways the harness installs or updates a tool. */
export const TOOL_COMMAND_METHODS = ["homebrew", "winget", "apt", "dnf", "script", "npm", "scoop", "mise", "asdf", "manual"] as const;
export const ToolCommandMethod = z.enum(TOOL_COMMAND_METHODS).meta({
  description:
    "A way the harness installs or updates a tool: homebrew; winget; apt or dnf, the vendor's repository added with its signing key; script, the vendor's install script (claude's native installer among them); npm, a global package; scoop, mise or asdf, the package manager's own upgrade of the package the tool was installed as; manual, a binary placed by hand, updated by the vendor's self-update or, for bao, its release archive checked against the published checksums. Only the first five install; the others only update.",
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
  .max(2048)
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

/** A package's name in a package manager: a word, never an option or a path. */
const PackageName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/)
  .meta({ description: "A package's name in Scoop, mise or asdf: letters, digits, dot, underscore, plus and hyphen, never first a hyphen or a dot." });

/** The argument of a Scoop, mise or asdf update that stands for the package the tool was installed as (`updateCommand`). */
export const TOOL_PACKAGE_ARGUMENT = "{package}";

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
    package: PackageName.optional().meta({
      description: `For scoop, mise and asdf, the package the update names where the argument ${TOOL_PACKAGE_ARGUMENT} stands: the one the tool's realpath is installed under (scoop/apps/<name>, mise/installs/<name>, .asdf/installs/<name>), else this, the registry's name for it, for a shim.`,
    }),
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

/** Scoop, on Windows, which only updates: `scoop update <app>`. */
const scoop = (tool: InstallableToolName, name: string): ToolCommandEntry => ({
  tool,
  method: "scoop",
  platforms: ["win32"],
  needs: ["scoop"],
  install: null,
  update: [[["scoop", "update", TOOL_PACKAGE_ARGUMENT]]],
  package: name,
});

/** mise, on every platform, which only updates: `mise upgrade <tool>`, within the version its configuration asks for. */
const mise = (tool: InstallableToolName, name: string): ToolCommandEntry => ({
  tool,
  method: "mise",
  platforms: ["darwin", "linux", "win32"],
  needs: ["mise"],
  install: null,
  update: [[["mise", "upgrade", TOOL_PACKAGE_ARGUMENT]]],
  package: name,
});

/** asdf (0.16 and later), on macOS and Linux, which only updates: the latest version installed, then made the home directory's. */
const asdf = (tool: InstallableToolName, name: string): ToolCommandEntry => ({
  tool,
  method: "asdf",
  platforms: ["darwin", "linux"],
  needs: ["asdf"],
  install: null,
  update: [[["asdf", "install", TOOL_PACKAGE_ARGUMENT, "latest"]], [["asdf", "set", "--home", TOOL_PACKAGE_ARGUMENT, "latest"]]],
  package: name,
});

/** A bare binary updated by its own self-update command, on the platforms named. */
const selfUpdate = (tool: InstallableToolName, platforms: ToolCommandEntry["platforms"]): ToolCommandEntry => ({
  tool,
  method: "manual",
  platforms,
  needs: [tool],
  install: null,
  update: [[[tool, "update"]]],
});

/**
 * A bare `bao` on macOS or Linux: OpenBao's release archive for the
 * platform and architecture (`openbao_<version>_<os>_<arch>.tar.gz`, the
 * latest release's tag read from GitHub's redirect), checked against the
 * release's `checksums.txt` before anything is replaced, then its `bao`
 * installed over the file the current one resolves to, under sudo where
 * that directory is not writable. Nothing is replaced when the checksum
 * does not match.
 */
export const BAO_ARCHIVE_UPDATE_POSIX = [
  "set -eu",
  'current=$(command -v bao) || { echo "bao is not on the PATH." >&2; exit 1; }',
  'target=$(readlink -f "$current" 2>/dev/null || printf %s "$current")',
  'case $(uname -s) in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "OpenBao publishes no archive for $(uname -s)." >&2; exit 1 ;; esac',
  'case $(uname -m) in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) echo "OpenBao publishes no archive for $(uname -m)." >&2; exit 1 ;; esac',
  "tag=$(curl -fsSLI -o /dev/null -w %{url_effective} https://github.com/openbao/openbao/releases/latest)",
  "tag=${tag##*/}",
  "version=${tag#v}",
  'case $version in [0-9]*) ;; *) echo "The latest OpenBao release could not be read." >&2; exit 1 ;; esac',
  "archive=openbao_${version}_${os}_${arch}.tar.gz",
  "base=https://github.com/openbao/openbao/releases/download/$tag",
  "dir=$(mktemp -d)",
  'trap "rm -rf $dir" EXIT',
  'echo "Downloading $archive and its checksums."',
  'curl -fsSL -o "$dir/$archive" "$base/$archive"',
  'curl -fsSL -o "$dir/checksums.txt" "$base/checksums.txt"',
  'expected=$(awk -v name="$archive" "\\$2 == name { print \\$1 }" "$dir/checksums.txt")',
  'actual=$( (sha256sum "$dir/$archive" 2>/dev/null || shasum -a 256 "$dir/$archive") | awk "{ print \\$1 }")',
  'if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then echo "The checksum of $archive does not match the release checksums: nothing was replaced." >&2; exit 1; fi',
  'tar -xzf "$dir/$archive" -C "$dir" bao',
  'if [ -w "$(dirname "$target")" ]; then install -m 0755 "$dir/bao" "$target"; else sudo install -m 0755 "$dir/bao" "$target"; fi',
  'echo "Installed OpenBao $version at $target."',
].join("; ");

/**
 * A bare `bao` on Windows: the same, in PowerShell, with no double quote
 * (the line reaches powershell.exe as one argument): the latest release
 * from GitHub's API, `openbao_<version>_windows_<arch>.zip`, its SHA-256
 * against `checksums.txt`, and `bao.exe` copied over the current one.
 */
export const BAO_ARCHIVE_UPDATE_WINDOWS = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$target = (Get-Command bao -CommandType Application -TotalCount 1).Source",
  "$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }",
  "$tag = (Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/openbao/openbao/releases/latest').tag_name",
  "$version = $tag.TrimStart('v')",
  "$archive = 'openbao_' + $version + '_windows_' + $arch + '.zip'",
  "$base = 'https://github.com/openbao/openbao/releases/download/' + $tag + '/'",
  "$dir = Join-Path $env:TEMP ('openbao-' + [guid]::NewGuid())",
  "New-Item -ItemType Directory -Path $dir | Out-Null",
  "try { Write-Host ('Downloading ' + $archive + ' and its checksums.')",
  "Invoke-WebRequest -UseBasicParsing -Uri ($base + $archive) -OutFile (Join-Path $dir $archive)",
  "Invoke-WebRequest -UseBasicParsing -Uri ($base + 'checksums.txt') -OutFile (Join-Path $dir 'checksums.txt')",
  "$expected = Get-Content (Join-Path $dir 'checksums.txt') | Where-Object { ($_ -split ' +')[1] -eq $archive } | ForEach-Object { ($_ -split ' +')[0] }",
  "$actual = (Get-FileHash -Algorithm SHA256 (Join-Path $dir $archive)).Hash",
  "if (-not $expected -or $expected -ne $actual) { throw ('The checksum of ' + $archive + ' does not match the release checksums: nothing was replaced.') }",
  "Expand-Archive -Path (Join-Path $dir $archive) -DestinationPath $dir",
  "Copy-Item -Force (Join-Path $dir 'bao.exe') $target",
  "Write-Host ('Installed OpenBao ' + $version + ' at ' + $target + '.') } finally { Remove-Item -Recurse -Force $dir }",
].join("; ");

/**
 * The table, checked against the vendors' documents on 2026-09-30 (the
 * pull request for #376 records what each is): OpenBao's downloads page
 * and install guide, Doppler's `INSTALL.md`, 1Password's CLI guide, GitHub
 * CLI's `install_linux.md`, Claude Code's setup guide, Bitwarden's Secrets
 * Manager CLI guide, the Homebrew API and WinGet's manifests. A repository
 * file the vendor has fetched (Doppler's, GitHub CLI's `.repo`) is written
 * here as the fixed text it holds, and a signing key goes to its own
 * keyring (`signed-by`), as each vendor's apt instructions do. The Scoop,
 * mise and asdf names and OpenBao's release assets were checked on
 * 2026-10-08 (#1833): Scoop's main bucket, mise's registry and asdf's
 * plugin index, and the assets and `checksums.txt` of OpenBao 2.7.1.
 */
export const MANAGED_TOOL_COMMANDS: readonly ToolCommandEntry[] = [
  // claude in your terminal: Homebrew's cask, WinGet, the native installer (claude update), npm; its own apt and dnf repositories, Scoop, mise, asdf and a bare binary (claude update) only update.
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
  scoop("claude", "claude-code"),
  mise("claude", "claude"),
  asdf("claude", "claude"),
  selfUpdate("claude", ["darwin", "linux", "win32"]),

  // OpenBao: the formula openbao (bao is another program), WinGet, and pkgs.openbao.org's repositories; Scoop, mise, asdf, and a bare binary by the checksum-verified release archive, only update.
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
  scoop("bao", "openbao"),
  mise("bao", "openbao"),
  asdf("bao", "openbao"),
  { tool: "bao", method: "manual", platforms: ["darwin", "linux"], needs: ["curl", "tar"], install: null, update: [[["sh", "-c", BAO_ARCHIVE_UPDATE_POSIX]]] },
  { tool: "bao", method: "manual", platforms: ["win32"], needs: ["powershell"], install: null, update: [[["iex", BAO_ARCHIVE_UPDATE_WINDOWS]]] },

  // Doppler: the formula, WinGet, packages.doppler.com's repositories, and its install.sh (it verifies the binary's signature with gnupg); Scoop, mise, asdf and a bare binary (doppler update) only update.
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
  scoop("doppler", "doppler"),
  mise("doppler", "doppler"),
  asdf("doppler", "doppler"),
  selfUpdate("doppler", ["darwin", "linux"]),

  // 1Password: the cask 1password-cli, WinGet, and its repositories (the apt one with the debsig policy its packages are checked by); Scoop, mise and asdf only update.
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
  scoop("op", "1password-cli"),
  mise("op", "1password"),
  asdf("op", "1password-cli"),

  // Bitwarden Secrets Manager: its install script, on every platform (it checks the release's checksum); on neither Homebrew nor WinGet; Scoop, mise and asdf only update.
  {
    tool: "bws",
    method: "script",
    platforms: ["darwin", "linux"],
    needs: ["curl", "sh"],
    install: [[["curl", "-fsSL", "https://bws.bitwarden.com/install"], ["sh"]]],
    update: [[["curl", "-fsSL", "https://bws.bitwarden.com/install"], ["sh"]]],
  },
  { tool: "bws", method: "script", platforms: ["win32"], needs: ["powershell"], install: [[["iwr", "https://bws.bitwarden.com/install"], ["iex"]]], update: [[["iwr", "https://bws.bitwarden.com/install"], ["iex"]]] },
  scoop("bws", "bws"),
  mise("bws", "bitwarden-secrets-manager"),
  asdf("bws", "bitwarden-secrets-manager"),

  // GitHub CLI: the formula gh, WinGet, and cli.github.com's repositories; Scoop, mise and asdf only update.
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
  scoop("gh", "gh"),
  mise("gh", "github-cli"),
  asdf("gh", "github-cli"),
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
 * The vendor's documented command for `tool` on `platform`, and the entry
 * it is from, for where the table drives no method (#376, #426, #1833): for
 * an installed tool its bare binary's update, else its vendor script's (one
 * installed in a way that could not be told was most likely installed by
 * one of them), else the install `installChoice` would run, else the first
 * install the table has for the platform; null for `vault`, which is never
 * installed, and where the table has none. A row that runs it in a tool
 * terminal carries its line, and a refusal of `tools.run` answers it.
 */
export const documentedChoice = (
  tool: ManagedToolName,
  installed: boolean,
  platform: ToolCommandPlatform,
  available: (program: string) => boolean,
  table: readonly ToolCommandEntry[] = MANAGED_TOOL_COMMANDS,
): { readonly entry: ToolCommandEntry; readonly command: ToolCommand } | null => {
  if (tool === "vault") return null;
  for (const method of installed ? (["manual", "script"] as const) : []) {
    const updates = toolCommandEntry(tool, method, platform, table);
    if (updates !== null) return { entry: updates, command: updates.update };
  }
  const chosen = installChoice(tool, platform, available, table) ?? TOOL_INSTALL_ORDER.map((method) => toolCommandEntry(tool, method, platform, table)).find((each) => each?.install != null);
  return chosen?.install == null ? null : { entry: chosen, command: chosen.install };
};

/** The command of `documentedChoice`, alone. */
export const documentedCommand = (
  tool: ManagedToolName,
  installed: boolean,
  platform: ToolCommandPlatform,
  available: (program: string) => boolean,
  table: readonly ToolCommandEntry[] = MANAGED_TOOL_COMMANDS,
): ToolCommand | null => documentedChoice(tool, installed, platform, available, table)?.command ?? null;

/**
 * The table's method for a tool detection says was installed by `method`:
 * Homebrew, WinGet, Scoop, mise, asdf, npm, apt, dnf and a bare binary
 * (manual) by their own; claude's native installer is its vendor script.
 * Null for `unknown`, which the table cannot drive.
 */
export const toolCommandMethodOf = (method: ManagedToolInstallMethod): ToolCommandMethod | null => {
  switch (method) {
    case "homebrew":
    case "winget":
    case "scoop":
    case "mise":
    case "asdf":
    case "npm":
    case "apt":
    case "dnf":
    case "manual":
      return method;
    case "native":
      return "script";
    case "unknown":
      return null;
  }
};

/**
 * An entry's update, its package argument (`TOOL_PACKAGE_ARGUMENT`) the
 * package the tool was installed as where its realpath names one, else the
 * entry's own: Scoop, mise and asdf update the package a person installed,
 * by whichever name.
 */
export const updateCommand = (entry: ToolCommandEntry, installedAs: string | null): ToolCommand => {
  const name = installedAs !== null && PackageName.safeParse(installedAs).success ? installedAs : entry.package;
  if (name === undefined) return entry.update;
  return entry.update.map((step) => step.map((program) => program.map((word) => (word === TOOL_PACKAGE_ARGUMENT ? name : word))));
};

/** The tool whose Install a tool's row offers: `bao` for `vault`, which is never installed; any other tool its own. */
export const installedInstead = (tool: ManagedToolName): InstallableToolName => (tool === "vault" ? "bao" : tool);

/** What `tools.run` does: a row's Install, Update or Run in a terminal pane; Copy runs nothing. */
export const RunnableToolAction = ManagedToolAction.exclude(["copy"]).meta({
  description:
    "What tools.run does: install (a tool not installed), update (one installed by a method the harness drives; for one it does not, as terminal) or terminal (the vendor's documented command, run in the tool terminal once a person presses Enter there); a Copy row runs nothing.",
});
export type RunnableToolAction = z.infer<typeof RunnableToolAction>;

/**
 * `tools.run` refused a tool it cannot install or update here (#376): a
 * tool no method installs on this environment, a tool the table has no
 * command for here at all, or `vault`'s Update. It answers the vendor's
 * documented command where there is one, for a person to copy and run.
 */
export const ToolNotRunnableError = errorSchema(
  "tool_not_runnable",
  z.object({
    tool: ManagedToolName,
    action: RunnableToolAction,
    command: ToolCommandLine.nullable().meta({
      description:
        "The vendor's documented command, to copy and run where the harness cannot: a bare binary's update, else the vendor script's, for an installed tool, else the install the table has for this platform. Null when there is none: vault, which the harness never installs or updates.",
    }),
  }),
).meta({
  description:
    "The harness does not run this tool's install or update here: a tool no method available on the environment installs, a tool the table has no command for on this platform, or vault, which is never installed or updated; data.command is the vendor's documented command to copy, where there is one.",
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

/** `tool.run-started`: a tool run began, by the client session the event's actor names (#376). */
export const ToolRunStartedPayload = z
  .object({ ...runFields, command: ToolCommandLine.meta({ description: "The command line the login shell runs." }) })
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
