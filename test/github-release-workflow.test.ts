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
let scratch: string | undefined;
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

describe("the public GitHub release workflow", () => {
  it("runs only for public v tags or manual dry runs", () => {
    expect(lines.slice(lines.indexOf("on:") + 1, lines.indexOf("permissions:"))).toEqual([
      "  push:", '    tags: ["v*"]', "  workflow_dispatch:", "",
    ]);
    expect(workflow).not.toMatch(/secrets\.|PACKAGES_TOKEN|desktop-builds\.sh/);
    expect(lines).toContain("    shell: bash");
  });

  it.skipIf(recovery === undefined)("keeps Forgejo recovery manual-only in the private tree", () => {
    const forgejo = recovery ?? "";
    expect(forgejo.slice(forgejo.indexOf("on:"), forgejo.indexOf("concurrency:")).replace(/^#.*\n/gm, "")).toBe("on:\n  workflow_dispatch:\n\n");
  });

  it("gates every publishing operation on the prepared run's publish flag, and latest on stability too", () => {
    expect(step("check", "The tag's release is not published yet")).toContain("if: steps.run.outputs.publish == 'true'");
    expect(step("image", "Authenticate to ghcr for a tag only")).toContain("if: needs.check.outputs.publish == 'true'");
    const image = step("image", "Build the image locally");
    expect(image).toContain("push: false");
    expect(image).toContain("load: true");
    expect(step("image", "Push the verified image on a tag")).toContain("if: needs.check.outputs.publish == 'true'");
    expect(step("release", "Upload every asset to a draft release, then publish it")).toContain("if: needs.check.outputs.publish == 'true'");
    expect(step("release", "Point latest at the stable release's exact image")).toContain("if: needs.check.outputs.publish == 'true' && needs.check.outputs.prerelease == 'false'");
    expect(step("release", "Keep all artefacts, including for a dry run")).not.toContain("if:");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("password: ${{ github.token }}");
  });

  it.each(["1.2.3-beta.2", "0.0.0"])("checks the built image's reported version %s before any push", async (reported) => {
    const build = step("image", "Build the image locally");
    expect(build).toContain("HARNESS_VERSION=${{ needs.check.outputs.version }}");
    const check = step("image", "Check the image's version");
    const publish = step("image", "Push the verified image on a tag");
    const imageSteps = job("image").join("\n");
    expect(imageSteps.indexOf(check)).toBeLessThan(imageSteps.indexOf(publish));
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
      expect(body).toContain("needs: [check, image]");
    }
    expect(job("desktop-windows").join("\n")).toContain("electronuserland/builder:24-wine-");
    // GitHub mounts its own HOME into container jobs, owned by the runner's user, and wine refuses
    // a prefix there (run 37049414754): the setup step runs with the container user's own home.
    expect(step("desktop-windows", "The Windows setup")).toMatch(/\n {8}env:\n {10}HOME: \/root\n/);
    expect(job("desktop-macos").join("\n")).toContain('codesign --verify --deep --strict "$app"');
    expect(job("desktop-arch").join("\n")).toContain('grep -qx "pkgname = agent-harness-desktop"');
    expect(step("release", "The desktop jobs' builds")).toContain("merge-multiple: true");
    expect(job("release")).toContain("    needs: [check, image, desktop-macos, desktop-windows, desktop-arch]");
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
