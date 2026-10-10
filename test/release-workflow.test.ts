/**
 * The release workflow (`.forgejo/workflows/release.yml`, launcher-update
 * spec, "The release"; #358, #359), read as text: its jobs' order and runners, and
 * the build and publish steps' scripts run by `bash` against a fake `pnpm`
 * on PATH that records what it was asked, so the asset list is checked as
 * the runner's shell reads it. Nothing is built, pushed or published; the
 * build and the publisher are tested in `packages/cli/scripts/release/`, and
 * a tag's real run is the service-install checklist's Release section.
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { releaseWorkflowInput } from "./release-workflow-input.js";

const root = join(import.meta.dirname, "..");
/** The jobs that build the desktops a release publishes (#359); `packages/desktop/scripts/desktop-build/workflow.test.ts` checks what each builds. */
const DESKTOP_JOBS = ["desktop-macos", "desktop-windows", "desktop-arch"];
const run = promisify(execFile);
const { recovery } = releaseWorkflowInput(root);
const lines = (recovery ?? "").split("\n");

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

/** The job `name`'s lines, from its key to the next job's, comments and blank lines dropped. */
const job = (name: string): string[] => {
  const start = lines.indexOf(`  ${name}:`);
  expect(start, name).toBeGreaterThan(lines.indexOf("jobs:"));
  const end = lines.findIndex((line, i) => i > start && /^ {2}\S/.test(line));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .filter((line) => !/^\s*(#.*)?$/.test(line))
    .map((line) => line.replace(/\s+# .*$/, ""));
};

/** The script of the step `name` in `jobLines`: its `run:` line, or the block under `run: |`. */
const script = (jobLines: string[], name: string): string => {
  const start = jobLines.indexOf(`      - name: ${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const at = jobLines.findIndex((line, i) => i > start && line.startsWith("        run: "));
  const first = jobLines[at]?.slice("        run: ".length) ?? "";
  if (first !== "|") return first;
  const block: string[] = [];
  for (const line of jobLines.slice(at + 1)) {
    if (!line.startsWith("          ")) break;
    block.push(line.slice("          ".length));
  }
  return block.join("\n");
};

/** The lines of the step `name` in `jobLines`, from its `- name:` line to the next step's. */
const step = (jobLines: string[], name: string): string[] => {
  const start = jobLines.indexOf(`      - name: ${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const end = jobLines.findIndex((line, i) => i > start && line.startsWith("      - "));
  return jobLines.slice(start, end === -1 ? undefined : end);
};

/** The steps' `run:` lines of `jobLines`, in order. */
const runs = (jobLines: string[]): string[] => jobLines.filter((line) => /^ {6}(- )? {0,2}run: /.test(line)).map((line) => line.replace(/^\s*(- )?run: /, ""));

/** Runs `step` in bash from the checkout's root as a job would, with a fake `pnpm` answering nothing, and answers the arguments it was given. */
const pnpmCalledBy = async (step: string, env: NodeJS.ProcessEnv): Promise<string[]> => {
  const dir = mkdtempSync(join(tmpdir(), "release-workflow-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "pnpm-args");
  writeFileSync(join(dir, "pnpm"), `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg" >> "${log}"; done\n`);
  chmodSync(join(dir, "pnpm"), 0o755);
  await run("bash", ["-euo", "pipefail", "-c", step], { cwd: root, env: { PATH: `${dir}:${process.env["PATH"] ?? "/usr/bin:/bin"}`, TAG: "v0.5.0", ...env } });
  return readFileSync(log, "utf8").split("\n").slice(0, -1);
};

describe.skipIf(recovery === undefined)("the private Forgejo recovery workflow", () => {
  it("checks, before anything is built or pushed, that the tag's release is unpublished, then runs typecheck, lint, test and the schema export's check", () => {
    const check = job("check");
    expect(check).toContain("    runs-on: ci");
    const steps = runs(check);
    const order = ['pnpm --filter agent-harness publish-release --tag "$TAG" --check', "pnpm typecheck", "pnpm lint", "pnpm test --maxWorkers=4", "|"];
    expect(steps.filter((step) => order.includes(step))).toEqual(order);
    expect(steps.indexOf(order[0] ?? "")).toBeGreaterThan(steps.indexOf("pnpm install --frozen-lockfile"));
    expect(script(check, "The JSON Schema export is current")).toContain("pnpm --filter @agent-harness/contracts export-schemas");
    expect(check).toContain("          RELEASE_TOKEN: ${{ github.token }}");
    expect(lines).toContain("  TAG: ${{ github.ref_name }}");
  });

  // ci.yml's checks run on GitHub (david-systemtech/agent-harness-ci), whose
  // test jobs take the same step from this checkout before their shard.
  it("puts PowerShell 7 on the check job's PATH before its tests, which run install.ps1 under it", () => {
    const steps = runs(job("check"));
    expect(steps.indexOf("bash .forgejo/scripts/pwsh.sh")).toBeGreaterThan(-1);
    expect(steps.indexOf("bash .forgejo/scripts/pwsh.sh")).toBeLessThan(steps.indexOf("pnpm test --maxWorkers=4"));
  });

  it("builds the image and the desktops only after the check, and the release after them all, each with the image job's reference and digest", () => {
    expect(job("image")).toContain("    needs: check");
    for (const desktop of DESKTOP_JOBS) {
      const lines = job(desktop);
      expect(lines, desktop).toContain("    needs: [check, image]");
      expect(lines, desktop).toContain("      IMAGE_REFERENCE: ${{ needs.image.outputs.reference }}");
      expect(lines, desktop).toContain("      IMAGE_DIGEST: ${{ needs.image.outputs.digest }}");
    }
    const release = job("release");
    expect(release).toContain(`    needs: [check, image, ${DESKTOP_JOBS.join(", ")}]`);
    expect(release).toContain("          IMAGE_REFERENCE: ${{ needs.image.outputs.reference }}");
    expect(release).toContain("          IMAGE_DIGEST: ${{ needs.image.outputs.digest }}");
  });

  it("builds on the x86_64-only label, never `ci`, which takes in an arm64 runner the build refuses", () => {
    expect(job("release")).toContain("    runs-on: ci-x64");
  });

  it("builds the three artefacts and the asset list's assets: the schema export, install.sh, install.ps1, compose.yaml and host-updater.sh from this checkout, and the desktop jobs' three builds, each with its platform and format", async () => {
    const args = await pnpmCalledBy(script(job("release"), "Build the server artefacts and the release's assets"), {
      IMAGE_REFERENCE: "git.example.test:5526/david/agent-harness:0.5.0",
      IMAGE_DIGEST: `sha256:${"0".repeat(64)}`,
    });
    expect(args).toEqual([
      "--filter",
      "agent-harness",
      "build-artefacts",
      "--tag",
      "v0.5.0",
      "--out",
      "release-assets",
      "--windows-pty-build",
      "windows-pty",
      "--image-reference",
      "git.example.test:5526/david/agent-harness:0.5.0",
      "--image-digest",
      `sha256:${"0".repeat(64)}`,
      "--asset",
      "schema=packages/contracts/schema",
      "--asset",
      "install-script=scripts/install.sh",
      "--asset",
      "install-script=scripts/install.ps1",
      "--asset",
      "compose=scripts/compose.yaml",
      "--asset",
      "host-updater=scripts/host-updater.sh",
      "--asset",
      "desktop:darwin-arm64:zip=desktop/agent-harness-desktop-darwin-arm64.zip",
      "--asset",
      "desktop:win32-x64:nsis=desktop/agent-harness-desktop-win32-x64-setup.exe",
      "--asset",
      "desktop:linux-x64:pacman=desktop/agent-harness-desktop-linux-x64.pacman",
    ]);
    const paths = args.filter((_, i) => args[i - 1] === "--asset").map((asset) => asset.slice(asset.indexOf("=") + 1));
    const [desktops, checkout] = [paths.filter((path) => path.startsWith("desktop/")), paths.filter((path) => !path.startsWith("desktop/"))];
    expect(checkout.filter((path) => !existsSync(join(root, path)))).toEqual([]);
    expect(statSync(join(root, "packages", "contracts", "schema")).isDirectory()).toBe(true);
    const got = script(job("release"), "The desktop jobs' builds").replace(/\\\n\s*/g, "");
    expect(got).toBe(`bash .forgejo/scripts/desktop-builds.sh get desktop ${desktops.map((path) => path.slice("desktop/".length)).join(" ")} windows-pty.tar.gz
mkdir windows-pty
tar -xzf desktop/windows-pty.tar.gz -C windows-pty`);
    const release = job("release");
    const get = release.indexOf("      - name: The desktop jobs' builds");
    expect(get).toBeGreaterThan(release.indexOf("      - run: pnpm install --frozen-lockfile"));
    expect(get).toBeLessThan(release.indexOf("      - name: Build the server artefacts and the release's assets"));
  });

  it("hands each desktop job's build to the release job through the package registry, with the packages token, and removes them once the release is published", () => {
    for (const desktop of DESKTOP_JOBS) {
      const lines = job(desktop);
      const hand = step(lines, "Hand the desktop to the release job");
      expect(hand.slice(0, 3), desktop).toEqual([
        "      - name: Hand the desktop to the release job",
        "        env:",
        "          PACKAGES_TOKEN: ${{ secrets.PACKAGES_TOKEN }}",
      ]);
      const put = script(lines, "Hand the desktop to the release job");
      if (desktop === "desktop-windows") {
        expect(put).toBe(`set -euo pipefail
tar -czf windows-pty.tar.gz -C windows-pty .
bash .forgejo/scripts/desktop-builds.sh put windows-pty.tar.gz
bash .forgejo/scripts/desktop-builds.sh put desktop/agent-harness-desktop-win32-x64-setup.exe`);
      } else {
        expect(put, desktop).toMatch(/^bash \.forgejo\/scripts\/desktop-builds\.sh put desktop\/agent-harness-desktop-[a-z0-9-]+\.(zip|pacman)$/);
      }
    }
    const release = job("release");
    for (const name of ["The desktop jobs' builds", "Remove the desktop jobs' builds from the package registry"]) {
      expect(step(release, name), name).toContain("          PACKAGES_TOKEN: ${{ secrets.PACKAGES_TOKEN }}");
    }
    expect(runs(release).at(-1)).toBe("bash .forgejo/scripts/desktop-builds.sh remove");
  });

  it("publishes the build's folder after building it, with the job's own token, and does nothing after but remove the desktop jobs' builds", async () => {
    const release = job("release");
    const steps = runs(release);
    const publish = 'pnpm --filter agent-harness publish-release --tag "$TAG" --from release-assets';
    expect(steps.slice(-2)).toEqual([publish, "bash .forgejo/scripts/desktop-builds.sh remove"]);
    expect(await pnpmCalledBy(publish, {})).toEqual(["--filter", "agent-harness", "publish-release", "--tag", "v0.5.0", "--from", "release-assets"]);
    const at = release.indexOf(`        run: ${publish}`);
    expect(release.slice(at - 2, at)).toEqual(["        env:", "          RELEASE_TOKEN: ${{ github.token }}"]);
  });
});
