/**
 * The release workflow (`.forgejo/workflows/release.yml`, launcher-update
 * spec, "The release"; #358), read as text: its jobs' order and runners, and
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

const root = join(import.meta.dirname, "..");
const run = promisify(execFile);
const lines = readFileSync(join(root, ".forgejo", "workflows", "release.yml"), "utf8").split("\n");

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

describe("the release workflow", () => {
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

  it("builds the image and the release only after the check, the release with the image job's reference and digest", () => {
    expect(job("image")).toContain("    needs: check");
    const release = job("release");
    expect(release).toContain("    needs: [check, image]");
    expect(release).toContain("          IMAGE_REFERENCE: ${{ needs.image.outputs.reference }}");
    expect(release).toContain("          IMAGE_DIGEST: ${{ needs.image.outputs.digest }}");
  });

  it("builds on the x86_64-only label, never `ci`, which takes in an arm64 runner the build refuses", () => {
    expect(job("release")).toContain("    runs-on: ci-x64");
  });

  it("builds the three artefacts and the asset list's assets from this checkout: the schema export, install.sh, compose.yaml and host-updater.sh", async () => {
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
      "--image-reference",
      "git.example.test:5526/david/agent-harness:0.5.0",
      "--image-digest",
      `sha256:${"0".repeat(64)}`,
      "--asset",
      "schema=packages/contracts/schema",
      "--asset",
      "install-script=scripts/install.sh",
      "--asset",
      "compose=scripts/compose.yaml",
      "--asset",
      "host-updater=scripts/host-updater.sh",
    ]);
    const paths = args.filter((_, i) => args[i - 1] === "--asset").map((asset) => asset.slice(asset.indexOf("=") + 1));
    expect(paths.filter((path) => !existsSync(join(root, path)))).toEqual([]);
    expect(statSync(join(root, "packages", "contracts", "schema")).isDirectory()).toBe(true);
  });

  it("publishes the build's folder as its last step, with the job's own token", async () => {
    const release = job("release");
    const steps = runs(release);
    expect(steps.at(-1)).toBe('pnpm --filter agent-harness publish-release --tag "$TAG" --from release-assets');
    expect(await pnpmCalledBy(steps.at(-1) ?? "", {})).toEqual(["--filter", "agent-harness", "publish-release", "--tag", "v0.5.0", "--from", "release-assets"]);
    expect(release.slice(-3)).toEqual(["        env:", "          RELEASE_TOKEN: ${{ github.token }}", '        run: pnpm --filter agent-harness publish-release --tag "$TAG" --from release-assets']);
  });
});
