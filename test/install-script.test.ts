/**
 * The headless install script, run by `sh` against a fake `curl`, `uname` and
 * `id` on PATH and a fake release: nothing here touches the network, and the
 * artefact's `agent-harness` only records how it was called.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "..", "scripts", "install.sh");
const run = promisify(execFile);

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const FORGE = "https://git.systemtech.dev:5526";
const API = `${FORGE}/api/v1/repos/david/agent-harness/releases`;
const TOKEN = "forgejo-read-token";

const write = (path: string, text: string, mode = 0o644) => {
  writeFileSync(path, text);
  chmodSync(path, mode);
};

/** A fake curl: logs its URL and arguments, checks the token arrives on stdin, and serves the fake release. */
const FAKE_CURL = `#!/bin/sh
out=""
url=""
config=""
while [ $# -gt 0 ]; do
  case $1 in
    -o) out=$2; shift 2 ;;
    -K) config=$(cat); shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf 'curl %s\\n' "$url" >> "$FAKE_LOG"
case $config in
  *"Authorization: token $EXPECTED_TOKEN"*) ;;
  *) echo "curl: (22) The requested URL returned error: 401" >&2; exit 22 ;;
esac
case $url in
  */releases/latest|*/releases/tags/*)
    [ -f "$FAKE_RELEASE" ] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
    cat "$FAKE_RELEASE" ;;
  */releases/download/*)
    name=\${url##*/}
    [ -f "$FAKE_ASSETS/$name" ] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
    cp "$FAKE_ASSETS/$name" "$out" ;;
  *) echo "curl: (6) Could not resolve host" >&2; exit 6 ;;
esac
`;

/** The artefact's binary: records each call, and answers service status with FAKE_STATUS_CODE. */
const FAKE_BINARY = `#!/bin/sh
printf 'agent-harness %s\\n' "$*" >> "$FAKE_LOG"
if [ "$1 $2" = "service status" ]; then
  echo "Ready: yes"
  exit "\${FAKE_STATUS_CODE:-0}"
fi
`;

interface Fixture {
  home: string;
  log: string;
  assets: string;
  env: NodeJS.ProcessEnv;
  calls: () => string[];
}

const release = (tag: string, assets: string[]) =>
  JSON.stringify({
    id: 7,
    tag_name: tag,
    target_commitish: "main",
    name: `agent-harness ${tag}`,
    body: 'Notes, with commas, and a quoted \\"tag_name\\": \\"v6.6.6\\" in them.',
    url: `${API}/7`,
    assets: assets.map((name, i) => ({
      id: 10 + i,
      name,
      size: 1,
      browser_download_url: `${FORGE}/david/agent-harness/releases/download/${tag}/${name}`,
    })),
  });

/** A home, a fake PATH and a fake release `tag` holding a Linux x64 artefact and, unless told, its checksum. */
const fixture = async (
  tag = "v0.1.0",
  options: { checksum?: "right" | "wrong" | "none"; assetName?: string } = {},
): Promise<Fixture> => {
  const root = mkdtempSync(join(tmpdir(), "agent-harness-install-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const fakeBin = join(root, "fake-bin");
  const assets = join(root, "assets");
  const staging = join(root, "staging");
  for (const dir of [home, fakeBin, assets, join(staging, "bin")]) mkdirSync(dir, { recursive: true });
  const log = join(root, "calls.log");
  write(log, "");

  write(join(fakeBin, "curl"), FAKE_CURL, 0o755);
  write(join(fakeBin, "uname"), '#!/bin/sh\ncase $1 in -s) echo "${FAKE_UNAME_S:-Linux}" ;; -m) echo "${FAKE_UNAME_M:-x86_64}" ;; esac\n', 0o755);
  write(join(fakeBin, "id"), '#!/bin/sh\necho "${FAKE_UID:-1000}"\n', 0o755);

  const assetName = options.assetName ?? "agent-harness-linux-x64.tar.gz";
  write(join(staging, "bin", "agent-harness"), FAKE_BINARY, 0o755);
  const tarball = join(assets, assetName);
  const names = [assetName];
  await run("tar", ["-czf", tarball, "-C", staging, "bin"]);
  const checksum = options.checksum ?? "right";
  if (checksum !== "none") {
    const digest = checksum === "right" ? createHash("sha256").update(readFileSync(tarball)).digest("hex") : "0".repeat(64);
    write(join(assets, `${assetName}.sha256`), `${digest}  ${assetName}\n`);
    names.push(`${assetName}.sha256`);
  }
  write(join(root, "release.json"), release(tag, names));
  const env: NodeJS.ProcessEnv = {
    PATH: `${fakeBin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    HOME: home,
    AGENT_HARNESS_TOKEN: TOKEN,
    EXPECTED_TOKEN: TOKEN,
    FAKE_LOG: log,
    FAKE_RELEASE: join(root, "release.json"),
    FAKE_ASSETS: assets,
  };
  return { home, log, assets, env, calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean) };
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

describe.skipIf(process.platform === "win32")("scripts/install.sh", () => {
  it("prints its usage, naming the token it needs, for --help", async () => {
    const f = await fixture();
    const result = await install(f, ["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Usage: install\.sh/);
    expect(result.stdout).toContain("AGENT_HARNESS_TOKEN");
    expect(f.calls()).toEqual([]);
  });

  it("refuses arguments it cannot parse with its usage and exit 2, before any download", async () => {
    for (const args of [["--nope"], ["--version"], ["--port"], ["--port", "http"], ["--port", "0"], ["--port", "70000"], ["--prefix"], ["extra"]]) {
      const f = await fixture();
      const result = await install(f, args);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stderr, args.join(" ")).toContain("Usage: install.sh");
      expect(f.calls()).toEqual([]);
    }
  });

  it("refuses to run without a token, saying which variable to set, with exit 2", async () => {
    const f = await fixture();
    const result = await install(f, [], { AGENT_HARNESS_TOKEN: "" });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("AGENT_HARNESS_TOKEN");
    expect(f.calls()).toEqual([]);
  });

  it("refuses to run as root, since the service runs as the user who installs it", async () => {
    const f = await fixture();
    const result = await install(f, [], { FAKE_UID: "0" });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/root/);
    expect(f.calls()).toEqual([]);
  });

  it("refuses a platform it has no artefact name for", async () => {
    const f = await fixture();
    const result = await install(f, [], { FAKE_UNAME_S: "FreeBSD" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("FreeBSD");
    expect(f.calls()).toEqual([]);
  });

  for (const how of [
    { name: "--dry-run", args: ["--dry-run"], env: {} },
    { name: "INSTALL_DRY_RUN=1", args: [], env: { INSTALL_DRY_RUN: "1" } },
  ]) {
    it(`resolves the latest release and prints the plan without downloading or changing anything, for ${how.name}`, async () => {
      const f = await fixture("v0.1.0");
      const result = await install(f, how.args, how.env);
      expect(result.code).toBe(0);
      expect(f.calls()).toEqual([`curl ${API}/latest`]);
      expect(result.stdout).toContain("Release: v0.1.0\n");
      expect(result.stdout).toContain(
        `Download: ${FORGE}/david/agent-harness/releases/download/v0.1.0/agent-harness-linux-x64.tar.gz\n`,
      );
      expect(result.stdout).toContain(`Checksum: ${FORGE}/david/agent-harness/releases/download/v0.1.0/agent-harness-linux-x64.tar.gz.sha256\n`);
      const target = join(f.home, ".local", "share", "agent-harness", "0.1.0");
      expect(result.stdout).toContain(`Unpack into: ${target}\n`);
      expect(result.stdout).toContain(`${target}/bin/agent-harness service install\n`);
      expect(result.stdout).toContain(`${target}/bin/agent-harness service start\n`);
      expect(result.stdout).toContain(`${target}/bin/agent-harness service status\n`);
      expect(result.stdout).toMatch(/Dry run: nothing was downloaded or changed\.\n$/);
      expect(readdirSync(f.home)).toEqual([]);
    });
  }

  it("keeps the token out of curl's arguments", async () => {
    const f = await fixture();
    await install(f, ["--dry-run"]);
    expect(readFileSync(f.log, "utf8")).not.toContain(TOKEN);
  });

  it("looks up the tag it is given, and names the artefact for macOS on arm64", async () => {
    const f = await fixture("v0.2.0", { assetName: "agent-harness-darwin-arm64.tar.gz" });
    const result = await install(f, ["--version", "v0.2.0", "--dry-run"], { FAKE_UNAME_S: "Darwin", FAKE_UNAME_M: "arm64" });
    expect(result.code).toBe(0);
    expect(f.calls()).toEqual([`curl ${API}/tags/v0.2.0`]);
    expect(result.stdout).toContain("/v0.2.0/agent-harness-darwin-arm64.tar.gz\n");
  });

  it("downloads, verifies and unpacks the artefact, then installs, starts and reports the service", async () => {
    const f = await fixture("v0.1.0");
    const result = await install(f, ["--port", "7500", "--data-dir", "/srv/my data"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const target = join(f.home, ".local", "share", "agent-harness", "0.1.0");
    expect(existsSync(join(target, "bin", "agent-harness"))).toBe(true);
    expect(f.calls()).toEqual([
      `curl ${API}/latest`,
      `curl ${FORGE}/david/agent-harness/releases/download/v0.1.0/agent-harness-linux-x64.tar.gz`,
      `curl ${FORGE}/david/agent-harness/releases/download/v0.1.0/agent-harness-linux-x64.tar.gz.sha256`,
      "agent-harness service install --data-dir /srv/my data --port 7500",
      "agent-harness service start",
      "agent-harness service status --port 7500",
      "agent-harness service status --port 7500",
    ]);
    expect(result.stdout).toMatch(/Ready: yes\n$/);
    expect(readdirSync(join(f.home, ".local", "share", "agent-harness"))).toEqual(["0.1.0"]);
  });

  it("unpacks under --prefix when given one", async () => {
    const f = await fixture();
    const prefix = join(f.home, "versions");
    expect((await install(f, ["--prefix", prefix])).code).toBe(0);
    expect(existsSync(join(prefix, "0.1.0", "bin", "agent-harness"))).toBe(true);
  });

  it("installs without verifying when no checksum is published, and says so", async () => {
    const f = await fixture("v0.1.0", { checksum: "none" });
    const result = await install(f);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No checksum is published");
  });

  it("stops before unpacking or installing when the checksum does not match", async () => {
    const f = await fixture("v0.1.0", { checksum: "wrong" });
    const result = await install(f);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/checksum/i);
    expect(existsSync(join(f.home, ".local", "share", "agent-harness", "0.1.0"))).toBe(false);
    expect(f.calls().filter((call) => call.startsWith("agent-harness"))).toEqual([]);
  });

  it("names the artefact and release when the release has no artefact for this platform", async () => {
    const f = await fixture("v0.1.0", { assetName: "agent-harness-darwin-arm64.tar.gz" });
    const result = await install(f);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("agent-harness-linux-x64.tar.gz");
    expect(result.stderr).toContain("v0.1.0");
  });

  it("says the token was refused when the releases API refuses it", async () => {
    const f = await fixture();
    const result = await install(f, [], { EXPECTED_TOKEN: "another-token" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${API}/latest`);
  });

  it("ends with the service's status and its exit code when the service never becomes ready", async () => {
    const f = await fixture();
    const result = await install(f, [], { FAKE_STATUS_CODE: "3", INSTALL_READY_TIMEOUT: "0" });
    expect(result.code).toBe(3);
    expect(result.stdout).toMatch(/Ready: yes\n$/);
  });

  it("reuses a version that is already unpacked instead of downloading it again", async () => {
    const f = await fixture();
    expect((await install(f)).code).toBe(0);
    writeFileSync(f.log, "");
    const again = await install(f);
    expect(again.code).toBe(0);
    expect(f.calls()[0]).toBe(`curl ${API}/latest`);
    expect(f.calls().filter((call) => call.startsWith("curl"))).toHaveLength(1);
    expect(again.stdout).toContain("already unpacked");
  });
});
