import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DESKTOP_TARGETS } from "./targets.js";

/**
 * The desktop workflow (`.forgejo/workflows/desktop.yml`, #423), read as
 * text: it runs by hand only, and each desktop with a runner is built in a
 * job on that runner, from its own platform's server artefact. Nothing is
 * run; the build is tested in `build.test.ts`, and a run of the workflow is
 * the desktop checklist's.
 */

const lines = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", ".forgejo", "workflows", "desktop.yml"), "utf8")
  .split("\n")
  .filter((line) => !/^\s*(#.*)?$/.test(line))
  .map((line) => line.replace(/\s+# .*$/, ""));

/** The jobs' lines, by job, comments and blank lines dropped. */
const jobs = (): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines.slice(lines.indexOf("jobs:") + 1)) {
    const name = /^ {2}([a-z0-9-]+):$/.exec(line)?.[1];
    if (name !== undefined) found.set(name, (current = []));
    else current?.push(line);
  }
  return found;
};

describe("the desktop workflow", () => {
  it("runs by hand, never on a pull request, a push or a tag", () => {
    const on = lines.slice(lines.indexOf("on:") + 1, lines.findIndex((line, i) => i > lines.indexOf("on:") && /^\S/.test(line)));
    expect(on).toEqual(["  workflow_dispatch:"]);
  });

  it("builds each desktop that has a runner on that runner, from that platform's server artefact, and none that has none", () => {
    const built = [...jobs()].map(([, job]) => {
      const runner = job.find((line) => line.startsWith("    runs-on: "))?.slice("    runs-on: ".length);
      const build = job.find((line) => line.includes("build-desktop"));
      const platform = /--platform (\S+)/.exec(build ?? "")?.[1];
      return { runner, platform, server: /--server (\S+)/.exec(build ?? "")?.[1], artefact: job.find((line) => line.includes("build-artefacts")) };
    });
    const withRunner = DESKTOP_TARGETS.filter((target) => target.runner !== null);
    const byPlatform = (a: { readonly platform: string | undefined }, b: { readonly platform: string | undefined }) => String(a.platform).localeCompare(String(b.platform));
    expect(built.map(({ runner, platform }) => ({ runner, platform })).sort(byPlatform)).toEqual(withRunner.map(({ runner, platform }) => ({ runner, platform })).sort(byPlatform));
    for (const { platform, server, artefact } of built) {
      expect(server).toBe(`server/agent-harness-${platform}.tar.gz`);
      expect(artefact).toContain(`--out server --platform ${platform}`);
    }
  });
});
