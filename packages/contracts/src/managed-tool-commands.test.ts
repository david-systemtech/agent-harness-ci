import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_NOTICE_TYPES,
  EnvironmentNotice,
  MANAGED_TOOL_COMMANDS,
  MANAGED_TOOL_NAMES,
  TOOL_COMMAND_PLATFORMS,
  TOOL_INSTALL_ORDER,
  TOOL_RUN_CONFLICT_REASONS,
  ToolCommand,
  TOOL_PACKAGE_ARGUMENT,
  ToolCommandEntry,
  documentedChoice,
  eventTypeEntry,
  installChoice,
  installedInstead,
  methods,
  registry,
  toolCommandEntry,
  toolCommandMethodOf,
  updateCommand,
  type ManagedToolInstallMethod,
  type ToolCommandEntry as Entry,
} from "./index.js";

/**
 * The closed command table (key-managers spec, "Managed tools"; ADR 0026;
 * #376): per tool, method and platform, an install and an update command as
 * fixed argument lists, never a fetched string or a shell line; `tools.run`,
 * its refusals and the two events that record a run.
 */

/** Every argument of a command, in order. */
const words = (command: ToolCommand): string[] => command.flat(2);

/** A command as a person reads it: steps joined by `&&`, a step's programs by `|`. */
const said = (command: ToolCommand | null): string | null => (command === null ? null : command.map((step) => step.map((program) => program.join(" ")).join(" | ")).join(" && "));

/** The table's entry for a tool, method and platform; throws when there is none. */
const entry = (tool: Entry["tool"], method: Entry["method"], platform: (typeof TOOL_COMMAND_PLATFORMS)[number]): Entry => {
  const found = toolCommandEntry(tool, method, platform);
  if (found === null) throw new Error(`No ${method} entry for ${tool} on ${platform}.`);
  return found;
};

describe("the closed command table", () => {
  it("holds every command as a fixed argument list: steps of programs, each program its arguments, never a control character, and no argument a shell operator", () => {
    expect(MANAGED_TOOL_COMMANDS.length).toBeGreaterThan(0);
    for (const each of MANAGED_TOOL_COMMANDS) {
      expect(ToolCommandEntry.parse(each), `${each.tool} ${each.method}`).toEqual(each);
      for (const command of [each.install, each.update]) {
        if (command === null) continue;
        for (const word of words(command)) expect(["|", "||", "&&", ";", "&", ">", ">>", "<", "$(", "`"], `${each.tool} ${each.method}: ${word}`).not.toContain(word);
      }
    }
    // A command line in one argument, or a control character in one, is refused; an argument with spaces is still one word.
    expect(ToolCommand.safeParse([[["brew", "install", "gh\nrm -rf ~"]]]).success).toBe(false);
    expect(ToolCommand.safeParse([[[]]]).success).toBe(false);
    expect(ToolCommand.safeParse([]).success).toBe(false);
    expect(ToolCommand.safeParse("brew install gh").success).toBe(false);
    expect(ToolCommand.safeParse([[["printf", "%s\\n", "deb [signed-by=/etc/apt/keyrings/x.asc] https://example.test/ stable main"]]]).success).toBe(true);
  });

  it("names each tool, method and platform once, and never vault, which the harness does not install", () => {
    const keys = MANAGED_TOOL_COMMANDS.flatMap((each) => each.platforms.map((platform) => `${each.tool} ${each.method} ${platform}`));
    expect(new Set(keys).size).toBe(keys.length);
    expect(MANAGED_TOOL_COMMANDS.some((each) => (each.tool as string) === "vault")).toBe(false);
    expect(ToolCommandEntry.safeParse({ ...entry("bao", "homebrew", "darwin"), tool: "vault" }).success).toBe(false);
    for (const platform of TOOL_COMMAND_PLATFORMS) expect(installChoice("vault", platform, () => true)).toBeNull();
  });

  it("gives each tool, on each platform, one Install method: the first available of Homebrew, WinGet, the vendor's repository or the vendor's script", () => {
    expect(TOOL_INSTALL_ORDER).toEqual(["homebrew", "winget", "apt", "dnf", "script"]);
    for (const tool of MANAGED_TOOL_NAMES.filter((name) => name !== "vault")) {
      for (const platform of TOOL_COMMAND_PLATFORMS) {
        const installs = MANAGED_TOOL_COMMANDS.filter((each) => each.tool === tool && each.install !== null && (each.platforms as readonly string[]).includes(platform)).map((each) => each.method);
        expect(installs.length, `${tool} on ${platform}`).toBeGreaterThan(0);
        // Every program available: the first in the order; none: none.
        expect(installChoice(tool, platform, () => true)?.method, `${tool} on ${platform}`).toBe(TOOL_INSTALL_ORDER.find((method) => installs.includes(method)));
        expect(installChoice(tool, platform, () => false), `${tool} on ${platform}`).toBeNull();
      }
    }
    // gh on Linux: Homebrew when brew is there, else the vendor's apt repository, else its dnf one.
    const on = (programs: string[]) => (program: string) => programs.includes(program);
    expect(installChoice("gh", "linux", on(["brew", "apt-get", "sudo", "curl", "dnf"]))?.method).toBe("homebrew");
    expect(installChoice("gh", "linux", on(["apt-get", "sudo", "curl", "dnf"]))?.method).toBe("apt");
    expect(installChoice("gh", "linux", on(["sudo", "dnf"]))?.method).toBe("dnf");
    expect(installChoice("doppler", "linux", on(["curl", "sh", "gpg"]))?.method).toBe("script");
    expect(installChoice("doppler", "linux", on(["curl", "sh"]))).toBeNull();
  });

  it("installs and updates through Homebrew: openbao (never bao, another program), doppler, the cask 1password-cli, gh and the cask claude-code", () => {
    const brew = (tool: Entry["tool"]) => [said(entry(tool, "homebrew", "darwin").install), said(entry(tool, "homebrew", "darwin").update)];
    expect(brew("bao")).toEqual(["brew install openbao", "brew upgrade openbao"]);
    expect(brew("doppler")).toEqual(["brew install doppler", "brew upgrade doppler"]);
    expect(brew("op")).toEqual(["brew install --cask 1password-cli", "brew upgrade --cask 1password-cli"]);
    expect(brew("gh")).toEqual(["brew install gh", "brew upgrade gh"]);
    expect(brew("claude")).toEqual(["brew install --cask claude-code", "brew upgrade --cask claude-code"]);
    expect(entry("bao", "homebrew", "linux")).toEqual(entry("bao", "homebrew", "darwin"));
    expect(toolCommandEntry("bws", "homebrew", "darwin")).toBeNull();
  });

  it("installs and updates through WinGet by exact id: OpenBao.OpenBao, Doppler.doppler, AgileBits.1Password.CLI, GitHub.cli and Anthropic.ClaudeCode", () => {
    const ids = { bao: "OpenBao.OpenBao", doppler: "Doppler.doppler", op: "AgileBits.1Password.CLI", gh: "GitHub.cli", claude: "Anthropic.ClaudeCode" } as const;
    for (const [tool, id] of Object.entries(ids) as [keyof typeof ids, string][]) {
      const winget = entry(tool, "winget", "win32");
      expect([said(winget.install), said(winget.update)], tool).toEqual([`winget install --exact --id ${id}`, `winget upgrade --exact --id ${id}`]);
      expect(toolCommandEntry(tool, "winget", "linux"), tool).toBeNull();
    }
  });

  it("adds the vendor's apt or dnf repository with its signing key under sudo, then installs from it; updates with --only-upgrade and upgrade", () => {
    const repositories = { bao: ["pkgs.openbao.org", "openbao"], doppler: ["packages.doppler.com", "doppler"], op: ["downloads.1password.com", "1password-cli"], gh: ["cli.github.com/packages", "gh"] } as const;
    for (const [tool, [host, pkg]] of Object.entries(repositories) as [keyof typeof repositories, readonly [string, string]][]) {
      const apt = entry(tool, "apt", "linux");
      const dnf = entry(tool, "dnf", "linux");
      expect(said(apt.install), tool).toContain(host);
      expect(said(apt.install), tool).toMatch(/signed-by=\/(?:etc\/apt\/keyrings|usr\/share\/keyrings)\//);
      expect(said(apt.install), tool).toMatch(new RegExp(`sudo apt-get update && sudo apt-get install ${pkg}$`));
      expect(said(apt.update), tool).toBe(`sudo apt-get update && sudo apt-get install --only-upgrade ${pkg}`);
      expect(said(dnf.install), tool).toContain(host);
      expect(said(dnf.install), tool).toMatch(/gpgkey=/);
      expect(said(dnf.install), tool).toMatch(new RegExp(`sudo dnf install ${pkg}$`));
      expect(said(dnf.update), tool).toBe(`sudo dnf upgrade ${pkg}`);
      for (const command of [apt.install, dnf.install]) {
        // Every step that writes outside the home directory is sudo's.
        for (const step of command ?? []) {
          const writes = step.some((program) => ["tee", "gpg", "install", "mkdir", "chmod", "rpm", "apt-get", "dnf"].includes(program[0] ?? "") || (program[0] === "curl" && program.includes("-o")));
          if (writes) expect(step.some((program) => program[0] === "sudo"), `${tool}: ${said([step])}`).toBe(true);
        }
      }
    }
  });

  it("runs the vendor's scripts: Doppler's install.sh, needing gnupg, updated by doppler update; Claude Code's native installer, updated by claude update; Bitwarden's install script for bws", () => {
    const doppler = entry("doppler", "script", "linux");
    expect(said(doppler.install)).toBe("curl -Ls --tlsv1.2 --proto =https --retry 3 https://cli.doppler.com/install.sh | sh");
    expect(doppler.needs).toContain("gpg");
    expect(said(doppler.update)).toBe("doppler update");
    expect([said(entry("claude", "script", "linux").install), said(entry("claude", "script", "linux").update)]).toEqual(["curl -fsSL https://claude.ai/install.sh | bash", "claude update"]);
    expect(said(entry("claude", "script", "win32").install)).toBe("irm https://claude.ai/install.ps1 | iex");
    expect(said(entry("bws", "script", "darwin").install)).toBe("curl -fsSL https://bws.bitwarden.com/install | sh");
    expect(said(entry("bws", "script", "win32").install)).toBe("iwr https://bws.bitwarden.com/install | iex");
  });

  it("updates claude installed by npm as a global package, which installs nothing", () => {
    for (const platform of TOOL_COMMAND_PLATFORMS) {
      const npm = entry("claude", "npm", platform);
      expect([npm.install, said(npm.update)]).toEqual([null, "npm install -g @anthropic-ai/claude-code@latest"]);
    }
  });

  it("gives Windows one step a command, since Windows PowerShell chains none", () => {
    for (const each of MANAGED_TOOL_COMMANDS.filter((candidate) => (candidate.platforms as readonly string[]).includes("win32"))) {
      for (const command of [each.install, each.update]) if (command !== null) expect(command, `${each.tool} ${each.method}`).toHaveLength(1);
    }
  });

  it("drives every install method detection names but unknown: a package manager by its own, claude's native installer by its script (#1833)", () => {
    expect(Object.fromEntries((["homebrew", "winget", "apt", "dnf", "npm", "native", "manual", "unknown", "mise", "asdf", "scoop"] as const).map((method) => [method, toolCommandMethodOf(method)]))).toEqual({
      homebrew: "homebrew",
      winget: "winget",
      apt: "apt",
      dnf: "dnf",
      npm: "npm",
      native: "script",
      manual: "manual",
      unknown: null,
      mise: "mise",
      asdf: "asdf",
      scoop: "scoop",
    });
  });

  it("updates claude and bao however they were installed, on every platform the method exists on (#1833)", () => {
    const everywhere = ["darwin", "linux", "win32"] as const;
    const methodsOn: Record<"claude" | "bao", Partial<Record<ManagedToolInstallMethod, readonly (typeof TOOL_COMMAND_PLATFORMS)[number][]>>> = {
      claude: { homebrew: ["darwin", "linux"], winget: ["win32"], scoop: ["win32"], mise: everywhere, asdf: ["darwin", "linux"], npm: everywhere, native: everywhere, manual: everywhere, apt: ["linux"], dnf: ["linux"] },
      bao: { homebrew: ["darwin", "linux"], winget: ["win32"], scoop: ["win32"], mise: everywhere, asdf: ["darwin", "linux"], manual: everywhere, apt: ["linux"], dnf: ["linux"] },
    };
    for (const [tool, byMethod] of Object.entries(methodsOn) as [keyof typeof methodsOn, (typeof methodsOn)["claude"]][]) {
      for (const [method, platforms] of Object.entries(byMethod) as [ManagedToolInstallMethod, readonly (typeof TOOL_COMMAND_PLATFORMS)[number][]][]) {
        const driven = toolCommandMethodOf(method);
        for (const platform of platforms) expect(driven === null ? null : toolCommandEntry(tool, driven, platform), `${tool} ${method} ${platform}`).not.toBeNull();
      }
    }
    expect(said(entry("claude", "manual", "win32").update)).toBe("claude update");
    expect(said(entry("doppler", "manual", "linux").update)).toBe("doppler update");
  });

  it("updates through Scoop, mise and asdf the package the tool was installed as, else the registry's name for it", () => {
    const names = { claude: ["claude-code", "claude", "claude"], bao: ["openbao", "openbao", "openbao"], doppler: ["doppler", "doppler", "doppler"], op: ["1password-cli", "1password", "1password-cli"], bws: ["bws", "bitwarden-secrets-manager", "bitwarden-secrets-manager"], gh: ["gh", "github-cli", "github-cli"] } as const;
    for (const [tool, [scoop, mise, asdf]] of Object.entries(names) as [keyof typeof names, readonly [string, string, string]][]) {
      expect(said(updateCommand(entry(tool, "scoop", "win32"), null)), tool).toBe(`scoop update ${scoop}`);
      expect(said(updateCommand(entry(tool, "mise", "linux"), null)), tool).toBe(`mise upgrade ${mise}`);
      expect(said(updateCommand(entry(tool, "asdf", "darwin"), null)), tool).toBe(`asdf install ${asdf} latest && asdf set --home ${asdf} latest`);
      for (const method of ["scoop", "mise", "asdf"] as const) expect(entry(tool, method, method === "scoop" ? "win32" : "linux").install, `${tool} ${method}`).toBeNull();
    }
    expect(toolCommandEntry("bao", "asdf", "win32")).toBeNull();
    // The package its realpath names wins; a name that could be an option or a path never becomes an argument.
    expect(said(updateCommand(entry("bao", "mise", "linux"), "bao-nightly"))).toBe("mise upgrade bao-nightly");
    expect(said(updateCommand(entry("bao", "mise", "linux"), "--all"))).toBe("mise upgrade openbao");
    expect(said(updateCommand(entry("bao", "homebrew", "linux"), "anything"))).toBe("brew upgrade openbao");
    expect(MANAGED_TOOL_COMMANDS.filter((each) => words(each.update).includes(TOOL_PACKAGE_ARGUMENT)).every((each) => each.package !== undefined)).toBe(true);
  });

  it("updates a bare bao from OpenBao's release archive, checked against the release's checksums before it replaces the current binary where it is", () => {
    const posix = entry("bao", "manual", "linux");
    expect(posix).toEqual(entry("bao", "manual", "darwin"));
    const [[[program, flag, script]]] = posix.update as [[[string, string, string]]];
    expect([program, flag, posix.update.flat(2)]).toEqual(["sh", "-c", ["sh", "-c", script]]);
    expect(script).toContain("command -v bao");
    expect(script).toContain("openbao_${version}_${os}_${arch}.tar.gz");
    expect(script).toContain("checksums.txt");
    expect(script.indexOf("checksums")).toBeLessThan(script.indexOf("install -m 0755"));
    const windows = entry("bao", "manual", "win32");
    const [[[iex, line]]] = windows.update as [[[string, string]]];
    expect(iex).toBe("iex");
    expect(line).toContain("Get-FileHash -Algorithm SHA256");
    expect(line).toContain("'_windows_'");
    // The line reaches powershell.exe as one argument, where a double quote would be mangled.
    expect(line).not.toContain('"');
    expect(line.indexOf("Get-FileHash")).toBeLessThan(line.indexOf("Copy-Item"));
  });

  it("documents a command for a tool the table cannot drive: its bare binary's update, else its script's, else an install", () => {
    const every = () => true;
    expect(documentedChoice("bao", true, "linux", every)?.entry.method).toBe("manual");
    expect(documentedChoice("doppler", true, "linux", every)?.entry.method).toBe("manual");
    expect(documentedChoice("bws", true, "linux", every)?.entry.method).toBe("script");
    expect(said(documentedChoice("gh", true, "linux", every)?.command ?? null)).toBe("brew install gh");
    expect(documentedChoice("gh", false, "win32", every)?.entry.method).toBe("winget");
    expect(documentedChoice("vault", true, "linux", every)).toBeNull();
  });

  it("offers bao's Install on vault's row, and nothing in vault's place for any other tool", () => {
    expect(installedInstead("vault")).toBe("bao");
    for (const tool of MANAGED_TOOL_NAMES.filter((name) => name !== "vault")) expect(installedInstead(tool)).toBe(tool);
  });
});

describe("tools.run", () => {
  it("is an admin command taking the tool, install or update, and the tool terminal's id, with an optional size", () => {
    const run = registry["tools.run"];
    expect([run.kind, run.scope]).toEqual(["command", "admin"]);
    expect(methods.filter((m) => m.name.startsWith("tools.")).map((m) => m.name)).toContain("tools.run");
    const id = "0b8f4f7e-6d3c-4d8a-9f5e-2a1c3b4d5e6f";
    for (const params of [
      { commandId: "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d", tool: "gh", action: "install", id },
      { commandId: "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d", tool: "vault", action: "install", id, cols: 120, rows: 40 },
    ])
      expect(run.params.safeParse(params).success, JSON.stringify(params)).toBe(true);
    for (const params of [
      { commandId: "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d", tool: "gh", action: "copy", id },
      { commandId: "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d", tool: "codex", action: "install", id },
      { commandId: "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d", tool: "gh", action: "install" },
      { commandId: "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d", tool: "gh", action: "install", id: "not-a-uuid" },
    ])
      expect(run.params.safeParse(params).success, JSON.stringify(params)).toBe(false);
  });

  it("answers the tool terminal, the tool it installs or updates, the method and the command line it runs, and what claude doctor said first", () => {
    const terminal = { id: "0b8f4f7e-6d3c-4d8a-9f5e-2a1c3b4d5e6f", owner: "managed-tools", sessionId: null, openedAt: "2026-09-30T01:02:03.456Z", cols: 80, rows: 24, exitCode: null, signal: null };
    const answer = { terminal, tool: "bao", action: "install", method: "homebrew", command: "brew install openbao", doctor: null };
    expect(registry["tools.run"].result.parse(answer)).toEqual(answer);
    expect(registry["tools.run"].result.safeParse({ ...answer, tool: "vault" }).success).toBe(false);
    expect(registry["tools.run"].result.safeParse({ ...answer, terminal: { ...terminal, owner: "session", sessionId: "s" } }).success).toBe(false);
  });

  it("is refused tool_not_runnable with the vendor's documented command, and conflict tool_run_in_progress naming the run under way", () => {
    const run = registry["tools.run"];
    const refused = { code: "tool_not_runnable", message: "gh installed by mise is not updated by the harness.", data: { tool: "gh", action: "update", command: "brew install gh" } };
    expect(run.error.parse(refused)).toEqual(refused);
    expect(run.error.safeParse({ ...refused, data: { tool: "vault", action: "update", command: null } }).success).toBe(true);
    expect(run.error.safeParse({ ...refused, data: { tool: "gh" } }).success).toBe(false);
    expect(TOOL_RUN_CONFLICT_REASONS).toEqual(["tool_run_in_progress", "exists", "pty_unavailable"]);
  });
});

describe("the tool run events", () => {
  it("are tool.run-started and tool.run-finished on the environment stream, never in the session list, naming the tool, the action and the exit code", () => {
    for (const type of ["tool.run-started", "tool.run-finished"]) {
      expect(ENVIRONMENT_NOTICE_TYPES).toContain(type);
      expect(eventTypeEntry("environment", type)?.list).toBe(false);
    }
    const terminalId = "0b8f4f7e-6d3c-4d8a-9f5e-2a1c3b4d5e6f";
    const started = { type: "tool.run-started", payload: { tool: "gh", action: "install", method: "apt", terminalId, command: "sudo apt-get install gh" } };
    expect(EnvironmentNotice.parse(started)).toEqual(started);
    const verification = { tool: "gh", outcome: "passed", reason: "gh auth status passed." };
    const finished = { type: "tool.run-finished", payload: { tool: "gh", action: "install", method: "apt", terminalId, exitCode: 0, signal: null, cause: "exited", verification } };
    expect(EnvironmentNotice.parse(finished)).toEqual(finished);
    // The environment stopped before the command exited: no exit code, and nothing verified.
    const stopped = { ...finished, payload: { ...finished.payload, exitCode: null, cause: "closed", verification: null } };
    expect(EnvironmentNotice.parse(stopped)).toEqual(stopped);
    expect(EnvironmentNotice.safeParse({ ...finished, payload: { ...finished.payload, exitCode: undefined } }).success).toBe(false);
    expect(EnvironmentNotice.safeParse({ ...started, payload: { ...started.payload, tool: "vault" } }).success).toBe(false);
  });
});
