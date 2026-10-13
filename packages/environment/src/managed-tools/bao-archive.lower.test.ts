import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { BAO_ARCHIVE_UPDATE_POSIX, installChoice } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { commandLine } from "./command-line.js";
import { useCleanups } from "../../test/cleanups.js";

/**
 * A bare `bao`'s Update (#1833), below the wire: the table's script run by
 * `sh` against a fake `curl` and `uname` that serve a release from a
 * folder, with the real `tar`, `awk`, `sha256sum` and `install`. It puts
 * the archive's `bao` where the current one resolves to once the
 * archive's SHA-256 matches the release's `checksums.txt`, and replaces
 * nothing when it does not. Nothing is downloaded.
 */

const { tempDir } = useCleanups();

const RELEASE = "v9.9.9";
const ARCHIVE = "openbao_9.9.9_linux_amd64.tar.gz";

/** A program that prints `text` when run. */
const script = (file: string, text: string): void => {
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${text}'\n`);
  chmodSync(file, 0o755);
};

/**
 * A machine with a bare `bao` linked from `bin` to `opt`, and a release
 * folder holding the archive (its `bao` printing the new version) and a
 * `checksums.txt` that matches it, or not.
 */
const machine = (checksum: "matching" | "wrong", installed = true, platform: "linux" | "darwin" = "linux", hash: "sha256sum" | "shasum" = "sha256sum") => {
  const root = join(realpathSync(tempDir()), "home with spaces");
  mkdirSync(root);
  const [fakes, bin, opt, release, build] = ["fakes", "bin", "opt", "release", "build"].map((name) => join(root, name)) as [string, string, string, string, string];
  for (const directory of [fakes, bin, opt, release, build]) mkdirSync(directory);
  if (installed) {
    script(join(opt, "bao"), "OpenBao v2.1.1");
    symlinkSync(join(opt, "bao"), join(bin, "bao"));
  }
  const archive = platform === "linux" ? ARCHIVE : "openbao_9.9.9_darwin_arm64.tar.gz";
  script(join(build, "bao"), "OpenBao v9.9.9");
  execFileSync("tar", ["-czf", join(release, archive), "-C", build, "bao"]);
  const sum = checksum === "matching" ? createHash("sha256").update(readFileSync(join(release, archive))).digest("hex") : "0".repeat(64);
  writeFileSync(join(release, "checksums.txt"), `${"1".repeat(64)}  unrelated.tar.gz\n${sum}  ${archive}\n`);
  // curl: the latest release's redirect for -w, else the file the URL names, from the release folder; uname: Linux on x86_64.
  writeFileSync(
    join(fakes, "curl"),
    [
      "#!/bin/sh",
      'out=""; url=""; effective=""',
      'while [ $# -gt 0 ]; do case $1 in -o) out=$2; shift 2 ;; -w) effective=1; shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done',
      `[ -n "$effective" ] && { printf '%s' "https://github.com/openbao/openbao/releases/tag/${RELEASE}"; exit 0; }`,
      `case $url in https://github.com/openbao/openbao/releases/download/${RELEASE}/*) cp "${release}/\${url##*/}" "$out" ;; *) echo "unexpected $url" >&2; exit 22 ;; esac`,
    ].join("\n"),
  );
  writeFileSync(join(fakes, "uname"), `#!/bin/sh\ncase $1 in -s) echo ${platform === "linux" ? "Linux" : "Darwin"} ;; -m) echo ${platform === "linux" ? "x86_64" : "arm64"} ;; esac\n`);
  for (const fake of ["curl", "uname"]) chmodSync(join(fakes, fake), 0o755);
  // A minimal PATH: the requested checksum program, ordinary POSIX utilities, no sudo or package manager.
  for (const name of ["sh", "tar", "gzip", "awk", "mktemp", "rm", "mkdir", "cp", "chmod", "readlink", "dirname", "install", hash]) {
    const executable = execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
    symlinkSync(executable, join(fakes, name));
  }
  const env = { PATH: `${fakes}:${bin}`, HOME: root, SHELL: "/bin/sh", TMPDIR: root };
  const selected = installChoice("bao", platform, (name) => existsSync(join(fakes, name)));
  const install = () => {
    if (selected?.install == null) throw new Error("No archive install method");
    return spawnSync("sh", ["-c", commandLine(selected.install, platform)], { encoding: "utf8", env });
  };
  const loginVersion = () => execFileSync("sh", ["-c", '. "$HOME/.profile"; bao'], { encoding: "utf8", env }).trim();
  const update = () => spawnSync("sh", ["-c", BAO_ARCHIVE_UPDATE_POSIX], { encoding: "utf8", env });
  const version = () => execFileSync(join(bin, "bao"), { encoding: "utf8" }).trim();
  return { update, install, loginVersion, version, opt, root, archive, env };
};

describe.runIf(process.platform === "linux")("a bare bao's Update", () => {
  it("installs the release archive's bao over the file the current one resolves to, once its checksum matches", () => {
    const { update, version, opt } = machine("matching");
    const ran = update();
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain(`Installed OpenBao 9.9.9 at ${join(opt, "bao")}.`);
    expect(version()).toBe("OpenBao v9.9.9");
  });

  it("replaces nothing when the archive's checksum does not match the release's, saying so", () => {
    const { update, version } = machine("wrong");
    const ran = update();
    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain(`The checksum of ${ARCHIVE} does not match the release checksums: nothing was replaced.`);
    expect(version()).toBe("OpenBao v2.1.1");
  });
});

describe.runIf(process.platform === "linux")("bao's archive Install", () => {
  it.each(["linux", "darwin"] as const)("installs on %s with either checksum program and makes bao visible to the next login probe", (platform) => {
    for (const hash of ["sha256sum", "shasum"] as const) {
      const { install, loginVersion, root } = machine("matching", false, platform, hash);
      const ran = install();
      expect(ran.stderr).toBe("");
      expect(ran.status).toBe(0);
      expect(loginVersion()).toBe("OpenBao v9.9.9");
      expect(existsSync(join(root, ".local/bin/bao"))).toBe(true);
    }
  });

  it.each([
    ["/bin/bash", ".bash_profile"],
    ["/bin/bash", ".bash_login"],
    ["/bin/zsh", ".zprofile"],
  ])("keeps the existing %s login profile and makes the user bin visible through %s", (shell, profile) => {
    const { install, env, root } = machine("matching", false);
    env.SHELL = shell;
    writeFileSync(join(root, profile), "# existing user settings\n");
    const ran = install();
    expect(ran.status).toBe(0);
    expect(readFileSync(join(root, profile), "utf8")).toMatch(/^# existing user settings\n/);
    const path = execFileSync("sh", ["-c", `. "$HOME/${profile}"; command -v bao`], { env, encoding: "utf8" }).trim();
    expect(path).toBe(join(root, ".local/bin/bao"));
  });

  it("runs the release smoke against the same command table and a local release fixture", () => {
    const { env } = machine("matching", false);
    const server = resolve(import.meta.dirname, "../../../..");
    const tsx = createRequire(import.meta.url).resolve("tsx");
    const ran = spawnSync(process.execPath, ["--conditions=@agent-harness/source", "--import", tsx,
      join(server, "scripts/check-packaged-bao-install.mjs"), server], { encoding: "utf8", env });
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("Verified packaged bao archive install: checksum checked, no sudo, user-local binary on the login PATH");
  });

  it("installs nothing and leaves the profile alone when the checksum is wrong", () => {
    const { install, root, archive } = machine("wrong", false);
    const ran = install();
    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain(`The checksum of ${archive} does not match`);
    expect(existsSync(join(root, ".local/bin/bao"))).toBe(false);
    expect(existsSync(join(root, ".profile"))).toBe(false);
  });
});
