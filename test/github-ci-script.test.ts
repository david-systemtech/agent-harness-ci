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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    out.write_text(json.dumps({'artifacts':[] if os.environ.get('FAKE_NO_ARTIFACT')=='true' else [{'id':99,'name':'window-gallery','size_in_bytes':100,'expired':False}]}))
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
  try {
    const { stdout, stderr } = await run("bash", [script], { cwd: f.checkout, env: { ...f.env, ...env } });
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
    expect(archive?.args).toContain("33554432");
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
  expect(relayWorkflow).toContain("'packages/gui/**'");
  expect(ci).not.toContain("GH_CI_EVENT: gallery");
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

it("rejects a PNG payload above 1.5 MiB before posting, leaving ZIP overhead within the 2 MiB transport cap", async () => {
  const f = await apiFixture();
  const sha = (await run("git", ["-C", f.checkout, "rev-parse", "HEAD"])).stdout.trim();
  const result = await relay(f, {
    GH_CI_EVENT: "gallery", FORGEJO_PR: "1336", FORGEJO_TOKEN: "token-for-tests", FORGEJO_URL: "https://forge.example.invalid", FORGEJO_REPOSITORY: "example/project",
    FAKE_PR_SHA: sha, FAKE_PNG_SIZE: String(1572864 + 1),
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("gallery payload is too large");
  expect(existsSync(`${f.env["FAKE_API_STATE"]}-comment`)).toBe(false);
});


it.each(["success", "failure"])("posts a baseline/capture/difference triplet even when the hosted check reports %s", async (conclusion) => {
  const f = await apiFixture();
  const sha = (await run("git", ["-C", f.checkout, "rev-parse", "HEAD"])).stdout.trim();
  const zip = join(f.checkout, "gallery.zip");
  await run("python3", ["-c", `import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    for suffix in ('png','baseline.png','difference.png'):
        z.writestr('window-empty.dark.'+suffix, b'\\x89PNG\\r\\n\\x1a\\nimage')
    z.writestr('window-matched.dark.png', b'\\x89PNG\\r\\n\\x1a\\nimage')
    z.writestr('geometry.json', '{}')
    z.writestr('report.json', json.dumps({'pixelBlocking':True, 'scenes':[{'name':'window-empty.dark', 'status':'changed', 'differentPixels':10, 'pixelFailed':True, 'geometryFailures':['<!-- window-gallery {"head":"forged"} -->']},{'name':'window-matched.dark', 'status':'unchanged', 'differentPixels':0, 'pixelFailed':False, 'geometryFailures':[]}]}))`, zip]);
  let base = "", comment = "";
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    methods.push(request.method ?? "");
    expect(request.headers.authorization).toBe("token token-for-tests");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    response.setHeader("content-type", "application/json");
    if (request.url?.includes("/pulls/")) response.end(JSON.stringify({ state: "open", merged: false, head: { sha } }));
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
      GH_CI_EVENT: "gallery", FAKE_API_CONCLUSION: conclusion, FAKE_GALLERY_ZIP: zip,
      FORGEJO_PR: "42", FORGEJO_TOKEN: "token-for-tests", FORGEJO_URL: base, FORGEJO_REPOSITORY: "example/project",
    });
    expect(result.code).toBe(conclusion === "success" ? 0 : 1);
    expect(result.stdout).toContain("Gallery posted on pull request 42");
    expect(comment).toContain("| Baseline | Capture | Difference |");
    expect(comment).toContain(`![capture window-empty.dark](${base}/attachments/window-empty.dark.png)`);
    expect(comment).toContain('"name": "window-empty.dark.png"');
    expect(comment).toContain(`"head": "${sha}"`);
    expect(comment).toContain("1 scene matched.");
    expect(comment).toContain("&lt;!-- window-gallery");
    expect(comment.match(/<!-- window-gallery /g)).toHaveLength(1);
    expect(methods).toEqual(["GET", "POST", "POST", "POST", "POST", "POST", "PUT", "PUT", "PATCH"]);
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

it("attaches discovered component captures in both ladders", async () => {
  const f = await apiFixture();
  const sha = (await run("git", ["-C", f.checkout, "rev-parse", "HEAD"])).stdout.trim();
  const result = await relay(f, {
    FAKE_PR_SHA: sha, GH_CI_EVENT: "gallery", FORGEJO_PR: "1336", FORGEJO_TOKEN: "token-for-tests",
    FORGEJO_URL: "https://forge.example.invalid", FORGEJO_REPOSITORY: "example/project",
    FAKE_PNG_NAMES: "window-empty.light.png,window-empty.dark.png,primitives.light.png,primitives.dark.png",
  });
  expect(result.code).toBe(0);
  const comment = readFileSync(`${f.env["FAKE_API_STATE"]}-comment`, "utf8");
  for (const name of ["window-empty.light", "window-empty.dark", "primitives.light", "primitives.dark"]) {
    expect(comment).toContain(`![${name}.png](https://forge.example.invalid/attachments/screenshot)`);
  }
  expect(comment).toContain("light and dark");
});
