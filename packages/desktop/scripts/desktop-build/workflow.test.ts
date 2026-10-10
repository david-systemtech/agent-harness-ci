import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DESKTOP_TARGETS } from "./targets.js";

/**
 * The desktop workflow (`.forgejo/workflows/desktop.yml`, #423) and the
 * release workflow's desktop jobs (`release.yml`, #359), read as text: the
 * desktop workflow runs by hand only, and each desktop is built in a job on
 * its runner, from its own platform's server artefact; a tag's release builds
 * each with those same steps, hands it on, and lists it with the platform and
 * format its shell's update installs. Nothing is run; the build is tested in
 * `build.test.ts`, and a run of the workflows is the desktop and
 * service-install checklists'.
 */

const workflowLines = (name: string): string[] =>
  readFileSync(join(import.meta.dirname, "..", "..", "..", "..", ".forgejo", "workflows", name), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(#.*)?$/.test(line))
    .map((line) => line.replace(/\s+# .*$/, ""));

const lines = workflowLines("desktop.yml");
const release = workflowLines("release.yml");

/** The jobs' lines of a workflow, by job, comments and blank lines dropped. */
const jobs = (workflow: string[]): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of workflow.slice(workflow.indexOf("jobs:") + 1)) {
    const name = /^ {2}([a-z0-9-]+):$/.exec(line)?.[1];
    if (name !== undefined) found.set(name, (current = []));
    else current?.push(line);
  }
  return found;
};

/** The platform a job's `build-desktop` builds, if it runs one. */
const platformBuilt = (job: readonly string[]): string | undefined => /--platform (\S+)/.exec(job.find((line) => line.includes("build-desktop")) ?? "")?.[1];

/** The jobs of `workflow` that build a desktop, by the platform they build. */
const desktopJobs = (workflow: string[]): Map<string, string[]> =>
  new Map([...jobs(workflow).values()].flatMap((job) => {
    const platform = platformBuilt(job);
    return platform === undefined ? [] : [[platform, job] as const];
  }));

describe("the desktop workflow", () => {
  it("runs by hand, never on a pull request, a push or a tag", () => {
    const on = lines.slice(lines.indexOf("on:") + 1, lines.findIndex((line, i) => i > lines.indexOf("on:") && /^\S/.test(line)));
    expect(on).toEqual(["  workflow_dispatch:"]);
  });

  it("builds each desktop on its runner, from that platform's server artefact, which the job builds on a platform it runs on", () => {
    const built = [...desktopJobs(lines)].map(([platform, job]) => ({ platform, runner: job.find((line) => line.startsWith("    runs-on: "))?.slice("    runs-on: ".length) }));
    const byPlatform = (a: { readonly platform: string }, b: { readonly platform: string }) => a.platform.localeCompare(b.platform);
    expect(built.sort(byPlatform)).toEqual(DESKTOP_TARGETS.map(({ runner, platform }) => ({ runner, platform })).sort(byPlatform));
    for (const [platform, job] of desktopJobs(lines)) {
      const build = job.find((line) => line.includes("build-desktop")) ?? "";
      const artefact = job.find((line) => line.includes("build-artefacts")) ?? "";
      // The release build names the Windows artefact a zip, which the desktop build unpacks on Linux too.
      expect(/--server (\S+)/.exec(build)?.[1], platform).toBe(`server/agent-harness-${platform}.${platform.startsWith("win32-") ? "zip" : "tar.gz"}`);
      expect(artefact, platform).toContain(`--out server --platform `);
      expect(artefact, platform).toContain(`--platform ${platform}`);
    }
  });

  it("builds the Windows setup in electron-builder's Wine image, pinned by its digest", () => {
    const windows = desktopJobs(lines).get("win32-x64") ?? [];
    expect(windows.slice(windows.indexOf("    container:"), windows.indexOf("    container:") + 2)).toEqual([
      "    container:",
      expect.stringMatching(/^ {6}image: electronuserland\/builder:24-wine-[0-9.]+@sha256:[0-9a-f]{64}$/),
    ]);
  });
});

describe("the release workflow's desktop jobs", () => {
  it("build each desktop with the desktop workflow's job for it, after the check and the image, with the image's reference and digest, then hand it to the release job", () => {
    const releaseJobs = desktopJobs(release);
    expect([...releaseJobs.keys()].sort()).toEqual(DESKTOP_TARGETS.map((target) => target.platform).sort());
    for (const target of DESKTOP_TARGETS) {
      const job = releaseJobs.get(target.platform) ?? [];
      const env = job.indexOf("    env:");
      expect(job.slice(env, env + 3), target.platform).toEqual([
        "    env:",
        "      IMAGE_REFERENCE: ${{ needs.image.outputs.reference }}",
        "      IMAGE_DIGEST: ${{ needs.image.outputs.digest }}",
      ]);
      const own = job.slice(0, job.indexOf("      - name: Hand the desktop to the release job")).filter((line, i) => line !== "    needs: [check, image]" && !(i >= env && i < env + 3));
      expect(own, target.platform).toEqual(desktopJobs(lines).get(target.platform));
      expect(job.at(-1)?.trim().replace(/^run: /, ""), target.platform).toBe(`bash .forgejo/scripts/desktop-builds.sh put desktop/${target.name}`);
    }
  });

  it("checks the built Arch package depends on polkit, which the desktop's own update runs pkexec from", () => {
    for (const workflow of [lines, release]) {
      expect(desktopJobs(workflow).get("linux-x64")).toContain('          grep -qx "depend = polkit" unpacked/.PKGINFO');
    }
  });

  it("list each desktop in the release with the platform and format its shell's update installs", () => {
    const listed = release.filter((line) => line.includes("--asset desktop:")).map((line) => line.trim().replace(/ \\$/, ""));
    expect(listed).toEqual(DESKTOP_TARGETS.map(({ platform, format, name }) => `--asset desktop:${platform}:${format}=desktop/${name}`));
  });
});


describe("Windows native payloads for the Forgejo build callers", () => {
  it("compiles the repaired payload on a hosted Windows runner before either cross-built desktop", () => {
    for (const workflow of [lines, release]) {
      const windows = desktopJobs(workflow).get("win32-x64") ?? [];
      expect(windows).toContain("          GH_CI_EVENT: windows-pty");
      expect(windows).toContain("          GH_CI_WINDOWS_PTY_OUT: windows-pty");
      expect(windows).toContain("          GH_CI_TOKEN: ${{ secrets.GH_CI_TOKEN }}");
      const compile = windows.indexOf("        run: bash .forgejo/scripts/github-ci.sh");
      const build = windows.findIndex((line) => line.includes("build-artefacts"));
      expect(compile).toBeGreaterThan(0);
      expect(compile).toBeLessThan(build);
      expect(windows[build]).toContain("--windows-pty-build windows-pty");
    }
    const hosted = readFileSync(join(import.meta.dirname, "../../../../.forgejo/github-workflows/windows-pty.yml"), "utf8");
    expect(hosted).toContain("runs-on: windows-2022");
    expect(hosted).toContain("ref: ${{ github.event.client_payload.sha }}");
    expect(hosted).toContain("pnpm --filter @agent-harness/environment rebuild node-pty");
    expect(hosted).toContain("packages/cli/scripts/export-windows-pty.ts windows-pty");
    expect(hosted).toContain("name: windows-pty");
    const publicRelease = readFileSync(join(import.meta.dirname, "../../../../public/.github-workflows/release.yml"), "utf8");
    const nativeSteps = (text: string): string => (text.split("\n  windows-pty:\n")[1]?.split(/\n {2}[a-z-]+:\n/)[0] ?? "").split("    steps:\n")[1]?.trim() ?? "";
    expect(nativeSteps(hosted)).toBe(nativeSteps(publicRelease).replace("${{ inputs.sha }}", "${{ github.event.client_payload.sha }}"));
  });

  it("hands that native payload to recovery's final server build along with the desktops", () => {
    const windows = desktopJobs(release).get("win32-x64") ?? [];
    expect(windows).toContain("          tar -czf windows-pty.tar.gz -C windows-pty .");
    expect(windows).toContain("          bash .forgejo/scripts/desktop-builds.sh put windows-pty.tar.gz");
    const final = jobs(release).get("release") ?? [];
    expect(final.some((line) => line.includes("windows-pty.tar.gz"))).toBe(true);
    expect(final).toContain("          tar -xzf desktop/windows-pty.tar.gz -C windows-pty");
    expect(final.find((line) => line.includes("build-artefacts"))).toContain("--windows-pty-build windows-pty");
  });
});
