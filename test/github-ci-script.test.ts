/**
 * The `ci` relay (`.forgejo/scripts/github-ci.sh`), run
 * by `bash` on a fake PATH: nothing here reaches GitHub. A fake `curl` serves
 * a fixture tarball whose `gitleaks` logs its call and reports a leak, so every
 * scan test stops before the relay pushes anything. API tests pass the scan
 * and fake git pushes, curl replies and sleep; nothing leaves the fixture.
 * The fixture is not the pinned release, so a `sha256sum` wrapper checks it against its own digest
 * wherever the script names the pinned one, and still compares real bytes: a
 * damaged copy fails the check as it would on the runner.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const script = join(root, ".forgejo", "scripts", "github-ci.sh");
const run = promisify(execFile);

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const VERSION = "8.30.1";
const ARCH = process.arch === "arm64" ? "arm64" : "x64";
/** The script's pin for this machine, read from its own table. */
const PINNED = (() => {
  const pin = new RegExp(`gl_arch=${ARCH} gl_sum=([0-9a-f]{64})`).exec(readFileSync(script, "utf8"));
  if (!pin?.[1]) throw new Error(`no gitleaks pin for ${ARCH} in github-ci.sh`);
  return pin[1];
})();
const RELEASE_URL = `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_linux_${ARCH}.tar.gz`;

/** FAKE_CURL: `ok` serves the fixture, `bad` serves other bytes, `504` fails as curl does once its retries are spent. */
const FAKE_CURL = `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$FAKE_LOG"
out=
while [ $# -gt 0 ]; do [ "$1" = -o ] && { out=$2; shift; }; shift; done
case $FAKE_CURL in
  ok) cp "$FAKE_TARBALL" "$out" ;;
  bad) echo "not gitleaks" > "$out" ;;
  504) echo "curl: (22) The requested URL returned error: 504" >&2; exit 22 ;;
esac
`;

const FAKE_GITLEAKS = `#!/bin/sh
printf 'gitleaks %s\\n' "$*" >> "$FAKE_LOG"
exit "\${FAKE_SCAN_EXIT:-1}"
`;

/** Models curl's bounded retry contract, including a partial file overwritten by a retry. */
const FAKE_API_CURL = `#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
def value(flag, default=None):
    return args[args.index(flag)+1] if flag in args else default
url = next(arg for arg in args if arg.startswith('https://'))
if 'forge.example.invalid' in url:
    with open(os.environ['FAKE_LOG'], 'a') as log: log.write('forgejo ' + json.dumps({'url':url, 'args':args}) + '\\n')
    out = pathlib.Path(value('-o'))
    if '/pulls/' in url:
        out.write_text(json.dumps({'state':os.environ.get('FAKE_PR_STATE','open'),'merged':os.environ.get('FAKE_PR_MERGED')=='true','head':{'sha':os.environ['FAKE_PR_SHA']}}))
    elif url.endswith('/assets'):
        out.write_text(json.dumps({'browser_download_url':'https://forge.example.invalid/attachments/screenshot'}))
    elif value('-X') == 'PATCH':
        body = json.loads(pathlib.Path(value('--data-binary')[1:]).read_text())
        pathlib.Path(os.environ['FAKE_API_STATE']+'-comment').write_text(body['body'])
    else: out.write_text(json.dumps({'id':123}))
    sys.exit(0)
if 'api.github.com/' not in url:
    os.execv('/bin/sh', ['sh', os.environ['FAKE_DOWNLOAD_CURL'], *args])
stage = ('artifacts' if '/artifacts?' in url else 'archive' if url.endswith('/zip') else
         'dispatch' if url.endswith('/dispatches') else
         'contents' if '/contents/' in url else
         'discovery' if '/actions/runs?' in url else
         'logs' if url.endswith('/logs') else
         'jobs' if '/jobs?' in url or url.endswith('/jobs') else 'status')
state = pathlib.Path(os.environ['FAKE_API_STATE'] + '-' + stage)
count = int(state.read_text()) + 1 if state.exists() else 1
state.write_text(str(count))
with open(os.environ['FAKE_LOG'], 'a') as log:
    log.write('api ' + json.dumps({'stage':stage, 'args':args}) + '\\n')
out = pathlib.Path(value('-o')) if value('-o') else None
mode = os.environ.get('FAKE_API_MODE', 'success')
target = os.environ.get('FAKE_API_STAGE', 'status')
if mode == 'hang' and stage == target:
    # A held transport ends only when the caller supplies both timeout bounds.
    if not value('--connect-timeout') or not value('--max-time'):
        sys.stderr.write('fake hanging transport has no request bounds\\n')
        sys.exit(99)
# A later valid reply lets a regressed, unbounded loop finish and fail the assertion.
if stage == target and mode in ('hang', 'exhausted', 'incomplete') and count <= 4:
    if out: out.write_text('{"status":')
    if mode == 'incomplete': sys.exit(0)
    sys.stderr.write('curl: (28) Operation timed out after bounded retries\\n')
    sys.exit(28)
if mode == 'incomplete-once' and stage == target and count == 1:
    out.write_text('{"reply":')
    sys.exit(0)
if stage == 'dispatch':
    payload = json.loads(value('-d'))
    pathlib.Path(os.environ['FAKE_API_STATE'] + '-title').write_text(
        payload['event_type'] + ' ' + payload['client_payload']['sha'] + ' ' + payload['client_payload']['id'])
    print('204', end='')
elif stage == 'artifacts':
    rows=[] if os.environ.get('FAKE_NO_ARTIFACT')=='true' else json.loads(os.environ['FAKE_ARTIFACTS']) if os.environ.get('FAKE_ARTIFACTS') else [{'id':99,'name':'window-gallery','size_in_bytes':int(os.environ.get('FAKE_ARTIFACT_SIZE','100')),'expired':False}]
    page=int(url.split('page=')[-1]) if os.environ.get('FAKE_PAGINATION') else 1
    out.write_text(json.dumps({'total_count':len(rows),'artifacts':rows[(page-1)*100:page*100]}, indent=2 if os.environ.get('FAKE_MULTILINE_JSON') else None))
elif stage == 'archive':
    # Advance a held transfer clock, with no wall-clock sleep. curl's request
    # deadline decides whether the complete ZIP becomes available to publish.
    duration = int(os.environ.get('FAKE_ARCHIVE_SECONDS', '0'))
    if duration > int(value('--max-time', '0')):
        out.write_bytes(b'PK')
        sys.stderr.write('curl: (28) ZIP transfer exceeded its attempt budget\\n')
        sys.exit(28)
    if os.environ.get('FAKE_GALLERY_ZIP'):
        import shutil
        archives=json.loads(os.environ.get('FAKE_GALLERY_ZIPS','{}'))
        shutil.copyfile(archives.get(url.split('/')[-2], os.environ['FAKE_GALLERY_ZIP']), out)
        sys.exit(0)
    import zipfile
    with zipfile.ZipFile(out,'w') as z:
        for name in os.environ.get('FAKE_PNG_NAMES','window-empty.dark.png').split(','): z.writestr(name, b'\\x89PNG\\r\\n\\x1a\\n' + b'x' * (int(os.environ.get('FAKE_PNG_SIZE','15')) - 8))
elif stage == 'discovery':
    title = pathlib.Path(os.environ['FAKE_API_STATE'] + '-title').read_text()
    if mode == 'retry-truncated' and stage == target:
        out.write_text('{"workflow_runs":')
        with open(os.environ['FAKE_LOG'], 'a') as log: log.write('partial reply\\n')
        if '--retry-all-errors' not in args or int(value('--retry', '0')) < 1: sys.exit(18)
        # curl rewinds -o files before retrying; stdout cannot be rewound.
        with open(os.environ['FAKE_LOG'], 'a') as log: log.write('retried reply\\n')
    out.write_text(json.dumps({'workflow_runs':[{'id':42, 'display_title':title}]}))
elif stage == 'jobs':
    reply=json.loads(os.environ.get('FAKE_JOBS') or json.dumps({'jobs':[{'id':7, 'name':'checks', 'conclusion':'failure',
                                      'steps':[{'name':'tests', 'conclusion':'failure'}]}]}))
    if os.environ.get('FAKE_PAGINATION'):
        page=int(url.split('page=')[-1]); rows=reply['jobs']; reply={'total_count':len(rows),'jobs':rows[(page-1)*100:page*100]}
    out.write_text(json.dumps(reply, indent=2 if os.environ.get('FAKE_MULTILINE_JSON') else None))
elif stage == 'contents':
    import base64
    out.write_text(json.dumps({'content':base64.b64encode(os.environ['FAKE_WORKFLOW'].encode()).decode()}))
elif stage == 'logs':
    if out: out.write_text('test failure details\\n')
    else: print('test failure details')
else:
    if mode == 'reset' and count in (1, 2, 4, 5):
        out.write_text('{"status":')
        sys.exit(28)
    if mode == 'reset' and count == 3:
        out.write_text(json.dumps({'status':'in_progress', 'conclusion':None}))
        sys.exit(0)
    out.write_text(json.dumps({'status':'queued' if os.environ.get('FAKE_QUEUED_CLEANUP') and count == 1 else 'completed', 'conclusion':None if os.environ.get('FAKE_QUEUED_CLEANUP') and count == 1 else os.environ.get('FAKE_API_CONCLUSION', 'success'),
                               'head_sha':'0123456789abcdef0123456789abcdef01234567', 'path':'.github/workflows/ci.yml'}))
`;

interface Fixture {
  readonly log: string;
  readonly cache: string;
  readonly checkout: string;
  readonly bin: string;
  readonly env: NodeJS.ProcessEnv;
}

const fixture = async (): Promise<Fixture> => {
  const dir = mkdtempSync(join(tmpdir(), "github-ci-script-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const release = join(dir, "release");
  const checkout = join(dir, "checkout");
  for (const folder of [bin, release, checkout]) mkdirSync(folder);

  writeFileSync(join(release, "gitleaks"), FAKE_GITLEAKS, { mode: 0o755 });
  const tarball = join(dir, "gitleaks.tar.gz");
  await run("tar", ["-czf", tarball, "-C", release, "gitleaks"]);
  const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");

  const sha256sum = (await run("bash", ["-c", "command -v sha256sum"])).stdout.trim();
  writeFileSync(join(bin, "curl"), FAKE_CURL);
  writeFileSync(join(bin, "sha256sum"), `#!/bin/sh\nprintf 'sha256sum %s\\n' "$*" >> "$FAKE_LOG"\nsed "s/^${PINNED} /${digest} /" | ${sha256sum} "$@"\n`);
  for (const tool of ["curl", "sha256sum"]) chmodSync(join(bin, tool), 0o755);

  const git = (...args: string[]) => run("git", ["-C", checkout, "-c", "commit.gpgsign=false", "-c", "user.name=Tests", "-c", "user.email=tests@example.invalid", ...args]);
  await git("init", "-q");
  await git("commit", "-q", "--allow-empty", "-m", "a commit");
  await git("remote", "add", "origin", checkout);

  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const cache = join(dir, "toolcache");
  return {
    log,
    cache,
    checkout,
    bin,
    env: {
      PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      HOME: dir,
      GH_CI_TOKEN: "token-for-tests",
      GROUP: "1096",
      RUNNER_TOOL_CACHE: cache,
      FAKE_LOG: log,
      FAKE_TARBALL: tarball,
      FAKE_CURL: "ok",
      FAKE_API_STATE: join(dir, "api-state"),
    },
  };
};

const apiFixture = async (): Promise<Fixture> => {
  const f = await fixture();
  const git = (await run("bash", ["-c", "command -v git"])).stdout.trim();
  // A fetch from GitHub reads FAKE_WORKFLOWS_REPO, the relay repository's stand-in, instead.
  writeFileSync(join(f.bin, "git"), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = push ]; then echo 'git push' >> "$FAKE_LOG"; exit 0; fi
done
for arg in "$@"; do
  shift
  case $arg in https://github.com/*) echo "git fetch $arg" >> "$FAKE_LOG"; set -- "$@" "$FAKE_WORKFLOWS_REPO" ;; *) set -- "$@" "$arg" ;; esac
done
exec ${git} "$@"
`, { mode: 0o755 });
  writeFileSync(join(f.bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const download = join(f.bin, "download-curl");
  writeFileSync(download, FAKE_CURL);
  writeFileSync(join(f.bin, "curl"), FAKE_API_CURL, { mode: 0o755 });
  return { ...f, env: { ...f.env, FAKE_SCAN_EXIT: "0", FAKE_DOWNLOAD_CURL: download } };
};

const relay = async (f: Fixture, env: NodeJS.ProcessEnv = {}) => {
  const target = env["GH_CI_EVENT"] === "gallery" ? {
    GITHUB_EVENT_NAME: "pull_request_target",
    GH_CI_SHA: (await run("git", ["-C", f.checkout, "rev-parse", "HEAD"])).stdout.trim(),
  } : {};
  try {
    const { stdout, stderr } = await run("bash", [script], { cwd: f.checkout, env: { ...f.env, ...target, ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
};

it("finishes a non-GUI gallery successfully without a hosted dispatch or a PR comment", async () => {
  const f = await apiFixture();
  const git = (...args: string[]) => run("git", ["-C", f.checkout, "-c", "commit.gpgsign=false", "-c", "user.name=Tests", "-c", "user.email=tests@example.invalid", ...args]);
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  writeFileSync(join(f.checkout, "README.md"), "Documentation only\n");
  await git("add", "README.md");
  await git("commit", "-qm", "docs");
  const head = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("checkout", "-q", base);
  const event = join(f.checkout, "event.json");
  writeFileSync(event, JSON.stringify({ pull_request: { labels: [] } }));
  const summary = join(f.checkout, "summary.md");
  const result = await relay(f, {
    GH_CI_EVENT: "gallery", GH_CI_BASE: base, GH_CI_SHA: head,
    GITHUB_EVENT_PATH: event, GITHUB_STEP_SUMMARY: summary,
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("no GUI change: gallery skipped");
  expect(readFileSync(summary, "utf8")).toContain("no GUI change: gallery skipped");
  expect(apiCalls(f)).toEqual([]);
  expect(readFileSync(f.log, "utf8")).not.toMatch(/gitleaks|git push|forgejo /);
  expect((await git("rev-parse", "HEAD")).stdout.trim()).toBe(base);
});

/** The calls the fakes logged since the last read, by tool. */
const calls = (f: Fixture) => {
  const lines = readFileSync(f.log, "utf8").split("\n").filter(Boolean);
  writeFileSync(f.log, "");
  return lines.map((line) => line.split(" ")[0]);
};

const kept = (f: Fixture) => join(f.cache, "gitleaks", VERSION, `${PINNED}.tar.gz`);
const apiCalls = (f: Fixture): { stage: string; args: string[] }[] => readFileSync(f.log, "utf8")
  .split("\n").filter((line) => line.startsWith("api ")).map((line) => JSON.parse(line.slice(4)) as { stage: string; args: string[] });

describe("the relay's gitleaks", () => {
  it("keeps the checked download for the next run, which checks the kept copy again and does not download", async () => {
    const f = await fixture();

    const first = await relay(f);
    expect(first.code).toBe(1);
    expect(first.stdout).toContain("::error::gitleaks found a secret; nothing was pushed to GitHub");
    expect(calls(f)).toEqual(["curl", "sha256sum", "gitleaks"]);
    expect(existsSync(kept(f))).toBe(true);

    const second = await relay(f);
    expect(second.stdout).toContain("::error::gitleaks found a secret; nothing was pushed to GitHub");
    expect(calls(f)).toEqual(["sha256sum", "gitleaks"]);
    expect(readdirSync(join(f.cache, "gitleaks", VERSION))).toEqual([`${PINNED}.tar.gz`]);
  });

  // GitHub's release downloads answered 504 for about two minutes on 2026-10-01
  // and curl's default backoff (1, 2, 4 s) failed every run that started in it.
  it("keeps trying the download for a minute and more, 5xx and timeouts included, with a time limit on each try", async () => {
    const f = await fixture();
    await relay(f);
    const curl = readFileSync(f.log, "utf8").split("\n").find((line) => line.startsWith("curl "));
    const flags = curl?.split(" ") ?? [];
    const value = (flag: string) => Number(flags[flags.indexOf(flag) + 1]);
    expect(flags).toContain("--retry-all-errors");
    expect(value("--retry") * value("--retry-delay")).toBeGreaterThanOrEqual(60);
    expect(value("--retry-max-time")).toBeGreaterThanOrEqual(60);
    expect(value("--connect-timeout")).toBeGreaterThan(0);
    expect(value("--max-time")).toBeGreaterThan(0);
    expect(flags.at(-1)).toBe(RELEASE_URL);
  });

  it("says in one error line that the download failed, names it, and scans nothing and keeps nothing", async () => {
    const f = await fixture();
    const result = await relay(f, { FAKE_CURL: "504" });
    expect(result.code).toBe(1);
    const errors = result.stdout.split("\n").filter((line) => line.startsWith("::error::"));
    expect(errors).toEqual([expect.stringContaining(`Could not download gitleaks ${VERSION} from ${RELEASE_URL}`)]);
    expect(calls(f)).toEqual(["curl"]);
    expect(existsSync(join(f.cache, "gitleaks"))).toBe(false);
  });

  it("refuses a download that is not the pinned build in one error line, and keeps nothing", async () => {
    const f = await fixture();
    const result = await relay(f, { FAKE_CURL: "bad" });
    expect(result.code).toBe(1);
    const errors = result.stdout.split("\n").filter((line) => line.startsWith("::error::"));
    expect(errors).toEqual([expect.stringContaining(`gitleaks ${VERSION} from ${RELEASE_URL} is not the pinned build`)]);
    expect(calls(f)).toEqual(["curl", "sha256sum"]);
    expect(existsSync(join(f.cache, "gitleaks"))).toBe(false);
  });

  it("downloads again over a kept copy that fails the check, and keeps the good one", async () => {
    const f = await fixture();
    mkdirSync(join(f.cache, "gitleaks", VERSION), { recursive: true });
    writeFileSync(kept(f), "a damaged copy");

    const result = await relay(f);
    expect(result.stdout).toContain("::error::gitleaks found a secret; nothing was pushed to GitHub");
    expect(calls(f)).toEqual(["sha256sum", "curl", "sha256sum", "gitleaks"]);
    expect(readFileSync(kept(f))).toEqual(readFileSync(f.env["FAKE_TARBALL"] ?? ""));
  });

  it("still scans when the tool cache cannot be written", async () => {
    const f = await fixture();
    writeFileSync(f.cache, "a file where the cache folder would be");

    const result = await relay(f);
    expect(result.stdout).toContain("::error::gitleaks found a secret; nothing was pushed to GitHub");
    expect(calls(f)).toEqual(["curl", "sha256sum", "gitleaks"]);
  });
});

describe("the relay's GitHub API", () => {
  it.each(["jobs", "logs"])("names an exhausted %s API request while reporting failed CI", async (stage) => {
    const f = await apiFixture();
    const result = await relay(f, { FAKE_API_CONCLUSION: "failure", FAKE_API_MODE: "exhausted", FAKE_API_STAGE: stage });
    expect(result.code).toBe(1);
    expect(result.stdout.split("\n").filter((line) => line.startsWith("::error::"))).toEqual([
      expect.stringContaining(`GitHub API transport failed: GET https://api.github.com/repos/david-systemtech/agent-harness-ci/actions/${stage === "jobs" ? "runs/42/jobs" : "jobs/7/logs"}`),
    ]);
    expect(result.stderr).not.toContain("Traceback");
  });

  it.each(["success", "incomplete-once"])("prints failed steps and logs with %s job replies", async (mode) => {
    const f = await apiFixture();
    const result = await relay(f, { FAKE_API_CONCLUSION: "failure", FAKE_API_MODE: mode, FAKE_API_STAGE: "jobs" });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("checks failed at: tests");
    expect(result.stdout).toContain("test failure details");
    expect(result.stdout).toContain("::error::GitHub CI failure:");
    expect(result.stdout).not.toContain("GitHub API transport failed");
  });

  it.each(["retry-truncated", "incomplete-once"])("discovers and completes a run after %s", async (mode) => {
    const f = await apiFixture();
    const result = await relay(f, { FAKE_API_MODE: mode, FAKE_API_STAGE: "discovery" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("GitHub run finished: success");
    expect(result.stdout).not.toContain("::error::");
    expect(result.stderr).not.toContain("Traceback");
    if (mode === "retry-truncated") {
      expect(readFileSync(f.log, "utf8")).toContain("partial reply\nretried reply");
      expect(apiCalls(f).filter((call) => call.stage === "discovery")).toHaveLength(1);
    } else {
      expect(apiCalls(f).filter((call) => call.stage === "discovery")).toHaveLength(2);
    }
    expect(apiCalls(f).find((call) => call.stage === "discovery")?.args.join(" ")).toContain("created=%3E%3D");
    expect(readFileSync(f.log, "utf8")).toContain("git push");
  });

  it("resets consecutive failures on a valid in-progress status", async () => {
    const f = await apiFixture();
    const result = await relay(f, { FAKE_API_MODE: "reset" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("GitHub run finished: success");
    expect(apiCalls(f).filter((call) => call.stage === "status")).toHaveLength(6);
  });

  it.each([
    ["discovery", "exhausted"], ["discovery", "incomplete"], ["status", "incomplete"],
  ])("reports exhausted %s %s replies instead of waiting for the job timeout", async (stage, mode) => {
    const f = await apiFixture();
    const result = await relay(f, { FAKE_API_MODE: mode, FAKE_API_STAGE: stage });
    expect(result.code).toBe(1);
    expect(result.stdout.split("\n").filter((line) => line.startsWith("::error::"))).toEqual([
      expect.stringContaining(`GitHub API transport failed: GET https://api.github.com/repos/david-systemtech/agent-harness-ci/actions/runs${stage === "discovery" ? "?" : "/42"}`),
    ]);
    expect(apiCalls(f).filter((call) => call.stage === stage)).toHaveLength(3);
    expect(result.stderr).not.toContain("Traceback");
  });

  it("bounds a hanging status request and stops after consecutive transport failures", async () => {
    const f = await apiFixture();
    const result = await relay(f, { FAKE_API_MODE: "hang" });
    expect(result.code).toBe(1);
    expect(result.stdout.split("\n").filter((line) => line.startsWith("::error::"))).toEqual([
      expect.stringContaining("GitHub API transport failed: GET"),
    ]);
    expect(result.stdout).toContain("/actions/runs/42");
    const requests = apiCalls(f).filter((call) => call.stage === "status");
    expect(requests).toHaveLength(3);
    for (const { args } of apiCalls(f)) {
      const value = (flag: string) => Number(args[args.indexOf(flag) + 1]);
      expect(value("--connect-timeout")).toBe(15);
      expect(value("--max-time")).toBe(120);
      expect(value("--retry")).toBe(5);
      expect(value("--retry-max-time")).toBe(180);
      expect(args).toContain("--retry-all-errors");
    }
    expect(result.stderr).not.toContain("Traceback");
  });

  it("names a dispatch whose transport exhausted its retries in one error line", async () => {
    const f = await apiFixture();
    const result = await relay(f, { FAKE_API_MODE: "exhausted", FAKE_API_STAGE: "dispatch" });
    expect(result.code).toBe(1);
    expect(result.stdout.split("\n").filter((line) => line.startsWith("::error::"))).toEqual([
      expect.stringContaining("GitHub API transport failed: POST"),
    ]);
    expect(result.stdout).toContain("/dispatches");
    expect(result.stderr).not.toContain("Traceback");
  });
});


// GitHub runs 37641730701 and 37655301851 (2026-10-07): every job passed, the
// cleanup job never appeared and the run ended `failure`, its one annotation
// GitHub's own "Internal server error" (#1816).
describe("a hosted run GitHub fails with no failed job (#1816)", () => {
  const WORKFLOW = `name: ci
jobs:
  checks:
    runs-on: ubuntu-24.04
  test:
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3]
    runs-on: ubuntu-24.04
  root-user:
    runs-on: ubuntu-24.04
  # The relay pushed ci/<id> only so the commit could be checked out.
  cleanup:
    needs: [checks, test, root-user]
    if: always()
    runs-on: ubuntu-24.04
`;
  const passed = (...names: string[]) => JSON.stringify({ jobs: names.map((name, id) => ({ id, name, conclusion: "success", steps: [] })) });
  const failedRun = async (jobs: string, env: NodeJS.ProcessEnv = {}) => {
    const f = await apiFixture();
    const result = await relay(f, { FAKE_API_CONCLUSION: "failure", FAKE_JOBS: jobs, FAKE_WORKFLOW: WORKFLOW, ...env });
    const lines = (kind: string) => result.stdout.split("\n").filter((line) => line.startsWith(`::${kind}::`));
    return { f, result, errors: lines("error"), warnings: lines("warning") };
  };

  it("passes ci once every job the verdict needs passed, reading them from the workflow at the run's commit", async () => {
    const { f, result, errors, warnings } = await failedRun(passed("checks", "root-user", "test (1)", "test (2)", "test (3)"));
    expect(errors).toEqual([]);
    expect(result.code).toBe(0);
    expect(warnings).toEqual([expect.stringContaining("GitHub ended the run as failed although none of its jobs failed")]);
    expect(warnings[0]).toContain("cleanup never ran");
    const contents = apiCalls(f).filter((call) => call.stage === "contents");
    expect(contents.map((call) => call.args.at(-1))).toEqual([
      "https://api.github.com/repos/david-systemtech/agent-harness-ci/contents/.github/workflows/ci.yml?ref=0123456789abcdef0123456789abcdef01234567",
    ]);
    expect(apiCalls(f).filter((call) => call.stage === "logs")).toEqual([]);
  });

  it.each([
    ["a shard", passed("checks", "root-user", "test (1)", "test (2)"), "test (3)"],
    ["the whole matrix", passed("checks", "root-user"), "test (1), test (2), test (3)"],
    ["a job", passed("checks", "test (1)", "test (2)", "test (3)"), "root-user"],
  ])("fails ci and lists %s the verdict needs that never appeared", async (_, jobs, missing) => {
    const { result, errors } = await failedRun(jobs);
    expect(result.code).toBe(1);
    expect(errors).toEqual([expect.stringContaining("GitHub ended the run as failed although none of its jobs failed")]);
    expect(errors[0]).toContain(`Jobs the verdict needs that did not pass: ${missing}.`);
    expect(errors[0]).toContain("a re-run clears an error of GitHub's, not one in the workflow file");
  });

  it("fails ci when a job the verdict needs was skipped", async () => {
    const jobs = JSON.stringify({ jobs: [...JSON.parse(passed("checks", "test (1)", "test (2)", "test (3)")).jobs, { id: 9, name: "root-user", conclusion: "skipped", steps: [] }] });
    const { result, errors } = await failedRun(jobs);
    expect(result.code).toBe(1);
    expect(errors[0]).toContain("did not pass: root-user.");
  });

  it("reads a job key with a trailing comment and stops the jobs at the next top-level key", async () => {
    const { result, errors } = await failedRun(passed("checks", "test (1)", "test (2)", "test (3)"), {
      FAKE_WORKFLOW: `${WORKFLOW.replace("  root-user:\n", "  root-user:  # runs as root\n")}concurrency:\n  group: ci\n`,
    });
    expect(result.code).toBe(1);
    expect(errors[0]).toContain("did not pass: root-user.");
  });

  it.each([
    ["a matrix other than one shard list", { FAKE_WORKFLOW: WORKFLOW.replace("        shard: [1, 2, 3]\n", "        os: [linux]\n") }],
    ["a quoted job key", { FAKE_WORKFLOW: WORKFLOW.replace("  root-user:\n", '  "root-user":\n') }],
    ["a job with a name of its own", { FAKE_WORKFLOW: WORKFLOW.replace("  root-user:\n", "  root-user:\n    name: as root\n") }],
    ["a workflow whose fetch fails", { FAKE_API_MODE: "exhausted", FAKE_API_STAGE: "contents" }],
  ])("fails ci without guessing on %s", async (_, env) => {
    const { result, errors } = await failedRun(passed("checks", "root-user", "test (1)", "test (2)", "test (3)"), env);
    expect(result.code).toBe(1);
    expect(errors[0]).toContain("did not pass: (the jobs its workflow needs could not be read).");
  });

  it("fails any other event's run with the same cause named, reading no workflow", async () => {
    const { f, result, errors } = await failedRun(passed("checks", "root-user", "test (1)", "test (2)", "test (3)"), { GH_CI_EVENT: "catalogue" });
    expect(result.code).toBe(1);
    expect(errors).toEqual([expect.stringContaining("GitHub ended the run as failed although none of its jobs failed")]);
    expect(errors[0]).not.toContain("Jobs the verdict needs");
    expect(apiCalls(f).filter((call) => call.stage === "contents")).toEqual([]);
  });

  it("still prints a failed job's steps and log when one failed", async () => {
    const jobs = JSON.stringify({ jobs: [...JSON.parse(passed("checks", "root-user", "test (1)", "test (3)")).jobs,
      { id: 7, name: "test (2)", conclusion: "failure", steps: [{ name: "tests", conclusion: "failure" }] }] });
    const { result, errors } = await failedRun(jobs);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("test (2) failed at: tests");
    expect(result.stdout).toContain("test failure details");
    expect(errors).toEqual([expect.stringContaining("GitHub CI failure:")]);
  });
});

describe("the advisory gallery relay", () => {
  it("publishes a valid ZIP whose held transfer takes 180 seconds, keeping JSON requests short", async () => {
    const f = await apiFixture();
    const sha = (await run("git", ["-C", f.checkout, "rev-parse", "HEAD"])).stdout.trim();
    const result = await relay(f, {
      FAKE_ARCHIVE_SECONDS: "180", FAKE_PR_SHA: sha, GH_CI_EVENT: "gallery",
      FORGEJO_PR: "42", FORGEJO_TOKEN: "token-for-tests",
      FORGEJO_URL: "https://forge.example.invalid", FORGEJO_REPOSITORY: "example/project",
    });
    expect(result.code, result.stderr).toBe(0);
    expect(readFileSync(`${f.env["FAKE_API_STATE"]}-comment`, "utf8")).toContain("![window-empty.dark.png](");
    for (const { stage, args } of apiCalls(f)) {
      const value = (flag: string) => Number(args[args.indexOf(flag) + 1]);
      expect(value("--max-time")).toBe(stage === "archive" ? 600 : 120);
      expect(value("--retry-max-time")).toBe(stage === "archive" ? 600 : 180);
      if (stage === "archive") {
        expect(value("--retry")).toBe(2);
        expect(value("--connect-timeout")).toBe(15);
        expect(value("--max-filesize")).toBe(64 * 1024 * 1024);
        expect(args).toContain("--retry-all-errors");
      }
    }
  });
  it("stops an over-budget ZIP transfer before publishing its partial archive", async () => {
    const f = await apiFixture();
    const result = await relay(f, { FAKE_ARCHIVE_SECONDS: "601", GH_CI_EVENT: "gallery" });
    expect(result.code).toBe(28);
    expect(result.stderr).toContain("ZIP transfer exceeded its attempt budget");
    expect(existsSync(`${f.env["FAKE_API_STATE"]}-comment`)).toBe(false);
    expect(readFileSync(f.log, "utf8")).not.toContain("forgejo ");
    expect(apiCalls(f).filter(({ stage }) => stage === "archive")).toHaveLength(1);
  });

  it.each(["GUI change", "gallery label"])("dispatches its own gallery run and retrieves the small screenshot artifact for a %s", async (reason) => {
    const f = await apiFixture();
    const git = (...args: string[]) => run("git", ["-C", f.checkout, "-c", "commit.gpgsign=false", "-c", "user.name=Tests", "-c", "user.email=tests@example.invalid", ...args]);
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    const path = reason === "GUI change" ? "packages/gui/src/app.tsx" : "README.md";
    mkdirSync(join(f.checkout, path, ".."), { recursive: true });
    writeFileSync(join(f.checkout, path), "fixture\n");
    await git("add", path);
    await git("commit", "-qm", "change");
    const sha = (await run("git", ["-C", f.checkout, "rev-parse", "HEAD"])).stdout.trim();
    await git("checkout", "-q", base);
    const event = join(f.checkout, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { labels: reason === "gallery label" ? [{ name: "gallery" }] : [] } }));
    const result = await relay(f, { GH_CI_BASE: base, GH_CI_SHA: sha, GITHUB_EVENT_PATH: event, FAKE_PR_SHA: sha, GH_CI_EVENT: "gallery", FORGEJO_PR: "1336", FORGEJO_TOKEN: "token-for-tests", FORGEJO_URL: "https://forge.example.invalid", FORGEJO_REPOSITORY: "example/project" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Gallery posted on pull request 1336");
    expect(readFileSync(`${f.env["FAKE_API_STATE"]}-comment`, "utf8")).toContain("![window-empty.dark.png](https://forge.example.invalid/attachments/screenshot)");
    const archive = apiCalls(f).find((call) => call.stage === "archive");
    expect(archive?.args).toContain("67108864");
    expect(archive?.args).toContain("--max-time");
    const forgejoCalls = readFileSync(f.log, "utf8").split("\n").filter((line) => line.startsWith("forgejo ") && line.includes("/api/v1/"));
    expect(forgejoCalls).toHaveLength(4);
    for (const call of forgejoCalls) {
      expect(call).toContain("--connect-timeout");
      expect(call).toContain("--max-time");
      expect(call).not.toContain("token-for-tests");
    }
    const dispatch = apiCalls(f).find((call) => call.stage === "dispatch");
    expect(dispatch?.args.join(" ")).toContain('"event_type": "gallery"');
  });
});

describe("the smoke relay (#1769)", () => {
  const HOSTED = { ".forgejo/github-workflows/smoke.yml": ".github/workflows/smoke.yml", "public/.github-workflows/release.yml": ".github/workflows/release.yml" };
  /** The commit under test holds `tree`; the relay repository's `workflows` branch holds `installed`. */
  const smokeFixture = async (tree: Record<string, string>, installed: Record<string, string>) => {
    const f = await apiFixture();
    const workflows = join(f.checkout, "..", "workflows");
    for (const [repo, files] of [[f.checkout, tree], [workflows, installed]] as const) {
      if (repo === workflows) await run("git", ["init", "-q", "-b", "workflows", repo]);
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(repo, path, ".."), { recursive: true });
        writeFileSync(join(repo, path), text);
      }
      await run("git", ["-C", repo, "add", "-A"]);
      await run("git", ["-C", repo, "-c", "commit.gpgsign=false", "-c", "user.name=Tests", "-c", "user.email=tests@example.invalid", "commit", "-q", "--allow-empty", "-m", "files"]);
    }
    return { ...f, env: { ...f.env, GH_CI_EVENT: "smoke", FAKE_WORKFLOWS_REPO: workflows } };
  };
  const errors = (stdout: string) => stdout.split("\n").filter((line) => line.startsWith("::error::"));
  const tree = { ".forgejo/github-workflows/smoke.yml": "name: smoke\n", "public/.github-workflows/release.yml": "name: release\n" };

  it("dispatches a smoke run once the relay repository's installed smoke and release workflows are this commit's, byte for byte", async () => {
    const f = await smokeFixture(tree, { ".github/workflows/smoke.yml": "name: smoke\n", ".github/workflows/release.yml": "name: release\n", ".github/workflows/ci.yml": "name: ci\n" });
    const result = await relay(f);
    expect(errors(result.stdout)).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("GitHub run finished: success");
    expect(readFileSync(f.log, "utf8")).toContain("git fetch https://github.com/david-systemtech/agent-harness-ci.git");
    expect(apiCalls(f).find((call) => call.stage === "dispatch")?.args.join(" ")).toContain('"event_type": "smoke"');
  });

  it.each([
    [".github/workflows/release.yml", { ".github/workflows/smoke.yml": "name: smoke\n", ".github/workflows/release.yml": "name: release \n" }],
    [".github/workflows/release.yml", { ".github/workflows/smoke.yml": "name: smoke\n" }],
    [".github/workflows/smoke.yml", { ".github/workflows/smoke.yml": "name: smoke # old\n", ".github/workflows/release.yml": "name: release\n" }],
  ])("pushes and dispatches nothing while the installed %s differs from this commit's or is missing", async (path, installed) => {
    const f = await smokeFixture(tree, installed);
    const result = await relay(f);
    expect(result.code).toBe(1);
    const source = Object.entries(HOSTED).find(([, target]) => target === path)?.[0] ?? "";
    expect(errors(result.stdout)).toEqual([expect.stringContaining(`${path} on its workflows branch is not this commit's ${source}`)]);
    expect(readFileSync(f.log, "utf8")).not.toContain("git push");
    expect(apiCalls(f)).toEqual([]);
  });

  it("relays each merge to main to the hosted smoke, which calls the release workflow with that commit and grants every permission its jobs ask for", () => {
    const relayWorkflow = readFileSync(join(root, ".forgejo", "workflows", "smoke.yml"), "utf8");
    expect(relayWorkflow).toMatch(/\non:\n {2}push:\n {4}branches: \[main\]\n(?: {2}#.*\n)? {2}workflow_dispatch:\n\n/);
    expect(relayWorkflow).toContain("    runs-on: relay\n");
    expect(relayWorkflow).toContain("          fetch-depth: 0\n");
    expect(relayWorkflow).toContain("        run: bash .forgejo/scripts/github-ci.sh\n");
    expect(relayWorkflow).toContain("          GH_CI_EVENT: smoke\n");
    expect(relayWorkflow).toContain("          GROUP: ${{ github.sha }}\n");
    const hosted = readFileSync(join(root, ".forgejo", "github-workflows", "smoke.yml"), "utf8");
    expect(hosted).toContain("    types: [smoke]\n");
    // The relay finds its run by this title.
    expect(hosted).toContain("run-name: smoke ${{ github.event.client_payload.sha }} ${{ github.event.client_payload.id }}\n");
    const call = /\n {2}smoke:\n([\s\S]*?)\n {2}[a-z]+:\n/.exec(hosted)?.[1] ?? "";
    expect(call).toContain("    uses: ./.github/workflows/release.yml\n");
    expect(call).toContain("      sha: ${{ github.event.client_payload.sha }}");
    // A caller that grants a called job less than it asks for fails the whole run before it starts.
    const release = readFileSync(join(root, "public", ".github-workflows", "release.yml"), "utf8");
    const asked = new Set([...release.matchAll(/^ {6}([a-z-]+): write$/gm)].map((match) => match[1]));
    expect([...asked].sort()).toEqual(["contents", "packages"]);
    for (const scope of asked) expect(call).toContain(`      ${scope}: write\n`);
    const cleanup = /\n {2}cleanup:\n([\s\S]*)$/.exec(hosted)?.[1] ?? "";
    expect(cleanup).toContain("    if: always()\n");
    expect(cleanup).toContain("RUN_REF: ci/${{ github.event.client_payload.id }}");
    expect(cleanup).toContain('gh api -X DELETE "repos/${{ github.repository }}/git/refs/heads/$RUN_REF"');
  });

  it("refuses a commit that has no hosted smoke workflow to compare", async () => {
    const f = await smokeFixture({}, {});
    const result = await relay(f);
    expect(result.code).toBe(1);
    expect(errors(result.stdout)).toEqual([expect.stringContaining(".github/workflows/smoke.yml on its workflows branch is not this commit's .forgejo/github-workflows/smoke.yml")]);
    expect(apiCalls(f)).toEqual([]);
  });
});

it("runs gallery independently and preserves geometry failures as blocking checks", () => {
  const hosted = readFileSync(join(root, ".forgejo", "github-workflows", "gallery.yml"), "utf8");
  const relayWorkflow = readFileSync(join(root, ".forgejo", "workflows", "gallery.yml"), "utf8");
  const ci = readFileSync(join(root, ".forgejo", "workflows", "ci.yml"), "utf8");
  expect(hosted).toContain("runs-on: ubuntu-24.04");
  expect(hosted).toContain("types: [gallery]");
  expect(relayWorkflow).not.toContain("continue-on-error: true");
  expect(relayWorkflow).toContain("timeout-minutes: 55");
  expect(relayWorkflow).toContain("PACKAGES_TOKEN: ${{ secrets.PACKAGES_TOKEN }}");
  expect(relayWorkflow).not.toMatch(/^ {4}paths:/m);
  expect(relayWorkflow).toContain("types: [opened, synchronize, reopened, labeled, unlabeled]");
  expect(relayWorkflow).toContain("GH_CI_BASE: ${{ github.event.pull_request.base.sha }}");
  expect(ci).not.toContain("GH_CI_EVENT: gallery");
});

// GitHub's test shards have 40 minutes, so the web smoke can wait on a slow Ubuntu mirror (#1802).
it("waits on the hosted run longer than a hosted test shard may take", () => {
  const ci = readFileSync(join(root, ".forgejo", "workflows", "ci.yml"), "utf8");
  expect(ci).toMatch(/\n {2}ci:\n {4}runs-on: relay\n(?: {4}#.*\n)* {4}timeout-minutes: 55\n/);
});

it("relays a PR head as data without executing its credential-stealing script", async () => {
  const f = await apiFixture();
  const git = (...args: string[]) => run("git", ["-C", f.checkout, "-c", "commit.gpgsign=false", "-c", "user.name=Tests", "-c", "user.email=tests@example.invalid", ...args]);
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  const scripts = join(f.checkout, ".forgejo", "scripts");
  mkdirSync(scripts, { recursive: true });
  const stolen = join(f.checkout, "stolen");
  writeFileSync(join(scripts, "github-ci.sh"), 'printf "%s" "$PACKAGES_TOKEN" > stolen\nexit 99\n');
  writeFileSync(join(scripts, "gallery-needed.py"), 'import os\nopen("stolen", "w").write(os.environ["PACKAGES_TOKEN"])\n');
  await git("add", ".forgejo");
  await git("commit", "-qm", "an untrusted change");
  const head = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("checkout", "-q", base);
  const event = join(f.checkout, "event.json");
  writeFileSync(event, JSON.stringify({ pull_request: { labels: [] } }));
  const result = await relay(f, {
    GH_CI_EVENT: "gallery", GH_CI_SHA: head, PACKAGES_TOKEN: "package-token-for-tests",
    GH_CI_BASE: base, GITHUB_EVENT_PATH: event,
    FAKE_PR_SHA: head, FORGEJO_PR: "42", FORGEJO_TOKEN: "token-for-tests",
    FORGEJO_URL: "https://forge.example.invalid", FORGEJO_REPOSITORY: "example/project",
  });
  expect(result.code).toBe(0);
  const dispatch = apiCalls(f).find((call) => call.stage === "dispatch");
  expect(JSON.parse(dispatch?.args[dispatch.args.indexOf("-d") + 1] ?? "{}").client_payload.sha).toBe(head);
  expect(readFileSync(f.log, "utf8")).toContain(`--log-opts=${head}`);
  expect((await git("rev-parse", "HEAD")).stdout.trim()).toBe(base);
  expect(existsSync(stolen)).toBe(false);
  const workflow = readFileSync(join(root, ".forgejo", "workflows", "gallery.yml"), "utf8");
  expect(workflow).toContain("pull_request_target:");
  expect(workflow).toContain("branches: [main]");
  expect(workflow).not.toMatch(/^ {2}pull_request:/m);
  expect(workflow).toContain("ref: ${{ github.event.pull_request.base.sha }}");
  expect(workflow).toContain("GH_CI_SHA: ${{ github.event.pull_request.head.sha }}");
});

it.each([
  ["pull_request", undefined, "trusted pull_request_target"],
  ["pull_request_target", "HEAD; touch stolen", "invalid gallery target sha"],
])("refuses unsafe gallery input before any network or credential-bearing publication (%s)", async (event, sha, error) => {
  const f = await apiFixture();
  const result = await relay(f, {
    GH_CI_EVENT: "gallery", GITHUB_EVENT_NAME: event,
    ...(sha === undefined ? {} : { GH_CI_SHA: sha }), PACKAGES_TOKEN: "package-token-for-tests",
  });
  expect(result.code).toBe(1);
  expect(result.stdout).toContain(error);
  expect(calls(f)).toEqual([]);
  expect(existsSync(join(f.checkout, "stolen"))).toBe(false);
});

it.each(["stale", "closed", "merged"])("does not create a screenshot comment on a %s PR", async (state) => {
  const f = await apiFixture();
  const sha = (await run("git", ["-C", f.checkout, "rev-parse", "HEAD"])).stdout.trim();
  const result = await relay(f, {
    GH_CI_EVENT: "gallery", FORGEJO_PR: "1336", FORGEJO_TOKEN: "token-for-tests", FORGEJO_URL: "https://forge.example.invalid", FORGEJO_REPOSITORY: "example/project",
    FAKE_PR_SHA: state === "stale" ? "a-different-head" : sha,
    FAKE_PR_STATE: state === "closed" ? "closed" : "open", FAKE_PR_MERGED: String(state === "merged"),
  });
  expect(result.code).toBe(2);
  expect(existsSync(`${f.env["FAKE_API_STATE"]}-comment`)).toBe(false);
  const mutations = readFileSync(f.log, "utf8").split("\n").filter((line) => line.startsWith("forgejo ") && (line.includes("POST") || line.includes("PATCH")));
  expect(mutations).toEqual([]);
});

it("publishes all 34 captures from seventeen scenes without rebuilding the artifact", async () => {
  const f = await apiFixture();
  const sha = (await run("git", ["-C", f.checkout, "rev-parse", "HEAD"])).stdout.trim();
  const names = Array.from({ length: 17 }, (_, index) => [`scene-${index}.light.png`, `scene-${index}.dark.png`]).flat();
  const result = await relay(f, {
    GH_CI_EVENT: "gallery", FORGEJO_PR: "1336", FORGEJO_TOKEN: "token-for-tests",
    FORGEJO_URL: "https://forge.example.invalid", FORGEJO_REPOSITORY: "example/project",
    FAKE_PR_SHA: sha, FAKE_PNG_NAMES: names.join(","), FAKE_PNG_SIZE: "100000",
  });
  expect(result.code).toBe(0);
  const comment = readFileSync(`${f.env["FAKE_API_STATE"]}-comment`, "utf8");
  expect(comment.match(/!\[/g)).toHaveLength(34);
  for (const name of names) expect(comment).toContain(`![${name}](`);
});

it("rejects a PNG payload above 48 MiB before posting, leaving ZIP overhead within the 64 MiB transport cap", async () => {
  const f = await apiFixture();
  const sha = (await run("git", ["-C", f.checkout, "rev-parse", "HEAD"])).stdout.trim();
  const result = await relay(f, {
    GH_CI_EVENT: "gallery", FORGEJO_PR: "1336", FORGEJO_TOKEN: "token-for-tests", FORGEJO_URL: "https://forge.example.invalid", FORGEJO_REPOSITORY: "example/project",
    FAKE_PR_SHA: sha, FAKE_PNG_SIZE: String(48*1024*1024 + 1),
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("gallery payload is too large");
  expect(existsSync(`${f.env["FAKE_API_STATE"]}-comment`)).toBe(false);
});


it.each([
  ["too-many", "gallery payload is too large"],
  ["compressed-payload", "gallery payload is too large"],
  ["large-zip", "gallery zip is too large"],
  ["unexpected", "unexpected gallery entry"],
  ["traversal", "unexpected gallery entry"],
  ["duplicate", "unexpected gallery entry"],
  ["not-png", "gallery entry is not a PNG"],
  ["empty", "gallery payload is too large"],
])("rejects an invalid capture-only gallery before any publication (%s)", async (mode, error) => {
  const f = await apiFixture();
  const sha = (await run("git", ["-C", f.checkout, "rev-parse", "HEAD"])).stdout.trim();
  const zip = join(f.checkout, "gallery.zip");
  await run("python3", ["-c", `import sys,zipfile
mode=sys.argv[2]
with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED if mode=='compressed-payload' else zipfile.ZIP_STORED) as z:
    if mode=='empty': pass
    elif mode=='too-many':
        for i in range(1201): z.writestr(f'scene-{i}.dark.png', b'\\x89PNG\\r\\n\\x1a\\nimage')
    else:
        size=(48*1024*1024+1 if mode=='compressed-payload' else 64*1024*1024+1 if mode=='large-zip' else 15)
        name=('geometry.json' if mode=='unexpected' else '../escape.dark.png' if mode=='traversal' else 'window-empty.dark.png')
        data=(b'not a PNG' if mode=='not-png' else b'\\x89PNG\\r\\n\\x1a\\n'+b'x'*(size-8))
        z.writestr(name, data)
        if mode=='duplicate': z.writestr(name, data)
`, zip, mode]);
  const result = await relay(f, {
    GH_CI_EVENT: "gallery", FORGEJO_PR: "1336", FORGEJO_TOKEN: "token-for-tests", FORGEJO_URL: "https://forge.example.invalid", FORGEJO_REPOSITORY: "example/project",
    FAKE_PR_SHA: sha, FAKE_GALLERY_ZIP: zip,
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(error);
  expect(existsSync(`${f.env["FAKE_API_STATE"]}-comment`)).toBe(false);
  const mutations = readFileSync(f.log, "utf8").split("\n").filter((line) => line.startsWith("forgejo ") && (line.includes("POST") || line.includes("PATCH")));
  expect(mutations).toEqual([]);
});


it.each([
  ["empty", "gallery payload is too large"],
  ["count", "gallery payload is too large"],
  ["expanded", "gallery payload is too large"],
  ["zip", "gallery zip is too large"],
  ["path", "unexpected gallery entry"],
  ["duplicate", "unexpected gallery entry"],
  ["signature", "gallery entry is not a PNG"],
  ["truncated", "File is not a zip file"],
])("refuses a %s archive before creating a gallery comment", async (kind, message) => {
  const f = await apiFixture();
  const sha = (await run("git", ["-C", f.checkout, "rev-parse", "HEAD"])).stdout.trim();
  const zip = join(f.checkout, "gallery.zip");
  await run("python3", ["-c", `import pathlib,sys,zipfile
path=pathlib.Path(sys.argv[1]); kind=sys.argv[2]
png=b'\\x89PNG\\r\\n\\x1a\\n'
with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    if kind=='count':
        for i in range(1201): z.writestr(f'scene-{i}.dark.png', png)
    elif kind=='expanded': z.writestr('scene.dark.png', png+b'x'*(48*1024*1024+1-len(png)))
    elif kind=='path': z.writestr('../scene.dark.png', png)
    elif kind=='duplicate':
        z.writestr('scene.dark.png', png); z.writestr('scene.dark.png', png)
    elif kind=='signature': z.writestr('scene.dark.png', b'not a PNG')
    elif kind!='empty': z.writestr('scene.dark.png', png)
if kind=='zip':
    with path.open('ab') as f: f.truncate(64*1024*1024+1)
if kind=='truncated': path.write_bytes(b'PK')`, zip, kind]);
  const result = await relay(f, {
    GH_CI_EVENT: "gallery", FORGEJO_PR: "1336", FORGEJO_TOKEN: "token-for-tests",
    FORGEJO_URL: "https://forge.example.invalid", FORGEJO_REPOSITORY: "example/project",
    FAKE_PR_SHA: sha, FAKE_GALLERY_ZIP: zip,
  });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain(message);
  expect(result.stderr).not.toContain("urllib");
  expect(existsSync(`${f.env["FAKE_API_STATE"]}-comment`)).toBe(false);
  const mutations = readFileSync(f.log, "utf8").split("\n").filter((line) => line.startsWith("forgejo ") && (line.includes("POST") || line.includes("PATCH")));
  expect(mutations).toEqual([]);
  if (kind === "truncated" || kind === "zip") expect(readFileSync(f.log, "utf8")).not.toContain("/api/v1/");
});

it.each([
  ["count", "gallery payload is too large"],
  ["expanded", "gallery payload is too large"],
  ["zip", "gallery zip is too large"],
])("refuses an oversized report %s before publication", async (kind, message) => {
  const f = await apiFixture();
  const sha = (await run("git", ["-C", f.checkout, "rev-parse", "HEAD"])).stdout.trim();
  const zip = join(f.checkout, "gallery.zip");
  await run("python3", ["-c", `import pathlib,sys,zipfile
with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED) as z:
    if sys.argv[2]=='count':
        for i in range(1201): z.writestr(f'scene-{i}.dark.png', b'\\x89PNG\\r\\n\\x1a\\n')
    else: z.writestr('scene.dark.png', b'\\x89PNG\\r\\n\\x1a\\n'+b'x'*(48*1024*1024 if sys.argv[2]=='expanded' else 0))
    z.writestr('report.json', '{}')
if sys.argv[2]=='zip':
    with pathlib.Path(sys.argv[1]).open('ab') as f: f.truncate(64*1024*1024+1)`, zip, kind]);
  const methods: string[] = [];
  const server = createServer((request, response) => {
    methods.push(request.method ?? "");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ state: "open", merged: false, head: { sha } }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no fixture address");
  try {
    const result = await relay(f, {
      GH_CI_EVENT: "gallery", FAKE_GALLERY_ZIP: zip, FORGEJO_PR: "42", FORGEJO_TOKEN: "token-for-tests",
      FORGEJO_URL: `http://127.0.0.1:${address.port}`, FORGEJO_REPOSITORY: "example/project",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
    expect(methods).toEqual(kind === "zip" ? [] : ["GET"]);
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});

it("the hosted gallery admits growth within the relay limits and rejects excess count or expanded bytes", async () => {
  const f = await fixture();
  const images = join(f.checkout, "packages/gui/gallery-images");
  mkdirSync(images, { recursive: true });
  const hosted = readFileSync(join(root, ".forgejo/github-workflows/gallery.yml"), "utf8");
  const guards = /# Leave room for ZIP headers[^\n]*\n([\s\S]*?)\n {6}- uses:/.exec(hosted)?.[1];
  if (!guards) throw new Error("no hosted gallery limits");
  // The hosted job uses GNU du; macOS's du has no byte-count option.
  if (process.platform === "darwin") writeFileSync(join(f.bin, "du"), `#!/usr/bin/env python3
import pathlib,sys
sizes=[pathlib.Path(p).stat().st_size for p in sys.argv[1:] if not p.startswith('-')]
print(str(sum(sizes))+'\\ttotal')
`, { mode: 0o755 });
  const check = () => run("bash", ["-e", "-c", guards], { cwd: f.checkout, env: { ...process.env, ...f.env } });
  for (let i = 0; i < 1200; i++) writeFileSync(join(images, `scene-${i}.dark.png`), "image");
  writeFileSync(join(images, "report.json"), "{}");
  writeFileSync(join(images, "geometry.json"), "{}");
  await expect(check()).resolves.toBeDefined();
  const extra = join(images, "scene-1200.dark.png");
  writeFileSync(extra, "image");
  await expect(check()).rejects.toMatchObject({ code: 1 });
  rmSync(extra);
  writeFileSync(join(images, "scene-0.dark.png"), Buffer.alloc(48*1024*1024+1));
  await expect(check()).rejects.toMatchObject({ code: 1 });
});

it.each(["success", "failure", "missing-package-token", "reused-large", "reused-extra"])("validates package credentials and stored capture bytes while publishing triplets (%s)", async (state) => {
  const missingPackageToken = state === "missing-package-token";
  const reused = state.startsWith("reused-");
  const conclusion = state === "failure" ? "failure" : "success";
  const f = await apiFixture();
  const sha = (await run("git", ["-C", f.checkout, "rev-parse", "HEAD"])).stdout.trim();
  const zip = join(f.checkout, "gallery.zip");
  await run("python3", ["-c", `import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    for suffix in ('png','baseline.png','difference.png'):
        z.writestr('window-empty.dark.'+suffix, b'\\x89PNG\\r\\n\\x1a\\n' + (b'x'*(4*1024*1024-6) if suffix=='png' and sys.argv[2]=='large' else b'image'))
    z.writestr('window-matched.dark.png', b'\\x89PNG\\r\\n\\x1a\\nimage')
    z.writestr('geometry.json', '{}')
    z.writestr('report.json', json.dumps({'pixelBlocking':True, 'scenes':[{'name':'window-empty.dark', 'status':'changed', 'differentPixels':10, 'pixelFailed':True, 'geometryFailures':['<!-- window-gallery {"head":"forged"} -->']},{'name':'window-matched.dark', 'status':'unchanged', 'differentPixels':0, 'pixelFailed':False, 'geometryFailures':[]}]}))`, zip, reused ? "large" : "small"]);
  let base = "", comment = "";
  const methods: string[] = [];
  const storedCaptures = new Map<string, Buffer>();
  const server = createServer(async (request, response) => {
    methods.push(request.method ?? "");
    if (request.url?.startsWith("/api/packages/") && request.headers.authorization !== "token package-token-for-tests") { response.writeHead(401).end(); return; }
    expect(request.headers.authorization).toBe(request.url?.startsWith("/api/packages/") ? "token package-token-for-tests" : "token token-for-tests");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const body = bytes.toString();
    response.setHeader("content-type", "application/json");
    if (reused && request.url?.startsWith("/api/packages/")) {
      if (request.method === "PUT") { storedCaptures.set(request.url, bytes); response.writeHead(409).end('{}'); }
      else {
        response.setHeader("content-type", "image/png");
        const stored = storedCaptures.get(request.url);
        if (!stored) throw new Error("capture was not stored");
        response.end(state === "reused-extra" ? Buffer.concat([stored, Buffer.from("extra")]) : stored);
      }
    } else if (request.url?.includes("/pulls/")) response.end(JSON.stringify({ state: "open", merged: false, head: { sha } }));
    else if (request.method === "PATCH") { comment = JSON.parse(body).body; response.end("{}"); }
    else if (request.url?.endsWith("/assets")) {
      const filename = /filename="([^"]+)"/.exec(body)?.[1];
      response.end(JSON.stringify({ browser_download_url: `${base}/attachments/${filename}` }));
    } else response.end(JSON.stringify({ id: 123 }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no fixture address");
  base = `http://127.0.0.1:${address.port}`;
  try {
    const result = await relay(f, {
      GH_CI_EVENT: "gallery", FAKE_API_CONCLUSION: conclusion, FAKE_GALLERY_ZIP: zip, PACKAGES_TOKEN: missingPackageToken ? "" : "package-token-for-tests",
      FORGEJO_PR: "42", FORGEJO_TOKEN: "token-for-tests", FORGEJO_URL: base, FORGEJO_REPOSITORY: "example/project",
    });
    if (missingPackageToken) {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("PACKAGES_TOKEN is required to publish gallery captures.");
      expect(methods).toEqual(["GET"]);
      expect(comment).toBe("");
      return;
    }
    if (state === "reused-extra") {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Gallery upload failed during capture storage window-empty.dark.png (ValueError)");
      expect(methods.filter((method) => method !== "GET")).toEqual(["POST", "POST", "POST", "POST", "POST", "PUT", "PATCH"]);
      expect(comment).toContain("Gallery upload failed");
      expect(comment).not.toContain("Uploading captures");
      expect(comment).not.toContain("<!-- window-gallery ");
      return;
    }
    expect(result.code).toBe(conclusion === "success" ? 0 : 1);
    expect(result.stdout).toContain("Gallery posted on pull request 42");
    expect(comment).toContain("| Baseline | Capture | Difference |");
    expect(comment).toContain(`![capture window-empty.dark](${base}/attachments/window-empty.dark.png)`);
    expect(comment).toContain('"name": "window-empty.dark.png"');
    expect(comment).toContain(`"head": "${sha}"`);
    expect(comment).toContain("1 scene matched.");
    expect(comment).toContain("&lt;!-- window-gallery");
    expect(comment.match(/<!-- window-gallery /g)).toHaveLength(1);
    expect(methods.filter((method) => method !== "GET")).toEqual(["POST", "POST", "POST", "POST", "POST", "PUT", "PUT", "PATCH"]);
    if (reused) expect([...storedCaptures.values()][0]?.byteLength).toBe(4*1024*1024+2);
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});

it("prints the failing capture job log when the gallery failed before producing an artifact", async () => {
  const f = await apiFixture();
  const result = await relay(f, { GH_CI_EVENT: "gallery", FAKE_API_CONCLUSION: "failure", FAKE_NO_ARTIFACT: "true" });
  expect(result.code).toBe(1);
  expect(result.stdout).toContain("checks failed at: tests");
  expect(result.stdout).toContain("test failure details");
  expect(apiCalls(f).some((call) => call.stage === "archive")).toBe(false);
});

/** Real relay and acceptance over an immutable generic-package HTTP peer. */
async function storedGallery(packagesToken = "token-for-tests") {
  const f = await apiFixture();
  const sha = (await run("git", ["-C", f.checkout, "rev-parse", "HEAD"])).stdout.trim();
  const zip = join(f.checkout, "gallery.zip");
  const captures = new Map<string, Buffer>();
  const attachments: string[] = [];
  const requests: string[] = [];
  const comments: { id: number; body: string; user?: { id: number } }[] = [];
  let base = "", failure = "", prState = "open", prHead = sha;
  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    requests.push(path);
    const expected = path.startsWith("/api/packages/") || path.startsWith("/api/v1/packages/") ? packagesToken : "token-for-tests";
    if (request.headers.authorization !== `token ${expected}`) { response.writeHead(401).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const data = Buffer.concat(chunks);
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path.includes("/pulls/")) response.end(JSON.stringify({ state: prState, merged: prState === "merged", head: { sha: prHead, ref: "build/42-gallery" } }));
    else if (request.method === "GET" && path.includes("/comments")) response.end(JSON.stringify(comments));
    else if (request.method === "POST" && path.endsWith("/comments")) {
      if (failure === "copied-comment") comments.push({ id: comments.length + 1, user: { id: 7 }, body: (JSON.parse(data.toString()) as { body: string }).body });
      const comment = { id: comments.length + 1, user: { id: -2 }, body: (JSON.parse(data.toString()) as { body: string }).body };
      comments.push(comment); response.end(JSON.stringify(comment));
    } else if (request.method === "PATCH") {
      const id = Number(path.split("/").at(-1));
      comments[id - 1]!.body = (JSON.parse(data.toString()) as { body: string }).body;
      response.end("{}");
    } else if (request.method === "POST" && path.endsWith("/assets")) {
      attachments.push(/filename="([^"]+)"/.exec(data.toString())?.[1] ?? "");
      if (failure === "attachment") { response.writeHead(503).end(); return; }
      response.end(JSON.stringify({ browser_download_url: failure === "asset-url" ? "https://elsewhere.example.invalid/capture" : `${base}/attachments/capture-${comments.length}` }));
    } else if (path.startsWith("/api/packages/")) {
      if (request.method === "PUT") {
        if (failure === "package") { response.writeHead(503).end(); return; }
        if (captures.has(path)) { response.writeHead(409).end(); return; }
        captures.set(path, data); response.writeHead(201).end();
      } else if (captures.has(path)) response.end(captures.get(path));
      else response.writeHead(404).end();
    } else response.end("[]");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(() => { server.close(); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no fixture address");
  base = `http://127.0.0.1:${address.port}`;
  const env = { PACKAGES_TOKEN: packagesToken, GH_CI_EVENT: "gallery", FAKE_GALLERY_ZIP: zip, FORGEJO_PR: "42", FORGEJO_TOKEN: "token-for-tests", FORGEJO_URL: base, FORGEJO_REPOSITORY: "example/project" };
  return {
    f, sha, comments, captures, attachments, requests, env,
    fail: (stage: string) => { failure = stage; },
    changePR: (state: string, head = sha) => { prState = state; prHead = head; },
    capture: async (pixel: number, count = 1, names = count === 1 ? ["window-empty.dark"] : Array.from({ length: count }, (_, index) => `scene-${index}.dark`), viewport?: { width: number; height: number }, shard?: { run: string; index: number; count: number; total: number } | { id: string; index: number; count: number }) => {
      await run("python3", ["-c", `import json,struct,sys,zipfile,zlib,pathlib
pixel=int(sys.argv[2])
def chunk(kind,data): return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
def image(width,height): return b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,6,0,0,0))+chunk(b'IDAT',zlib.compress((b'\\0'+bytes([pixel,pixel,pixel,255])*width)*height))+chunk(b'IEND',b'')
png=image(1400,900); narrow=image(1024,768)
pathlib.Path(sys.argv[1]+'.png').write_bytes(png)
with zipfile.ZipFile(sys.argv[1],'w') as z:
    names=json.loads(sys.argv[3])
    for name in names:
        override=json.loads(sys.argv[4])
        if override: data=image(override['width'],override['height'])
        elif '-phone-360.' in name: data=image(360,740)
        elif '-phone-390-keyboard.' in name: data=image(390,480)
        elif '-phone-390' in name: data=image(390,844)
        else: data=narrow if '-narrow.' in name else png
        z.writestr(name+'.png',data)
    z.writestr('geometry.json','{}')
    z.writestr('report.json',json.dumps({'pixelBlocking':bool(json.loads(sys.argv[5])),**({'shard':json.loads(sys.argv[5])} if json.loads(sys.argv[5]) else {}),'captureBudget':{'desktop':sum(not n.startswith('phone-') for n in names),'phone':sum(n.startswith('phone-') for n in names),'total':len(names),'limit':400,'remaining':400-len(names)},'scenes':[{'name':name,'status':'new','pixelFailed':True,'geometryFailures':[]} for name in names]}))`, zip, String(pixel), JSON.stringify(names), JSON.stringify(viewport ?? null), JSON.stringify(shard ?? null)]);
      return readFileSync(`${zip}.png`);
    },
  };
}

it("finishes a published gallery without scanning repository-wide retention", async () => {
  const g = await storedGallery();
  await g.capture(230);
  const result = await relay(g.f, g.env);
  expect(result.code, result.stderr).toBe(0);
  expect(g.comments[0]!.body).toContain("<!-- window-gallery ");
  expect(g.requests.some(path => path.includes("/pulls?state=open") || path.startsWith("/api/v1/packages/"))).toBe(false);
});

it("publishes a healthy 1040-capture four-shard set that takes longer than ten minutes", async () => {
  const g = await storedGallery();
  const artifacts: { id: number; name: string; size_in_bytes: number }[] = [];
  const archives: Record<string, string> = {};
  for (const [index, count] of [400, 120, 400, 120].entries()) {
    const family = index < 2 ? "desktop" : "phone";
    const id = `${family}-${String(index % 2 + 1).padStart(3, "0")}`;
    const names = Array.from({ length: count }, (_, row) => family === "desktop" ? `scene-${index}-${row}.dark` : `phone-scene-${index}-${row}-phone-390.dark`);
    await g.capture(230, count, names, undefined, { id, index, count: 4 });
    const archive = join(g.f.checkout, `gallery-${id}.zip`);
    writeFileSync(archive, readFileSync(g.env.FAKE_GALLERY_ZIP));
    archives[String(index + 99)] = archive;
    artifacts.push({ id: index + 99, name: `window-gallery-${id}`, size_in_bytes: statSync(archive).size });
  }
  const hooks = join(g.f.checkout, "hooks"); mkdirSync(hooks);
  writeFileSync(join(hooks, "sitecustomize.py"), `import time,urllib.request
original=urllib.request.OpenerDirector.open
clock=0
time.monotonic=lambda: clock
def opened(self, req, *args, **kwargs):
    global clock
    reply=original(self,req,*args,**kwargs)
    clock+=0.35
    return reply
urllib.request.OpenerDirector.open=opened
`);
  const result = await relay(g.f, { ...g.env, PYTHONPATH: hooks, FAKE_ARTIFACTS: JSON.stringify(artifacts), FAKE_GALLERY_ZIPS: JSON.stringify(archives) });
  expect(result.code, result.stderr).toBe(0);
  expect(g.comments).toHaveLength(4);
  expect(g.captures.size).toBe(1040);
  for (const comment of g.comments) {
    expect(comment.body).toContain("<!-- window-gallery ");
    expect(comment.body).not.toContain("Uploading captures");
  }
});

it.each(["attachment", "storage", "read", "reused", "final-report", "terminated", "budget"])("finalizes a held gallery upload when its %s deadline interrupts publication", async (stage) => {
  const g = await storedGallery();
  await g.capture(230);
  // Deliver the deadline signal at the transport boundary, without a wall-clock race.
  const hooks = join(g.f.checkout, "hooks"); mkdirSync(hooks);
  writeFileSync(join(hooks, "sitecustomize.py"), `import json,os,signal,time,urllib.error,urllib.request
original=urllib.request.OpenerDirector.open
clock=0
if os.environ['HELD_STAGE']=='budget': time.monotonic=lambda: clock
def opened(self, req, *args, **kwargs):
    global clock
    url=req.full_url
    stage=os.environ['HELD_STAGE']
    if stage=='reused' and '/api/packages/' in url and req.get_method()=='PUT':
        raise urllib.error.HTTPError(url,409,'Conflict',{},None)
    if stage=='final-report': target=req.get_method()=='PATCH' and b'<!-- window-gallery ' in (req.data or b'')
    else: target=('/assets' in url if stage in ('attachment','read','terminated') else '/api/packages/' in url)
    if target:
        with open(os.environ['DEADLINE_LOG'],'w') as log: json.dump(signal.getitimer(signal.ITIMER_REAL)[0],log)
        if stage=='budget':
            clock=601
        elif stage=='read':
            reply=original(self,req,*args,**kwargs)
            def read(*args): os.kill(os.getpid(),signal.SIGALRM)
            reply.read=read
            return reply
        else: os.kill(os.getpid(),signal.SIGTERM if stage=='terminated' else signal.SIGALRM)
    return original(self,req,*args,**kwargs)
urllib.request.OpenerDirector.open=opened
`);
  const deadlineLog = join(hooks, "deadline.json");
  const result = await relay(g.f, { ...g.env, PYTHONPATH: hooks, HELD_STAGE: stage, DEADLINE_LOG: deadlineLog });
  expect(result.code).not.toBe(0);
  expect(g.comments).toHaveLength(1);
  const body = g.comments[0]!.body;
  expect(body).toContain("Gallery upload failed during");
  expect(body).toContain(stage === "terminated" ? "UploadInterrupted" : "UploadTimeout");
  expect(body).not.toContain("Uploading captures");
  expect(body).not.toContain("<!-- window-gallery ");
  expect(result.stderr).toContain("Gallery upload failed during");
  const deadline = JSON.parse(readFileSync(deadlineLog, "utf8")) as number;
  expect(deadline).toBeGreaterThan(0);
  expect(deadline).toBeLessThanOrEqual(60);
});

it.each(["timeout", "terminated", "connection"])("recovers and finalizes a committed gallery comment after its creation response is lost (%s)", async (mode) => {
  const g = await storedGallery();
  await g.capture(230);
  g.fail("copied-comment");
  g.comments.push({ id: 1, user: { id: -2 }, body: `Window gallery for \`${g.sha}\`. Uploading captures…` });
  const hooks = join(g.f.checkout, "hooks"); mkdirSync(hooks);
  writeFileSync(join(hooks, "sitecustomize.py"), `import os,signal,urllib.error,urllib.request
original=urllib.request.OpenerDirector.open
def opened(self, req, *args, **kwargs):
    reply=original(self,req,*args,**kwargs)
    if req.get_method()=='POST' and req.full_url.endswith('/comments'):
        def read(*args):
            mode=os.environ['CREATION_FAILURE']
            if mode=='connection': raise urllib.error.URLError('connection lost')
            os.kill(os.getpid(),signal.SIGTERM if mode=='terminated' else signal.SIGALRM)
        reply.read=read
    return reply
urllib.request.OpenerDirector.open=opened
`);
  const result = await relay(g.f, { ...g.env, PYTHONPATH: hooks, CREATION_FAILURE: mode });
  expect(result.code).not.toBe(0);
  expect(g.comments).toHaveLength(3);
  expect(g.comments[0]!.body).toBe(`Window gallery for \`${g.sha}\`. Uploading captures…`);
  expect(g.comments[1]!.body).toContain("Uploading captures");
  expect(g.comments[2]!.body).toContain("Gallery upload failed during comment creation");
  expect(g.comments[2]!.body).not.toContain("Uploading captures");
  expect(g.comments[2]!.body).not.toContain("<!-- window-gallery ");
  expect(g.attachments).toEqual([]);
  expect(g.captures.size).toBe(0);
  expect(result.stderr).toContain("Gallery upload failed during comment creation");
});

it.each([{ count: 212, status: "new" }, { count: 212, status: "changed" }, { count: 400, status: "changed" }])("publishes $count $status captures across both widths and ladders", async ({ count, status }) => {
  const g = await storedGallery();
  await run("python3", ["-c", `import json,sys,zipfile
scenes=[]
# 32 KiB per PNG exercises more than the old expanded and transport byte caps at 400 rows.
png=b'\\x89PNG\\r\\n\\x1a\\n'+b'x'*(32768-8)
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    for i in range(int(sys.argv[2])):
        name=f'scene-{i//4}'+('-narrow' if i%4>=2 else '')+('.dark' if i%2 else '.light')
        scenes.append({'name':name,'status':sys.argv[3],'pixelFailed':True,'geometryFailures':[]})
        for suffix in (('png','baseline.png','difference.png') if sys.argv[3]=='changed' else ('png',)): z.writestr(name+'.'+suffix,png)
    z.writestr('geometry.json','{}')
    z.writestr('report.json',json.dumps({'pixelBlocking':False,'scenes':scenes}))`, g.env.FAKE_GALLERY_ZIP, String(count), status]);
  const result = await relay(g.f, { ...g.env, FAKE_ARTIFACT_SIZE: String(statSync(g.env.FAKE_GALLERY_ZIP).size) });
  expect(result.code, result.stderr).toBe(0);
  expect(g.comments).toHaveLength(1);
  expect(g.captures.size).toBe(count);
  expect(g.attachments).toHaveLength(status === "changed" ? count * 3 : count);
  expect(new Set(g.attachments).size).toBe(g.attachments.length);
  const body = g.comments[0]!.body;
  expect(body.match(/\| Baseline \| Capture \| Difference \|/g) ?? []).toHaveLength(status === "changed" ? count : 0);
  const manifest = /<!-- window-gallery (.*) -->/.exec(body)?.[1];
  expect(manifest).toBeDefined();
  expect((JSON.parse(manifest!) as { captures: unknown[] }).captures).toHaveLength(count);
  for (const width of ["", "-narrow"]) {
    for (const ladder of ["light", "dark"]) {
      expect(body).toContain(`![capture scene-0${width}.${ladder}]`);
      if (status === "changed") {
        expect(body).toContain(`![baseline scene-0${width}.${ladder}]`);
        expect(body).toContain(`![difference scene-0${width}.${ladder}]`);
      }
    }
  }
});

it.each([
  ["scenes", "invalid gallery scene list"],
  ["pngs", "gallery payload is too large"],
  ["entries", "gallery payload is too large"],
  ["expanded", "gallery payload is too large"],
  ["zip", "gallery zip is too large"],
  ["duplicate-scene", "invalid gallery scene name"],
  ["scene-name", "invalid gallery scene name"],
  ["missing-triplet", "incomplete gallery triplet"],
  ["status", "incomplete gallery triplet"],
  ["empty-scenes", "invalid gallery scene list"],
])("rejects a report with invalid %s before publishing", async (kind, message) => {
  const g = await storedGallery();
  await run("python3", ["-c", `import json,pathlib,sys,zipfile
kind=sys.argv[2]; path=pathlib.Path(sys.argv[1])
count=401 if kind=='scenes' else 1201 if kind=='pngs' else 1200 if kind=='entries' else 1
scenes=[]
with zipfile.ZipFile(path,'w',compression=zipfile.ZIP_DEFLATED) as z:
    for i in range(count):
        name=f'scene-{i}.dark'
        scenes.append({'name':name,'status':'new','pixelFailed':False,'geometryFailures':[]})
        z.writestr(name+'.png',b'\\x89PNG\\r\\n\\x1a\\n'+(b'x'*(48*1024*1024) if kind=='expanded' else b'image'))
    if kind in ('pngs','entries'): scenes=scenes[:1]
    if kind=='entries':
        z.writestr('geometry.json','{}'); z.writestr('extra.json','{}')
    if kind=='duplicate-scene': scenes+=scenes
    if kind=='scene-name': scenes[0]['name']='../scene.dark'
    if kind=='missing-triplet': scenes[0]['status']='changed'
    if kind=='status': scenes[0]['status']='invalid'
    if kind=='empty-scenes': scenes=[]
    z.writestr('report.json',json.dumps({'pixelBlocking':False,'scenes':scenes}))
if kind=='zip':
    with path.open('ab') as f: f.truncate(64*1024*1024+1)`, g.env.FAKE_GALLERY_ZIP, kind]);
  const result = await relay(g.f, g.env);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain(message);
  expect(g.comments).toEqual([]);
  expect(g.captures.size).toBe(0);
});

it("publishes and accepts a 204-capture report within the existing payload budgets", async () => {
  const g = await storedGallery();
  const image = await g.capture(255, 204);
  const result = await relay(g.f, g.env);
  expect(result.code, result.stderr).toBe(0);
  expect(g.captures.size).toBe(204);
  const manifest = /<!-- window-gallery (.*?) -->/.exec(g.comments[0]!.body)?.[1];
  expect(manifest).toBeDefined();
  expect((JSON.parse(manifest!) as { captures: unknown[] }).captures).toHaveLength(204);
  await run("bash", [join(root, "scripts/gallery-accept.sh"), "42"], { cwd: g.f.checkout, env: { ...g.f.env, ...g.env } });
  const baselines = join(g.f.checkout, "packages/gui/gallery/baselines");
  expect(readdirSync(baselines)).toHaveLength(204);
  for (let i = 0; i < 204; i++) expect(readFileSync(join(baselines, `scene-${i}.dark.png`))).toEqual(image);
});

it("finalizes a rerun on the same head and accepts its newly reviewed bytes while keeping the earlier manifest immutable", async () => {
  const g = await storedGallery();
  const first = await g.capture(255);
  expect((await relay(g.f, g.env)).code).toBe(0);
  const second = await g.capture(0);
  const result = await relay(g.f, g.env);
  expect(result.code, result.stderr).toBe(0);
  expect(g.comments).toHaveLength(2);
  expect(g.comments[1]!.body).not.toContain("Uploading captures");
  expect([...g.captures.values()]).toEqual([first, second]);
  await run("bash", [join(root, "scripts/gallery-accept.sh"), "42"], { cwd: g.f.checkout, env: { ...g.f.env, ...g.env } });
  expect(readFileSync(join(g.f.checkout, "packages/gui/gallery/baselines/window-empty.dark.png"))).toEqual(second);
});

it.each(["attachment", "package", "asset-url"])("finalizes an actionable failure report when the %s upload fails", async (stage) => {
  const g = await storedGallery();
  await g.capture(255);
  g.fail(stage);
  const result = await relay(g.f, g.env);
  expect(result.code).toBe(1);
  expect(g.comments).toHaveLength(1);
  const body = g.comments[0]!.body;
  expect(body).toContain("Gallery upload failed");
  expect(body).toContain(stage === "asset-url" ? "ValueError" : "HTTP 503");
  expect(body).toContain("Rerun the gallery job");
  expect(body).not.toContain("Uploading captures");
  expect(body).not.toContain("<!-- window-gallery ");
  expect(body).toContain('<!-- window-gallery-attempt {"head": "' + g.sha + '"');
  expect(body).not.toContain("token-for-tests");
});

it("publishes and accepts the required captures per registered scene through main's named report shards", async () => {
  const g = await storedGallery();
  const plan = await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'import { capturePlan, sceneFiles } from "./packages/gui/gallery/capture-plan.ts"; const desktop = (await sceneFiles("./packages/gui/gallery/scenes")).filter(name => !name.startsWith("phone-")); console.log(JSON.stringify(capturePlan(desktop).shards.map(shard => ({ id: shard.id, names: shard.captures.map(c => c.name) }))));'], { cwd: root });
  const shards = JSON.parse(plan.stdout) as { id: string; names: string[] }[];
  const names = shards.flatMap(shard => shard.names);
  // The hosted job captures the registered desktop scenes in named shards of at most 400 captures (#1937), however many the plan holds.
  const artifacts: { id: number; name: string; size_in_bytes: number }[] = [];
  const archives: Record<string, string> = {};
  for (const [index, shard] of shards.entries()) {
    await g.capture(255, shard.names.length, shard.names, undefined, { id: shard.id, index, count: shards.length });
    const archive = join(g.f.checkout, `${shard.id}.zip`);
    writeFileSync(archive, readFileSync(g.env.FAKE_GALLERY_ZIP));
    artifacts.push({ id: 100 + index, name: `window-gallery-${shard.id}`, size_in_bytes: statSync(archive).size });
    archives[String(100 + index)] = archive;
  }
  const result = await relay(g.f, { ...g.env, FAKE_ARTIFACTS: JSON.stringify(artifacts), FAKE_GALLERY_ZIPS: JSON.stringify(archives) });
  expect(result.code, result.stderr).toBe(0);
  expect(g.comments).toHaveLength(shards.length);
  const manifests = g.comments.map(({ body }) => {
    expect(body).toContain("Geometry: passed");
    const marker = /<!-- window-gallery (.*?) -->/.exec(body)?.[1];
    expect(marker).toBeDefined();
    return JSON.parse(marker!) as { version: string; captures: { name: string }[] };
  });
  expect(manifests.flatMap(({ captures }) => captures.map(({ name }) => name))).toEqual(names.map((name) => `${name}.png`));
  expect(g.captures.size).toBe(names.length);
  await run("bash", [join(root, "scripts/gallery-accept.sh"), "42"], { cwd: g.f.checkout, env: { ...g.f.env, ...g.env } });
  const baselines = join(g.f.checkout, "packages/gui/gallery/baselines");
  expect(readdirSync(baselines).sort()).toEqual(names.map((name) => `${name}.png`).sort());
  for (const { version, captures } of manifests) {
    for (const { name } of captures) {
      const image = readFileSync(join(baselines, name));
      expect(image).toEqual(g.captures.get(`/api/packages/example/generic/window-gallery/${version}/${name}`));
      expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual(name.includes("-narrow.") ? [1024, 768] : [1400, 900]);
    }
  }
});


it("uses the owner package credential for captures while keeping comment requests on the repository token", async () => {
  const g = await storedGallery("package-token-for-tests");
  await g.capture(255);
  const result = await relay(g.f, g.env);
  expect(result.code, result.stderr).toBe(0);
  expect(g.comments[0]!.body).toContain("<!-- window-gallery ");
});


it("runs cleanup daily and manually outside gallery publication", () => {
  const workflow = readFileSync(join(import.meta.dirname, "../.forgejo/workflows/gallery-retention.yml"), "utf8");
  expect(workflow).toContain("cron:");
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).toContain("ref: ${{ github.event.repository.default_branch }}");
  expect(workflow).toContain("python3 scripts/gallery-retention.py");
  expect(workflow).toContain("PACKAGES_TOKEN: ${{ secrets.PACKAGES_TOKEN }}");
  expect(readFileSync(join(import.meta.dirname, "../.forgejo/workflows/gallery.yml"), "utf8")).toContain("PACKAGES_TOKEN: ${{ secrets.PACKAGES_TOKEN }}");
  expect(readFileSync(join(import.meta.dirname, "../.forgejo/scripts/github-ci.sh"), "utf8")).not.toContain("scripts/gallery-retention.py");
});

it("publishes more than fifty gallery scenes across both themes and viewports", async () => {
  const g = await storedGallery();
  await run("python3", ["-c", `import json,sys,zipfile
scenes=[]
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    for index in range(52):
        for viewport in ('', '-narrow'):
            for theme in ('light', 'dark'):
                name=f'scene-{index}{viewport}.{theme}'
                z.writestr(name+'.png', b'\\x89PNG\\r\\n\\x1a\\nimage')
                scenes.append({'name':name, 'status':'new', 'pixelFailed':False, 'geometryFailures':[]})
    z.writestr('report.json', json.dumps({'pixelBlocking':False, 'scenes':scenes}))`, g.env.FAKE_GALLERY_ZIP]);
  const result = await relay(g.f, g.env);
  expect(result.code, result.stderr).toBe(0);
  expect(g.captures.size).toBe(208);
  expect(g.comments).toHaveLength(1);
  expect(g.comments[0]!.body).toContain('"name": "scene-51-narrow.dark.png"');
  expect(g.comments[0]!.body).not.toContain("Uploading captures");
});

it("publishes and accepts every phone profile beside the preserved desktop captures", async () => {
  const g = await storedGallery();
  const names = ["window-empty.dark", "window-empty-narrow.light", "phone-gallery-conversation-phone-390.dark", "phone-gallery-conversation-phone-360.light", "phone-gallery-conversation-phone-390-text-20.dark", "phone-gallery-conversation-phone-390-keyboard.light"];
  await g.capture(230, names.length, names);
  const result = await relay(g.f, g.env);
  expect(result.code, result.stderr).toBe(0);
  expect(g.captures.size).toBe(6);
  expect(g.comments[0]!.body).toContain("Capture budget: 2 desktop + 4 phone = 6/400; 394 slots reserved.");
  const accepted = await run("bash", [join(root, "scripts/gallery-accept.sh"), "42"], { cwd: g.f.checkout, env: { ...process.env, ...g.env } });
  for (const name of names) expect(accepted.stdout).toContain(`Accepted ${name}.png`);
});

it.each([
  ["320", 320, 568],
  ["320-short", 320, 320],
  ["360-short", 360, 400],
  ["430", 430, 932],
  ["430-short", 430, 360],
  ["844", 844, 390],
  ["740", 740, 360],
  ["844-text-20", 844, 390],
  ["740-text-20", 740, 360],
] as const)("publishes and accepts named phone-%s captures and their changed triplets", async (profile, width, height) => {
  const g = await storedGallery();
  const names = ["dark", "light"].map(ladder => `phone-frame-conversation-phone-${profile}.${ladder}`);
  await g.capture(230, names.length, names, { width, height });
  await run("python3", ["-c", `import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z: files={n:z.read(n) for n in z.namelist()}
report=json.loads(files['report.json'])
report['pixelBlocking']=True
report['shard']={'id':'phone-001','index':0,'count':1}
for scene in report['scenes']:
    scene['status']='changed'
    for suffix in ('.baseline.png','.difference.png'): files[scene['name']+suffix]=files[scene['name']+'.png']
files['report.json']=json.dumps(report).encode()
with zipfile.ZipFile(sys.argv[1],'w') as z:
    for name,data in files.items(): z.writestr(name,data)`, g.env.FAKE_GALLERY_ZIP]);
  const env = { ...g.env, FAKE_ARTIFACTS: JSON.stringify([{ id: 99, name: "window-gallery-phone-001", size_in_bytes: statSync(g.env.FAKE_GALLERY_ZIP).size }]) };
  const result = await relay(g.f, env);
  expect(result.code, result.stderr).toBe(0);
  expect(g.comments).toHaveLength(1);
  expect(g.captures.size).toBe(2);
  expect(g.attachments).toHaveLength(6);
  await run("bash", [join(root, "scripts/gallery-accept.sh"), "42"], { cwd: g.f.checkout, env: { ...process.env, ...g.env } });
  for (const [url, image] of g.captures) {
    const filename = url.split("/").at(-1)!;
    expect(readFileSync(join(g.f.checkout, "packages/gui/gallery/baselines", filename))).toEqual(image);
  }
  expect(readdirSync(join(g.f.checkout, "packages/gui/gallery/baselines"))).toHaveLength(2);
});

it.each([
  ["390-keyboard", 390, 844],
  ["320", 320, 320],
  ["320-short", 320, 568],
  ["360-short", 360, 740],
  ["430", 430, 360],
  ["430-short", 430, 932],
  ["999", 320, 568],
  ["320-extra", 320, 568],
  ["844", 390, 844],
  ["740", 360, 740],
  ["844-text-20", 740, 360],
  ["740-text-20", 844, 390],
  ["844-extra", 844, 390],
  ["740-short", 740, 360],
] as const)("refuses to publish phone-%s whose dimensions disagree with its profile name", async (profile, width, height) => {
  const g = await storedGallery();
  await g.capture(230, 1, [`phone-gallery-conversation-phone-${profile}.dark`], { width, height });
  const result = await relay(g.f, g.env);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("unexpected phone gallery dimensions");
  expect(g.comments).toHaveLength(0);
});

it.each(["320", "844"].flatMap(profile => ["truncated-png", "invalid-ihdr", "wrong-size-difference", "invalid-name"].map(mode => [profile, mode] as const)))("rejects a phone-%s %s report before any publication", async (profile, mode) => {
  const g = await storedGallery();
  await g.capture(230, 1, [`phone-frame-conversation-phone-${profile}.dark`], profile === "320" ? { width: 320, height: 568 } : { width: 844, height: 390 });
  await run("python3", ["-c", `import json,struct,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z: files={n:z.read(n) for n in z.namelist()}
report=json.loads(files['report.json']); scene=report['scenes'][0]; name=scene['name']+'.png'; data=files[name]
if sys.argv[2]=='truncated-png': files[name]=data[:32]
elif sys.argv[2]=='invalid-ihdr': files[name]=data[:12]+b'IDAT'+data[16:]
elif sys.argv[2]=='wrong-size-difference':
    scene['status']='changed'
    files[scene['name']+'.baseline.png']=data
    files[scene['name']+'.difference.png']=data[:16]+struct.pack('>II',320,320)+data[24:]
else:
    files['../'+name]=files.pop(name)
files['report.json']=json.dumps(report).encode()
with zipfile.ZipFile(sys.argv[1],'w') as z:
    for name,data in files.items(): z.writestr(name,data)`, g.env.FAKE_GALLERY_ZIP, mode]);
  const result = await relay(g.f, g.env);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(mode === "invalid-name" ? "unexpected gallery entry" : "unexpected phone gallery dimensions");
  expect(g.comments).toHaveLength(0);
  expect(g.captures.size).toBe(0);
});

async function shardedGallery() {
  const g = await storedGallery();
  const first = join(g.f.checkout, "first.zip");
  const second = join(g.f.checkout, "second.zip");
  const names = Array.from({ length: 472 }, (_, index) => `scene-${index}.dark`);
  await g.capture(230, 400, names.slice(0, 400), undefined, { run: "sharded-run", index: 1, count: 2, total: 472 });
  writeFileSync(first, readFileSync(g.env.FAKE_GALLERY_ZIP));
  await g.capture(230, 72, names.slice(400), undefined, { run: "sharded-run", index: 2, count: 2, total: 472 });
  writeFileSync(second, readFileSync(g.env.FAKE_GALLERY_ZIP));
  const env = { ...g.env,
    FAKE_ARTIFACTS: JSON.stringify([{ id: 99, name: "window-gallery-shard-1", size_in_bytes: statSync(first).size }, { id: 100, name: "window-gallery-shard-2", size_in_bytes: statSync(second).size }]),
    FAKE_GALLERY_ZIPS: JSON.stringify({ "99": first, "100": second }),
  };
  return { ...g, first, second, shardEnv: env };
}

it("publishes and accepts 472 captures from two slow ZIP transfers as complete independently bounded reports", async () => {
  const g = await shardedGallery();
  const result = await relay(g.f, { ...g.shardEnv, FAKE_ARCHIVE_SECONDS: "180" });
  expect(result.code, result.stderr).toBe(0);
  expect(apiCalls(g.f).filter(({ stage }) => stage === "archive")).toHaveLength(2);
  expect(g.comments).toHaveLength(2);
  expect(g.captures.size).toBe(472);
  expect(g.comments[0]!.body).toContain('"index": 1');
  expect(g.comments[1]!.body).toContain('"index": 2');
  await run("bash", [join(root, "scripts/gallery-accept.sh"), "42"], { cwd: g.f.checkout, env: { ...process.env, ...g.env } });
  expect(readdirSync(join(g.f.checkout, "packages/gui/gallery/baselines"))).toHaveLength(472);
});

it.each(["missing", "mixed-run", "duplicate-name", "invalid-count", "advisory"])("rejects a %s shard set before creating any report", async (mode) => {
  const g = await shardedGallery();
  if (mode === "missing") g.shardEnv.FAKE_ARTIFACTS = JSON.stringify([{ id: 100, name: "window-gallery-shard-2", size_in_bytes: statSync(g.second).size }]);
  else await run("python3", ["-c", `import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z: files={name:z.read(name) for name in z.namelist()}
report=json.loads(files['report.json'])
mode=sys.argv[2]
if mode=='mixed-run': report['shard']['run']='other-run'
if mode=='invalid-count': report['shard']['count']=3
if mode=='advisory': report['pixelBlocking']=False
if mode=='duplicate-name':
    original=report['scenes'][0]['name']; report['scenes'][0]['name']='scene-0.dark'
    files['scene-0.dark.png']=files.pop(original+'.png')
files['report.json']=json.dumps(report).encode()
with zipfile.ZipFile(sys.argv[1],'w') as z:
    for name,data in files.items(): z.writestr(name,data)`, g.second, mode]);
  const result = await relay(g.f, g.shardEnv);
  expect(result.code).toBe(1);
  expect(g.comments).toEqual([]);
  expect(g.captures.size).toBe(0);
});

it("executes the hosted shard guard against bounded, inconsistent and ungated reports", async () => {
  const f = await fixture();
  const images = join(f.checkout, "packages/gui/gallery-images");
  mkdirSync(images, { recursive: true });
  const hosted = readFileSync(join(root, ".forgejo/github-workflows/gallery.yml"), "utf8");
  const guard = /python3 - <<'PY'\n([\s\S]*?)\n {10}PY/.exec(hosted)?.[1];
  if (guard === undefined) throw new Error("no hosted report guard");
  const code = guard.split("\n").map(line => line.slice(10)).join("\n");
  // Run the hosted executable guard, with only its shared validation module supplied.
  mkdirSync(join(f.checkout, "scripts"));
  writeFileSync(join(f.checkout, "scripts/gallery_reports.py"), readFileSync(join(root, "scripts/gallery_reports.py")));
  const report = { pixelBlocking: true, scenes: Array.from({ length: 72 }, (_, index) => ({ name: `scene-${index}.dark` })), shard: { run: "hosted-run", index: 2, count: 2, total: 472 } };
  const check = () => run("python3", ["-c", code], { cwd: f.checkout, env: { ...process.env, GALLERY_SHARD: "2", GALLERY_RUN: "hosted-run" } });
  const write = () => writeFileSync(join(images, "report.json"), JSON.stringify(report));
  write(); await expect(check()).resolves.toBeDefined();
  report.shard.total = 473;
  write(); await expect(check()).rejects.toMatchObject({ code: 1 });
  report.shard.total = 472; report.pixelBlocking = false;
  write(); await expect(check()).rejects.toMatchObject({ code: 1 });
  report.pixelBlocking = true; report.shard.run = "other-run";
  write(); await expect(check()).rejects.toMatchObject({ code: 1 });
  expect(hosted).toContain("fail-fast: false");
  expect(hosted).toContain("name: ${{ matrix.artifact }}");
});

it("plans named report artifacts without launching the renderer", async () => {
  const result = await run(process.execPath, ["--import", "tsx", "gallery/plan.ts"], { cwd: join(root, "packages/gui") });
  const matrix = JSON.parse(result.stdout.trim().replace(/^matrix=/, "")) as { include: { shard: string; count: number; artifact: string }[] };
  const f = await fixture();
  const hosted = readFileSync(join(root, ".forgejo/github-workflows/gallery.yml"), "utf8");
  const plan = /- id: plan\n {8}run: ([\s\S]*?)\n {6}- uses: actions\/upload-artifact/.exec(hosted)?.[1];
  if (!plan) throw new Error("no hosted planning step");
  const command = plan.slice(2).split("\n").map(line => line.slice(10)).join("\n");
  const output = join(f.checkout, "output");
  await run("bash", ["-e", "-c", command], { cwd: root, env: { ...process.env, RUNNER_TEMP: f.checkout, GITHUB_OUTPUT: output } });
  expect(JSON.parse(readFileSync(join(f.checkout, "gallery-plan/matrix.json"), "utf8"))).toEqual(matrix);
  expect(readFileSync(output, "utf8").trim()).toBe(`matrix=${JSON.stringify(matrix)}`);
  expect(hosted).toContain("name: gallery (${{ matrix.shard }})");
  expect(matrix.include.map(entry => entry.shard)).toEqual(expect.arrayContaining(["desktop-001", "phone-001"]));
  expect(new Set(matrix.include.map(entry => entry.shard)).size).toBe(matrix.include.length);
  for (const entry of matrix.include) {
    expect(entry.shard).toMatch(/^(desktop|phone)-[0-9]{3}$/);
    expect(entry.count).toBe(matrix.include.length);
    expect(entry.artifact).toBe(`window-gallery-${entry.shard}`);
  }
});

it("plans and validates a bounded single report on heads predating shard support", async () => {
  const f = await fixture();
  const hosted = readFileSync(join(root, ".forgejo/github-workflows/gallery.yml"), "utf8");
  const plan = /- id: plan\n {8}run: ([\s\S]*?)\n {6}- uses: actions\/upload-artifact/.exec(hosted)?.[1];
  if (plan === undefined) throw new Error("no hosted planning step");
  const output = join(f.checkout, "gallery-output");
  const command = plan.startsWith("|\n") ? plan.slice(2).split("\n").map(line => line.slice(10)).join("\n") : plan;
  await run("bash", ["-e", "-c", command], { cwd: f.checkout, env: { ...process.env, GITHUB_OUTPUT: output, RUNNER_TEMP: f.checkout } });
  expect(readFileSync(output, "utf8").trim()).toBe('matrix={"include":[{"shard":1,"artifact":"window-gallery","legacy":true}]}');
  expect(JSON.parse(readFileSync(join(f.checkout, "gallery-plan/matrix.json"), "utf8"))).toEqual({ include: [{ shard: 1, artifact: "window-gallery", legacy: true }] });
  const guard = /python3 - <<'PY'\n([\s\S]*?)\n {10}PY/.exec(hosted)?.[1];
  if (guard === undefined) throw new Error("no hosted report guard");
  const code = guard.split("\n").map(line => line.slice(10)).join("\n");
  const images = join(f.checkout, "packages/gui/gallery-images");
  mkdirSync(images, { recursive: true });
  const report = { pixelBlocking: true, scenes: Array.from({ length: 400 }, (_, index) => ({ name: `scene-${index}.dark` })) };
  writeFileSync(join(images, "report.json"), JSON.stringify(report));
  const check = (legacy: string, shard = "1") => run("python3", ["-c", code], { cwd: f.checkout, env: { ...process.env, GALLERY_LEGACY: legacy, GALLERY_SHARD: shard, GALLERY_RUN: "hosted-run" } });
  await expect(check("true")).resolves.toBeDefined();
  await expect(check("false")).rejects.toMatchObject({ code: 1 });
  await expect(check("true", "2")).rejects.toMatchObject({ code: 1 });
  report.scenes.push({ name: "scene-overflow.dark" });
  writeFileSync(join(images, "report.json"), JSON.stringify(report));
  await expect(check("true")).rejects.toMatchObject({ code: 1 });
  report.scenes.pop(); report.pixelBlocking = false;
  writeFileSync(join(images, "report.json"), JSON.stringify(report));
  await expect(check("true")).rejects.toMatchObject({ code: 1 });
});


it("publishes and accepts older combined reports including all frame phone profiles", async () => {
  const g = await storedGallery();
  const plan = await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'import { capturePlan, sceneFiles } from "./packages/gui/gallery/capture-plan.ts"; const desktop = (await sceneFiles("./packages/gui/gallery/scenes")).filter(name => !name.startsWith("phone-")); const phone = [...Array.from({ length: 6 }, (_, i) => `phone-capacity-existing-${i}`), "phone-frame-conversation", "phone-frame-drawer"]; console.log(JSON.stringify(capturePlan([...desktop, ...phone]).shards.filter(shard => shard.id === "desktop-001" || shard.id.startsWith("phone-")).flatMap(shard => shard.captures.map(c => c.name))));'], { cwd: root });
  const names = JSON.parse(plan.stdout) as string[];
  // This older combined format holds one bounded report per family (the registered desktop captures now fill more than one, #1937),
  // and must keep working beyond one 400-capture report's limit across both families.
  expect(names.filter(name => !name.startsWith("phone-frame-")).length).toBeGreaterThan(400);
  expect(names.filter(name => name.startsWith("phone-frame-"))).toHaveLength(16);
  await g.capture(230, names.length, names);
  await run("python3", ["-c", `import json,sys,zipfile
path=sys.argv[1]
with zipfile.ZipFile(path) as z: entries={n:z.read(n) for n in z.namelist()}
report=json.loads(entries['report.json'])
scenes=report.pop('scenes')
report['pixelBlocking']=True
report['captureBudget']['limit']=800
report['captureBudget']['remaining']=800-len(scenes)
report['shards']=[{'name':shard,'scenes':[s for s in scenes if s['name'].startswith('phone-') == (shard=='phone')]} for shard in ('desktop','phone')]
entries['report.json']=json.dumps(report).encode()
with zipfile.ZipFile(path,'w') as z:
    for name,data in entries.items(): z.writestr(name,data)
`, g.env.FAKE_GALLERY_ZIP]);
  const result = await relay(g.f, g.env);
  expect(result.code, result.stderr).toBe(0);
  const manifest = JSON.parse(/<!-- window-gallery (.*?) -->/.exec(g.comments[0]!.body)![1]!) as { captures: { name: string }[] };
  expect(manifest.captures.map(c => c.name)).toEqual(names.map(name => `${name}.png`));
  await run("bash", [join(root, "scripts/gallery-accept.sh"), "42"], { cwd: g.f.checkout, env: { ...g.f.env, ...g.env } });
  const baselines = join(g.f.checkout, "packages/gui/gallery/baselines");
  expect(readdirSync(baselines).sort()).toEqual(names.map(name => `${name}.png`).sort());
  for (const name of names) expect(readFileSync(join(baselines, `${name}.png`))).toEqual(g.captures.get(`/api/packages/example/generic/window-gallery/${g.sha}-1/${name}.png`));
});


it.each(["overflow", "wrong-shard", "missing-shard", "duplicate-shard", "duplicate-capture", "missing-triplet", "advisory"])("refuses a sharded %s report before any publication", async (kind) => {
  const g = await storedGallery();
  await g.capture(230);
  await run("python3", ["-c", `import json,sys,zipfile
path,kind=sys.argv[1:]
with zipfile.ZipFile(path) as z: entries={n:z.read(n) for n in z.namelist()}
report=json.loads(entries['report.json'])
scenes=report.pop('scenes')
report['pixelBlocking']=kind!='advisory'
report['shards']=[{'name':'desktop','scenes':scenes},{'name':'phone','scenes':[]}]
if kind=='overflow': report['shards'][0]['scenes']=scenes*401
if kind=='wrong-shard': report['shards'][0]['name']='phone'; report['shards'][1]['name']='desktop'
if kind=='missing-shard': report['shards'].pop()
if kind=='duplicate-shard': report['shards'][1]['name']='desktop'
if kind=='duplicate-capture': report['shards'][0]['scenes']+=scenes
if kind=='missing-triplet': scenes[0]['status']='changed'
entries['report.json']=json.dumps(report).encode()
with zipfile.ZipFile(path,'w') as z:
    for name,data in entries.items(): z.writestr(name,data)
`, g.env.FAKE_GALLERY_ZIP, kind]);
  const result = await relay(g.f, g.env);
  expect(result.code).not.toBe(0);
  expect(g.comments).toEqual([]);
  expect(g.captures.size).toBe(0);
});

it.each([
  ["single", ".png"], ["single", ".baseline.png"], ["single", ".difference.png"],
  ["sharded", ".png"], ["sharded", ".baseline.png"], ["sharded", ".difference.png"],
  ["matrix", ".png"], ["matrix", ".baseline.png"], ["matrix", ".difference.png"],
])("refuses an unreported %s report image ending in %s before any publication", async (format, suffix) => {
  const g = await storedGallery();
  await g.capture(230);
  await run("python3", ["-c", `import json,sys,zipfile
path,format,suffix=sys.argv[1:]
with zipfile.ZipFile(path) as z: entries={n:z.read(n) for n in z.namelist()}
report=json.loads(entries['report.json'])
scenes=report['scenes']
if format=='sharded':
    report['pixelBlocking']=True
    report['shards']=[{'name':'desktop','scenes':scenes},{'name':'phone','scenes':[]}]
if format=='matrix':
    report['pixelBlocking']=True
    report['shard']={'id':'desktop-001','index':0,'count':1}
entries['unreported.dark'+suffix]=entries[scenes[0]['name']+'.png']
entries['report.json']=json.dumps(report).encode()
with zipfile.ZipFile(path,'w') as z:
    for name,data in entries.items(): z.writestr(name,data)
`, g.env.FAKE_GALLERY_ZIP, format, suffix]);
  const env = format === "matrix" ? { ...g.env,
    FAKE_ARTIFACTS: JSON.stringify([{ id: 100, name: "window-gallery-desktop-001", size_in_bytes: 100, expired: false }]),
  } : g.env;
  const result = await relay(g.f, env);
  if (format === "matrix") expect(readFileSync(g.f.log, "utf8")).toContain("/actions/artifacts/100/zip");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("unreported gallery image");
  expect(g.comments).toEqual([]);
  expect(g.attachments).toEqual([]);
  expect(g.captures.size).toBe(0);
});

it("publishes complete changed triplets at both shard limits", async () => {
  const g = await storedGallery();
  const names = [...Array.from({ length: 400 }, (_, i) => `scene-${i}.dark`), ...Array.from({ length: 400 }, (_, i) => `phone-scene-${i}-phone-390.dark`)];
  await g.capture(230, names.length, names);
  await run("python3", ["-c", `import json,sys,zipfile
path=sys.argv[1]
with zipfile.ZipFile(path) as z: entries={n:z.read(n) for n in z.namelist()}
report=json.loads(entries['report.json'])
scenes=report.pop('scenes')
for scene in scenes:
    scene['status']='changed'
    for suffix in ('baseline','difference'): entries[scene['name']+'.'+suffix+'.png']=entries[scene['name']+'.png']
report['pixelBlocking']=True
report['captureBudget']['limit']=800
report['captureBudget']['remaining']=800-len(scenes)
report['shards']=[{'name':shard,'scenes':[s for s in scenes if s['name'].startswith('phone-') == (shard=='phone')]} for shard in ('desktop','phone')]
entries['report.json']=json.dumps(report).encode()
with zipfile.ZipFile(path,'w') as z:
    for name,data in entries.items(): z.writestr(name,data)
`, g.env.FAKE_GALLERY_ZIP]);
  const result = await relay(g.f, g.env);
  expect(result.code, result.stderr).toBe(0);
  expect(g.captures.size).toBe(800);
  expect(g.attachments).toHaveLength(2400);
  expect(g.comments[0]!.body).toContain("Report shards: desktop 400/400, phone 400/400.");
});


it("the hosted gallery supports earlier checkouts without the allocation files and keeps their bounds", async () => {
  const f = await apiFixture();
  const images = join(f.checkout, "packages/gui/gallery-images");
  mkdirSync(images, { recursive: true });
  const hosted = readFileSync(join(root, ".forgejo/github-workflows/gallery.yml"), "utf8");
  const guard = /python3 - <<'PY'\n([\s\S]*?)\n {10}PY/.exec(hosted)?.[1]?.replace(/^ {10}/gm, "");
  const pngGuard = /if \[ -f scripts\/gallery_allocation.py[\s\S]*?test "\$\(find packages\/gui\/gallery-images[^\n]+/.exec(hosted)?.[0];
  if (!guard || !pngGuard) throw new Error("no hosted gallery guards");
  const scenes = Array.from({ length: 400 }, (_, i) => ({ name: `scene-${i}.dark` }));
  const report = { pixelBlocking: true, scenes };
  const check = () => run("python3", ["-c", guard], { cwd: f.checkout, env: { ...process.env, GALLERY_LEGACY: "true", GALLERY_SHARD: "1" } });
  writeFileSync(join(images, "report.json"), JSON.stringify(report));
  await expect(check()).resolves.toBeDefined();
  scenes.push({ name: "scene-overflow.dark" });
  writeFileSync(join(images, "report.json"), JSON.stringify(report));
  await expect(check()).rejects.toMatchObject({ stderr: expect.stringContaining("Capture budget exceeded") });
  scenes.pop();
  writeFileSync(join(images, "report.json"), JSON.stringify({ ...report, pixelBlocking: false }));
  await expect(check()).rejects.toMatchObject({ stderr: expect.stringContaining("Every capture remains gated") });
  writeFileSync(join(images, "report.json"), JSON.stringify({ ...report, shards: [] }));
  await expect(check()).rejects.toMatchObject({ stderr: expect.stringContaining("Capture budget exceeded") });
  scenes[1] = scenes[0]!;
  writeFileSync(join(images, "report.json"), JSON.stringify(report));
  await expect(check()).rejects.toMatchObject({ stderr: expect.stringContaining("Duplicate gallery capture name") });
  for (let i = 0; i < 1200; i++) writeFileSync(join(images, `scene-${i}.dark.png`), "image");
  const checkPngs = () => run("bash", ["-e", "-c", pngGuard], { cwd: f.checkout });
  await expect(checkPngs()).resolves.toBeDefined();
  writeFileSync(join(images, "scene-1200.dark.png"), "image");
  await expect(checkPngs()).rejects.toMatchObject({ code: 1 });
});

it("the hosted report guard admits both shards and rejects overflow or an advisory gate", async () => {
  const f = await apiFixture();
  const images = join(f.checkout, "packages/gui/gallery-images");
  mkdirSync(images, { recursive: true });
  mkdirSync(join(f.checkout, "scripts"));
  for (const name of ["gallery_allocation.py", "gallery-allocation.json"]) writeFileSync(join(f.checkout, "scripts", name), readFileSync(join(root, "scripts", name)));
  const hosted = readFileSync(join(root, ".forgejo/github-workflows/gallery.yml"), "utf8");
  const guard = /python3 - <<'PY'\n([\s\S]*?)\n {10}PY/.exec(hosted)?.[1]?.replace(/^ {10}/gm, "");
  expect(guard).toBeDefined();
  const desktop = Array.from({ length: 400 }, (_, i) => ({ name: `scene-${i}.dark` }));
  const phone = Array.from({ length: 400 }, (_, i) => ({ name: `phone-scene-${i}-phone-390.dark` }));
  const report = { pixelBlocking: true, shards: [{ name: "desktop", scenes: desktop }, { name: "phone", scenes: phone }] };
  const check = () => run("python3", ["-c", guard!], { cwd: f.checkout, env: { ...process.env, GALLERY_LEGACY: "true", GALLERY_SHARD: "1" } });
  writeFileSync(join(images, "report.json"), JSON.stringify(report));
  await expect(check()).resolves.toBeDefined();
  desktop.push({ name: "scene-overflow.dark" });
  writeFileSync(join(images, "report.json"), JSON.stringify(report));
  await expect(check()).rejects.toMatchObject({ stderr: expect.stringContaining("invalid gallery shards") });
  desktop.pop();
  writeFileSync(join(images, "report.json"), JSON.stringify({ ...report, pixelBlocking: false }));
  await expect(check()).rejects.toMatchObject({ stderr: expect.stringContaining("Every capture remains gated") });
});

it.each(["complete", "missing", "duplicate", "mixed-group", "missing-metadata", "wrong-family", "wrong-artifact", "advisory"])("publishes main's named reports and requires their complete run before acceptance (%s)", async mode => {
  const g = await shardedGallery();
  for (const [index, archive] of [g.first, g.second].entries()) await run("python3", ["-c", `import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z: files={n:z.read(n) for n in z.namelist()}
r=json.loads(files['report.json']); r['shard']={'id':f'desktop-{int(sys.argv[2])+1:03d}','index':int(sys.argv[2]),'count':2}; files['report.json']=json.dumps(r).encode()
with zipfile.ZipFile(sys.argv[1],'w') as z:
 for n,data in files.items(): z.writestr(n,data)`, archive, String(index)]);
  g.shardEnv.FAKE_ARTIFACTS = JSON.stringify([{ id: 99, name: "window-gallery-desktop-001", size_in_bytes: statSync(g.first).size }, { id: 100, name: "window-gallery-desktop-002", size_in_bytes: statSync(g.second).size }]);
  if (["missing-metadata", "wrong-family", "advisory"].includes(mode)) await run("python3", ["-c", `import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z: files={n:z.read(n) for n in z.namelist()}
r=json.loads(files['report.json'])
if sys.argv[2]=='missing-metadata': del r['shard']
if sys.argv[2]=='wrong-family': r['shard']['id']='phone-001'
if sys.argv[2]=='advisory': r['pixelBlocking']=False
files['report.json']=json.dumps(r).encode()
with zipfile.ZipFile(sys.argv[1],'w') as z:
 for n,data in files.items(): z.writestr(n,data)`, g.first, mode]);
  if (mode === "wrong-artifact" || mode === "wrong-family") g.shardEnv.FAKE_ARTIFACTS = g.shardEnv.FAKE_ARTIFACTS.replace("window-gallery-desktop-001", mode === "wrong-family" ? "window-gallery-phone-001" : "window-gallery-desktop-003");
  const result = await relay(g.f, g.shardEnv);
  if (["missing-metadata", "wrong-family", "wrong-artifact", "advisory"].includes(mode)) {
    expect(result.code).toBe(1); expect(g.comments).toHaveLength(0); return;
  }
  expect(result.code, result.stderr).toBe(0);
  expect(g.comments).toHaveLength(2);
  if (mode === "missing") g.comments.splice(0, 1);
  if (mode === "duplicate") g.comments.push({ ...g.comments[0]!, id: 3, body: g.comments[0]!.body.replaceAll(`${g.sha}-1`, `${g.sha}-3`) });
  if (mode === "mixed-group") g.comments[0]!.body = g.comments[0]!.body.replaceAll("run-42-1", "run-43-1");
  const acceptance = run("bash", [join(root, "scripts/gallery-accept.sh"), "42"], { cwd: g.f.checkout, env: { ...process.env, ...g.env } });
  if (mode === "complete") {
    await acceptance;
    expect(readdirSync(join(g.f.checkout, "packages/gui/gallery/baselines"))).toHaveLength(472);
  } else {
    await expect(acceptance).rejects.toThrow();
    expect(existsSync(join(g.f.checkout, "packages/gui/gallery/baselines"))).toBe(false);
  }
});


it("binds main's named hosted reports to the planned shard count and family", async () => {
  const f = await fixture();
  const images = join(f.checkout, "packages/gui/gallery-images"); mkdirSync(images, { recursive: true });
  const hosted = readFileSync(join(root, ".forgejo/github-workflows/gallery.yml"), "utf8");
  const guard = /python3 - <<'PY'\n([\s\S]*?)\n {10}PY/.exec(hosted)?.[1];
  if (guard === undefined) throw new Error("no hosted report guard");
  const code = guard.split("\n").map(line => line.slice(10)).join("\n");
  const report = { pixelBlocking: true, scenes: [{ name: "phone-sample-phone-390.dark" }], shard: { id: "phone-001", index: 1, count: 2 } };
  const check = () => run("python3", ["-c", code], { cwd: f.checkout, env: { ...process.env, GALLERY_SHARD: "phone-001", GALLERY_SHARD_COUNT: "2" } });
  const write = () => writeFileSync(join(images, "report.json"), JSON.stringify(report));
  write(); await expect(check()).resolves.toBeDefined();
  report.shard.count = 3; write(); await expect(check()).rejects.toThrow();
  report.shard.count = 2; report.scenes[0]!.name = "window-empty.dark";
  write(); await expect(check()).rejects.toThrow();
});

it.each([
  { format: "legacy", suffix: "png" }, { format: "legacy", suffix: "baseline.png" }, { format: "legacy", suffix: "difference.png" },
  { format: "sharded", suffix: "png" }, { format: "sharded", suffix: "baseline.png" }, { format: "sharded", suffix: "difference.png" },
])("rejects unreported $suffix entries in a $format report before publication", async ({ format, suffix }) => {
  const g = await storedGallery();
  await g.capture(255);
  await run("python3", ["-c", `import json,sys,zipfile
path=sys.argv[1]; form=sys.argv[2]; suffix=sys.argv[3]
with zipfile.ZipFile(path) as z: entries={n:z.read(n) for n in z.namelist()}
report=json.loads(entries['report.json'])
if form=='sharded':
    report['pixelBlocking']=True
    report['shards']=[{'name':'desktop','scenes':report.pop('scenes')},{'name':'phone','scenes':[]}]
entries['report.json']=json.dumps(report).encode()
image=entries['window-empty.dark.png']
for index in range(400): entries[f'unlisted-{index}.dark.{suffix}']=image
with zipfile.ZipFile(path,'w') as z:
    for name,data in entries.items(): z.writestr(name,data)
`, g.env.FAKE_GALLERY_ZIP, format, suffix]);
  const result = await relay(g.f, g.env);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("unreported gallery image");
  expect(g.comments).toEqual([]);
  expect(g.attachments).toEqual([]);
  expect(g.captures.size).toBe(0);
});


/** Queued cleanup with a complete named or numbered capture plan. */
async function queuedGallery(format: "named" | "numbered" | "numbered-single" = "named") {
  const g = await storedGallery();
  const numbered = format !== "named";
  const shards = numbered ? format === "numbered-single" ? ["1"] : ["1", "2"] : ["desktop-001", "desktop-002", "phone-001", "phone-002"];
  const artifactName = (id: string) => format === "numbered-single" ? "window-gallery" : `window-gallery-${numbered ? "shard-" : ""}${id}`;
  const artifacts = [];
  const archives: Record<string, string> = {};
  for (const [index, id] of shards.entries()) {
    const name = id.startsWith("phone-") ? `phone-scene-${index}-phone-390.dark` : `scene-${index}.dark`;
    const count = format === "numbered" && index === 0 ? 400 : 1;
    const names = count === 1 ? [name] : Array.from({ length: count }, (_, capture) => `scene-${index}-${capture}.dark`);
    await g.capture(230, count, names, undefined, numbered ? { run: "numbered-run", index: index + 1, count: shards.length, total: format === "numbered" ? 401 : 1 } : { id, index, count: shards.length });
    const archive = join(g.f.checkout, `${id}.zip`);
    // A successful job's report has no geometry or comparison failure.
    await run("python3", ["-c", `import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z: files={n:z.read(n) for n in z.namelist()}
r=json.loads(files['report.json'])
for scene in r['scenes']: scene['pixelFailed']=False
files['report.json']=json.dumps(r).encode()
with zipfile.ZipFile(sys.argv[2],'w') as z:
    for n,data in files.items(): z.writestr(n,data)`, g.env.FAKE_GALLERY_ZIP, archive]);
    artifacts.push({ id: 100 + index, name: artifactName(id), size_in_bytes: statSync(archive).size });
    archives[String(100 + index)] = archive;
  }
  const plan = join(g.f.checkout, "plan.zip");
  const matrix = { include: shards.map(shard => numbered ? { shard: Number(shard), artifact: artifactName(shard) } : { shard, count: shards.length, artifact: artifactName(shard) }) };
  await run("python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('matrix.json',sys.argv[2]); z.close()", plan, JSON.stringify(matrix)]);
  artifacts.push({ id: 90, name: "gallery-plan", size_in_bytes: statSync(plan).size });
  archives["90"] = plan;
  const jobs: { id: number; name: string; status: string; conclusion: string | null; steps: never[] }[] = [{ id: 1, name: "plan", status: "completed", conclusion: "success", steps: [] },
    ...shards.map((shard, index) => ({ id: index + 2, name: `gallery (${shard})`, status: "completed", conclusion: "success", steps: [] })),
    { id: 6, name: "cleanup", status: "queued", conclusion: null, steps: [] }];
  const env = { ...g.env, FAKE_QUEUED_CLEANUP: "true", FAKE_API_CONCLUSION: "failure",
    FAKE_ARTIFACTS: JSON.stringify(artifacts), FAKE_GALLERY_ZIPS: JSON.stringify(archives), FAKE_JOBS: JSON.stringify({ total_count: jobs.length, jobs }) };
  return { ...g, shards, jobs, artifacts, archives, plan, env };
}

it.each(["named", "numbered", "numbered-single"] as const)("publishes every %s planned capture and passes while hosted cleanup stays queued", async (format) => {
  const g = await queuedGallery(format);
  const result = await relay(g.f, g.env);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  expect(g.comments).toHaveLength(g.shards.length);
  expect(g.comments.every(({ body }) => body.includes("<!-- window-gallery "))).toBe(true);
  expect(g.captures.size).toBe(format === "numbered" ? 401 : g.shards.length);
  expect(apiCalls(g.f).filter(({ stage }) => stage === "status")).toHaveLength(1);
});

it.each(["missing", "queued", "failed", "skipped"])("fails when a planned capture is %s despite other successful jobs and artifacts", async (mode) => {
  const g = await queuedGallery();
  if (mode === "missing") g.jobs.splice(4, 1);
  else {
    g.jobs[4]!.status = mode === "queued" ? "queued" : "completed";
    g.jobs[4]!.conclusion = mode === "queued" ? null : mode === "failed" ? "failure" : "skipped";
  }
  const result = await relay(g.f, { ...g.env, FAKE_JOBS: JSON.stringify({ jobs: g.jobs }) });
  expect(result.code, result.stdout).toBe(1);
  if (mode === "missing" || mode === "queued") {
    expect(result.stdout).toContain("missing or unfinished planned captures");
    expect(g.comments).toHaveLength(0);
  } else {
    expect(g.comments).toHaveLength(4);
    expect(apiCalls(g.f).filter(({ stage }) => stage === "status")).toHaveLength(1);
  }
});

it.each(["missing-artifact", "malformed-plan", "wrong-plan-count", "wrong-report-count", "pixel-failure", "geometry-failure", "upload-failure"])("does not pass queued cleanup with %s", async (mode) => {
  const g = await queuedGallery();
  if (mode === "missing-artifact") g.artifacts.splice(3, 1);
  else if (mode === "malformed-plan") writeFileSync(g.plan, "not a ZIP");
  else if (mode === "wrong-plan-count") {
    await run("python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('matrix.json',sys.argv[2]); z.close()", g.plan,
      JSON.stringify({ include: g.shards.map(shard => ({ shard, count: 1, artifact: `window-gallery-${shard}` })) })]);
  } else if (mode === "upload-failure") g.fail("package");
  else await run("python3", ["-c", `import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z: files={n:z.read(n) for n in z.namelist()}
r=json.loads(files['report.json'])
if sys.argv[2]=='wrong-report-count': r['shard']['count']=1
if sys.argv[2]=='pixel-failure': r['scenes'][0]['pixelFailed']=True
if sys.argv[2]=='geometry-failure': r['scenes'][0]['geometryFailures']=['out of bounds']
files['report.json']=json.dumps(r).encode()
with zipfile.ZipFile(sys.argv[1],'w') as z:
    for n,data in files.items(): z.writestr(n,data)`, g.archives["100"]!, mode]);
  const result = await relay(g.f, { ...g.env, FAKE_ARTIFACTS: JSON.stringify(g.artifacts) });
  expect(result.code, result.stdout).toBe(1);
  if (mode === "pixel-failure" || mode === "geometry-failure") {
    expect(g.comments).toHaveLength(4);
    expect(result.stderr).toContain("Gallery geometry or pixel comparison failed");
  } else if (mode !== "upload-failure") expect(g.comments).toHaveLength(0);
});

it.each(["closed", "merged", "stale"])("refuses publication for a %s PR while cleanup is queued", async (state) => {
  const g = await queuedGallery();
  g.changePR(state === "stale" ? "open" : state, state === "stale" ? "0123456789abcdef0123456789abcdef01234567" : g.sha);
  const result = await relay(g.f, g.env);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("the PR is closed, merged, or its head changed");
  expect(g.comments).toHaveLength(0);
  expect(g.captures.size).toBe(0);
});

it.each(["compact", "multiline"])("reads every %s jobs and artifact page before deciding that planned captures are complete", async (format) => {
  const g = await queuedGallery();
  const jobs = [...Array.from({ length: 98 }, (_, index) => ({ id: index + 20, name: `other-${index}`, status: "completed", conclusion: "success" })), ...g.jobs];
  const artifacts = [...Array.from({ length: 98 }, (_, index) => ({ id: index + 200, name: `other-${index}`, size_in_bytes: 100 })), ...g.artifacts];
  const result = await relay(g.f, { ...g.env, FAKE_PAGINATION: "true", FAKE_MULTILINE_JSON: format === "multiline" ? "true" : "", FAKE_JOBS: JSON.stringify({ jobs }), FAKE_ARTIFACTS: JSON.stringify(artifacts) });
  expect(result.code, result.stderr).toBe(0);
  expect(g.comments).toHaveLength(4);
  for (const stage of ["jobs", "artifacts"]) expect(apiCalls(g.f).some(call => call.stage === stage && call.args.some(arg => arg.includes("page=2")))).toBe(true);
});

it("bounds failed gallery job polls even when the run status transport keeps succeeding", async () => {
  const g = await queuedGallery();
  const result = await relay(g.f, { ...g.env, FAKE_API_MODE: "exhausted", FAKE_API_STAGE: "jobs" });
  expect(result.code).toBe(1);
  expect(result.stdout).toContain("3 consecutive failed or incomplete replies");
  expect(apiCalls(g.f).filter(({ stage }) => stage === "jobs")).toHaveLength(3);
  expect(g.comments).toHaveLength(0);
});

it("does not replace a cancelled hosted run with a successful gallery verdict", async () => {
  const g = await queuedGallery();
  const result = await relay(g.f, { ...g.env, FAKE_QUEUED_CLEANUP: "", FAKE_API_CONCLUSION: "cancelled" });
  expect(result.code).toBe(1);
  expect(g.comments).toHaveLength(0);
});
