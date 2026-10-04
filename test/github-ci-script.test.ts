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
         'discovery' if '?' in url else
         'logs' if url.endswith('/logs') else
         'jobs' if url.endswith('/jobs') else 'status')
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
    out.write_text(json.dumps({'artifacts':[] if os.environ.get('FAKE_NO_ARTIFACT')=='true' else [{'id':99,'name':'window-gallery','size_in_bytes':int(os.environ.get('FAKE_ARTIFACT_SIZE','100')),'expired':False}]}))
elif stage == 'archive':
    if os.environ.get('FAKE_GALLERY_ZIP'):
        import shutil
        shutil.copyfile(os.environ['FAKE_GALLERY_ZIP'], out)
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
    out.write_text(json.dumps({'jobs':[{'id':7, 'name':'checks', 'conclusion':'failure',
                                      'steps':[{'name':'tests', 'conclusion':'failure'}]}]}))
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
    out.write_text(json.dumps({'status':'completed', 'conclusion':os.environ.get('FAKE_API_CONCLUSION', 'success')}))
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
  writeFileSync(join(f.bin, "git"), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = push ]; then echo 'git push' >> "$FAKE_LOG"; exit 0; fi
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


describe("the advisory gallery relay", () => {
  it("dispatches its own gallery run and retrieves the small screenshot artifact", async () => {
    const f = await apiFixture();
    const sha = (await run("git", ["-C", f.checkout, "rev-parse", "HEAD"])).stdout.trim();
    const result = await relay(f, { FAKE_PR_SHA: sha, GH_CI_EVENT: "gallery", FORGEJO_PR: "1336", FORGEJO_TOKEN: "token-for-tests", FORGEJO_URL: "https://forge.example.invalid", FORGEJO_REPOSITORY: "example/project" });
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

it("runs gallery independently and preserves geometry failures as blocking checks", () => {
  const hosted = readFileSync(join(root, ".forgejo", "github-workflows", "gallery.yml"), "utf8");
  const relayWorkflow = readFileSync(join(root, ".forgejo", "workflows", "gallery.yml"), "utf8");
  const ci = readFileSync(join(root, ".forgejo", "workflows", "ci.yml"), "utf8");
  expect(hosted).toContain("runs-on: ubuntu-24.04");
  expect(hosted).toContain("types: [gallery]");
  expect(relayWorkflow).not.toContain("continue-on-error: true");
  expect(relayWorkflow).toContain("PACKAGES_TOKEN: ${{ secrets.PACKAGES_TOKEN }}");
  expect(relayWorkflow).toContain("'packages/gui/**'");
  expect(ci).not.toContain("GH_CI_EVENT: gallery");
});

it("relays a PR head as data without executing its credential-stealing script", async () => {
  const f = await apiFixture();
  const git = (...args: string[]) => run("git", ["-C", f.checkout, "-c", "commit.gpgsign=false", "-c", "user.name=Tests", "-c", "user.email=tests@example.invalid", ...args]);
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  const scripts = join(f.checkout, ".forgejo", "scripts");
  mkdirSync(scripts, { recursive: true });
  const stolen = join(f.checkout, "stolen");
  writeFileSync(join(scripts, "github-ci.sh"), 'printf "%s" "$PACKAGES_TOKEN" > stolen\nexit 99\n');
  await git("add", ".forgejo");
  await git("commit", "-qm", "an untrusted change");
  const head = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("checkout", "-q", base);
  const result = await relay(f, {
    GH_CI_EVENT: "gallery", GH_CI_SHA: head, PACKAGES_TOKEN: "package-token-for-tests",
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
    expect(methods).toEqual(kind === "zip" || kind === "expanded" ? [] : ["GET"]);
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
  const comments: { id: number; body: string }[] = [];
  let base = "", failure = "";
  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    const expected = path.startsWith("/api/packages/") || path.startsWith("/api/v1/packages/") ? packagesToken : "token-for-tests";
    if (request.headers.authorization !== `token ${expected}`) { response.writeHead(401).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const data = Buffer.concat(chunks);
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path.includes("/pulls/")) response.end(JSON.stringify({ state: "open", merged: false, head: { sha, ref: "build/42-gallery" } }));
    else if (request.method === "GET" && path.includes("/comments")) response.end(JSON.stringify(comments));
    else if (request.method === "POST" && path.endsWith("/comments")) {
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
    f, sha, comments, captures, attachments, env,
    fail: (stage: string) => { failure = stage; },
    capture: async (pixel: number, count = 1, names = count === 1 ? ["window-empty.dark"] : Array.from({ length: count }, (_, index) => `scene-${index}.dark`), viewport?: { width: number; height: number }) => {
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
    z.writestr('report.json',json.dumps({'pixelBlocking':False,'captureBudget':{'desktop':sum(not n.startswith('phone-') for n in names),'phone':sum(n.startswith('phone-') for n in names),'total':len(names),'limit':400,'remaining':400-len(names)},'scenes':[{'name':name,'status':'new','pixelFailed':True,'geometryFailures':[]} for name in names]}))`, zip, String(pixel), JSON.stringify(names), JSON.stringify(viewport ?? null)]);
      return readFileSync(`${zip}.png`);
    },
  };
}

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
  ["entries", "unexpected gallery entry"],
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
  expect(body).not.toContain("token-for-tests");
});

it("publishes and accepts the required captures per registered scene through a report manifest", async () => {
  const g = await storedGallery();
  const plan = await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'import { captureCases, sceneFiles } from "./packages/gui/gallery/capture-plan.ts"; console.log(JSON.stringify(captureCases(await sceneFiles("./packages/gui/gallery/scenes"))));'], { cwd: root });
  const cases = JSON.parse(plan.stdout) as { scene: string; ladder: "light" | "dark" }[];
  const names = cases.flatMap(({ scene, ladder }) => [`${scene}.${ladder}`, `${scene}-narrow.${ladder}`]);
  expect(names.length).toBeGreaterThan(200);
  await g.capture(255, names.length, names);
  const result = await relay(g.f, g.env);
  expect(result.code, result.stderr).toBe(0);
  expect(g.comments).toHaveLength(1);
  const body = g.comments[0]!.body;
  expect(body).toContain("Geometry: passed");
  const marker = /<!-- window-gallery (.*?) -->/.exec(body)?.[1];
  expect(marker).toBeDefined();
  const manifest = JSON.parse(marker!) as { captures: { name: string }[] };
  expect(manifest.captures.map(({ name }) => name)).toEqual(names.map((name) => `${name}.png`));
  expect(g.captures.size).toBe(names.length);
  await run("bash", [join(root, "scripts/gallery-accept.sh"), "42"], { cwd: g.f.checkout, env: { ...g.f.env, ...g.env } });
  const baselines = join(g.f.checkout, "packages/gui/gallery/baselines");
  expect(readdirSync(baselines).sort()).toEqual(names.map((name) => `${name}.png`).sort());
  for (const name of names) {
    const image = readFileSync(join(baselines, `${name}.png`));
    const stored = g.captures.get(`/api/packages/example/generic/window-gallery/${g.sha}-1/${name}.png`);
    expect(image).toEqual(stored);
    expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual(name.includes("-narrow.") ? [1024, 768] : [1400, 900]);
  }
});


it("uses the owner package credential for captures while keeping comment requests on the repository token", async () => {
  const g = await storedGallery("package-token-for-tests");
  await g.capture(255);
  const result = await relay(g.f, g.env);
  expect(result.code, result.stderr).toBe(0);
  expect(g.comments[0]!.body).toContain("<!-- window-gallery ");
});


it("runs cleanup daily and after a completed gallery report", () => {
  const workflow = readFileSync(join(import.meta.dirname, "../.forgejo/workflows/gallery-retention.yml"), "utf8");
  expect(workflow).toContain("cron:");
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).toContain("ref: ${{ github.event.repository.default_branch }}");
  expect(workflow).toContain("python3 scripts/gallery-retention.py");
  expect(workflow).toContain("PACKAGES_TOKEN: ${{ secrets.PACKAGES_TOKEN }}");
  expect(readFileSync(join(import.meta.dirname, "../.forgejo/workflows/gallery.yml"), "utf8")).toContain("PACKAGES_TOKEN: ${{ secrets.PACKAGES_TOKEN }}");
  expect(readFileSync(join(import.meta.dirname, "../.forgejo/scripts/github-ci.sh"), "utf8")).toContain("scripts/gallery-retention.py");
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

it("refuses to publish a phone capture whose dimensions disagree with its profile name", async () => {
  const g = await storedGallery();
  await g.capture(230, 1, ["phone-gallery-conversation-phone-390-keyboard.dark"], { width: 390, height: 844 });
  const result = await relay(g.f, g.env);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("unexpected phone gallery dimensions");
  expect(g.comments).toHaveLength(0);
});

it("publishes and accepts bounded gallery shards without dropping desktop or phone captures", async () => {
  const g = await storedGallery();
  await g.capture(255);
  await run("python3", ["-c", `import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1], 'a') as z:
    data=z.read('window-empty.dark.png')
    z.writestr('shard-1/window-extra.dark.png',data)
    z.writestr('shard-1/geometry.json','{}')
    z.writestr('shard-1/report.json',json.dumps({'pixelBlocking':False,'scenes':[{'name':'window-extra.dark','status':'new','pixelFailed':True,'geometryFailures':[]}]}))`, g.env.FAKE_GALLERY_ZIP]);
  const result = await relay(g.f, g.env);
  expect(result.code, result.stderr).toBe(0);
  expect(g.comments).toHaveLength(2);
  await run("bash", [join(root, "scripts/gallery-accept.sh"), "42"], { cwd: g.f.checkout, env: { ...g.f.env, ...g.env } });
  expect(readdirSync(join(g.f.checkout, "packages/gui/gallery/baselines"))).toEqual(["window-empty.dark.png", "window-extra.dark.png"]);
});
