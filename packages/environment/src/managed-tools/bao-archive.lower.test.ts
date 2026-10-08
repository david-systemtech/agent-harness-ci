import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BAO_ARCHIVE_UPDATE_POSIX } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
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
const machine = (checksum: "matching" | "wrong") => {
  const root = realpathSync(tempDir());
  const [fakes, bin, opt, release, build] = ["fakes", "bin", "opt", "release", "build"].map((name) => join(root, name)) as [string, string, string, string, string];
  for (const directory of [fakes, bin, opt, release, build]) mkdirSync(directory);
  script(join(opt, "bao"), "OpenBao v2.1.1");
  symlinkSync(join(opt, "bao"), join(bin, "bao"));
  script(join(build, "bao"), "OpenBao v9.9.9");
  execFileSync("tar", ["-czf", join(release, ARCHIVE), "-C", build, "bao"]);
  const sum = checksum === "matching" ? createHash("sha256").update(readFileSync(join(release, ARCHIVE))).digest("hex") : "0".repeat(64);
  writeFileSync(join(release, "checksums.txt"), `${"1".repeat(64)}  openbao_9.9.9_darwin_arm64.tar.gz\n${sum}  ${ARCHIVE}\n`);
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
  writeFileSync(join(fakes, "uname"), '#!/bin/sh\ncase $1 in -s) echo Linux ;; -m) echo x86_64 ;; esac\n');
  for (const fake of ["curl", "uname"]) chmodSync(join(fakes, fake), 0o755);
  const update = () => spawnSync("sh", ["-c", BAO_ARCHIVE_UPDATE_POSIX], { encoding: "utf8", env: { PATH: `${fakes}:${bin}:/usr/bin:/bin`, HOME: root } });
  const version = () => execFileSync(join(bin, "bao"), { encoding: "utf8" }).trim();
  return { update, version, opt };
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
