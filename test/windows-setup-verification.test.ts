import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { packZip } from "../packages/cli/scripts/release/archive.js";
import { releaseWorkflowInput } from "./release-workflow-input.js";

const root = join(import.meta.dirname, "..");
const run = promisify(execFile);
const fixture = join(import.meta.dirname, "fixtures/windows-payload-arm64.7z");
const expected = '{"name":"@agent-harness/contracts"}\n';
const lines = releaseWorkflowInput(root).hosted.split("\n");
const start = lines.indexOf("      - name: The setup carries its server dependencies");
const end = lines.findIndex((line, i) => i > start && line.startsWith("      - "));
const command = lines.slice(start, end).join("\n").split("        run: |\n")[1]?.split("\n").map((line) => line.slice(10)).join("\n") ?? "";
let scratch = "";
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

/** The transport and readers are faked; the inner fixture really uses ARM64 + LZMA2.
 * The supported reader models that tool's external contract, while 7z models the failing old reader.
 * The hash wrapper substitutes only the fixture's digest for the published pin and checks real bytes.
 * Real reader interoperability is checked when the hosted job extracts the actual setup. */
const setup = (payload?: Uint8Array) => {
  scratch = mkdtempSync(join(tmpdir(), "windows-setup-reader-"));
  const wrapper = join(scratch, "wrapper/$PLUGINSDIR");
  mkdirSync(wrapper, { recursive: true });
  if (payload) writeFileSync(join(wrapper, "app-64.7z"), payload);
  else copyFileSync(fixture, join(wrapper, "app-64.7z"));
  mkdirSync(join(scratch, "desktop"));
  packZip(join(scratch, "wrapper"), join(scratch, "desktop/agent-harness-desktop-win32-x64-setup.exe"));
  mkdirSync(join(scratch, "scripts"));
  const bootstrap = join(root, "scripts/7zip.sh");
  if (existsSync(bootstrap)) copyFileSync(bootstrap, join(scratch, "scripts/7zip.sh"));
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  const tools = join(scratch, "reader");
  mkdirSync(tools);
  writeFileSync(join(tools, "7zz"), `#!/bin/sh
case "$3" in
  desktop/*) mkdir -p 'unpacked-setup/$PLUGINSDIR'; cp "$WRAPPED_PAYLOAD" 'unpacked-setup/$PLUGINSDIR/app-64.7z' ;;
  *)
    cmp -s "$PAYLOAD_FIXTURE" "$3" || { echo 'damaged payload' >&2; exit 2; }
    mkdir -p unpacked-windows/resources/server/node_modules/@agent-harness/contracts
    printf '%s\\n' '{"name":"@agent-harness/contracts"}' > unpacked-windows/resources/server/node_modules/@agent-harness/contracts/package.json
    ;;
esac
`);
  chmodSync(join(tools, "7zz"), 0o755);
  const tarball = join(scratch, "reader.tar.xz");
  execFileSync("tar", ["-cJf", tarball, "-C", tools, "7zz"]);
  const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  const pin = /arch=(?:x64|arm64) sha256=([a-f0-9]{64})/g;
  const pins = [...readFileSync(bootstrap, "utf8").matchAll(pin)].map((match) => match[1] ?? "");
  const realChecksum = execFileSync("sh", ["-c", "command -v sha256sum"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "sha256sum"), `#!/bin/sh
sed ${pins.map((pin) => `-e 's/${pin}/${digest}/g'`).join(" ")} | "${realChecksum}" "$@"
`);
  writeFileSync(join(bin, "curl"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then shift; cp "$READER_TARBALL" "$1"; exit 0; fi
  shift
done
exit 1
`);
  // Reproduce the failing reader without installing system packages: its wrapper extraction
  // succeeds, but it cannot decode the ARM64-filtered payload. No apt call leaves the fixture.
  writeFileSync(join(bin, "apt-get"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(bin, "7z"), `#!/bin/sh
case "$3" in
  desktop/*) mkdir -p 'unpacked-setup/$PLUGINSDIR'; cp "$WRAPPED_PAYLOAD" 'unpacked-setup/$PLUGINSDIR/app-64.7z' ;;
  *) echo 'ERROR: Unsupported Method: ARM64' >&2; exit 2 ;;
esac
`);
  for (const name of ["apt-get", "7z", "curl", "sha256sum"]) chmodSync(join(bin, name), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env["PATH"]}`, RUNNER_TEMP: scratch, PAYLOAD_FIXTURE: fixture,
    SEVENZIP_CACHE: join(scratch, "cache"), READER_TARBALL: tarball, WRAPPED_PAYLOAD: join(wrapper, "app-64.7z") };
};

describe.skipIf(process.platform !== "linux")("the Windows setup's dependency verification", () => {
  it("selects a compatible reader for the ARM64 payload and checks its contracts file", async () => {
    expect(start).toBeGreaterThan(-1);
    const env = setup();
    await run("bash", ["-euo", "pipefail", "-c", command], { cwd: scratch, env });
    expect(readFileSync(join(scratch, "unpacked-windows/resources/server/node_modules/@agent-harness/contracts/package.json"), "utf8")).toBe(expected);
  });

  it("fails verification when the payload cannot be extracted", async () => {
    const env = setup(Buffer.from("damaged payload"));
    await expect(run("bash", ["-euo", "pipefail", "-c", command], { cwd: scratch, env })).rejects.toMatchObject({ code: 2 });
    expect(existsSync(join(scratch, "unpacked-windows/resources/server/node_modules/@agent-harness/contracts/package.json"))).toBe(false);
  });

  it("refuses a damaged cached reader and a replacement that does not match its pin", async () => {
    const env = setup();
    const cache = join(scratch, "cache");
    mkdirSync(cache);
    const name = `7z2603-linux-${process.arch === "arm64" ? "arm64" : "x64"}.tar.xz`;
    writeFileSync(join(cache, name), "damaged cache");
    writeFileSync(join(scratch, "bin/curl"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then shift; printf 'damaged replacement' > "$1"; exit 0; fi
  shift
done
exit 1
`);
    chmodSync(join(scratch, "bin/curl"), 0o755);
    await expect(run("bash", ["scripts/7zip.sh"], { cwd: scratch, env: { ...env, SEVENZIP_CACHE: cache } })).rejects.toMatchObject({ code: 1 });
    expect(readdirSync(cache)).toEqual([name]);
    expect(readFileSync(join(cache, name), "utf8")).toBe("damaged cache");
    expect(readdirSync(scratch).some((name) => name.startsWith("7zip-"))).toBe(false);
  });
});
