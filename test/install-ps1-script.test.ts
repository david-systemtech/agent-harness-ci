/**
 * The Windows install script, `install.ps1`, run by PowerShell 7 (`pwsh`)
 * against a fake `curl.exe` and `whoami.exe` on PATH and a fake release, as
 * `install-script.test.ts` runs `install.sh`: nothing here touches the network,
 * Task Scheduler or the registry. The release's zip is packed by the release
 * build's own zip writer, and holds a `node\node.exe` that records how the
 * version's CLI was called and plays the service (`service install` writes the
 * service state naming its version active, `service start` starts it,
 * `service status --json` says whether it runs); the fake `curl.exe` answers
 * the environment's health and discovery URLs only while that service runs.
 * Windows is read from the environment the script reads it from: `OS` and
 * `PROCESSOR_ARCHITECTURE`.
 *
 * CI's runners install `pwsh` in the job (`.forgejo/scripts/pwsh.sh`); where
 * it is absent outside CI these tests skip, and in CI they fail. What only a
 * real Windows proves is the service-install checklist's Windows install
 * script section.
 */
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { packZip } from "../packages/cli/scripts/release/archive.js";
import { pathLine } from "../packages/cli/src/service/shim.js";
import { API, DISCOVERY, DOWNLOAD, FAKE_CURL, HEALTH, LIST, releaseJson, type ReleaseSpec, TOKEN, write } from "./install-fakes.js";

const script = join(import.meta.dirname, "..", "scripts", "install.ps1");
const run = promisify(execFile);

/** PowerShell 7: `PWSH` when it names one, else `pwsh` on PATH. */
const PWSH = process.env["PWSH"] ?? "pwsh";
/** What every run of it gets: no ICU needed (the agent box has none), and no telemetry or update check. */
const POWERSHELL_ENV = { DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1", POWERSHELL_TELEMETRY_OPTOUT: "1", POWERSHELL_UPDATECHECK: "Off" };
const hasPwsh =
  process.platform !== "win32" &&
  spawnSync(PWSH, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { env: { ...process.env, ...POWERSHELL_ENV } }).status === 0;
const inCi = Boolean(process.env["CI"]);

const ASSET = "agent-harness-win32-x64.zip";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

/** PowerShell's own home, shared by the runs so each does not rebuild its caches: the fixture's folders stay the script's alone. */
let pwshHome = "";
beforeAll(() => {
  pwshHome = mkdtempSync(join(tmpdir(), "agent-harness-install-ps1-home-"));
});
afterAll(() => rmSync(pwshHome, { recursive: true, force: true }));

/**
 * The version's Node, run as the launcher runs a version: its first argument
 * must be this version's CLI entry. Records `<version> <arguments>` (and the
 * token, should it ever reach the CLI's environment), and each argument after
 * the entry exactly in FAKE_ARGV (a line a call, each argument ended by a unit
 * separator), fails the verb FAKE_FAIL
 * names with exit 3, keeps what `update credential` reads on stdin, and
 * answers `pair` with a pairing.
 */
const FAKE_NODE = `#!/bin/sh
version_dir=$(cd "$(dirname "$0")/.." && pwd)
version=\${version_dir##*/}
entry=$1
shift
[ "$entry" = "$version_dir/packages/cli/dist/main.js" ] || { echo "node.exe: $entry is not this version's CLI" >&2; exit 64; }
printf '%s %s\\n' "$version" "$*" >> "$FAKE_LOG"
{ for word in "$@"; do printf '%s\\037' "$word"; done; echo; } >> "$FAKE_ARGV"
[ -z "\${AGENT_HARNESS_TOKEN:-}" ] || printf '%s saw AGENT_HARNESS_TOKEN\\n' "$version" >> "$FAKE_LOG"
[ "$1 $2" != "\${FAKE_FAIL:-}" ] || { echo "$1 $2 failed here." >&2; exit 3; }
data_dir=$FAKE_DATA_DIR
previous=""
for word in "$@"; do
  [ "$previous" = --data-dir ] && data_dir=$word
  previous=$word
done
case "$1 $2" in
  "service install")
    mkdir -p "$data_dir/bin"
    : > "$data_dir/bin/agent-harness.cmd"
    printf '{\\n  "activeVersion": "%s",\\n  "previousVersion": null\\n}\\n' "$version" > "$data_dir/service-state.json"
    echo "Installed the launcher." ;;
  "service start") : > "$FAKE_STATE/running"; echo "Started." ;;
  "service status")
    if [ -f "$FAKE_STATE/running" ]; then running=true; else running=false; fi
    printf '{\\n  "installed": true,\\n  "running": %s\\n}\\n' "$running"
    [ "$running" = true ] || exit 3 ;;
  "update credential") cat > "$FAKE_STATE/credential"; echo "The release token was added." ;;
  "update settings") echo "Saved." ;;
  "update apply") echo "The update was asked for." ;;
  "pair "*) printf 'Pair a client with this environment.\\n\\n  http://box.tailnet-for-tests.ts.net:7433/pair#code\\n\\n  Code: ABCD-EFGH\\n\\n' ;;
esac
`;

/** \`whoami /groups /fo csv /nh\`: an administrator's filtered token at medium integrity, or the label FAKE_INTEGRITY names (12288 high, 16384 system). */
const FAKE_WHOAMI = `#!/bin/sh
[ "$*" = "/groups /fo csv /nh" ] || { echo "whoami: unexpected arguments $*" >&2; exit 1; }
echo '"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"'
echo '"BUILTIN\\\\Administrators","Alias","S-1-5-32-544","Group used for deny only"'
echo "\\"Mandatory Label\\\\Integrity Level\\",\\"Label\\",\\"S-1-16-\${FAKE_INTEGRITY:-8192}\\",\\"\\""
`;

interface Fixture {
  readonly root: string;
  /** LOCALAPPDATA, under which the script's data directory is when no -DataDir is given. */
  readonly localAppData: string;
  readonly dataDir: string;
  readonly state: string;
  /** The temporary folder the script's .NET reads from TMPDIR. */
  readonly temp: string;
  readonly log: string;
  readonly env: NodeJS.ProcessEnv;
  calls(): string[];
  /** The arguments each call of a version's CLI got after its entry, exactly as its Node read them. */
  argv(): string[][];
  /** Forgets the calls so far, as a new run of the script would find the machine. */
  forget(): void;
}

/** A fake PATH, a fake forge listing `releases` in that order, each with a Windows x64 zip and its sidecar unless told, and an empty LOCALAPPDATA. */
const fixture = (releases: readonly ReleaseSpec[] = [{ tag: "v0.1.0" }]): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "agent-harness-install-ps1-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const localAppData = join(root, "local");
  const fakeBin = join(root, "fake-bin");
  const assets = join(root, "assets");
  const listed = join(root, "releases");
  const state = join(root, "state");
  const temp = join(root, "temp");
  for (const dir of [localAppData, fakeBin, assets, listed, state, temp]) mkdirSync(dir, { recursive: true });
  const log = join(root, "calls.log");
  write(log, "");
  const argvLog = join(root, "argv.log");
  write(argvLog, "");

  write(join(fakeBin, "curl.exe"), FAKE_CURL, 0o755);
  write(join(fakeBin, "whoami.exe"), FAKE_WHOAMI, 0o755);

  const list = [];
  for (const spec of releases) {
    const staging = join(root, "staging", spec.tag);
    mkdirSync(join(staging, "node"), { recursive: true });
    mkdirSync(join(staging, "packages", "cli", "dist"), { recursive: true });
    mkdirSync(join(staging, "bin"), { recursive: true });
    if (!spec.withoutBinary) write(join(staging, "node", "node.exe"), FAKE_NODE, 0o755);
    write(join(staging, "packages", "cli", "dist", "main.js"), "// the version's CLI\n");
    write(join(staging, "bin", "agent-harness.cmd"), "@echo off\r\n");
    const assetName = spec.assetName ?? ASSET;
    mkdirSync(join(assets, spec.tag), { recursive: true });
    const zip = join(assets, spec.tag, assetName);
    packZip(staging, zip);
    const names = [assetName];
    const checksum = spec.checksum ?? "right";
    if (checksum !== "none") {
      const digest = checksum === "right" ? createHash("sha256").update(readFileSync(zip)).digest("hex") : "0".repeat(64);
      write(join(assets, spec.tag, `${assetName}.sha256`), `${digest}  ${assetName}\n`);
      names.push(`${assetName}.sha256`);
    }
    const json = releaseJson(spec, names);
    write(join(listed, `${spec.tag}.json`), JSON.stringify(json));
    list.push(json);
  }
  write(join(listed, "list.json"), JSON.stringify(list));

  const dataDir = join(localAppData, "agent-harness");
  const env: NodeJS.ProcessEnv = {
    ...POWERSHELL_ENV,
    PATH: `${fakeBin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    HOME: pwshHome,
    TMPDIR: temp,
    LOCALAPPDATA: localAppData,
    OS: "Windows_NT",
    PROCESSOR_ARCHITECTURE: "AMD64",
    AGENT_HARNESS_TOKEN: TOKEN,
    EXPECTED_TOKEN: TOKEN,
    FAKE_LOG: log,
    FAKE_ARGV: argvLog,
    FAKE_RELEASES: listed,
    FAKE_ASSETS: assets,
    FAKE_STATE: state,
    FAKE_DATA_DIR: dataDir,
  };
  return {
    root,
    localAppData,
    dataDir,
    state,
    temp,
    log,
    env,
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    argv: () =>
      readFileSync(argvLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\x1f").slice(0, -1)),
    forget: () => {
      writeFileSync(log, "");
      writeFileSync(argvLog, "");
      rmSync(join(state, "probes"), { force: true });
    },
  };
};

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const settle = async (running: Promise<{ stdout: string; stderr: string }>): Promise<Result> => {
  try {
    const { stdout, stderr } = await running;
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
};

/** Runs the script as a file, as `powershell -File install.ps1 ...` does. */
const install = (f: Fixture, args: string[] = [], env: NodeJS.ProcessEnv = {}): Promise<Result> =>
  settle(run(PWSH, ["-NoProfile", "-NonInteractive", "-File", script, ...args], { env: { ...f.env, ...env } }));

/** Runs `command` in a PowerShell session that holds the script's text in `$text`, as a line that makes a script block of a downloaded script does. */
const inSession = (f: Fixture, command: string, env: NodeJS.ProcessEnv = {}): Promise<Result> =>
  settle(
    run(PWSH, ["-NoProfile", "-NonInteractive", "-Command", `$text = Get-Content -Raw -LiteralPath '${script}'; ${command}`], {
      env: { ...f.env, ...env },
      cwd: f.root,
    }),
  );

/**
 * The script's function `name` called on each of `words`, in a PowerShell that defines that function
 * alone, taken out of the parsed script, so nothing else of the script runs; answers what it returned for each.
 */
const callEach = async (name: string, words: readonly string[]): Promise<string[]> => {
  const command =
    `$ast = [Management.Automation.Language.Parser]::ParseFile($env:SCRIPT, [ref]$null, [ref]$null); ` +
    `$definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $env:FUNCTION }, $true); ` +
    `. ([scriptblock]::Create($definition.Extent.Text)); ` +
    `ConvertTo-Json -Compress -InputObject @(ConvertFrom-Json $env:WORDS | ForEach-Object { & $env:FUNCTION $_ })`;
  const { stdout } = await run(PWSH, ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...process.env, ...POWERSHELL_ENV, HOME: pwshHome, SCRIPT: script, FUNCTION: name, WORDS: JSON.stringify(words) },
  });
  return JSON.parse(stdout) as string[];
};

/** The version's Node and CLI entry in `dataDir`, as the script runs them. */
const cliOf = (dataDir: string, version: string) => {
  const folder = join(dataDir, "versions", version);
  return { node: join(folder, "node", "node.exe"), entry: join(folder, "packages", "cli", "dist", "main.js") };
};

/** The lines the script ends with: the shim, then the CLI's own line that puts its folder first on the user Path. */
const pathEnding = (dataDir: string) =>
  `The shim ${join(dataDir, "bin", "agent-harness.cmd")} runs the active version. To put it on your Path, run this line in PowerShell, then sign out and back in:\n` +
  `  ${pathLine("cmd", join(dataDir, "bin"))}\n`;

it.runIf(inCi)("has PowerShell 7 to run the script under in CI", () => {
  expect(hasPwsh, `${PWSH} does not run: .forgejo/scripts/pwsh.sh puts it on the job's PATH`).toBe(true);
});

describe.skipIf(!hasPwsh && !inCi)("scripts/install.ps1", { timeout: 60_000 }, () => {
  it("prints its usage, naming the token it needs, for -Help", async () => {
    const f = fixture();
    const result = await install(f, ["-Help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Usage: install\.ps1/);
    expect(result.stdout).toContain("AGENT_HARNESS_TOKEN");
    expect(f.calls()).toEqual([]);
  });

  it.each([
    [["-Nope"]],
    [["-Prefix", "C:\\versions"]],
    [["-Channel", "nightly"]],
    [["-Channel", "Stable"]],
    [["-Name", ""]],
    [["-Version", ""]],
    [["-Port", "http"]],
    [["-Port", "0"]],
    [["-Port", "08"]],
    [["-Port", "70000"]],
    [["extra"]],
  ])("refuses %j with its usage and exit 2, before any download", async (args) => {
    const f = fixture();
    const result = await install(f, args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage: install.ps1");
    expect(f.calls()).toEqual([]);
  });

  it("leaves a parameter given without its value to PowerShell, which refuses it before the script runs", async () => {
    const f = fixture();
    const result = await install(f, ["-Channel"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Missing an argument for parameter 'Channel'");
    expect(f.calls()).toEqual([]);
  });

  it("refuses to run without a token, saying which variable to set, with exit 2", async () => {
    const f = fixture();
    const result = await install(f, [], { AGENT_HARNESS_TOKEN: "" });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("AGENT_HARNESS_TOKEN");
    expect(f.calls()).toEqual([]);
  });

  it.each(["soon", "1.5", "08", "-1"])("refuses INSTALL_READY_TIMEOUT=%s, no whole number of seconds, with exit 2, before any download", async (timeout) => {
    const f = fixture();
    const result = await install(f, [], { INSTALL_READY_TIMEOUT: timeout });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`INSTALL_READY_TIMEOUT takes a number of seconds; got ${timeout}.`);
    expect(f.calls()).toEqual([]);
  });

  it.each([
    ["an elevated shell", "12288"],
    ["SYSTEM", "16384"],
  ])("refuses to run from %s before any download or command, since the service runs as the user who installs it", async (_, integrity) => {
    const f = fixture();
    const result = await install(f, ["-Name", "Build box"], { FAKE_INTEGRITY: integrity });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/refusing to run from an elevated shell/);
    expect(f.calls()).toEqual([]);
    expect(readdirSync(f.localAppData)).toEqual([]);
  });

  it("refuses a system other than Windows, and an architecture it has no artefact name for, before any download", async () => {
    const f = fixture();
    const linux = await install(f, [], { OS: "" });
    expect(linux.code).toBe(1);
    expect(linux.stderr).toContain("this script installs on Windows");
    const x86 = await install(f, [], { PROCESSOR_ARCHITECTURE: "x86" });
    expect(x86.code).toBe(1);
    expect(x86.stderr).toContain("the x86 architecture");
    expect(f.calls()).toEqual([]);
  });

  it("reads the machine's architecture from a 32-bit PowerShell on 64-bit Windows", async () => {
    const f = fixture();
    const result = await install(f, [], { PROCESSOR_ARCHITECTURE: "x86", PROCESSOR_ARCHITEW6432: "AMD64" });
    expect(result.code).toBe(0);
    expect(f.calls()[1]).toBe(`curl ${DOWNLOAD}/v0.1.0/${ASSET}`);
  });

  it("names the artefact and release when the release has no artefact for this machine's architecture", async () => {
    const f = fixture();
    const result = await install(f, [], { PROCESSOR_ARCHITECTURE: "ARM64" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("agent-harness-win32-arm64.zip");
    expect(result.stderr).toContain("v0.1.0");
    expect(f.calls()).toEqual([`curl ${LIST}`]);
  });

  it("keeps the token off every command line, and out of the environment the CLI runs in", async () => {
    const f = fixture();
    expect((await install(f)).code).toBe(0);
    expect(readFileSync(f.log, "utf8")).not.toContain(TOKEN);
    expect(f.calls()).not.toContainEqual(expect.stringMatching(/saw AGENT_HARNESS_TOKEN/));
    expect(readFileSync(join(f.state, "credential"), "utf8").trim()).toBe(TOKEN);
  });

  it("says the token was refused when the releases API refuses it", async () => {
    const f = fixture();
    const result = await install(f, [], { EXPECTED_TOKEN: "another-token" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(LIST);
  });

  it("unpacks under %LOCALAPPDATA%, and under the home's AppData\\Local when that is not set", async () => {
    const f = fixture();
    expect((await install(f)).code).toBe(0);
    expect(existsSync(join(f.dataDir, "versions", "0.1.0", ".complete"))).toBe(true);

    const g = fixture();
    const home = join(g.root, "home");
    mkdirSync(home);
    const dataDir = join(home, "AppData", "Local", "agent-harness");
    const result = await install(g, [], { LOCALAPPDATA: "", HOME: home, FAKE_DATA_DIR: dataDir });
    expect(result.code).toBe(0);
    expect(existsSync(join(dataDir, "versions", "0.1.0", ".complete"))).toBe(true);
    expect(result.stdout.endsWith(pathEnding(dataDir))).toBe(true);
  });

  it("reuses a complete version already in the versions directory instead of downloading it again", async () => {
    const f = fixture();
    expect((await install(f)).code).toBe(0);
    rmSync(join(f.state, "running"));
    f.forget();
    const again = await install(f);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("already unpacked");
    expect(f.calls().filter((call) => call.startsWith("curl https://"))).toEqual([`curl ${LIST}`]);
  });

  it("replaces a version folder without its sentinel, which an interrupted install left, instead of reusing it", async () => {
    const f = fixture();
    const target = join(f.dataDir, "versions", "0.1.0");
    mkdirSync(join(target, "node"), { recursive: true });
    writeFileSync(join(target, "node", "node.exe"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(target, "stale"), "left by an interrupted install\n");

    const result = await install(f);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("already unpacked");
    expect(readdirSync(target).sort()).toEqual([".complete", "bin", "node", "packages"]);
  });

  it("leaves no partial folder and no temporary file behind when the artefact holds no node.exe", async () => {
    const f = fixture([{ tag: "v0.1.0", withoutBinary: true }]);
    const result = await install(f);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(join("node", "node.exe"));
    expect(readdirSync(join(f.dataDir, "versions"))).toEqual([]);
    expect(readdirSync(f.temp)).toEqual([]);
  });

  it("installs the stable channel's newest release, starts it, waits for it, hands it the channel and the token, and ends with the pairing and the Path line", async () => {
    const f = fixture();
    const result = await install(f, ["-Name", "Build box"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const version = join(f.dataDir, "versions", "0.1.0");
    expect(existsSync(join(version, "node", "node.exe"))).toBe(true);
    expect(existsSync(join(version, ".complete"))).toBe(true);
    expect(f.calls()).toEqual([
      `curl ${LIST}`,
      `curl ${DOWNLOAD}/v0.1.0/${ASSET}`,
      `curl ${DOWNLOAD}/v0.1.0/${ASSET}.sha256`,
      "0.1.0 service install --name Build box",
      "0.1.0 service start",
      `curl ${HEALTH}`,
      "0.1.0 update settings --channel stable",
      "0.1.0 update credential --stdin",
      `curl ${DISCOVERY}`,
      "0.1.0 pair --preset own-client",
    ]);
    expect(readFileSync(join(f.state, "credential"), "utf8").trim()).toBe(TOKEN);
    expect(result.stdout).toContain("Verified the SHA-256 of agent-harness-win32-x64.zip.");
    expect(result.stdout).toContain("\n  Code: ABCD-EFGH\n");
    expect(result.stdout.indexOf("Code: ABCD-EFGH")).toBeLessThan(result.stdout.indexOf("The shim "));
    expect(result.stdout.endsWith(pathEnding(f.dataDir))).toBe(true);
    expect(readdirSync(f.temp)).toEqual([]);
  });

  it("ends with the Tailscale warning instead of a pairing when the environment binds only loopback, then the Path line", async () => {
    const f = fixture();
    const result = await install(f, [], { FAKE_AUTH_POLICY: "local-only" });
    expect(result.code).toBe(0);
    expect(f.calls().slice(-2)).toEqual(["0.1.0 update credential --stdin", `curl ${DISCOVERY}`]);
    expect(f.calls().filter((call) => call.startsWith("0.1.0 pair"))).toEqual([]);
    expect(result.stdout).toContain(
      "No Tailscale address found. This machine is reachable only from itself. Install Tailscale to reach it from your other devices.\n",
    );
    expect(result.stdout).not.toContain("Code:");
    expect(result.stdout.endsWith(pathEnding(f.dataDir))).toBe(true);
  });

  describe("resolves the channel's newest at run time, by precedence rather than the forge's order, passing over drafts and tags that name no version", () => {
    const listed: ReleaseSpec[] = [
      { tag: "v0.5.0", draft: true },
      { tag: "v0.3.0-beta.9", prerelease: true },
      { tag: "v0.3.0-beta.10", prerelease: true },
      { tag: "nightly" },
      { tag: "v0.2.0" },
      { tag: "v0.10.0-rc.1", prerelease: true },
      { tag: "v0.2.1" },
      { tag: "v0.3.0-alpha.1", prerelease: true },
      { tag: "v0.2.1+rebuilt" },
    ];
    it.each([
      ["stable", "v0.2.1"],
      ["beta", "v0.10.0-rc.1"],
    ])("%s: %s", async (channel, tag) => {
      const f = fixture(listed);
      const result = await install(f, ["-Channel", channel]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(f.calls().slice(0, 3)).toEqual([`curl ${LIST}`, `curl ${DOWNLOAD}/${tag}/${ASSET}`, `curl ${DOWNLOAD}/${tag}/${ASSET}.sha256`]);
      expect(f.calls()).toContain(`${tag.slice(1)} update settings --channel ${channel}`);
      expect(readdirSync(join(f.dataDir, "versions"))).toEqual([tag.slice(1)]);
    });

    it("beta, among prereleases of one version: the highest by identifiers, numbers by value", async () => {
      const f = fixture(listed.filter((spec) => spec.tag !== "v0.10.0-rc.1"));
      expect((await install(f, ["-Channel", "beta"])).code).toBe(0);
      expect(readdirSync(join(f.dataDir, "versions"))).toEqual(["0.3.0-beta.10"]);
    });
  });

  it("says so, installing nothing, when the channel has no release", async () => {
    const f = fixture([{ tag: "v0.3.0-beta.1" }, { tag: "v0.4.0", draft: true }]);
    const result = await install(f, ["-Channel", "stable"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no release is published on the stable channel");
    expect(f.calls()).toEqual([`curl ${LIST}`]);
  });

  it.each(["0.2.0", "v0.2.0"])("installs the release -Version %s names, looked up by its tag, rather than the channel's newest", async (asked) => {
    const f = fixture([{ tag: "v0.3.0" }, { tag: "v0.2.0" }]);
    const result = await install(f, ["-Version", asked]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(f.calls().slice(0, 4)).toEqual([
      `curl ${API}/tags/v0.2.0`,
      `curl ${DOWNLOAD}/v0.2.0/${ASSET}`,
      `curl ${DOWNLOAD}/v0.2.0/${ASSET}.sha256`,
      "0.2.0 service install",
    ]);
    expect(f.calls()).not.toContainEqual(expect.stringMatching(/update apply/));
    expect(readdirSync(join(f.dataDir, "versions"))).toEqual(["0.2.0"]);
  });

  it("refuses a -Version that is no release version as a usage error, and one whose release is a draft or missing, installing nothing", async () => {
    const f = fixture([{ tag: "v0.2.0", draft: true }]);
    for (const version of ["0.2", "01.2.0", "0.2.0\n"]) {
      const malformed = await install(f, ["-Version", version]);
      expect(malformed.code, version).toBe(2);
      expect(malformed.stderr, version).toContain("-Version takes a release version");
      expect(f.calls(), version).toEqual([]);
    }

    for (const version of ["0.2.0", "0.9.0"]) {
      f.forget();
      const result = await install(f, ["-Version", version]);
      expect(result.code, version).toBe(1);
      expect(result.stderr, version).toContain(`v${version}`);
      expect(f.calls(), version).toEqual([`curl ${API}/tags/v${version}`]);
    }
  });

  it.each(["wrong", "none"] as const)("installs nothing when the artefact's digest is %s", async (checksum) => {
    const f = fixture([{ tag: "v0.1.0", checksum }]);
    const result = await install(f);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/nothing was installed/);
    expect(result.stderr).toContain(ASSET);
    expect(f.calls()).toEqual(
      checksum === "wrong" ? [`curl ${LIST}`, `curl ${DOWNLOAD}/v0.1.0/${ASSET}`, `curl ${DOWNLOAD}/v0.1.0/${ASSET}.sha256`] : [`curl ${LIST}`],
    );
    expect(existsSync(join(f.dataDir, "versions", "0.1.0"))).toBe(false);
    expect(readdirSync(f.temp)).toEqual([]);
  });

  it("waits while the environment says it is starting, probing the health URL until it says ready", async () => {
    const f = fixture();
    const result = await install(f, [], { FAKE_STARTING_PROBES: "1" });
    expect(result.code).toBe(0);
    expect(f.calls().slice(4, 8)).toEqual(["0.1.0 service start", `curl ${HEALTH}`, `curl ${HEALTH}`, "0.1.0 update settings --channel stable"]);
  });

  it("fails naming the service's log when the health URL does not say ready in time, and goes no further", async () => {
    const f = fixture();
    const dataDir = join(f.root, "data");
    const result = await install(f, ["-DataDir", dataDir, "-Port", "7500"], { FAKE_STARTING_PROBES: "1000", INSTALL_READY_TIMEOUT: "0" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("http://127.0.0.1:7500/health");
    expect(result.stderr).toContain(join(dataDir, "logs", "service.log"));
    expect(f.calls()).toEqual([
      `curl ${LIST}`,
      `curl ${DOWNLOAD}/v0.1.0/${ASSET}`,
      `curl ${DOWNLOAD}/v0.1.0/${ASSET}.sha256`,
      `0.1.0 service install --data-dir ${dataDir} --port 7500`,
      "0.1.0 service start",
      "curl http://127.0.0.1:7500/health",
    ]);
  });

  it("ends the run with a verb's exit code when the verb fails, running nothing after it", async () => {
    const f = fixture();
    const result = await install(f, [], { FAKE_FAIL: "service start" });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("`agent-harness service start` failed with exit code 3");
    expect(f.calls().at(-1)).toBe("0.1.0 service start");
  });

  it.each([
    { name: "-DryRun", args: ["-DryRun", "-Name", "Build box"], env: {} },
    { name: "INSTALL_DRY_RUN=1", args: ["-Name", "Build box"], env: { INSTALL_DRY_RUN: "1" } },
  ])("resolves the release and prints the plan without downloading or changing anything, for $name", async (how) => {
    const f = fixture();
    const result = await install(f, how.args, how.env);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(f.calls()).toEqual([`curl ${LIST}`]);
    const { node, entry } = cliOf(f.dataDir, "0.1.0");
    expect(result.stdout).toBe(
      [
        "Release: v0.1.0",
        `Download: ${DOWNLOAD}/v0.1.0/${ASSET}`,
        `Digest: ${DOWNLOAD}/v0.1.0/${ASSET}.sha256`,
        `Unpack into: ${join(f.dataDir, "versions", "0.1.0")}`,
        "Then:",
        `  & ${node} ${entry} service install --name 'Build box'`,
        `  & ${node} ${entry} service start`,
        `  wait up to 60 seconds for ${HEALTH} to say ready`,
        `  & ${node} ${entry} update settings --channel stable`,
        `  & ${node} ${entry} update credential --stdin`,
        `  & ${node} ${entry} pair --preset own-client, or the Tailscale warning when only loopback is bound`,
        "Dry run: nothing was downloaded or changed.",
        "",
      ].join("\n"),
    );
    expect(readdirSync(f.localAppData)).toEqual([]);
    expect(readdirSync(f.temp)).toEqual([]);
  });

  it("gives pair's plan line the -DataDir and -Port that the run passes it", async () => {
    const f = fixture();
    const dataDir = join(f.root, "data");
    const result = await install(f, ["-DryRun", "-DataDir", dataDir, "-Port", "7500"]);
    expect(result.code).toBe(0);
    const { node, entry } = cliOf(dataDir, "0.1.0");
    expect(result.stdout).toContain(
      `  & ${node} ${entry} pair --preset own-client --data-dir ${dataDir} --port 7500, or the Tailscale warning when only loopback is bound\n`,
    );
  });

  it("prints the plan of a re-run over a running service for -DryRun, changing nothing", async () => {
    const f = fixture([{ tag: "v0.1.0" }, { tag: "v0.2.0" }]);
    expect((await install(f, ["-Version", "0.1.0"])).code).toBe(0);
    f.forget();
    const result = await install(f, ["-DryRun", "-Version", "0.2.0"]);
    expect(result.code).toBe(0);
    expect(f.calls()).toEqual(["0.1.0 service status --json"]);
    const { node, entry } = cliOf(f.dataDir, "0.1.0");
    expect(result.stdout).toContain(`Then:\n  & ${node} ${entry} service install\n  wait up to 60 seconds for ${HEALTH} to say ready\n`);
    expect(result.stdout).toContain(`  & ${node} ${entry} update apply --version 0.2.0\n`);
    expect(result.stdout).toMatch(/Dry run: nothing was downloaded or changed\.\n$/);
  });

  describe("run again over a running service", () => {
    it("downloads and unpacks nothing, repairs the task and the entry through the active version's service install, and ends with a new pairing", async () => {
      const f = fixture([{ tag: "v0.1.0" }, { tag: "v0.2.0" }]);
      expect((await install(f, ["-Version", "0.1.0"])).code).toBe(0);
      f.forget();

      const result = await install(f, ["-Name", "Build box", "-Channel", "beta"]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(f.calls()).toEqual([
        "0.1.0 service status --json",
        "0.1.0 service install --name Build box",
        `curl ${HEALTH}`,
        "0.1.0 update settings --channel beta",
        "0.1.0 update credential --stdin",
        `curl ${DISCOVERY}`,
        "0.1.0 pair --preset own-client",
      ]);
      expect(result.stdout).toContain("The agent-harness service is running, so nothing is downloaded or unpacked.");
      expect(readFileSync(join(f.state, "credential"), "utf8").trim()).toBe(TOKEN);
      expect(readdirSync(join(f.dataDir, "versions"))).toEqual(["0.1.0"]);
      expect(result.stdout).toContain("\n  Code: ABCD-EFGH\n");
      expect(result.stdout.endsWith(pathEnding(f.dataDir))).toBe(true);
    });

    it("asks for the version -Version names through update apply, which stages it as any update", async () => {
      const f = fixture([{ tag: "v0.1.0" }, { tag: "v0.2.0" }]);
      const dataDir = join(f.root, "data");
      expect((await install(f, ["-Version", "0.1.0", "-DataDir", dataDir])).code).toBe(0);
      f.forget();

      const result = await install(f, ["-Version", "v0.2.0", "-DataDir", dataDir]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(f.calls()).toEqual([
        `0.1.0 service status --json --data-dir ${dataDir}`,
        `0.1.0 service install --data-dir ${dataDir}`,
        `curl ${HEALTH}`,
        `0.1.0 update settings --channel stable --data-dir ${dataDir}`,
        `0.1.0 update credential --stdin --data-dir ${dataDir}`,
        `0.1.0 update apply --version 0.2.0 --data-dir ${dataDir}`,
        `curl ${DISCOVERY}`,
        `0.1.0 pair --preset own-client --data-dir ${dataDir}`,
      ]);
      expect(readdirSync(join(dataDir, "versions"))).toEqual(["0.1.0"]);
    });

    it("installs as a first install does when the service is installed but stopped", async () => {
      const f = fixture([{ tag: "v0.1.0" }, { tag: "v0.2.0" }]);
      expect((await install(f, ["-Version", "0.1.0"])).code).toBe(0);
      rmSync(join(f.state, "running"));
      f.forget();

      const result = await install(f);
      expect(result.code).toBe(0);
      expect(f.calls().slice(0, 6)).toEqual([
        "0.1.0 service status --json",
        `curl ${LIST}`,
        `curl ${DOWNLOAD}/v0.2.0/${ASSET}`,
        `curl ${DOWNLOAD}/v0.2.0/${ASSET}.sha256`,
        "0.2.0 service install",
        "0.2.0 service start",
      ]);
      expect(readdirSync(join(f.dataDir, "versions")).sort()).toEqual(["0.1.0", "0.2.0"]);
    });
  });

  describe("run as a script block made from its text, in the session that ran the line", () => {
    it("keeps the session open, setting $LASTEXITCODE to the run's exit code, and puts the token back", async () => {
      const f = fixture();
      const result = await inSession(
        f,
        "& ([scriptblock]::Create($text)) -Channel nightly; \"after: $LASTEXITCODE\"; " +
          "& ([scriptblock]::Create($text)); \"after: $LASTEXITCODE, token: $($env:AGENT_HARNESS_TOKEN -eq 'token-for-tests'), run: $(Test-Path variable:run)\"",
      );
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("-Channel takes stable or beta; got nightly.");
      expect(result.stdout).toContain("after: 2\n");
      expect(result.stdout).toContain("\n  Code: ABCD-EFGH\n");
      expect(result.stdout).toMatch(/after: 0, token: True, run: False\n$/);
    });

    it("reads a relative -DataDir against the session's location, which .NET's working directory does not follow", async () => {
      const f = fixture();
      const here = join(f.root, "here");
      mkdirSync(here);
      const dataDir = join(here, "data");
      const result = await inSession(f, `Set-Location -LiteralPath '${here}'; & ([scriptblock]::Create($text)) -DataDir data`);
      expect(result.code).toBe(0);
      expect(existsSync(join(dataDir, "versions", "0.1.0", ".complete"))).toBe(true);
      expect(f.calls()).toContain(`0.1.0 service install --data-dir ${dataDir}`);
    });
  });

  describe("keeps its own exit-code checks in a session with $PSNativeCommandUseErrorActionPreference on, which PowerShell 7.3 and later take from a profile", () => {
    const withPreference = (f: Fixture, env: NodeJS.ProcessEnv = {}) =>
      inSession(
        f,
        "$PSNativeCommandUseErrorActionPreference = $true; & ([scriptblock]::Create($text)); \"after: $LASTEXITCODE, preference: $PSNativeCommandUseErrorActionPreference\"",
        env,
      );

    it("ends the run with a failed verb's exit code and its own message, and leaves the session's preference as it was", async () => {
      const f = fixture();
      const result = await withPreference(f, { FAKE_FAIL: "service start" });
      expect(result.stderr).toBe("service start failed here.\ninstall.ps1: `agent-harness service start` failed with exit code 3; nothing after it ran.\n");
      expect(result.stdout).toMatch(/after: 3, preference: True\n$/);
    });

    it("says the token was refused when curl.exe fails on the releases API", async () => {
      const f = fixture();
      const result = await withPreference(f, { EXPECTED_TOKEN: "another-token" });
      expect(result.stderr).toBe(
        `curl: (22) The requested URL returned error: 401\ninstall.ps1: could not read the releases from ${LIST}; check AGENT_HARNESS_TOKEN.\n`,
      );
      expect(result.stdout).toMatch(/after: 1, preference: True\n$/);
    });

    it("waits through health probes that get no answer, printing nothing but curl.exe's own words", async () => {
      const f = fixture();
      const result = await withPreference(f, { FAKE_UNANSWERED_PROBES: "2" });
      expect(result.stderr).toBe("curl: (7) Failed to connect\n".repeat(2));
      expect(f.calls().slice(4, 9)).toEqual(["0.1.0 service start", `curl ${HEALTH}`, `curl ${HEALTH}`, `curl ${HEALTH}`, "0.1.0 update settings --channel stable"]);
      expect(result.stdout).toMatch(/after: 0, preference: True\n$/);
    });
  });

  // Legacy is how Windows PowerShell 5.1 and PowerShell 7 before 7.3 pass them: PowerShell writes
  // the command line itself, and .NET reads it back into the arguments by Windows' rules here too.
  describe("hands every verb its arguments exactly, a double quote and a trailing backslash included, however the session passes a native command's", () => {
    // The trailing backslash rides on the name: PowerShell on Linux turns a path's backslashes into slashes.
    const name = 'The "big" box\\';
    it("writes a word for the command line as the C runtime reads it back: in double quotes when it holds white space or a double quote, each quote escaped, and the backslashes before one or before the closing quote doubled", async () => {
      const written: [word: string, onTheCommandLine: string][] = [
        ["service", "service"],
        ["D:\\agent-data\\", "D:\\agent-data\\"],
        ["", '""'],
        ["Build box", '"Build box"'],
        [String.raw`The "big" box`, String.raw`"The \"big\" box"`],
        ["D:\\agent data\\", '"D:\\agent data\\\\"'],
        [String.raw`D:\a b\c d`, String.raw`"D:\a b\c d"`],
        [String.raw`a\"b`, String.raw`"a\\\"b"`],
        ["tab\there", '"tab\there"'],
        ["no\u00a0break", '"no\u00a0break"'],
      ];
      const words = written.map(([word]) => word);
      expect(await callEach("Format-CommandLineWord", words)).toEqual(written.map(([, onTheCommandLine]) => onTheCommandLine));
    });

    it.each(["Legacy", "Standard", "Windows"])("with $PSNativeCommandArgumentPassing at %s, installing and then run again over the running service", async (passing) => {
      const f = fixture();
      const dataDir = join(f.root, "agent data");
      const line = `$PSNativeCommandArgumentPassing = '${passing}'; & ([scriptblock]::Create($text)) -Name $env:TEST_NAME -DataDir $env:TEST_DATA_DIR`;
      const given = { TEST_NAME: name, TEST_DATA_DIR: dataDir };
      const result = await inSession(f, line, given);
      expect(result.stderr).toBe("");
      expect(f.argv()).toEqual([
        ["service", "install", "--name", name, "--data-dir", dataDir],
        ["service", "start"],
        ["update", "settings", "--channel", "stable", "--data-dir", dataDir],
        ["update", "credential", "--stdin", "--data-dir", dataDir],
        ["pair", "--preset", "own-client", "--data-dir", dataDir],
      ]);

      f.forget();
      expect((await inSession(f, line, given)).stderr).toBe("");
      expect(f.argv().slice(0, 2)).toEqual([
        ["service", "status", "--json", "--data-dir", dataDir],
        ["service", "install", "--name", name, "--data-dir", dataDir],
      ]);
    });
  });
});
