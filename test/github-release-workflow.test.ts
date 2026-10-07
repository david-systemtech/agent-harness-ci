import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { releaseWorkflowInput } from "./release-workflow-input.js";

const root = join(import.meta.dirname, "..");
const { hosted: workflow, recovery } = releaseWorkflowInput(root);
const lines = workflow.split("\n");
const run = promisify(execFile);
const jobs = new Map<string, string[]>();
let current: string[] | undefined;
for (const line of lines.slice(lines.indexOf("jobs:") + 1)) {
  const name = /^ {2}([a-z-]+):$/.exec(line)?.[1];
  if (name) jobs.set(name, (current = []));
  else current?.push(line);
}
const job = (name: string) => jobs.get(name) ?? [];
const step = (name: string, title: string) => {
  const body = job(name);
  const start = body.indexOf(`      - name: ${title}`);
  expect(start, title).toBeGreaterThan(-1);
  const end = body.findIndex((line, i) => i > start && line.startsWith("      - "));
  return body.slice(start, end === -1 ? undefined : end).join("\n");
};
/** The jobs `name` names in its `needs:`, directly. */
const needs = (name: string): string[] => {
  const line = job(name).find((entry) => entry.startsWith("    needs: ")) ?? "";
  return line.slice("    needs: ".length).replace(/^\[|\]$/g, "").split(",").map((entry) => entry.trim()).filter(Boolean);
};
/** Every job `name` waits for, directly or through another job. */
const waitsFor = (name: string): Set<string> => {
  const found = new Set<string>();
  const visit = (next: string) => { for (const need of needs(next)) if (!found.has(need)) { found.add(need); visit(need); } };
  visit(name);
  return found;
};
let scratch: string | undefined;
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

describe("the public GitHub release workflow", () => {
  it("uploads only the sanitized macOS diagnostic directory after a smoke failure", () => {
    const replacement = step("smoke-macos", "Replace the packaged desktop with an existing client credential");
    expect(replacement).toContain('SMOKE_DIAGNOSTICS: ${{ runner.temp }}/macos-update-diagnostics');
    const upload = step("smoke-macos", "Keep macOS timeout diagnostics");
    expect(upload).toContain("if: failure()");
    expect(upload).toContain("uses: actions/upload-artifact@");
    expect(upload).toContain("path: ${{ runner.temp }}/macos-update-diagnostics");
    expect(upload).toContain("name: macos-update-diagnostics");
    expect(upload).toContain("retention-days: 7");
    expect(upload).not.toContain("continue-on-error");
  });

  it("updates an environment the macOS desktop installed from the desktop job's own server artefact, before the replacement smoke (#1724)", () => {
    const kept = step("desktop-macos", "Keep the server artefact the macOS smoke updates to");
    expect(kept).toContain("uses: actions/upload-artifact@");
    expect(kept).toContain("name: server-darwin-arm64");
    expect(kept).toContain("path: server/agent-harness-darwin-arm64.tar.gz");
    expect(kept).toContain("if-no-files-found: error");
    // The release job collects the desktops by their prefix; the artefact is not one of its assets.
    expect(step("release", "The desktop jobs' builds")).toContain("pattern: desktop-*");
    const smoke = job("smoke-macos").join("\n");
    expect(smoke).toMatch(/download-artifact@[a-f0-9]{40} # v7\n {8}with:\n {10}name: server-darwin-arm64\n {10}path: artefact\n/);
    const update = step("smoke-macos", "Update an environment the desktop installed from the server artefact with no keychain prompt");
    expect(update).toContain('"$server/node/bin/node" scripts/macos-tarball-update-smoke.mjs unzipped/agent-harness.app artefact/agent-harness-darwin-arm64.tar.gz');
    expect(smoke.indexOf(update)).toBeLessThan(smoke.indexOf("Replace the packaged desktop with an existing client credential"));
  });

  it("checks the actual native screenshot collectors before the packaged macOS smoke", () => {
    const native = step("smoke-macos", "Verify native screenshot diagnostics");
    expect(native).toContain('"$server/node/bin/node" --test scripts/macos-smoke-diagnostics-native.test.mjs');
    const steps = job("smoke-macos").join("\n");
    expect(steps.indexOf(native)).toBeLessThan(steps.indexOf("Replace the packaged desktop with an existing client credential"));
  });

  it("runs only for public v tags, manual dry runs or a main merge's smoke, which names its commit", () => {
    expect(lines.slice(lines.indexOf("on:") + 1, lines.indexOf("permissions:")).filter((line) => !line.trimStart().startsWith("#"))).toEqual([
      "  push:", '    tags: ["v*"]', "  workflow_dispatch:", "  workflow_call:", "    inputs:", "      sha:",
      "        description: The commit to build and smoke, without publishing", "        required: true", "        type: string", "",
    ]);
    expect(workflow).not.toMatch(/secrets\.|PACKAGES_TOKEN|desktop-builds\.sh/);
    expect(lines).toContain("    shell: bash");
  });

  it.skipIf(recovery === undefined)("keeps Forgejo recovery manual-only in the private tree", () => {
    const forgejo = recovery ?? "";
    expect(forgejo.slice(forgejo.indexOf("on:"), forgejo.indexOf("concurrency:")).replace(/^#.*\n/gm, "")).toBe("on:\n  workflow_dispatch:\n\n");
  });

  it("gates every publishing operation on the prepared run's publish flag, and latest on stability too", () => {
    expect(step("prepare", "The tag's release is not published yet")).toContain("if: steps.run.outputs.publish == 'true'");
    expect(step("image-push", "Authenticate to ghcr for a tag only")).toContain("if: needs.prepare.outputs.publish == 'true'");
    const image = step("image", "Build the image locally");
    expect(image).toContain("push: false");
    expect(image).toContain("load: true");
    expect(step("image-push", "Push the verified image on a tag")).toContain("if: needs.prepare.outputs.publish == 'true'");
    expect(step("release", "Upload every asset to a draft release, then publish it")).toContain("if: needs.prepare.outputs.publish == 'true'");
    expect(step("release", "Point latest at the stable release's exact image")).toContain("if: needs.prepare.outputs.publish == 'true' && needs.prepare.outputs.prerelease == 'false'");
    expect(workflow).not.toContain("needs.check.");
    expect(step("release", "Keep all artefacts, including for a dry run")).not.toContain("if:");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("password: ${{ github.token }}");
  });

  it.each(["1.2.3-beta.2", "0.0.0"])("checks the built image's reported version %s before any push", async (reported) => {
    const build = step("image", "Build the image locally");
    expect(build).toContain("HARNESS_VERSION=${{ needs.prepare.outputs.version }}");
    const check = step("image", "Check the image's version");
    const publish = step("image-push", "Push the verified image on a tag");
    expect(needs("image-push")).toContain("image");
    scratch = mkdtempSync(join(tmpdir(), "release-image-version-"));
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    const log = join(scratch, "calls");
    const output = join(scratch, "outputs");
    writeFileSync(log, "");
    writeFileSync(output, "");
    writeFileSync(join(bin, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
case "$1" in
  run) echo "agent-harness $REPORTED" ;;
  image) echo "$IMAGE_REFERENCE@sha256:fixture-digest" ;;
esac
`);
    chmodSync(join(bin, "docker"), 0o755);
    const commands = [check, publish].map((body) => body.split("        run: |\n")[1]?.replace(/^ {10}/gm, "") ?? "").join("\n");
    const result = await run("bash", ["-euc", commands], { env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}`, CALLS: log, REPORTED: reported, VERSION: "1.2.3-beta.2", IMAGE_REFERENCE: "example/image:1.2.3-beta.2", GITHUB_OUTPUT: output } }).then(() => 0, () => 1);
    expect(result).toBe(reported === "0.0.0" ? 1 : 0);
    expect(readFileSync(log, "utf8").includes("push example/image:1.2.3-beta.2")).toBe(reported !== "0.0.0");
    expect(readFileSync(output, "utf8")).toBe(reported === "0.0.0" ? "" : "digest=sha256:fixture-digest\n");
  });

  // ghcr once refused the manifest with `unknown blob` after accepting every layer (run 37513514128, #1735).
  it.each([
    { failures: 2, pushes: 3, passes: true },
    { failures: 3, pushes: 3, passes: false },
  ])("pushes the verified image again after a refused push, at most three times ($failures refused)", async ({ failures, pushes, passes }) => {
    const publish = step("image-push", "Push the verified image on a tag");
    scratch = mkdtempSync(join(tmpdir(), "release-image-push-"));
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    const log = join(scratch, "calls");
    const output = join(scratch, "outputs");
    writeFileSync(log, "");
    writeFileSync(output, "");
    writeFileSync(join(bin, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
case "$1" in
  push) [ "$(grep -c '^push ' "$CALLS")" -gt "$FAILURES" ] || { echo "unknown blob" >&2; exit 1; } ;;
  image) echo "$IMAGE_REFERENCE@sha256:fixture-digest" ;;
esac
`);
    writeFileSync(join(bin, "sleep"), `#!/bin/sh
printf 'sleep %s\\n' "$*" >> "$CALLS"
`);
    chmodSync(join(bin, "docker"), 0o755);
    chmodSync(join(bin, "sleep"), 0o755);
    const commands = publish.split("        run: |\n")[1]?.replace(/^ {10}/gm, "") ?? "";
    const result = await run("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", commands], { env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}`, CALLS: log, FAILURES: String(failures), IMAGE_REFERENCE: "example/image:1.2.3", GITHUB_OUTPUT: output } }).then(() => true, () => false);
    expect(result).toBe(passes);
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    expect(calls.filter((call) => call === "push example/image:1.2.3")).toHaveLength(pushes);
    // A pause between attempts, none after the last.
    expect(calls.filter((call) => call.startsWith("sleep "))).toHaveLength(pushes - 1);
    expect(readFileSync(output, "utf8")).toBe(passes ? "digest=sha256:fixture-digest\n" : "");
  });

  /**
   * Runs the image job's container smoke against a fake docker that answers the
   * container's AGENT_HARNESS_WEB_ORIGIN from the .env file beside the compose
   * file, as compose passes it through, or not at all when `dropsWebOrigin`.
   */
  const containerSmoke = async ({ dropsWebOrigin = false, needsDataDir = false } = {}) => {
    const smoke = step("image", "Inspect a container update without applying it");
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = mkdtempSync(join(tmpdir(), "release-updater-smoke-"));
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    const log = join(scratch, "calls");
    writeFileSync(log, "");
    writeFileSync(join(bin, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
  "compose -f "*" exec -T environment agent-harness update status --json")
    [ -z "$NEEDS_DATA_DIR" ] || { echo "No environment is running: it has no bootstrap grant file." >&2; exit 1; }
    printf '{"version":"%s","pending":{"state":"current"},"manager":{"lastPoll": null}}\\n' "$VERSION" ;;
  "compose -f "*" exec -T environment agent-harness update status --json --data-dir /data")
    printf '{"version":"%s","pending":{"state":"current"},"manager":{"lastPoll": null}}\\n' "$VERSION" ;;
  "compose -f "*" exec -T environment printenv AGENT_HARNESS_WEB_ORIGIN")
    [ -z "$DROPS_WEB_ORIGIN" ] || exit 1
    sed -n 's/^AGENT_HARNESS_WEB_ORIGIN=//p' "$(dirname "$3")/.env" ;;
  "compose -f "*" ps -q environment") echo container-for-tests ;;
  "inspect --format {{.Config.Image}} container-for-tests") echo "$IMAGE_REFERENCE" ;;
  "compose -f "*" up -d --pull never environment" | "compose -f "*" down --volumes --timeout 5") ;;
  *) echo "unexpected docker call: $*" >&2; exit 97 ;;
esac
`);
    writeFileSync(join(bin, "curl"), `#!/bin/sh\necho '{"status":"ready"}'\n`);
    for (const tool of ["docker", "curl"]) chmodSync(join(bin, tool), 0o755);
    const commands = smoke.split("        run: |\n")[1]?.replace(/^ {10}/gm, "") ?? "";
    const result = await run("bash", ["-euc", commands], { cwd: root, env: {
      ...process.env, PATH: `${bin}:${process.env["PATH"]}`, TMPDIR: scratch, CALLS: log,
      IMAGE_REFERENCE: "example/image:1.2.3", VERSION: "1.2.3", DROPS_WEB_ORIGIN: dropsWebOrigin ? "1" : "", NEEDS_DATA_DIR: needsDataDir ? "1" : "",
    } }).then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), (error: { code: number; stdout: string; stderr: string }) => error);
    return { smoke, result, calls: readFileSync(log, "utf8").trim().split("\n") };
  };

  it("smokes the host updater against the built image before pushing it, without applying an update", async () => {
    const { smoke, result, calls } = await containerSmoke();
    const kept = step("image", "Keep the verified image for its push");
    expect(job("image").join("\n").indexOf(smoke)).toBeLessThan(job("image").join("\n").indexOf(kept));
    expect(job("image").join("\n")).not.toMatch(/docker push|login-action/);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No pending update.");
    expect(calls.filter((call) => call.includes(" up -d "))).toHaveLength(1);
    expect(calls.at(-1)).toContain("down --volumes --timeout 5");
    expect(calls.join("\n")).not.toMatch(/--host-updater|update begin|update snapshot|update restore|^pull /m);
  });

  it("checks that the phone address the compose project's .env file names reaches the container, and fails when it does not (#1691)", async () => {
    const passed = await containerSmoke();
    expect(passed.result.code).toBe(0);
    expect(passed.calls.filter((call) => call.endsWith(" exec -T environment printenv AGENT_HARNESS_WEB_ORIGIN"))).toHaveLength(1);
    const dropped = await containerSmoke({ dropsWebOrigin: true });
    expect(dropped.result.code).not.toBe(0);
    expect(dropped.result.stdout).toContain("::error::the container does not have the .env file's AGENT_HARNESS_WEB_ORIGIN");
    expect(dropped.calls.at(-1)).toContain("down --volumes --timeout 5");
  });

  it("checks that a verb run through compose exec finds the container's environment without --data-dir, and fails when it does not (#1725)", async () => {
    const passed = await containerSmoke();
    expect(passed.result.code).toBe(0);
    expect(passed.calls.filter((call) => call.endsWith(" exec -T environment agent-harness update status --json"))).toHaveLength(1);
    const lost = await containerSmoke({ needsDataDir: true });
    expect(lost.result.code).not.toBe(0);
    expect(lost.result.stdout).toContain("::error::agent-harness in the container does not find its environment without --data-dir");
    expect(lost.calls.at(-1)).toContain("down --volumes --timeout 5");
  });

  it("builds three desktops on hosted runners, preserves the package checks, and transfers all three before assembling the release", () => {
    for (const [name, runner, platform, format, filename] of [
      ["desktop-macos", "macos-latest", "darwin-arm64", "zip", "agent-harness-desktop-darwin-arm64.zip"],
      ["desktop-windows", "ubuntu-latest", "win32-x64", "nsis", "agent-harness-desktop-win32-x64-setup.exe"],
      ["desktop-arch", "ubuntu-latest", "linux-x64", "pacman", "agent-harness-desktop-linux-x64.pacman"],
    ]) {
      const body = job(name ?? "").join("\n");
      expect(body).toContain(`runs-on: ${runner}`);
      expect(body).toContain(`build-desktop --platform ${platform} --tag "$TAG" --server server/agent-harness-${platform}.${format === "nsis" ? "zip" : "tar.gz"}`);
      expect(body).toContain(`path: desktop/${filename}`);
      expect(body).toContain(`name: desktop-${platform}`);
      expect(needs(name ?? "")).toEqual(["prepare", "image"]);
    }
    expect(job("desktop-windows").join("\n")).toContain("electronuserland/builder:24-wine-");
    // GitHub mounts its own HOME into container jobs, owned by the runner's user, and wine refuses
    // a prefix there (run 37049414754): the setup step runs with the container user's own home.
    expect(step("desktop-windows", "The Windows setup")).toMatch(/\n {8}env:\n {10}HOME: \/root\n/);
    expect(job("desktop-macos").join("\n")).toContain('codesign --verify --deep --strict "$app"');
    expect(job("desktop-arch").join("\n")).toContain('grep -qx "pkgname = agent-harness-desktop"');
    // The desktop's own update runs pkexec, which polkit provides (#1692).
    expect(job("desktop-arch").join("\n")).toContain('grep -qx "depend = polkit" unpacked/.PKGINFO');
    expect(step("release", "The desktop jobs' builds")).toContain("merge-multiple: true");
    expect(job("release")).toContain("    needs: [prepare, verify, suite, image-push, desktop-macos, desktop-windows, desktop-arch, smoke-windows, smoke-macos, smoke-linux]");
  });

  it("builds and smokes from the prepared run alone, beside the suite, which starts with the run", () => {
    expect(needs("verify")).toEqual([]);
    const verify = job("verify").join("\n");
    for (const command of ["pnpm typecheck", "pnpm lint"]) expect(verify).toContain(`      - run: ${command}`);
    expect(verify).not.toContain("pnpm test");
    expect(step("verify", "The JSON Schema export is current")).toContain("pnpm --filter @agent-harness/contracts export-schemas");
    // One hosted runner no longer finishes the whole suite in 30 minutes (run 37441040959): six
    // shards, like pull request CI, together run every test file once (#1687).
    expect(needs("suite")).toEqual([]);
    const suite = job("suite").join("\n");
    expect(suite).toContain("    timeout-minutes: 25\n");
    expect(suite).toMatch(/\n {6}fail-fast: false\n/);
    expect(suite).toMatch(/\n {8}shard: \[1, 2, 3, 4, 5, 6\]\n/);
    expect(step("suite", "The suite shard")).toContain("pnpm test --maxWorkers=4 --shard=${{ matrix.shard }}/6");
    expect(workflow.match(/pnpm test/g)).toHaveLength(1);
    expect(job("prepare").join("\n")).not.toMatch(/pnpm (typecheck|lint|test)/);
    expect(needs("image")).toEqual(["prepare"]);
    for (const [smoke, build] of [["smoke-windows", "desktop-windows"], ["smoke-macos", "desktop-macos"], ["smoke-linux", "desktop-arch"]] as const) {
      expect(needs(build)).toEqual(["prepare", "image"]);
      expect(needs(smoke)).toEqual(["prepare", build]);
    }
    for (const build of ["image", "desktop-macos", "desktop-windows", "desktop-arch", "smoke-windows", "smoke-macos", "smoke-linux"]) {
      expect(waitsFor(build).has("verify"), build).toBe(false);
      expect(waitsFor(build).has("suite"), build).toBe(false);
    }
  });

  it("runs no publishing step, and grants no job a write to the registry, unless the suite passed", () => {
    const publishing = /docker push|docker\/login-action|publish-release --tag "\$TAG" --from|imagetools create/;
    const publishers = [...jobs.keys()].filter((name) => publishing.test(job(name).join("\n")));
    expect(publishers.sort()).toEqual(["image-push", "release"]);
    const writers = [...jobs.keys()].filter((name) => job(name).includes("      packages: write"));
    expect(writers.sort()).toEqual(["image-push", "release"]);
    for (const name of [...publishers, ...writers]) {
      expect(waitsFor(name).has("verify"), name).toBe(true);
      expect(waitsFor(name).has("suite"), name).toBe(true);
    }
    expect(needs("release")).toEqual(expect.arrayContaining(["verify", "suite", "image-push"]));
  });

  it("builds and smokes the called commit without publishing when a main merge's smoke calls it (#1769)", () => {
    // Every job checks out the called commit; a tag's run leaves the input empty, so its own ref.
    const checkouts = lines.flatMap((line, i) => line.includes("- uses: actions/checkout@") ? [lines.slice(i, i + 3).join("\n")] : []);
    expect(checkouts.length).toBeGreaterThan(0);
    for (const checkout of checkouts) expect(checkout).toMatch(/\n {8}with:\n {10}ref: \$\{\{ inputs\.sha \}\}$/);
    expect(step("prepare", "Prepare the tag or dry run")).toContain("RELEASE_SMOKE_SHA: ${{ inputs.sha }}");
    // The merge's own CI ran typecheck, lint and the suite; without them nothing publishes.
    for (const name of ["verify", "suite"]) expect(job(name), name).toContain("    if: ${{ !inputs.sha }}");
    for (const name of ["image-push", "release"]) {
      expect(waitsFor(name).has("verify"), name).toBe(true);
      expect(job(name).some((line) => line.startsWith("    if:")), name).toBe(false);
    }
    for (const name of ["prepare", "image", "desktop-macos", "desktop-windows", "desktop-arch", "smoke-windows", "smoke-macos", "smoke-linux"]) {
      expect(job(name).some((line) => line.startsWith("    if:")), name).toBe(false);
    }
    // Each merge's smoke is its own group; a tag's run keeps its ref's.
    expect(lines.slice(lines.indexOf("concurrency:"), lines.indexOf("concurrency:") + 2)).toEqual(["concurrency:", "  group: release-${{ inputs.sha || github.ref }}"]);
    expect(step("image", "Build the image locally")).toContain("org.opencontainers.image.revision=${{ inputs.sha || github.sha }}");
  });

  it("pushes the very image the image job checked, handed on as an artifact", () => {
    const kept = step("image", "Keep the verified image for its push");
    expect(kept).toContain('docker save "$IMAGE_REFERENCE"');
    const upload = step("image", "Hand the verified image to its push");
    expect(upload).toContain("uses: actions/upload-artifact@");
    expect(upload).toContain("name: container-image");
    const pushJob = job("image-push").join("\n");
    const download = step("image-push", "The verified image");
    expect(download).toContain("uses: actions/download-artifact@");
    expect(download).toContain("name: container-image");
    const load = step("image-push", "Load the verified image");
    expect(load).toContain("docker load");
    expect(pushJob.indexOf(load)).toBeLessThan(pushJob.indexOf(step("image-push", "Push the verified image on a tag")));
    expect(pushJob).toContain("IMAGE_REFERENCE: ${{ needs.image.outputs.reference }}");
    expect(pushJob).toContain("digest: ${{ steps.publish.outputs.digest || needs.image.outputs.digest }}");
    const release = job("release").join("\n");
    expect(release).toContain("IMAGE_REFERENCE: ${{ needs.image-push.outputs.reference }}");
    expect(release).toContain("IMAGE_DIGEST: ${{ needs.image-push.outputs.digest }}");
    expect(release).not.toContain("needs.image.outputs");
  });

  it("checks persisted channel targets on the packaged Linux server's second start", () => {
    const smoke = step("smoke-linux", "Start the packaged environment twice");
    expect(smoke).toContain('environment.update-pending');
    expect(smoke).toContain('source: "channel"');
    expect(smoke).toContain('cause === "superseded"');
    expect(smoke).toContain('update status --json --data-dir "$data_dir"');
    expect(smoke).toContain('status.pending.state !== "current"');
  });

  it("smokes the public headless installers without credentials on each release platform", () => {
    for (const name of ["smoke-macos", "smoke-linux"]) {
      const body = job(name).join("\n");
      expect(body).toContain("actions/checkout@");
      expect(step(name, "Resolve a public headless install without credentials")).toContain('sh scripts/install.sh --dry-run --data-dir "$RUNNER_TEMP/headless-install"');
      expect(body).toContain("unset AGENT_HARNESS_TOKEN");
      expect(body).toContain("https://github.com/david-systemtech/agent-harness/releases/download/");
    }
    const windows = job("smoke-windows").join("\n");
    expect(windows).toContain("actions/checkout@");
    expect(windows).toContain("scripts/install.ps1");
    expect(windows).toContain("-DryRun -DataDir");
    expect(windows).toContain("Remove-Item Env:\\AGENT_HARNESS_TOKEN");
    expect(windows).toContain("https://github.com/david-systemtech/agent-harness/releases/download/");
  });

  it("hands the manifest writer every asset, the tag and exact ghcr image through the runner's shell", async () => {
    scratch = mkdtempSync(join(tmpdir(), "github-release-workflow-"));
    const log = join(scratch, "args");
    writeFileSync(join(scratch, "pnpm"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CALL_LOG"\n');
    chmodSync(join(scratch, "pnpm"), 0o755);
    const command = step("release", "Build the server artefacts and the release's assets").split("        run: |\n")[1]?.split("\n").map((line) => line.slice(10)).join("\n") ?? "";
    await run("bash", ["-euo", "pipefail", "-c", command], { cwd: root, env: {
      PATH: `${scratch}:${process.env["PATH"]}`, CALL_LOG: log, TAG: "v1.2.3-beta.2",
      IMAGE_REFERENCE: "ghcr.io/david-systemtech/agent-harness:1.2.3-beta.2", IMAGE_DIGEST: `sha256:${"0".repeat(64)}`,
    } });
    const args = readFileSync(log, "utf8").trim().split("\n");
    expect(args.slice(0, 11)).toEqual(["--filter", "agent-harness", "build-artefacts", "--tag", "v1.2.3-beta.2", "--out", "release-assets", "--image-reference", "ghcr.io/david-systemtech/agent-harness:1.2.3-beta.2", "--image-digest", `sha256:${"0".repeat(64)}`]);
    expect(args.slice(11)).toEqual([
      "--asset", "schema=packages/contracts/schema", "--asset", "install-script=scripts/install.sh",
      "--asset", "install-script=scripts/install.ps1", "--asset", "compose=scripts/compose.yaml",
      "--asset", "host-updater=scripts/host-updater.sh",
      "--asset", "desktop:darwin-arm64:zip=desktop/agent-harness-desktop-darwin-arm64.zip",
      "--asset", "desktop:win32-x64:nsis=desktop/agent-harness-desktop-win32-x64-setup.exe",
      "--asset", "desktop:linux-x64:pacman=desktop/agent-harness-desktop-linux-x64.pacman",
    ]);
  });
});
