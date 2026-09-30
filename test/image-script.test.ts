/**
 * The image job's script (`.forgejo/scripts/image.sh`, launcher-update spec,
 * "The release"; #357), run by `bash` against a fake `docker` on PATH and the
 * environment a Forgejo Actions job gives it: nothing here builds, pushes or
 * pulls an image, or reaches the registry. The fake `docker` logs each call,
 * keeps what `docker login` read on stdin, says the built image's platform
 * and answers a push with the digest the test names. What only the `build`
 * runner and the registry can show is the Release image section of
 * `docs/agents/service-install-checklist.md`.
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const script = join(root, ".forgejo", "scripts", "image.sh");
const run = promisify(execFile);

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const SERVER = "https://git.systemtech.dev:5526";
const REPOSITORY = "git.systemtech.dev:5526/david/agent-harness";
const SHA = "1234567890".repeat(4);
const DIGEST = `sha256:${"a".repeat(64)}`;
const TOKEN = "token-for-tests";

/** The build a job asks of the daemon, for the image named `tag`, with the labels after the source's. */
const buildOf = (tag: string, ...labels: string[]) =>
  [
    "docker build --pull --platform linux/amd64 --provenance=false --sbom=false",
    `-f ${join(root, "Dockerfile")} -t ${tag}`,
    `--label org.opencontainers.image.source=${SERVER}/david/agent-harness`,
    `--label org.opencontainers.image.revision=${SHA}`,
    ...labels.map((label) => `--label ${label}`),
    root,
  ].join(" ");
const inspectOf = (tag: string) => `docker image inspect --format {{.Os}}/{{.Architecture}} ${tag}`;

/**
 * A fake docker. FAKE_FAIL names the calls that fail (build, login, push),
 * FAKE_PLATFORM is the built image's platform (linux/amd64 unless set), and a
 * push prints docker's lines with FAKE_PUSHED_DIGEST as the registry's
 * digest, or no digest line when that is empty.
 */
const FAKE_DOCKER = `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$FAKE_LOG"
fails() { case " \${FAKE_FAIL:-} " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
case $1 in
  build) fails build && { echo "ERROR: failed to solve" >&2; exit 1; } ;;
  image) [ "$2" = inspect ] && echo "\${FAKE_PLATFORM:-linux/amd64}" ;;
  login)
    cat > "$FAKE_STATE/login-stdin"
    fails login && { echo "Error response from daemon: unauthorized" >&2; exit 1; }
    echo "Login Succeeded" ;;
  push)
    fails push && { echo "denied: requires authentication" >&2; exit 1; }
    echo "The push refers to repository [\${2%:*}]"
    echo "5f70bf18a086: Pushed"
    [ -z "\${FAKE_PUSHED_DIGEST:-}" ] || echo "\${2##*:}: digest: $FAKE_PUSHED_DIGEST size: 2419" ;;
esac
exit 0
`;

const write = (path: string, text: string, mode = 0o644) => {
  writeFileSync(path, text);
  chmodSync(path, mode);
};

interface Fixture {
  env: NodeJS.ProcessEnv;
  calls: () => string[];
  /** What the job wrote to its step's outputs file. */
  outputs: () => string;
  /** What `docker login` read on stdin, or null when it never ran. */
  loginStdin: () => string | null;
}

/** A job's environment on a fake PATH: the job's ref, and nothing of the environment the tests run in. */
const fixture = (ref: string): Fixture => {
  const dir = mkdtempSync(join(tmpdir(), "agent-harness-image-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const fakeBin = join(dir, "fake-bin");
  const state = join(dir, "state");
  for (const sub of [fakeBin, state]) mkdirSync(sub, { recursive: true });
  const log = join(dir, "calls.log");
  const outputs = join(dir, "outputs");
  write(log, "");
  write(outputs, "");
  write(join(fakeBin, "docker"), FAKE_DOCKER, 0o755);
  return {
    env: {
      PATH: `${fakeBin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      HOME: dir,
      GITHUB_SERVER_URL: SERVER,
      GITHUB_REPOSITORY: "david/agent-harness",
      GITHUB_REPOSITORY_OWNER: "david",
      GITHUB_SHA: SHA,
      GITHUB_REF: ref,
      GITHUB_OUTPUT: outputs,
      FAKE_LOG: log,
      FAKE_STATE: state,
      FAKE_PUSHED_DIGEST: DIGEST,
    },
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    outputs: () => readFileSync(outputs, "utf8"),
    loginStdin: () => (existsSync(join(state, "login-stdin")) ? readFileSync(join(state, "login-stdin"), "utf8") : null),
  };
};

const image = async (f: Fixture, mode: string, env: NodeJS.ProcessEnv = {}) => {
  try {
    const { stdout, stderr } = await run("bash", [script, mode], { env: { ...f.env, ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
};

describe("a pull request's build", () => {
  it("builds the Dockerfile for linux/amd64 under a name no registry holds, checks its platform, and throws it away without logging in or pushing", async () => {
    const f = fixture("refs/pull/12/head");
    const local = `david/agent-harness:${SHA.slice(0, 12)}`;
    expect((await image(f, "build")).code).toBe(0);
    expect(f.calls()).toEqual([buildOf(local), inspectOf(local), `docker image rm ${local}`]);
    expect(f.outputs()).toBe("");
    expect(f.loginStdin()).toBeNull();
  });
});

describe("a v tag's release image", () => {
  const released = `${REPOSITORY}:0.5.0`;

  it("builds the version's image, logs in with the packages token on stdin, pushes it by its exact version and hands on its reference and digest", async () => {
    const f = fixture("refs/tags/v0.5.0");
    expect((await image(f, "publish", { PACKAGES_TOKEN: TOKEN })).code).toBe(0);
    expect(f.calls()).toEqual([
      buildOf(released, "org.opencontainers.image.version=0.5.0"),
      inspectOf(released),
      "docker login git.systemtech.dev:5526 -u david --password-stdin",
      `docker push ${released}`,
      "docker logout git.systemtech.dev:5526",
      `docker image rm ${released}`,
    ]);
    expect(f.loginStdin()).toBe(`${TOKEN}\n`);
    expect(f.calls().join("\n")).not.toContain(TOKEN);
    expect(f.outputs()).toBe(`reference=${released}\ndigest=${DIGEST}\n`);
  });

  it("tags a prerelease with its whole version, prerelease part and all", async () => {
    const f = fixture("refs/tags/v1.0.0-beta.2");
    expect((await image(f, "publish", { PACKAGES_TOKEN: TOKEN })).code).toBe(0);
    expect(f.calls().filter((call) => call.startsWith("docker push"))).toEqual([`docker push ${REPOSITORY}:1.0.0-beta.2`]);
    expect(f.outputs()).toBe(`reference=${REPOSITORY}:1.0.0-beta.2\ndigest=${DIGEST}\n`);
  });

  it("refuses, before it builds anything, a ref that is not a tag of v and a release version", async () => {
    for (const ref of [
      "refs/tags/v0.5",
      "refs/tags/v01.0.0",
      "refs/tags/V1.0.0",
      "refs/tags/vv1.0.0",
      "refs/tags/v1.0.0-01",
      "refs/tags/v1.0.0-",
      "refs/tags/0.5.0",
      "refs/tags/release-1.0.0",
      "refs/heads/main",
      "refs/pull/12/head",
    ]) {
      const f = fixture(ref);
      const result = await image(f, "publish", { PACKAGES_TOKEN: TOKEN });
      expect(result.code, ref).toBe(1);
      expect(result.stderr, ref).toContain("is not a v tag of a release version");
      expect(f.calls(), ref).toEqual([]);
      expect(f.outputs(), ref).toBe("");
    }
  });

  it("refuses a version with build metadata, which no Docker tag can hold", async () => {
    const f = fixture("refs/tags/v1.0.0-beta.2+build.7");
    const result = await image(f, "publish", { PACKAGES_TOKEN: TOKEN });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("build metadata");
    expect(f.calls()).toEqual([]);
  });

  it("pushes nothing, and hands nothing on, when the image did not build for linux/amd64", async () => {
    const f = fixture("refs/tags/v0.5.0");
    const result = await image(f, "publish", { PACKAGES_TOKEN: TOKEN, FAKE_PLATFORM: "linux/arm64" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("linux/arm64, not linux/amd64");
    expect(f.calls()).toEqual([buildOf(released, "org.opencontainers.image.version=0.5.0"), inspectOf(released), `docker image rm ${released}`]);
    expect(f.outputs()).toBe("");
  });

  it("hands nothing on when the login or the push fails, and still logs out and throws the image away", async () => {
    for (const failing of ["login", "push"]) {
      const f = fixture("refs/tags/v0.5.0");
      expect((await image(f, "publish", { PACKAGES_TOKEN: TOKEN, FAKE_FAIL: failing })).code, failing).not.toBe(0);
      expect(f.calls().slice(-2), failing).toEqual(["docker logout git.systemtech.dev:5526", `docker image rm ${released}`]);
      expect(f.calls().filter((call) => call.startsWith("docker push")), failing).toEqual(failing === "login" ? [] : [`docker push ${released}`]);
      expect(f.outputs(), failing).toBe("");
    }
  });

  it("fails, handing nothing on, when the push names no digest", async () => {
    const f = fixture("refs/tags/v0.5.0");
    const result = await image(f, "publish", { PACKAGES_TOKEN: TOKEN, FAKE_PUSHED_DIGEST: "" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no digest");
    expect(f.outputs()).toBe("");
  });

  it("refuses, before it builds anything, to publish without the packages token", async () => {
    const f = fixture("refs/tags/v0.5.0");
    const result = await image(f, "publish", { PACKAGES_TOKEN: "" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("PACKAGES_TOKEN");
    expect(f.calls()).toEqual([]);
  });
});

/** A workflow's lines, comments and blank lines dropped. */
const workflow = (name: string): string[] =>
  readFileSync(join(root, ".forgejo", "workflows", name), "utf8")
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, "").replace(/^\s*#.*$/, ""))
    .filter((line) => line.trim() !== "");

/** A workflow's `on:` block: the events that start it. */
const triggers = (lines: string[]): string[] => {
  const start = lines.indexOf("on:");
  const end = lines.findIndex((line, i) => i > start && /^\S/.test(line));
  return lines.slice(start + 1, end);
};

describe("the workflows that run it", () => {
  it("publishes from the release workflow on a v tag's push alone, on the build runner, handing on the pushed reference and digest", () => {
    const lines = workflow("release.yml");
    expect(triggers(lines)).toEqual(["  push:", '    tags: ["v*"]']);
    expect(lines).toContain("  image:");
    expect(lines).toContain("    runs-on: build");
    expect(lines).toContain("      reference: ${{ steps.publish.outputs.reference }}");
    expect(lines).toContain("      digest: ${{ steps.publish.outputs.digest }}");
    expect(lines).toContain("        id: publish");
    expect(lines).toContain("          PACKAGES_TOKEN: ${{ secrets.PACKAGES_TOKEN }}");
    expect(lines).toContain("        run: bash .forgejo/scripts/image.sh publish");
  });

  it("builds a pull request's image on the build runner with no secret, and nothing on a push to main", () => {
    const lines = workflow("image.yml");
    expect(triggers(lines)).toEqual(["  pull_request:", "    types: [opened, synchronize, reopened]"]);
    expect(lines).toContain("    runs-on: build");
    expect(lines).toContain("        run: bash .forgejo/scripts/image.sh build");
    expect(lines.join("\n")).not.toMatch(/secrets\.|image\.sh publish/);
  });

  it("leave every docker call to the script, so no workflow pushes a tag of its own", () => {
    const names = readdirSync(join(root, ".forgejo", "workflows"));
    expect(names).toEqual(expect.arrayContaining(["image.yml", "release.yml"]));
    for (const name of names) {
      for (const line of workflow(name)) expect(line, `${name}: ${line}`).not.toMatch(/\bdocker\b/);
      if (name !== "release.yml") expect(workflow(name).join("\n"), name).not.toContain("image.sh publish");
    }
  });
});
