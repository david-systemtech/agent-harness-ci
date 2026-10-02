import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const script = join(root, "scripts/publish-public.py");
const folders: string[] = [];
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "public-snapshot-"));
  folders.push(dir);
  const source = join(dir, "source");
  const remote = join(dir, "public.git");
  mkdirSync(source);
  git(source, "init", "-q");
  git(source, "config", "user.name", "Private Developer");
  git(source, "config", "user.email", "private@example.com");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  const write = (path: string, text: string) => { mkdirSync(join(source, path, ".."), { recursive: true }); writeFileSync(join(source, path), text); };
  write(".public-exclude", readFileSync(join(root, ".public-exclude"), "utf8") + "\nprivate/\n");
  write(".public-privacy.json", readFileSync(join(root, ".public-privacy.json"), "utf8"));
  write(".public-map.json", "{}\n");
  write("README.md", "Public README from the ref\n");
  write(".github/workflows/release.yml", "name: public release\n");
  write("private/runbook.md", "private deployment notes\n");
  write(".forgejo/internal.yml", "private workflow\n");
  write("old-secret.txt", "discarded private history\n");
  const commit = () => { git(source, "add", "."); git(source, "commit", "-qm", "private source commit"); };
  commit();
  git(source, "rm", "-q", "old-secret.txt");
  commit();
  const scanner = join(dir, "gitleaks");
  writeFileSync(scanner, `#!/usr/bin/env python3\nimport pathlib,sys\nif sys.argv[1:] == ['version']: print('8.30.1'); sys.exit(0)\nassert sys.argv[1] == 'dir' and '--redact' in sys.argv and '--no-banner' in sys.argv\nassert '--ignore-gitleaks-allow' in sys.argv\nassert not (pathlib.Path(sys.argv[-1]) / '.git').exists()\nsys.exit(1 if any(b'fake-secret-for-tests' in p.read_bytes() for p in pathlib.Path(sys.argv[-1]).rglob('*') if p.is_file()) else 0)\n`);
  chmodSync(scanner, 0o755);
  const publishWithEnv = (env: NodeJS.ProcessEnv, ...args: string[]) => execFileSync("python3", [script, "--source", source, "--ref", "HEAD", "--remote", remote, "--version", "1.2.3", "--gitleaks", scanner, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  const publish = (...args: string[]) => publishWithEnv({}, ...args);
  return { source, remote, scanner, write, commit, publish, publishWithEnv };
}
it("publishes a cleaned root snapshot and stacks a second snapshot with a release tag", () => {
  const f = fixture();
  f.publish("--tag", "v1.2.3");
  expect(git(f.remote, "ls-tree", "-r", "--name-only", "main").split("\n")).toEqual([".github/workflows/release.yml", "README.md"]);
  expect(git(f.remote, "rev-list", "--count", "main")).toBe("1");
  expect(() => git(f.remote, "cat-file", "-e", git(f.source, "rev-parse", "HEAD"))).toThrow();
  expect(git(f.remote, "show", "main:README.md")).toBe("Public README from the ref");
  expect(git(f.remote, "log", "-1", "--format=%an|%ae|%cn|%ce|%s", "main")).toBe("Public snapshot|snapshot@users.noreply.github.com|Public snapshot|snapshot@users.noreply.github.com|Publish 1.2.3");
  expect(git(f.remote, "rev-parse", "v1.2.3")).toBe(git(f.remote, "rev-parse", "main"));
  const previous = git(f.remote, "rev-parse", "main");
  f.write("README.md", "Second public snapshot\n"); f.commit();
  f.publish("--version", "1.2.4", "--tag", "v1.2.4");
  expect(git(f.remote, "rev-list", "--count", "main")).toBe("2");
  expect(git(f.remote, "rev-parse", "main^")).toBe(previous);
  expect(git(f.remote, "for-each-ref", "--format=%(refname)").split("\n")).toEqual(["refs/heads/main", "refs/tags/v1.2.3", "refs/tags/v1.2.4"]);
});

it("preserves the selected ref's exact blob bytes and executable modes", () => {
  const f = fixture();
  f.write("README.md", "Committed public README\r\n");
  f.write("launch.sh", "#!/bin/sh\necho public\n");
  chmodSync(join(f.source, "launch.sh"), 0o755);
  f.commit();
  // A later attributes file must not transform blobs already stored in the ref.
  f.write(".gitattributes", "README.md text\n");
  git(f.source, "add", ".gitattributes"); git(f.source, "commit", "-qm", "add attributes");
  f.write("README.md", "Uncommitted private edit\n");
  f.publish();
  expect(execFileSync("git", ["-C", f.remote, "show", "main:README.md"], { encoding: "utf8" })).toBe("Committed public README\r\n");
  expect(git(f.remote, "ls-tree", "main", "launch.sh")).toMatch(/^100755 blob /);
});

it.each(["public/.github-workflows/release.yml", "public/custom.yml"])("installs the declared workflow mapping from %s without its source copy", (source) => {
  const f = fixture();
  f.write(".public-map.json", JSON.stringify({ [source]: ".github/workflows/release.yml" }));
  f.write(".public-exclude", readFileSync(join(root, ".public-exclude"), "utf8") + "\n.public-map.json\npublic/.github-workflows/\nprivate/\n");
  f.write(source, "name: mapped public release\n");
  git(f.source, "rm", "-q", ".github/workflows/release.yml");
  f.commit();
  f.publish();
  expect(git(f.remote, "show", "main:.github/workflows/release.yml")).toBe("name: mapped public release");
  expect(git(f.remote, "ls-tree", "-r", "--name-only", "main").split("\n")).toEqual([".github/workflows/release.yml", "README.md"]);
});

it.each(["../escape.yml", "/escape.yml", ".git/config", ".forgejo/workflows/release.yml"])("refuses an unsafe or excluded mapping destination %s", (destination) => {
  const f = fixture();
  f.write(".public-map.json", JSON.stringify({ "README.md": destination })); f.commit();
  expect(() => f.publish()).toThrow();
  expect(git(f.remote, "for-each-ref")).toBe("");
});

it.each([
  'readFileSync(".forgejo/workflows/ci.yml")',
  'readFileSync(join(root, ".forgejo", "workflows", "ci.yml"))',
  'readFileSync(join(root, "docs", "agents", "switch-over-runbook.md"))',
  'readFileSync("docs/routines/hermes-delivery.md")',
])("refuses a kept test naming an excluded input: %s", (contents) => {
  const f = fixture();
  f.write("test/public.test.ts", contents); f.commit();
  expect(() => f.publish()).toThrow(/test\/public.test.ts:1: excluded test input/);
  expect(git(f.remote, "for-each-ref")).toBe("");
});

it("checks the committed repository's actual filtered test inventory before the privacy gate", () => {
  const f = fixture();
  let output: string;
  // The scrub can still be pending; this check observes export and test closure.
  try { output = f.publish("--source", root, "--dry-run"); }
  catch (error) { output = (error as { stdout: string }).stdout; }
  expect(output).toContain("Test inputs: pass");
  expect(git(f.remote, "for-each-ref")).toBe("");
}, 120_000);

it("checks UTF-8 tests even when the caller's locale is ASCII", () => {
  const f = fixture();
  f.write("test/public.test.ts", "// café\n"); f.commit();
  f.publishWithEnv({ LC_ALL: "C", PYTHONUTF8: "0", PYTHONCOERCECLOCALE: "0" });
  expect(git(f.remote, "show", "main:test/public.test.ts")).toBe("// café");
});

it.skipIf(process.env["GITHUB_ACTIONS"] !== "true" || process.env["RUNNER_ENVIRONMENT"] !== "github-hosted")("runs the hosted check commands on an actual published-tree fixture", () => {
  const f = fixture();
  git(f.source, "rm", "-q", ".github/workflows/release.yml");
  for (const path of git(root, "ls-files").split("\n")) {
    mkdirSync(join(f.source, path, ".."), { recursive: true });
    cpSync(join(root, path), join(f.source, path));
  }
  // This integration fixture tests public test closure before the scrub lands.
  // Real publication always runs its selected ref's privacy policy unchanged.
  f.write(".public-privacy.json", JSON.stringify({ deny: [], allow: [] }));
  git(f.source, "add", "-f", ".");
  git(f.source, "commit", "-qm", "public check fixture");
  f.publish();
  const published = join(f.source, "..", "published");
  execFileSync("git", ["clone", "-q", "--branch", "main", f.remote, published]);
  const run = (args: string[]) => {
    try {
      execFileSync("pnpm", args, {
        cwd: published, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 20 * 1024 * 1024,
      });
    } catch (error) {
      const failure = error as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(`Public checkout: pnpm ${args.join(" ")} failed\n${String(failure.stdout ?? "")}\n${String(failure.stderr ?? "")}`, { cause: error });
    }
  };
  run(["install", "--frozen-lockfile"]);
  run(["typecheck"]);
  run(["lint"]);
  // The publisher test itself is excluded, so this full run cannot recurse.
  run(["test", "--maxWorkers=4"]);
  expect(git(published, "ls-tree", "-r", "--name-only", "HEAD")).toContain(".github/workflows/release.yml");
}, 1_200_000);

it("dry-runs the full checks and commit without moving public refs", () => {
  const f = fixture();
  const output = f.publish("--dry-run", "--tag", "v1.2.3");
  expect(output).toContain("Privacy deny-list: pass");
  expect(output).toContain("gitleaks: pass");
  expect(output).toMatch(/Commit: [a-f0-9]{40}\nParent: \(root\)\nMessage: Publish 1.2.3/);
  expect(output).toContain(".github/workflows/release.yml\nREADME.md");
  expect(git(f.remote, "for-each-ref")).toBe("");
});

it.each([
  ["host", "README.md", ["SYSTEM", "SERVER"].join("-")],
  ["company", "README.md", ["Brands", "olidate"].join("")],
  ["vault", "README.md", ["personal", "forgejo"].join("/")],
  ["private IP", "README.md", "10.44.55.66"],
  ["private IPv6", "README.md", "fd12:3456:789a::1"],
  ["private fixture IP", "test/fixture.txt", "10.44.55.66"],
  ["private filename", ["SYSTEM", "SERVER.txt"].join("-"), "public content"],
  ["secret", "ignored.txt", "fake-secret-for-tests"],
])("blocks a planted %s before any push", (_name, path, content) => {
  const f = fixture();
  f.write(path, content); f.commit();
  expect(() => f.publish()).toThrow();
  expect(git(f.remote, "for-each-ref")).toBe("");
});

it("allows only the listed synthetic fixture values, while scanning fixture prose", () => {
  const f = fixture();
  f.write("test/fixture.txt", "synthetic: 10.0.0.1, 192.168.1.2, 100.64.0.1; documentation: 192.0.2.1, tail1234, example.com\n");
  f.commit(); f.publish();
  const previous = git(f.remote, "rev-parse", "main");
  f.write("test/fixture.txt", ["SYSTEM", "MNL"].join("-")); f.commit();
  expect(() => f.publish()).toThrow();
  expect(git(f.remote, "rev-parse", "main")).toBe(previous);
});

it("refuses an existing tag atomically without advancing main", () => {
  const f = fixture(); f.publish("--tag", "v1.2.3");
  const previous = git(f.remote, "rev-parse", "main");
  f.write("README.md", "Next snapshot\n"); f.commit();
  expect(() => f.publish("--tag", "v1.2.3")).toThrow();
  expect(git(f.remote, "rev-parse", "main")).toBe(previous);
});

it("reports scanner rule and location without exposing matched secrets or scanner output", () => {
  const f = fixture();
  writeFileSync(f.scanner, `#!/usr/bin/env python3
import json,pathlib,sys
if sys.argv[1:] == ['version']: print('8.30.1'); sys.exit(0)
args = sys.argv[1:]
report = pathlib.Path(args[args.index('--report-path') + 1]) if '--report-path' in args else None
if report:
    report.write_text(json.dumps([{'File': str(pathlib.Path(args[-1]) / 'README.md'), 'StartLine': 7, 'RuleID': 'test-secret-rule', 'Secret': 'fake-secret-for-tests', 'Match': 'fake-secret-for-tests'}]))
print('fake-secret-for-tests')
print('fake-secret-for-tests', file=sys.stderr)
sys.exit(1)
`);
  let failure: unknown;
  try { f.publish(); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ status: 1 });
  const stderr = (failure as { stderr: string }).stderr;
  expect(stderr).toContain('"README.md":7: test-secret-rule');
  expect(stderr).toContain("publication blocked");
  expect(stderr).not.toContain("fake-secret-for-tests");
  expect(git(f.remote, "for-each-ref")).toBe("");
});

it("blocks secrets even when the selected tree contains scanner ignore fingerprints", () => {
  const f = fixture();
  f.write("README.md", "fake-secret-for-tests\n");
  f.write(".gitleaksignore", "test-secret-fingerprint\n");
  f.commit();
  writeFileSync(f.scanner, `#!/usr/bin/env python3
import pathlib,sys
if sys.argv[1:] == ['version']: print('8.30.1'); sys.exit(0)
args = sys.argv[1:]
ignore = pathlib.Path(args[-1]) / '.gitleaksignore'
suppressed = ignore.is_file() and bool(ignore.read_text().strip())
secret = any(b'fake-secret-for-tests' in p.read_bytes() for p in pathlib.Path(args[-1]).rglob('*') if p.is_file())
sys.exit(1 if secret and not suppressed else 0)
`);
  expect(() => f.publish()).toThrow();
  expect(git(f.remote, "for-each-ref")).toBe("");
});

it("refuses an unpinned scanner and missing public release files", () => {
  const f = fixture();
  const scanner = join(f.source, "..", "wrong-gitleaks");
  writeFileSync(scanner, "#!/bin/sh\necho 0.0.0\n"); chmodSync(scanner, 0o755);
  expect(() => f.publish("--gitleaks", scanner)).toThrow();
  git(f.source, "rm", "-q", ".github/workflows/release.yml"); f.commit();
  expect(() => f.publish()).toThrow();
  expect(git(f.remote, "for-each-ref")).toBe("");
});

it("refuses symlinks before the scanner can follow anything outside the tree", () => {
  const f = fixture();
  symlinkSync("../private-file", join(f.source, "external-link")); f.commit();
  expect(() => f.publish()).toThrow();
  expect(git(f.remote, "for-each-ref")).toBe("");
});
