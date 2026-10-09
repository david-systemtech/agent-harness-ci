import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const run = promisify(execFile);
const script = join(import.meta.dirname, "../.forgejo/scripts/gallery-needed.py");
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "gallery-needed-"));
  folders.push(folder);
  const git = (...args: string[]) => run("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Tests", "-c", "user.email=tests@example.invalid", ...args], { cwd: folder });
  await git("init", "-q");
  await git("commit", "-qm", "base", "--allow-empty");
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("remote", "add", "origin", folder);
  const commit = async (path: string) => {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), "fixture\n");
    await git("add", path);
    await git("commit", "-qm", "change");
    return (await git("rev-parse", "HEAD")).stdout.trim();
  };
  const decide = async (head: string, labels: string[] = [], target = base) => {
    const event = join(folder, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { labels: labels.map((name) => ({ name })) } }));
    return run("python3", [script, target, head, event], { cwd: folder });
  };
  return { folder, git, base, commit, decide };
}

it("skips a non-GUI pull request", async () => {
  const f = await fixture();
  const head = await f.commit("packages/environment/src/service.ts");
  expect((await f.decide(head)).stdout.trim()).toBe("render=false");
});

it.each([
  "packages/gui/src/app.tsx",
  "packages/gui/gallery/scenes/dialog.tsx",
  "packages/gui/gallery/baselines/dialog.dark.png",
  "packages/gui/public/fonts/example.woff2",
  "packages/theme/src/tokens.ts",
  "packages/client-runtime/src/runtime.ts",
  "packages/contracts/src/settings.ts",
  "packages/browser/src/driver.ts",
  "scripts/gallery_reports.py",
  ".forgejo/scripts/gallery-needed.py",
  ".forgejo/scripts/github-ci.sh",
  ".forgejo/workflows/gallery.yml",
  ".forgejo/github-workflows/gallery.yml",
  "pnpm-lock.yaml",
])("renders when a capture input changes: %s", async (path) => {
  const f = await fixture();
  expect((await f.decide(await f.commit(path))).stdout.trim()).toBe("render=true");
});

it("renders a mixed diff even when the last push only changes documentation", async () => {
  const f = await fixture();
  await f.commit("packages/gui/src/app.tsx");
  expect((await f.decide(await f.commit("docs/example.md"))).stdout.trim()).toBe("render=true");
});

it("uses the merge base so a GUI change on main alone does not render a non-GUI PR", async () => {
  const f = await fixture();
  await f.git("checkout", "-qb", "topic");
  const head = await f.commit("packages/environment/src/service.ts");
  await f.git("checkout", "-q", f.base);
  const main = await f.commit("packages/gui/src/app.tsx");
  expect((await f.decide(head, [], main)).stdout.trim()).toBe("render=false");
});

it("the gallery label forces a non-GUI render; other labels do not", async () => {
  const f = await fixture();
  const head = await f.commit("docs/example.md");
  expect((await f.decide(head, ["gallery"])).stdout.trim()).toBe("render=true");
  expect((await f.decide(head, ["bot-1"])).stdout.trim()).toBe("render=false");
});

it.each(["delete", "rename"])("renders when a GUI baseline is removed by %s", async (action) => {
  const f = await fixture();
  const path = "packages/gui/gallery/baselines/dialog.dark.png";
  const base = await f.commit(path);
  await f.git(...(action === "delete" ? ["rm", path] : ["mv", path, "outside.png"]));
  await f.git("commit", "-qm", "remove baseline");
  const head = (await f.git("rev-parse", "HEAD")).stdout.trim();
  expect((await f.decide(head, [], base)).stdout.trim()).toBe("render=true");
});

it("skips when an earlier GUI change was fully reverted", async () => {
  const f = await fixture();
  const change = await f.commit("packages/gui/src/app.tsx");
  await f.git("revert", "--no-edit", change);
  const head = (await f.git("rev-parse", "HEAD")).stdout.trim();
  expect((await f.decide(head)).stdout.trim()).toBe("render=false");
});

it("refuses unreadable comparison data instead of skipping", async () => {
  const f = await fixture();
  await expect(f.decide("missing-head")).rejects.toThrow();
  const event = join(f.folder, "invalid-event.json");
  writeFileSync(event, JSON.stringify({ pull_request: { labels: null } }));
  await expect(run("python3", [script, f.base, f.base, event], { cwd: f.folder })).rejects.toThrow();
});
