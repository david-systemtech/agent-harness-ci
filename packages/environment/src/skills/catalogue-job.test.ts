import { execFile, execFileSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { CATALOGUE, type CatalogueSkillEntry, type ReadinessOverlay } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useCleanups } from "../../test/cleanups.js";
import { SKILLS_HOST, skill, skillRepositories, testGit, write } from "../../test/skill-repositories.js";

// The script seam: real git against local bare repositories. Disallow every
// protocol except file even if the URL rewrite ever stops working.
const { tempDir } = useCleanups();
const exec = promisify(execFile);
const script = join(import.meta.dirname, "../../scripts/check-catalogue.ts");

const entry = (id: string, repository: string, folder: string, names: string[]): CatalogueSkillEntry => ({
  ...CATALOGUE.skills[0]!,
  id,
  url: `${SKILLS_HOST}${repository}.git`,
  folder,
  skillCount: names.length,
  members: names.map((name) => ({ name, description: "A fixture skill.", invocation: "model+slash" })),
  alwaysOnHints: [],
});

const fixture = () => {
  const forge = skillRepositories(tempDir);
  const dir = tempDir("catalogue-job-");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const audit = join(dir, "shallow");
  // Observe actual checkout depth at the git process boundary, before the
  // script removes its temporary files; execute every git operation normally.
  write(join(dir, "git"), `#!/bin/sh\n"${realGit}" "$@"\nrc=$?\nif [ "$1" = clone ] && [ "$rc" = 0 ]; then\n  for last in "$@"; do :; done\n  "${realGit}" -C "$last" rev-parse --is-shallow-repository >> "${audit}"\nfi\nexit "$rc"\n`);
  chmodSync(join(dir, "git"), 0o755);
  const run = async (skills: CatalogueSkillEntry[], overlay: ReadinessOverlay = []) => {
    const catalogueFile = join(dir, "catalogue.json");
    const overlayFile = join(dir, "overlay.json");
    write(catalogueFile, JSON.stringify({ ...CATALOGUE, skills }));
    write(overlayFile, JSON.stringify(overlay));
    try {
      const result = await exec(process.execPath, ["--import", "tsx", "--conditions=@agent-harness/source", script, "--catalogue", catalogueFile, "--overlay", overlayFile], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `url.${pathToFileURL(forge.root).href}/.insteadOf`,
          GIT_CONFIG_VALUE_0: SKILLS_HOST,
          GIT_ALLOW_PROTOCOL: "file",
        },
      });
      return { code: 0, output: result.stdout + result.stderr };
    } catch (error) {
      if (error instanceof Error && "code" in error && "stdout" in error && "stderr" in error) return { code: error.code, output: `${String(error.stdout)}${String(error.stderr)}` };
      throw error;
    }
  };
  return { forge, run, shallow: () => readFileSync(audit, "utf8").trim().split("\n") };
};

describe("the catalogue job's script", () => {
  it("reads every entry at the remote default branch, including a root skill and only direct children", async () => {
    const { forge, run, shallow } = fixture();
    forge.commit("owner/root-skill", { "SKILL.md": skill(null), "ignored/SKILL.md": skill("ignored") });
    forge.commit("owner/set", { "skills/old/SKILL.md": skill("old") });
    forge.commit("owner/set", { "skills/one/SKILL.md": skill("one"), "skills/deep/two/SKILL.md": skill("two") }, "release");
    testGit(join(forge.root, "owner/set.git"), "symbolic-ref", "HEAD", "refs/heads/release");
    const result = await run([entry("root-entry", "owner/root-skill", ".", ["root-skill"]), entry("set-entry", "owner/set", "skills", ["one"])]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("root-entry: 1 skill");
    expect(result.output).toContain("set-entry: 1 skill");
    expect(shallow()).toEqual(["true", "true"]);
  });

  it("fails with the entry and count difference after an upstream re-layout", async () => {
    const { forge, run } = fixture();
    const skills = [entry("moving-entry", "owner/moving", "skills", ["one"])];
    forge.commit("owner/moving", { "skills/one/SKILL.md": skill("one") });
    expect((await run(skills)).code).toBe(0);
    forge.commit("owner/moving", { "elsewhere/one/SKILL.md": skill("one") });
    const result = await run(skills);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("moving-entry: expected 1 skill(s), found 0");
  });

  it("fails with expected and found names even when the count stays the same", async () => {
    const { forge, run } = fixture();
    forge.commit("owner/renamed", { "skills/one/SKILL.md": skill("renamed") });
    const result = await run([entry("renamed-entry", "owner/renamed", "skills", ["one"])]);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("renamed-entry: expected names [one], found [renamed]");
  });

  it("checks overlay folders, including repositories outside the catalogue and intentionally removed folders", async () => {
    const { forge, run } = fixture();
    const overlay: ReadinessOverlay = [
      { repository: `${SKILLS_HOST}owner/overlay`, path: "skills/active", removedUpstream: false, declaration: { version: 1, checks: [] } },
      { repository: `${SKILLS_HOST}owner/overlay`, path: "skills/retired", removedUpstream: true, declaration: { version: 1, checks: [] } },
    ];
    forge.commit("owner/overlay", { "skills/active/SKILL.md": skill("active") });
    expect((await run([], overlay)).code).toBe(0);
    forge.commit("owner/overlay", { "elsewhere/active/SKILL.md": skill("active") });
    const result = await run([], overlay);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("overlay https://skills.test/owner/overlay:skills/active: expected folder present, found absent");
    forge.commit("owner/overlay", { "skills/active/SKILL.md": skill("active"), "skills/retired/SKILL.md": skill("retired") });
    const returned = await run([], overlay);
    expect(returned.code, returned.output).toBe(1);
    expect(returned.output).toContain("overlay https://skills.test/owner/overlay:skills/retired: expected folder absent, found present");
  });

  it("reports a broken repository alongside other entries and excludes invalid members", async () => {
    const { forge, run } = fixture();
    forge.commit("owner/invalid", { "skills/one/SKILL.md": skill("one", "") });
    const result = await run([entry("unreachable-entry", "owner/gone", ".", ["gone"]), entry("invalid-entry", "owner/invalid", "skills", ["one"])]);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("unreachable-entry:");
    expect(result.output).toContain("invalid-entry: expected 1 skill(s), found 0");
    expect(result.output).toContain("invalid-entry: invalid member one:");
  });
});

describe("the catalogue workflow", () => {
  it("runs only on manual dispatch until the external catalogue workflow is installed", () => {
    const root = join(import.meta.dirname, "../../../..");
    const relay = parse(readFileSync(join(root, ".forgejo/workflows/catalogue.yml"), "utf8"));
    expect(Object.keys(relay.on)).toEqual(["workflow_dispatch"]);
    expect(relay.jobs.catalogue["runs-on"]).toBe("relay");
    expect(relay.jobs.catalogue.steps).toContainEqual(expect.objectContaining({ run: "bash .forgejo/scripts/github-ci.sh", env: expect.objectContaining({ GH_CI_EVENT: "catalogue" }) }));
    const github = parse(readFileSync(join(root, ".forgejo/github-workflows/catalogue.yml"), "utf8"));
    expect(github.on.repository_dispatch.types).toEqual(["catalogue"]);
    expect(github.jobs.catalogue["runs-on"]).toBe("ubuntu-24.04");
    expect(github.jobs.catalogue.container).toBe("public.ecr.aws/docker/library/node:24-bookworm");
    expect(github.jobs.catalogue.steps).toContainEqual(expect.objectContaining({ with: expect.objectContaining({ ref: "${{ github.event.client_payload.sha }}" }) }));
    expect(github.jobs.catalogue.steps).toContainEqual(expect.objectContaining({ run: "pnpm exec tsx --conditions=@agent-harness/source packages/environment/scripts/check-catalogue.ts" }));
  });
});
