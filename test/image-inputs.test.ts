/** PR image selection against real merge bases; no image, daemon or network is used. */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const script = join(root, ".forgejo/scripts/image-inputs.mjs");
const cleanups: string[] = [];
afterEach(() => { for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true }); });

const fixture = () => {
  const cwd = mkdtempSync(join(tmpdir(), "image-inputs-"));
  cleanups.push(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path: string, content = "fixture\n") => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };
  for (const name of readdirSync(join(root, "packages"))) {
    mkdirSync(join(cwd, "packages", name), { recursive: true });
    copyFileSync(join(root, "packages", name, "package.json"), join(cwd, "packages", name, "package.json"));
  }
  git("init", "-b", "main");
  git("config", "user.name", "Test Builder");
  git("config", "user.email", "builder@example.invalid");
  const commit = () => { git("add", "."); git("commit", "-m", "Fixture change"); };
  commit();
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-b", "feature");
  return {
    git, write, commit, cwd,
    decide: (labels: string[] = []) => {
      const event = join(cwd, ".git/event.json");
      const output = join(cwd, ".git/output");
      writeFileSync(event, JSON.stringify({ pull_request: { labels: labels.map(name => ({ name })) } }));
      writeFileSync(output, "");
      const stdout = execFileSync(process.execPath, [script], {
        cwd, encoding: "utf8", env: { ...process.env, GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output },
      });
      return { stdout, output: readFileSync(output, "utf8") };
    },
  };
};

it("skips a documentation-only PR and reports success without asking Docker to build", () => {
  const f = fixture();
  f.write("docs/contributing.md");
  f.commit();
  expect(f.decide()).toEqual({ stdout: "no image input changed: build skipped\n", output: "build=false\n" });
});

it("builds when an environment source file changes", () => {
  const f = fixture();
  f.write("packages/environment/src/serve/server.ts");
  f.commit();
  expect(f.decide().output).toBe("build=true\n");
});

it.each([
  "Dockerfile", ".dockerignore", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "tsconfig.base.json",
  "packages/contracts/src/events.ts", "packages/filesystem/src/index.ts", "packages/browser/src/index.ts",
  "packages/theme/src/index.ts", "packages/client-runtime/src/index.ts", "packages/tui/src/index.ts", "packages/cli/src/main.ts",
  "packages/gui/src/web/service-worker.ts", "packages/gui/src/setup/Setup.tsx", "packages/gui/public/phone-icons/icon.png", "packages/gui/vite.config.ts",
  "scripts/image-deps.sh", "scripts/image-sdk-cache.mjs", "scripts/image-version.mjs", "scripts/image-web-smoke.mjs", "scripts/stage-web-client.mjs",
  "scripts/compose.yaml", "scripts/host-updater.sh", ".forgejo/scripts/image.sh", ".forgejo/scripts/image-inputs.mjs",
  ".forgejo/workflows/image.yml", ".forgejo/workflows/release.yml", "public/.github-workflows/release.yml", ".forgejo/github-workflows/smoke.yml",
])("builds when an input changes: %s", path => {
  const f = fixture();
  f.write(path);
  f.commit();
  expect(f.decide().output).toBe("build=true\n");
});

it("skips GUI tests and gallery-only changes along with desktop code and docs", () => {
  const f = fixture();
  for (const path of ["packages/gui/src/setup/Setup.test.tsx", "packages/gui/test/harness.tsx", "packages/gui/gallery/baselines/window.png", "packages/desktop/src/main.ts", "packages/environment/src/serve/server.test.ts", "test/container.test.ts", "scripts/gallery-accept.sh", "docs/agents/gallery.md"]) f.write(path);
  f.commit();
  expect(f.decide().output).toBe("build=false\n");
});

it("builds a mixed change and retains an earlier input change after a docs-only push", () => {
  const f = fixture();
  f.write("packages/environment/src/serve/server.ts");
  f.write("packages/gui/gallery/scene.ts");
  f.commit();
  f.write("docs/contributing.md");
  f.commit();
  expect(f.decide().output).toBe("build=true\n");
});

it("the image label forces a build for a PR without any image input change", () => {
  const f = fixture();
  f.write("docs/contributing.md");
  f.commit();
  expect(f.decide(["bot-1"]).output).toBe("build=false\n");
  expect(f.decide(["bot-1", "image"])).toEqual({ stdout: "image label: build forced\n", output: "build=true\n" });
});

it("does not count image changes made only on main after the PR forked", () => {
  const f = fixture();
  f.write("docs/contributing.md");
  f.commit();
  f.git("checkout", "main");
  f.write("packages/environment/src/serve/server.ts");
  f.commit();
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  f.git("checkout", "feature");
  expect(f.decide().output).toBe("build=false\n");
});

it("includes the source path when an image input is deleted or renamed into tests", () => {
  const f = fixture();
  f.write("packages/environment/src/old.ts");
  f.write("packages/environment/src/remove.ts");
  f.commit();
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  f.git("mv", "packages/environment/src/old.ts", "packages/environment/src/old.test.ts");
  f.git("rm", "packages/environment/src/remove.ts");
  f.commit();
  expect(f.decide().output).toBe("build=true\n");
});

it("includes workspace dependencies newly introduced by the CLI", () => {
  const f = fixture();
  const path = "packages/cli/package.json";
  const manifest = JSON.parse(readFileSync(join(f.cwd, path), "utf8")) as { dependencies: Record<string, string> };
  manifest.dependencies["@agent-harness/extension"] = "workspace:*";
  f.write(path, JSON.stringify(manifest));
  f.commit();
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  f.write("packages/extension/src/worker.ts");
  f.commit();
  expect(f.decide().output).toBe("build=true\n");
});
