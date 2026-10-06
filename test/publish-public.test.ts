import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const script = join(root, "scripts/publish-public.py");
const folders: string[] = [];
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });
// The hosted release workflow's check job owns the test suite (#1679).
const rehearsalSteps = [["install", "--frozen-lockfile"], ["typecheck"], ["lint"]];
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
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const rehearsalLog = join(dir, "rehearsal.jsonl");
  writeFileSync(join(bin, "pnpm"), `#!/usr/bin/env python3
import json,os,pathlib,subprocess,sys
args = sys.argv[1:]
def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()
with open(os.environ['REHEARSAL_LOG'], 'a') as log:
    log.write(json.dumps({'args': args, 'head': git('rev-parse', 'HEAD'),
                         'files': git('ls-tree', '-r', '--name-only', 'HEAD').split('\\n'),
                         'remoteRefs': git('-C', os.environ['PUBLIC_REMOTE'], 'for-each-ref')}) + '\\n')
if args[0] == os.environ.get('REHEARSAL_FAIL'):
    print('fake-secret-for-tests', file=sys.stderr)
    sys.exit(17)
if os.environ.get('REHEARSAL_MUTATE'):
    pathlib.Path('README.md').write_text('generated change')
    pathlib.Path('generated.txt').write_text('generated file')
`);
  chmodSync(join(bin, "pnpm"), 0o755);
  const rehearsal = () => readFileSync(rehearsalLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; head: string; files: string[]; remoteRefs: string });
  const publishWithEnv = (env: NodeJS.ProcessEnv, ...args: string[]) => execFileSync("python3", [script, "--source", source, "--ref", "HEAD", "--remote", remote, "--version", "1.2.3", "--gitleaks", scanner, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}`, REHEARSAL_LOG: rehearsalLog, PUBLIC_REMOTE: remote, ...env } });
  const publish = (...args: string[]) => publishWithEnv({}, ...args);
  return { source, remote, scanner, write, commit, publish, publishWithEnv, rehearsal };
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

it("rehearses the proposed public commit before publishing it", () => {
  const f = fixture();
  const output = f.publish("--tag", "v1.2.3");
  const steps = f.rehearsal();
  expect(steps.map((step) => step.args)).toEqual(rehearsalSteps);
  for (const step of steps) {
    expect(step.head).toBe(git(f.remote, "rev-parse", "main"));
    expect(step.files).toEqual([".github/workflows/release.yml", "README.md"]);
    expect(step.remoteRefs).toBe("");
  }
  expect(output).toContain("Public checkout rehearsal: pass");
});

it.each(["install", "typecheck", "lint"])("blocks both public refs when the rehearsal's %s fails", (step) => {
  const f = fixture();
  f.publish("--tag", "v1.2.3");
  const previous = git(f.remote, "for-each-ref");
  f.write("README.md", "Next public snapshot\n"); f.commit();
  let failure: unknown;
  try { f.publishWithEnv({ REHEARSAL_FAIL: step }, "--version", "1.2.4", "--tag", "v1.2.4"); }
  catch (error) { failure = error; }
  const stderr = (failure as { stderr: string }).stderr;
  expect(stderr).toContain(`pnpm ${step}`);
  expect(stderr).toContain("failed (exit 17); publication blocked");
  expect(stderr).not.toContain("fake-secret-for-tests");
  expect(git(f.remote, "for-each-ref")).toBe(previous);
  const names = rehearsalSteps.map((args) => args[0]);
  expect(f.rehearsal().slice(rehearsalSteps.length).map((entry) => entry.args[0])).toEqual(
    names.slice(0, names.indexOf(step) + 1),
  );
});

it("runs no test step in the rehearsal, by any name", () => {
  const f = fixture();
  f.publish("--dry-run");
  for (const step of f.rehearsal()) expect(step.args.join(" ")).not.toMatch(/test|vitest/);
});

it("publishes without a second rehearsal when told a dry run of the same ref and version passed", () => {
  const f = fixture();
  f.publish("--dry-run", "--tag", "v1.2.3");
  expect(f.rehearsal()).toHaveLength(rehearsalSteps.length);
  const output = f.publish("--tag", "v1.2.3", "--no-rehearsal");
  expect(f.rehearsal()).toHaveLength(rehearsalSteps.length);
  expect(output).toContain("Public checkout rehearsal: skipped (--no-rehearsal)");
  expect(output).not.toContain("Public checkout rehearsal: pass");
  expect(output).toContain("gitleaks: pass");
  expect(git(f.remote, "rev-parse", "v1.2.3")).toBe(git(f.remote, "rev-parse", "main"));
});

it("refuses to skip the rehearsal on a dry run", () => {
  const f = fixture();
  const result = spawnSync("python3", [script, "--source", f.source, "--ref", "HEAD", "--remote", f.remote,
    "--version", "1.2.3", "--gitleaks", f.scanner, "--dry-run", "--no-rehearsal"], { encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--no-rehearsal is refused on a dry run: the dry run is the rehearsal a publish may skip");
  expect(result.stdout).not.toContain("Dry run: no refs pushed");
  expect(git(f.remote, "for-each-ref")).toBe("");
});

it("documents the rehearsal opt-out as safe only after a passing dry run", () => {
  const help = execFileSync("python3", [script, "--help"], { encoding: "utf8" }).replace(/\s+/g, " ");
  expect(help).toContain("--no-rehearsal");
  expect(help).toContain("only after a passing dry run of the same ref and version");
});

it.each(["posix", "nt"])("stops the whole timed-out rehearsal on %s before blocking publication", (platform) => {
  const f = fixture();
  const result = spawnSync("python3", ["-c", `
import os,runpy,shutil,signal,subprocess,sys,types
publisher = runpy.run_path(sys.argv[1])['main']
namespace = publisher.__globals__
real_popen, real_run = subprocess.Popen, subprocess.run
alive = {'launcher': True, 'worker': True}
class RehearsalProcess:
    pid = 12345
    def __init__(self, args, **kwargs):
        self.args = args
    def __enter__(self):
        return self
    def __exit__(self, *args):
        assert not any(alive.values()), 'rehearsal processes survived cleanup'
    def wait(self, timeout=None):
        if timeout is not None:
            raise subprocess.TimeoutExpired(self.args, timeout)
        assert not alive['launcher'], 'launcher was not terminated'
        return 1
    def kill(self):
        alive['launcher'] = False

def popen(args, **kwargs):
    if args[0] == 'pnpm':
        return RehearsalProcess(args, **kwargs)
    return real_popen(args, **kwargs)

def run(args, **kwargs):
    if args[0] == 'taskkill':
        assert args == ['taskkill', '/PID', '12345', '/T', '/F']
        assert kwargs['stdout'] == subprocess.DEVNULL
        assert kwargs['stderr'] == subprocess.DEVNULL
        alive.update(launcher=False, worker=False)
        return subprocess.CompletedProcess(args, 0)
    return real_run(args, **kwargs)

def killpg(pid, sig):
    assert pid == 12345 and sig == signal.SIGKILL
    alive.update(launcher=False, worker=False)

namespace['os'] = types.SimpleNamespace(**{**vars(os), 'name': sys.argv[2], 'killpg': killpg})
namespace['shutil'] = types.SimpleNamespace(**{**vars(shutil), 'which': lambda name: 'pnpm'})
subprocess.Popen, subprocess.run = popen, run
sys.argv = [sys.argv[1], *sys.argv[3:]]
assert publisher() == 1
assert not any(alive.values())
`, script, platform, "--source", f.source, "--ref", "HEAD", "--remote", f.remote,
  "--version", "1.2.3", "--tag", "v1.2.3", "--gitleaks", f.scanner], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("Public checkout rehearsal exceeded 30 minutes; publication blocked");
  expect(result.stdout).not.toContain("Published ");
  expect(result.stdout).not.toContain("Public checkout rehearsal: pass");
  expect(git(f.remote, "for-each-ref")).toBe("");
});

it.each([0, 17])("launches the resolved Windows pnpm shim and keeps diagnostics safe on exit %s", (status) => {
  const f = fixture();
  const result = spawnSync("python3", ["-c", `
import json,os,runpy,shutil,subprocess,sys,types
publisher = runpy.run_path(sys.argv[1])['main']
namespace = publisher.__globals__
real_popen = subprocess.Popen
shim = 'C:/test-tools/pnpm.cmd'
calls = []
status = int(sys.argv[2])
class RehearsalProcess:
    def __init__(self, args, **kwargs):
        assert kwargs['stdout'] == subprocess.DEVNULL
        assert kwargs['stderr'] == subprocess.DEVNULL
        self.args = args
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def wait(self, timeout=None):
        return status

def which(name):
    assert name == 'pnpm'
    return shim

def popen(args, **kwargs):
    if args[0] in ('pnpm', shim):
        if args[0] != shim:
            raise FileNotFoundError('unresolved pnpm launcher')
        calls.append(args[1:])
        return RehearsalProcess(args, **kwargs)
    return real_popen(args, **kwargs)

namespace['os'] = types.SimpleNamespace(**{**vars(os), 'name': 'nt'})
namespace['shutil'] = types.SimpleNamespace(**{**vars(shutil), 'which': which})
subprocess.Popen = popen
sys.argv = [sys.argv[1], *sys.argv[3:]]
assert publisher() == (1 if status else 0)
print(json.dumps(calls))
`, script, String(status), "--source", f.source, "--ref", "HEAD", "--remote", f.remote,
  "--version", "1.2.3", "--tag", "v1.2.3", "--gitleaks", f.scanner], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "null")).toEqual(status
    ? [["install", "--frozen-lockfile"]]
    : rehearsalSteps);
  expect(result.stderr).not.toContain("C:/test-tools");
  if (status) {
    expect(result.stderr).toContain("pnpm install --frozen-lockfile failed (exit 17); publication blocked");
    expect(git(f.remote, "for-each-ref")).toBe("");
  } else {
    expect(result.stdout).toContain("Public checkout rehearsal: pass");
    expect(git(f.remote, "for-each-ref")).toContain("refs/heads/main");
  }
});

it("keeps rehearsal changes and generated files out of the public snapshot", () => {
  const f = fixture();
  f.publishWithEnv({ REHEARSAL_MUTATE: "true" });
  expect(git(f.remote, "show", "main:README.md")).toBe("Public README from the ref");
  expect(git(f.remote, "ls-tree", "-r", "--name-only", "main").split("\n")).toEqual([".github/workflows/release.yml", "README.md"]);
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
  expect(f.rehearsal()[0]?.files).toEqual([".github/workflows/release.yml", "README.md"]);
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

it.each([
  'readFileSync(join(\n  "docs",\n  "routines",\n  "hermes-delivery.md"\n))',
  'readFileSync(join(\n  "docs",\n  "agents",\n  "switch-over-runbook.md"\n))',
  'readFileSync(join(\n  "test",\n  "container.test.ts"\n))',
])("refuses multiline joins naming excluded test inputs: %s", (contents) => {
  const f = fixture();
  f.write("test/public.test.ts", contents); f.commit();
  expect(() => f.publish("--dry-run")).toThrow(/excluded test input/);
  expect(git(f.remote, "for-each-ref")).toBe("");
});

it("reports the original line after earlier multiline joins", () => {
  const f = fixture();
  f.write("test/public.test.ts", 'readFileSync(join(\n  "public",\n  "notes.md"\n));\nreadFileSync(join(\n  "docs",\n  "routines",\n  "hermes-delivery.md"\n));'); f.commit();
  expect(() => f.publish("--dry-run")).toThrow(/test\/public.test.ts:6: excluded test input/);
  expect(git(f.remote, "for-each-ref")).toBe("");
});

it("refuses excluded test paths stored as UTF-16", () => {
  const f = fixture();
  f.write("test/public.test.ts", "");
  writeFileSync(join(f.source, "test/public.test.ts"), Buffer.from('readFileSync(".forgejo/workflows/ci.yml")', "utf16le")); f.commit();
  expect(() => f.publish()).toThrow(/test\/public.test.ts:1: excluded test input/);
  expect(git(f.remote, "for-each-ref")).toBe("");
});

it("checks the committed repository's actual filtered test inventory and privacy policy", () => {
  const f = fixture();
  let output: string;
  try { output = f.publish("--source", root, "--dry-run"); }
  catch (error) { output = (error as { stdout: string }).stdout; }
  expect(output).toContain("Test inputs: pass");
  expect(output).toContain("Privacy deny-list: pass");
  expect(git(f.remote, "for-each-ref")).toBe("");
}, 120_000);

it("checks UTF-8 tests even when the caller's locale is ASCII", () => {
  const f = fixture();
  f.write("test/public.test.ts", "// café\n"); f.commit();
  f.publishWithEnv({ LC_ALL: "C", PYTHONUTF8: "0", PYTHONCOERCECLOCALE: "0" });
  expect(git(f.remote, "show", "main:test/public.test.ts")).toBe("// café");
});

it("dry-runs the full checks and commit without moving public refs", () => {
  const f = fixture();
  const output = f.publish("--dry-run", "--tag", "v1.2.3");
  expect(output).toContain("Privacy deny-list: pass");
  expect(output).toContain("gitleaks: pass");
  expect(output).toContain("Public checkout rehearsal: pass");
  expect(f.rehearsal().map((step) => step.args)).toEqual(rehearsalSteps);
  for (const step of f.rehearsal()) {
    expect(output).toContain(`Commit: ${step.head}\n`);
    expect(step.remoteRefs).toBe("");
  }
  expect(output).toMatch(/Commit: [a-f0-9]{40}\nParent: \(root\)\nMessage: Publish 1.2.3/);
  expect(output).toContain(".github/workflows/release.yml\nREADME.md");
  expect(git(f.remote, "for-each-ref")).toBe("");
});

it.each([
  ["deployment variants", ["SYSTEM", "USA"].join("-")],
  ["person boundary", ["se", "th"].join("")],
  ["company whitespace", ["brand", "solidate"].join("\n")],
  ["company separator", ["cool", "jams"].join("-")],
  ["company name", ["blue", "beards"].join("")],
  ["company phrase", ["sir", "waggingtons"].join("\\n")],
  ["vault organization", ["systemtech", "dev/"].join("")],
  ["vault service", ["personal", "forgejo"].join("/")],
  ["vault agents", ["personal", "agents/"].join("/")],
  ["private account", ["david", "abusiewiez"].join("")],
  ["deployment service", ["dok", "ploy"].join("")],
  ["relay name", ["vm", "relay", "1"].join("-")],
  ["vault host", ["bao", "systemtech", "dev"].join(".")],
  ["location boundary", ["m", "nl"].join("")],
  ["private project", ["cor", "tex"].join("")],
  ["person name", ["al", "bert"].join("")],
  ["private address", [100, 109, 204, 54].join(".")],
  ["private release", ["v2026", "9", "24"].join(".")],
  ["organization boundary", ["system", "tech"].join("")],
  ["private remote alias", ["git", "systemtech"].join("-")],
  ["audit marker", ["oa9YJpND", "k68"].join("")],
  ["private revision", ["d3b25", "b5"].join("")],
  ["runner name", ["mba", "macos", "12"].join("-")],
  ["escaped deployment separator", ["system", "server"].join("\\t")],
  ["escaped company separator", ["brand", "solidate"].join("\\r")],
])("blocks the scrub deny-list's %s in a future snapshot", (_name, content) => {
  const f = fixture();
  f.write("README.md", content); f.commit();
  expect(() => f.publish("--dry-run")).toThrow(/Privacy deny-list failed/);
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

it.each(["Gateway at 10.44.55.66.", ".10.44.55.66", "(10.44.55.66).", "10.44.55.66, next"])("blocks a private address with prose punctuation: %s", (contents) => {
  const f = fixture();
  f.write("README.md", contents); f.commit();
  expect(() => f.publish("--dry-run")).toThrow(/Privacy deny-list failed/);
  expect(git(f.remote, "for-each-ref")).toBe("");
});

it("keeps private address matching bounded to complete dotted numbers", () => {
  const f = fixture();
  f.write("README.md", "9.10.44.55.66; 10.44.55.66.7; 110.44.55.66"); f.commit();
  f.publish("--dry-run");
  expect(git(f.remote, "for-each-ref")).toBe("");
});

it.each([false, true])("blocks a UTF-16 private term (big endian: %s)", (bigEndian) => {
  const f = fixture();
  f.write("test.ps1", "");
  const encoded = Buffer.from(["SYSTEM", "SERVER"].join("-"), "utf16le");
  if (bigEndian) encoded.swap16();
  writeFileSync(join(f.source, "test.ps1"), encoded); f.commit();
  expect(() => f.publish()).toThrow(/test.ps1:1: deployment-host/);
  expect(git(f.remote, "for-each-ref")).toBe("");
});

it("allows documented network constants without allowing deployment addresses or names", () => {
  const f = fixture();
  f.write("README.md", "Tailscale range: 100.64.0.0/10\n");
  f.write("scripts/compose.yaml", "# Tailscale range: 100.64.0.0/10\n");
  f.write("docs/specs/browser.md", "Metadata addresses: 100.100.100.200 and fd00:ec2::254\n");
  f.write("packages/client-runtime/src/access/words.ts", "Example peer: 100.64.0.7");
  f.write("packages/contracts/schema/cases/repository-identity.json", '{"host":"100.101.102.103"}');
  f.commit(); f.publish("--dry-run");
  for (const path of ["README.md", "scripts/compose.yaml"]) {
    f.write(path, "100.64.0.9"); f.commit();
    expect(() => f.publish("--dry-run")).toThrow(/Privacy deny-list failed/);
    f.write(path, "Tailscale range: 100.64.0.0/10\n"); f.commit();
  }
  f.write("docs/specs/browser.md", "10.44.55.66"); f.commit();
  expect(() => f.publish("--dry-run")).toThrow(/Privacy deny-list failed/);
  f.write("docs/specs/browser.md", "100.100.100.200");
  f.write("packages/contracts/schema/cases/repository-identity.json", JSON.stringify({ host: [100, 109, 204, 54].join(".") })); f.commit();
  expect(() => f.publish("--dry-run")).toThrow(/scrub-private-address/);
  expect(git(f.remote, "for-each-ref")).toBe("");
});

it("allows LAN preference subnet constants only in the detector, retaining address denial", () => {
  const f = fixture();
  const detector = "packages/environment/src/serve/interfaces.ts";
  f.write(detector, "LAN subnets: 10.0.0.0, 172.16.0.0, 192.168.0.0, fc00::\n");
  f.commit(); f.publish("--dry-run");
  f.write(detector, "10.0.0.1"); f.commit();
  expect(() => f.publish("--dry-run")).toThrow(/Privacy deny-list failed/);
  f.write(detector, "");
  f.write("README.md", "10.0.0.0"); f.commit();
  expect(() => f.publish("--dry-run")).toThrow(/Privacy deny-list failed/);
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

it("identifies a failed Git operation without forwarding its remote or stderr", () => {
  const f = fixture();
  let failure: unknown;
  try { f.publish("--remote", join(f.source, "..", "fake-secret-for-tests-not-a-repository")); }
  catch (error) { failure = error; }
  expect(failure).toMatchObject({ status: 1 });
  const stderr = (failure as { stderr: string }).stderr;
  expect(stderr).toContain("git ls-remote failed");
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


it.each(["tEXt", "zTXt", "iTXt"])("blocks private text in PNG %s metadata", (kind) => {
  const f = fixture();
  f.write(".public-privacy.json", JSON.stringify({ deny: [{ id: "sample", pattern: "private-example" }], allow: [] }));
  const image = readFileSync(join(root, "packages/gui/gallery/baselines/window-empty.dark.png"));
  const text = Buffer.from("private-example");
  const payload = kind === "tEXt" ? Buffer.concat([Buffer.from("Note\0"), text])
    : kind === "zTXt" ? Buffer.concat([Buffer.from("Note\0\0"), deflateSync(text)])
      : Buffer.concat([Buffer.from("Note\0\x01\0\0\0"), deflateSync(text)]);
  const typeAndPayload = Buffer.concat([Buffer.from(kind), payload]);
  const length = Buffer.alloc(4); length.writeUInt32BE(payload.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(typeAndPayload));
  writeFileSync(join(f.source, "capture.png"), Buffer.concat([image.subarray(0, -12), length, typeAndPayload, checksum, image.subarray(-12)]));
  f.commit();
  expect(() => f.publish()).toThrow(/capture.png:.*sample/);
  expect(git(f.remote, "for-each-ref")).toBe("");
});


it("refuses corrupt PNG chunks before publishing", () => {
  const f = fixture();
  const image = readFileSync(join(root, "packages/gui/gallery/baselines/window-empty.dark.png"));
  image[image.length - 1] = image[image.length - 1]! ^ 1;
  writeFileSync(join(f.source, "capture.png"), image);
  f.commit();
  expect(() => f.publish()).toThrow(/Invalid PNG checksum/);
  expect(git(f.remote, "for-each-ref")).toBe("");
});
