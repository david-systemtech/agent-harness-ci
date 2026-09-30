/**
 * The headless install script, run by `sh` against a fake `curl`, `uname` and
 * `id` on PATH and a fake release: nothing here touches the network or a
 * service manager. The artefact's `agent-harness` records how it was called,
 * plays the service (`service install` writes a shim that records as `shim`,
 * `service start` starts it, `service status --json` says whether it runs),
 * and the fake `curl` answers the environment's health and discovery URLs
 * only while that service runs.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const script = join(import.meta.dirname, "..", "scripts", "install.sh");
const run = promisify(execFile);

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const FORGE = "https://git.systemtech.dev:5526";
const API = `${FORGE}/api/v1/repos/david/agent-harness/releases`;
const LIST = `${API}?limit=50`;
const DOWNLOAD = `${FORGE}/david/agent-harness/releases/download`;
const ENVIRONMENT = "http://127.0.0.1:7433";
const HEALTH = `${ENVIRONMENT}/health`;
const DISCOVERY = `${ENVIRONMENT}/.well-known/agent-harness/environment`;
const TOKEN = "token-for-tests";

const write = (path: string, text: string, mode = 0o644) => {
  writeFileSync(path, text);
  chmodSync(path, mode);
};

/**
 * A fake curl: logs its URL; for the forge, checks the token arrives on stdin
 * and serves the fake release; for the environment's own URLs, refuses the
 * token and answers health and discovery while the fake service runs, health
 * saying `starting` for its first FAKE_STARTING_PROBES probes.
 */
const FAKE_CURL = `#!/bin/sh
out=""
url=""
config=""
with_config=0
while [ $# -gt 0 ]; do
  case $1 in
    -o | --max-time) [ "$1" = -o ] && out=$2; shift 2 ;;
    -K) config=$(cat); with_config=1; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf 'curl %s\\n' "$url" >> "$FAKE_LOG"
case $url in
  http://127.0.0.1:*)
    [ "$with_config" = 0 ] || { echo "curl: the forge token was sent to $url" >&2; exit 99; }
    [ -f "$FAKE_STATE/running" ] || { echo "curl: (7) Failed to connect" >&2; exit 7; }
    case $url in
      */health)
        probes=$(( $(cat "$FAKE_STATE/probes" 2>/dev/null || echo 0) + 1 ))
        echo "$probes" > "$FAKE_STATE/probes"
        if [ "$probes" -gt "\${FAKE_STARTING_PROBES:-0}" ]; then status=ready; else status=starting; fi
        printf '{"status":"%s","version":"0.1.0"}' "$status" ;;
      */.well-known/agent-harness/environment)
        printf '{"environmentId":"env-for-tests","environmentName":"box","authPolicy":"%s","readiness":"ready"}' "\${FAKE_AUTH_POLICY:-tailnet}" ;;
      *) echo "curl: (22) The requested URL returned error: 404" >&2; exit 22 ;;
    esac
    exit 0 ;;
esac
case $config in
  *"Authorization: token $EXPECTED_TOKEN"*) ;;
  *) echo "curl: (22) The requested URL returned error: 401" >&2; exit 22 ;;
esac
case $url in
  *"/releases?limit=50") cat "$FAKE_RELEASES/list.json" ;;
  */releases/tags/*)
    tag=\${url##*/}
    [ -f "$FAKE_RELEASES/$tag.json" ] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
    cat "$FAKE_RELEASES/$tag.json" ;;
  */releases/download/*)
    asset=\${url#*/releases/download/}
    [ -f "$FAKE_ASSETS/$asset" ] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
    cp "$FAKE_ASSETS/$asset" "$out" ;;
  *) echo "curl: (6) Could not resolve host" >&2; exit 6 ;;
esac
`;

/**
 * The artefact's binary, and the shim its `service install` writes, which
 * records as `shim`: records each call (and the token, should it ever reach
 * the CLI's environment), keeps what `update credential` reads on stdin, and
 * answers `pair` with a pairing.
 */
const FAKE_BINARY = `#!/bin/sh
who=agent-harness
printf '%s %s\\n' "$who" "$*" >> "$FAKE_LOG"
[ -z "\${AGENT_HARNESS_TOKEN:-}" ] || printf '%s saw AGENT_HARNESS_TOKEN\\n' "$who" >> "$FAKE_LOG"
data_dir=$FAKE_DATA_DIR
previous=""
for word in "$@"; do
  [ "$previous" = --data-dir ] && data_dir=$word
  previous=$word
done
case "$1 $2" in
  "service install")
    mkdir -p "$data_dir/bin"
    sed 's/^who=.*/who=shim/' "$0" > "$data_dir/bin/.agent-harness.new"
    chmod 755 "$data_dir/bin/.agent-harness.new"
    mv "$data_dir/bin/.agent-harness.new" "$data_dir/bin/agent-harness"
    echo "Installed the launcher." ;;
  "service start") : > "$FAKE_STATE/running"; echo "Started." ;;
  "service status")
    if [ -f "$FAKE_STATE/running" ]; then running=true; else running=false; fi
    printf '{\\n  "installed": true,\\n  "running": %s\\n}\\n' "$running"
    [ "$running" = true ] ;;
  "update credential") cat > "$FAKE_STATE/credential"; echo "The release token was added." ;;
  "update settings") echo "Saved." ;;
  "update apply") echo "The update was asked for." ;;
  "pair "*) printf 'Pair a client with this environment.\\n\\n  http://box.tailnet-for-tests.ts.net:7433/pair#code\\n\\n  Code: ABCD-EFGH\\n\\n' ;;
esac
`;

interface ReleaseSpec {
  readonly tag: string;
  readonly draft?: boolean;
  readonly prerelease?: boolean;
  /** The published digest: the tarball's, another, or none published. Preset: the tarball's. */
  readonly checksum?: "right" | "wrong" | "none";
  readonly assetName?: string;
  readonly withoutBinary?: boolean;
}

interface Fixture {
  readonly home: string;
  readonly log: string;
  /** The data directory the script uses when no --data-dir is given. */
  readonly dataDir: string;
  readonly state: string;
  readonly env: NodeJS.ProcessEnv;
  calls(): string[];
  /** Forgets the calls so far, as a new run of the script would find the machine. */
  forget(): void;
}

const releaseJson = (spec: ReleaseSpec, assets: readonly string[]) => ({
  id: 7,
  tag_name: spec.tag,
  target_commitish: "main",
  name: `agent-harness ${spec.tag}`,
  body: 'Notes, with commas, and a quoted \\"tag_name\\": \\"v6.6.6\\" and \\"draft\\": true in them.',
  url: `${API}/7`,
  draft: spec.draft ?? false,
  prerelease: spec.prerelease ?? false,
  author: { id: 1, login: "david" },
  assets: assets.map((name, i) => ({ id: 10 + i, name, size: 1, browser_download_url: `${DOWNLOAD}/${spec.tag}/${name}` })),
});

/** A home, a fake PATH and a fake forge listing `releases` in that order, each with a Linux x64 artefact and its sidecar unless told. */
const fixture = async (releases: readonly ReleaseSpec[] = [{ tag: "v0.1.0" }]): Promise<Fixture> => {
  const root = mkdtempSync(join(tmpdir(), "agent-harness-install-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const fakeBin = join(root, "fake-bin");
  const assets = join(root, "assets");
  const listed = join(root, "releases");
  const state = join(root, "state");
  for (const dir of [home, fakeBin, assets, listed, state]) mkdirSync(dir, { recursive: true });
  const log = join(root, "calls.log");
  write(log, "");

  write(join(fakeBin, "curl"), FAKE_CURL, 0o755);
  write(join(fakeBin, "uname"), '#!/bin/sh\ncase $1 in -s) echo "${FAKE_UNAME_S:-Linux}" ;; -m) echo "${FAKE_UNAME_M:-x86_64}" ;; esac\n', 0o755);
  write(join(fakeBin, "id"), '#!/bin/sh\necho "${FAKE_UID:-1000}"\n', 0o755);

  const list = [];
  for (const spec of releases) {
    const staging = join(root, "staging", spec.tag);
    mkdirSync(join(staging, "bin"), { recursive: true });
    if (spec.withoutBinary) write(join(staging, "bin", "README"), "no binary here\n");
    else write(join(staging, "bin", "agent-harness"), FAKE_BINARY, 0o755);
    const assetName = spec.assetName ?? "agent-harness-linux-x64.tar.gz";
    mkdirSync(join(assets, spec.tag), { recursive: true });
    const tarball = join(assets, spec.tag, assetName);
    await run("tar", ["-czf", tarball, "-C", staging, "bin"]);
    const names = [assetName];
    const checksum = spec.checksum ?? "right";
    if (checksum !== "none") {
      const digest = checksum === "right" ? createHash("sha256").update(readFileSync(tarball)).digest("hex") : "0".repeat(64);
      write(join(assets, spec.tag, `${assetName}.sha256`), `${digest}  ${assetName}\n`);
      names.push(`${assetName}.sha256`);
    }
    const json = releaseJson(spec, names);
    write(join(listed, `${spec.tag}.json`), JSON.stringify(json));
    list.push(json);
  }
  write(join(listed, "list.json"), JSON.stringify(list));

  const dataDir = join(home, ".local", "state", "agent-harness");
  const env: NodeJS.ProcessEnv = {
    PATH: `${fakeBin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    HOME: home,
    AGENT_HARNESS_TOKEN: TOKEN,
    EXPECTED_TOKEN: TOKEN,
    FAKE_LOG: log,
    FAKE_RELEASES: listed,
    FAKE_ASSETS: assets,
    FAKE_STATE: state,
    FAKE_DATA_DIR: dataDir,
  };
  return {
    home,
    log,
    dataDir,
    state,
    env,
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    forget: () => {
      writeFileSync(log, "");
      rmSync(join(state, "probes"), { force: true });
    },
  };
};

const install = async (f: Fixture, args: string[] = [], env: NodeJS.ProcessEnv = {}) => {
  try {
    const { stdout, stderr } = await run("sh", [script, ...args], { env: { ...f.env, ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
};

/** The line the script ends with: the shim's folder put first on the PATH. */
const pathLine = (dataDir: string) => `  export PATH="${dataDir}/bin:$PATH"\n`;

describe.skipIf(process.platform === "win32")("scripts/install.sh", () => {
  it("prints its usage, naming the token it needs, for --help", async () => {
    const f = await fixture();
    const result = await install(f, ["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Usage: install\.sh/);
    expect(result.stdout).toContain("AGENT_HARNESS_TOKEN");
    expect(f.calls()).toEqual([]);
  });

  it("refuses arguments it cannot parse, and --prefix, which is gone, with its usage and exit 2, before any download", async () => {
    for (const args of [
      ["--nope"],
      ["--prefix", "/tmp/versions"],
      ["--channel"],
      ["--channel", "nightly"],
      ["--version"],
      ["--name"],
      ["--name", ""],
      ["--port"],
      ["--port", "http"],
      ["--port", "0"],
      ["--port", "70000"],
      ["extra"],
    ]) {
      const f = await fixture();
      const result = await install(f, args);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stderr, args.join(" ")).toContain("Usage: install.sh");
      expect(f.calls(), args.join(" ")).toEqual([]);
    }
  });

  it("refuses to run without a token, saying which variable to set, with exit 2", async () => {
    const f = await fixture();
    const result = await install(f, [], { AGENT_HARNESS_TOKEN: "" });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("AGENT_HARNESS_TOKEN");
    expect(f.calls()).toEqual([]);
  });

  it("refuses an INSTALL_READY_TIMEOUT that is no whole number of seconds, or that has a leading zero the shell would read as octal, with exit 2, before any download", async () => {
    for (const timeout of ["soon", "1.5", "08", "010"]) {
      const f = await fixture();
      const result = await install(f, [], { INSTALL_READY_TIMEOUT: timeout });
      expect(result.code, timeout).toBe(2);
      expect(result.stderr, timeout).toContain(`INSTALL_READY_TIMEOUT takes a number of seconds; got ${timeout}.`);
      expect(f.calls(), timeout).toEqual([]);
    }
  });

  it("refuses to run as root before any download or command, since the service runs as the user who installs it", async () => {
    const f = await fixture();
    const result = await install(f, ["--name", "Build box"], { FAKE_UID: "0" });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/refusing to run as root/);
    expect(f.calls()).toEqual([]);
    expect(readdirSync(f.home)).toEqual([]);
  });

  it("refuses a platform it has no artefact name for", async () => {
    const f = await fixture();
    const result = await install(f, [], { FAKE_UNAME_S: "FreeBSD" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("FreeBSD");
    expect(f.calls()).toEqual([]);
  });

  it("keeps the token off every command line, and out of the environment the CLI runs in", async () => {
    const f = await fixture();
    expect((await install(f)).code).toBe(0);
    expect(readFileSync(f.log, "utf8")).not.toContain(TOKEN);
    expect(f.calls()).not.toContain("agent-harness saw AGENT_HARNESS_TOKEN");
    expect(readFileSync(join(f.state, "credential"), "utf8")).toBe(`${TOKEN}\n`);
  });

  it("says the token was refused when the releases API refuses it", async () => {
    const f = await fixture();
    const result = await install(f, [], { EXPECTED_TOKEN: "another-token" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(LIST);
  });

  it("names the artefact and release when the release has no artefact for this platform", async () => {
    const f = await fixture([{ tag: "v0.1.0", assetName: "agent-harness-darwin-arm64.tar.gz" }]);
    const result = await install(f);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("agent-harness-linux-x64.tar.gz");
    expect(result.stderr).toContain("v0.1.0");
  });

  it("names the artefact for macOS on arm64 and unpacks under Application Support", async () => {
    const f = await fixture([{ tag: "v0.1.0", assetName: "agent-harness-darwin-arm64.tar.gz" }]);
    const dataDir = join(f.home, "Library", "Application Support", "agent-harness");
    const result = await install(f, [], { FAKE_UNAME_S: "Darwin", FAKE_UNAME_M: "arm64", XDG_STATE_HOME: "/elsewhere", FAKE_DATA_DIR: dataDir });
    expect(result.code).toBe(0);
    expect(f.calls()[1]).toBe(`curl ${DOWNLOAD}/v0.1.0/agent-harness-darwin-arm64.tar.gz`);
    expect(existsSync(join(dataDir, "versions", "0.1.0", ".complete"))).toBe(true);
    expect(result.stdout.endsWith(pathLine(dataDir))).toBe(true);
  });

  it("unpacks under an absolute XDG_STATE_HOME on Linux, and under ~/.local/state for a relative one", async () => {
    const f = await fixture();
    const xdg = join(f.home, "xdg-state");
    expect((await install(f, [], { XDG_STATE_HOME: xdg, FAKE_DATA_DIR: join(xdg, "agent-harness") })).code).toBe(0);
    expect(existsSync(join(xdg, "agent-harness", "versions", "0.1.0", ".complete"))).toBe(true);
    const g = await fixture();
    expect((await install(g, [], { XDG_STATE_HOME: "relative" })).code).toBe(0);
    expect(existsSync(join(g.dataDir, "versions", "0.1.0", ".complete"))).toBe(true);
  });

  it("reuses a complete version already in the versions directory instead of downloading it again", async () => {
    const f = await fixture();
    expect((await install(f)).code).toBe(0);
    rmSync(join(f.state, "running"));
    f.forget();
    const again = await install(f);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("already unpacked");
    expect(f.calls().filter((call) => call.startsWith("curl https://"))).toEqual([`curl ${LIST}`]);
  });

  it("replaces a version folder without its sentinel, which an interrupted install left, instead of reusing it", async () => {
    const f = await fixture();
    const target = join(f.dataDir, "versions", "0.1.0");
    mkdirSync(join(target, "bin"), { recursive: true });
    writeFileSync(join(target, "bin", "agent-harness"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(target, "stale"), "left by an interrupted install\n");

    const result = await install(f);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("already unpacked");
    expect(readdirSync(target).sort()).toEqual([".complete", "bin"]);
  });

  it("leaves no partial folder behind when the artefact holds no binary", async () => {
    const f = await fixture([{ tag: "v0.1.0", withoutBinary: true }]);
    const result = await install(f);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("bin/agent-harness");
    expect(readdirSync(join(f.dataDir, "versions"))).toEqual([]);
  });

  it("exits 143 when terminated, removing its temporary files", async () => {
    const f = await fixture();
    const tmp = mkdtempSync(join(tmpdir(), "agent-harness-install-tmp-"));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    const child = spawn("sh", [script], { env: { ...f.env, TMPDIR: tmp, FAKE_STARTING_PROBES: "1000", INSTALL_READY_TIMEOUT: "600" } });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    cleanups.push(() => void child.kill("SIGKILL"));
    await vi.waitFor(() => expect(f.calls()).toContain(`curl ${HEALTH}`), { timeout: 10_000 });
    child.kill("SIGTERM");
    expect(await exited).toBe(143);
    // The EXIT trap removed the working directory the download used.
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("installs the stable channel's newest release, starts it, waits for it, hands it the channel and the token, and ends with the pairing and the path line", async () => {
    const f = await fixture();
    const result = await install(f, ["--name", "Build box"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const version = join(f.dataDir, "versions", "0.1.0");
    expect(existsSync(join(version, "bin", "agent-harness"))).toBe(true);
    expect(existsSync(join(version, ".complete"))).toBe(true);
    expect(f.calls()).toEqual([
      `curl ${LIST}`,
      `curl ${DOWNLOAD}/v0.1.0/agent-harness-linux-x64.tar.gz`,
      `curl ${DOWNLOAD}/v0.1.0/agent-harness-linux-x64.tar.gz.sha256`,
      "agent-harness service install --name Build box",
      "agent-harness service start",
      `curl ${HEALTH}`,
      "agent-harness update settings --channel stable",
      "agent-harness update credential --stdin",
      `curl ${DISCOVERY}`,
      "agent-harness pair",
    ]);
    expect(readFileSync(join(f.state, "credential"), "utf8")).toBe(`${TOKEN}\n`);
    expect(result.stdout).toContain("\n  Code: ABCD-EFGH\n");
    expect(result.stdout.indexOf("Code: ABCD-EFGH")).toBeLessThan(result.stdout.indexOf("export PATH="));
    expect(result.stdout.endsWith(pathLine(f.dataDir))).toBe(true);
  });

  it("ends with the Tailscale warning instead of a pairing when the environment binds only loopback, then the path line", async () => {
    const f = await fixture();
    const result = await install(f, [], { FAKE_AUTH_POLICY: "local-only" });
    expect(result.code).toBe(0);
    expect(f.calls().slice(-2)).toEqual(["agent-harness update credential --stdin", `curl ${DISCOVERY}`]);
    expect(f.calls()).not.toContain("agent-harness pair");
    expect(result.stdout).toContain(
      "No Tailscale address found. This machine is reachable only from itself. Install Tailscale to reach it from your other devices.\n",
    );
    expect(result.stdout).not.toContain("Code:");
    expect(result.stdout.indexOf("No Tailscale address found")).toBeLessThan(result.stdout.indexOf("export PATH="));
    expect(result.stdout.endsWith(pathLine(f.dataDir))).toBe(true);
  });

  describe("resolves the channel's newest at run time, by precedence rather than the forge's order, passing over drafts and tags that name no version", () => {
    const listed: ReleaseSpec[] = [
      { tag: "v0.5.0", draft: true },
      { tag: "v0.3.0-beta.9", prerelease: true },
      { tag: "v0.3.0-beta.10", prerelease: true },
      { tag: "nightly" },
      { tag: "v0.2.0" },
      { tag: "v0.2.1" },
      { tag: "v0.3.0-alpha.1", prerelease: true },
      { tag: "v0.2.1+rebuilt" },
    ];
    for (const [channel, tag] of [
      ["stable", "v0.2.1"],
      ["beta", "v0.3.0-beta.10"],
    ] as const) {
      it(`${channel}: ${tag}`, async () => {
        const f = await fixture(listed);
        const result = await install(f, ["--channel", channel]);
        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
        expect(f.calls().slice(0, 3)).toEqual([
          `curl ${LIST}`,
          `curl ${DOWNLOAD}/${tag}/agent-harness-linux-x64.tar.gz`,
          `curl ${DOWNLOAD}/${tag}/agent-harness-linux-x64.tar.gz.sha256`,
        ]);
        expect(f.calls()).toContain(`agent-harness update settings --channel ${channel}`);
        expect(readdirSync(join(f.dataDir, "versions"))).toEqual([tag.slice(1)]);
      });
    }
  });

  it("says so, installing nothing, when the channel has no release", async () => {
    const f = await fixture([{ tag: "v0.3.0-beta.1" }, { tag: "v0.4.0", draft: true }]);
    const result = await install(f, ["--channel", "stable"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("stable");
    expect(f.calls()).toEqual([`curl ${LIST}`]);
  });

  for (const asked of ["0.2.0", "v0.2.0"]) {
    it(`installs the release --version ${asked} names, looked up by its tag, rather than the channel's newest`, async () => {
      const f = await fixture([{ tag: "v0.3.0" }, { tag: "v0.2.0" }]);
      const result = await install(f, ["--version", asked]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(f.calls().slice(0, 4)).toEqual([
        `curl ${API}/tags/v0.2.0`,
        `curl ${DOWNLOAD}/v0.2.0/agent-harness-linux-x64.tar.gz`,
        `curl ${DOWNLOAD}/v0.2.0/agent-harness-linux-x64.tar.gz.sha256`,
        "agent-harness service install",
      ]);
      expect(f.calls()).not.toContainEqual(expect.stringMatching(/update apply/));
      expect(readdirSync(join(f.dataDir, "versions"))).toEqual(["0.2.0"]);
    });
  }

  it("refuses a --version that is no release version as a usage error, and one whose release is a draft or missing, installing nothing", async () => {
    const f = await fixture([{ tag: "v0.2.0", draft: true }]);
    for (const version of ["0.2", "01.2.0", "0.2.0\nextra"]) {
      const malformed = await install(f, ["--version", version]);
      expect(malformed.code, version).toBe(2);
      expect(malformed.stderr, version).toContain("--version takes a release version");
      expect(f.calls(), version).toEqual([]);
    }

    for (const version of ["0.2.0", "0.9.0"]) {
      f.forget();
      const result = await install(f, ["--version", version]);
      expect(result.code, version).toBe(1);
      expect(result.stderr, version).toContain(`v${version}`);
      expect(f.calls(), version).toEqual([`curl ${API}/tags/v${version}`]);
    }
  });

  for (const checksum of ["wrong", "none"] as const) {
    it(`installs nothing when the artefact's SHA-256 ${checksum === "wrong" ? "is not the published digest" : "has no published digest"}`, async () => {
      const f = await fixture([{ tag: "v0.1.0", checksum }]);
      const result = await install(f);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/nothing was installed/);
      expect(result.stderr).toContain("agent-harness-linux-x64.tar.gz");
      expect(f.calls()).toEqual(
        checksum === "wrong"
          ? [`curl ${LIST}`, `curl ${DOWNLOAD}/v0.1.0/agent-harness-linux-x64.tar.gz`, `curl ${DOWNLOAD}/v0.1.0/agent-harness-linux-x64.tar.gz.sha256`]
          : [`curl ${LIST}`],
      );
      expect(existsSync(join(f.dataDir, "versions", "0.1.0"))).toBe(false);
    });
  }

  it("waits while the environment says it is starting, probing the health URL until it says ready", async () => {
    const f = await fixture();
    const result = await install(f, [], { FAKE_STARTING_PROBES: "1" });
    expect(result.code).toBe(0);
    expect(f.calls().slice(4, 8)).toEqual(["agent-harness service start", `curl ${HEALTH}`, `curl ${HEALTH}`, "agent-harness update settings --channel stable"]);
  });

  it("fails naming the service's log when the health URL does not say ready in time, and goes no further", async () => {
    const f = await fixture();
    const dataDir = join(f.home, "data");
    const result = await install(f, ["--data-dir", dataDir, "--port", "7500"], { FAKE_STARTING_PROBES: "1000", INSTALL_READY_TIMEOUT: "0" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("http://127.0.0.1:7500/health");
    expect(result.stderr).toContain(join(dataDir, "logs", "service.log"));
    expect(f.calls()).toEqual([
      `curl ${LIST}`,
      `curl ${DOWNLOAD}/v0.1.0/agent-harness-linux-x64.tar.gz`,
      `curl ${DOWNLOAD}/v0.1.0/agent-harness-linux-x64.tar.gz.sha256`,
      `agent-harness service install --data-dir ${dataDir} --port 7500`,
      "agent-harness service start",
      "curl http://127.0.0.1:7500/health",
    ]);
  });

  for (const how of [
    { name: "--dry-run", args: ["--dry-run", "--name", "Build box"], env: {} },
    { name: "INSTALL_DRY_RUN=1", args: ["--name", "Build box"], env: { INSTALL_DRY_RUN: "1" } },
  ]) {
    it(`resolves the release and prints the plan without downloading or changing anything, for ${how.name}`, async () => {
      const f = await fixture();
      const result = await install(f, how.args, how.env);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(f.calls()).toEqual([`curl ${LIST}`]);
      const bin = join(f.dataDir, "versions", "0.1.0", "bin", "agent-harness");
      expect(result.stdout).toBe(
        [
          "Release: v0.1.0",
          `Download: ${DOWNLOAD}/v0.1.0/agent-harness-linux-x64.tar.gz`,
          `Digest: ${DOWNLOAD}/v0.1.0/agent-harness-linux-x64.tar.gz.sha256`,
          `Unpack into: ${join(f.dataDir, "versions", "0.1.0")}`,
          "Then:",
          `  ${bin} service install --name 'Build box'`,
          `  ${bin} service start`,
          `  wait up to 60 seconds for ${HEALTH} to say ready`,
          `  ${bin} update settings --channel stable`,
          `  ${bin} update credential --stdin`,
          `  ${bin} pair, or the Tailscale warning when only loopback is bound`,
          "Dry run: nothing was downloaded or changed.",
          "",
        ].join("\n"),
      );
      expect(readdirSync(f.home)).toEqual([]);
    });
  }

  it("prints the plan of a re-run over a running service for --dry-run, changing nothing", async () => {
    const f = await fixture([{ tag: "v0.1.0" }, { tag: "v0.2.0" }]);
    expect((await install(f, ["--version", "0.1.0"])).code).toBe(0);
    f.forget();
    const result = await install(f, ["--dry-run", "--version", "0.2.0"]);
    expect(result.code).toBe(0);
    expect(f.calls()).toEqual(["shim service status --json"]);
    const shim = join(f.dataDir, "bin", "agent-harness");
    expect(result.stdout).toContain(`Then:\n  ${shim} service install\n  wait up to 60 seconds for ${HEALTH} to say ready\n`);
    expect(result.stdout).toContain(`  ${shim} update apply --version 0.2.0\n`);
    expect(result.stdout).toMatch(/Dry run: nothing was downloaded or changed\.\n$/);
  });

  describe("run again over a running service", () => {
    it("downloads and unpacks nothing, repairs the definition and the entry through the shim's service install, and ends with a new pairing", async () => {
      const f = await fixture([{ tag: "v0.1.0" }, { tag: "v0.2.0" }]);
      expect((await install(f, ["--version", "0.1.0"])).code).toBe(0);
      f.forget();

      const result = await install(f, ["--name", "Build box", "--channel", "beta"]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(f.calls()).toEqual([
        "shim service status --json",
        "shim service install --name Build box",
        `curl ${HEALTH}`,
        "shim update settings --channel beta",
        "shim update credential --stdin",
        `curl ${DISCOVERY}`,
        "shim pair",
      ]);
      expect(readFileSync(join(f.state, "credential"), "utf8")).toBe(`${TOKEN}\n`);
      expect(readdirSync(join(f.dataDir, "versions"))).toEqual(["0.1.0"]);
      expect(result.stdout).toContain("\n  Code: ABCD-EFGH\n");
      expect(result.stdout.endsWith(pathLine(f.dataDir))).toBe(true);
    });

    it("asks for the version --version names through update apply, which stages it as any update", async () => {
      const f = await fixture([{ tag: "v0.1.0" }, { tag: "v0.2.0" }]);
      const dataDir = join(f.home, "data");
      expect((await install(f, ["--version", "0.1.0", "--data-dir", dataDir])).code).toBe(0);
      f.forget();

      const result = await install(f, ["--version", "v0.2.0", "--data-dir", dataDir]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(f.calls()).toEqual([
        `shim service status --json --data-dir ${dataDir}`,
        `shim service install --data-dir ${dataDir}`,
        `curl ${HEALTH}`,
        `shim update settings --channel stable --data-dir ${dataDir}`,
        `shim update credential --stdin --data-dir ${dataDir}`,
        `shim update apply --version 0.2.0 --data-dir ${dataDir}`,
        `curl ${DISCOVERY}`,
        `shim pair --data-dir ${dataDir}`,
      ]);
      expect(readdirSync(join(dataDir, "versions"))).toEqual(["0.1.0"]);
    });

    it("installs as a first install does when the service is installed but stopped", async () => {
      const f = await fixture([{ tag: "v0.1.0" }, { tag: "v0.2.0" }]);
      expect((await install(f, ["--version", "0.1.0"])).code).toBe(0);
      rmSync(join(f.state, "running"));
      f.forget();

      const result = await install(f);
      expect(result.code).toBe(0);
      expect(f.calls().slice(0, 6)).toEqual([
        "shim service status --json",
        `curl ${LIST}`,
        `curl ${DOWNLOAD}/v0.2.0/agent-harness-linux-x64.tar.gz`,
        `curl ${DOWNLOAD}/v0.2.0/agent-harness-linux-x64.tar.gz.sha256`,
        "agent-harness service install",
        "agent-harness service start",
      ]);
      expect(readdirSync(join(f.dataDir, "versions")).sort()).toEqual(["0.1.0", "0.2.0"]);
    });
  });
});
