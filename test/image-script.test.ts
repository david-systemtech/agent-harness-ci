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
const buildOf = (tag: string, version: string, ...labels: string[]) =>
  [
    "docker build --pull --platform linux/amd64 --provenance=false --sbom=false",
    `-f ${join(root, "Dockerfile")} -t ${tag} --build-arg HARNESS_VERSION=${version}`,
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
  run) fails run && exit 1; echo "agent-harness $FAKE_VERSION" ;;
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
  downloadSource: () => string | null;
  downloadToken: () => string | null;
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
  write(join(fakeBin, "node"), `#!/bin/sh
printf '%s\\n' "$IMAGE_SDK_CACHE_BASE" > "$FAKE_STATE/download-source"
printf '%s\\n' "$FORGEJO_TOKEN" > "$FAKE_STATE/download-token"
exit "\${FAKE_DOWNLOAD_EXIT:-0}"
`, 0o755);
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
      FAKE_VERSION: ref.startsWith("refs/tags/v") ? ref.slice("refs/tags/v".length) : "0.0.0",
      FAKE_LOG: log,
      FAKE_STATE: state,
      FAKE_PUSHED_DIGEST: DIGEST,
    },
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    outputs: () => readFileSync(outputs, "utf8"),
    loginStdin: () => (existsSync(join(state, "login-stdin")) ? readFileSync(join(state, "login-stdin"), "utf8") : null),
    downloadSource: () => existsSync(join(state, "download-source")) ? readFileSync(join(state, "download-source"), "utf8").trim() : null,
    downloadToken: () => existsSync(join(state, "download-token")) ? readFileSync(join(state, "download-token"), "utf8").trim() : null,
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
    expect(f.calls()).toEqual([buildOf(local, "0.0.0"), inspectOf(local), `docker run --rm ${local} --version`, `docker run --rm --entrypoint node ${local} /opt/agent-harness/scripts/image-web-smoke.mjs`, `docker image rm ${local}`]);
    expect(f.outputs()).toBe("");
    expect(f.loginStdin()).toBeNull();
    expect(f.downloadSource()).toBeNull();
    expect(f.downloadToken()).toBeNull();
  });

  it("uses the job token to prepare the pinned download before Docker, without giving Docker any credential", async () => {
    const f = fixture("refs/pull/12/head");
    const result = await image(f, "build", { FORGEJO_TOKEN: TOKEN });
    expect(result.code).toBe(0);
    expect(f.downloadSource()).toBe(`${SERVER}/api/packages/${REPOSITORY.split("/")[1]}/generic`);
    expect(f.downloadToken()).toBe(TOKEN);
    expect(f.calls().join("\n") + result.stdout + result.stderr).not.toContain(TOKEN);
    expect(f.loginStdin()).toBeNull();
  });
  it("warns and still builds when cache preparation fails", async () => {
    const f = fixture("refs/pull/12/head");
    const local = `david/agent-harness:${SHA.slice(0, 12)}`;
    const result = await image(f, "build", { FORGEJO_TOKEN: TOKEN, FAKE_DOWNLOAD_EXIT: "1" });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("SDK cache preparation failed; using npm");
    expect(f.calls()).toEqual([buildOf(local, "0.0.0"), inspectOf(local), `docker run --rm ${local} --version`, `docker run --rm --entrypoint node ${local} /opt/agent-harness/scripts/image-web-smoke.mjs`, `docker image rm ${local}`]);
    expect(result.stdout + result.stderr + f.calls().join("\n")).not.toContain(TOKEN);
  });

});

describe("a v tag's release image", () => {
  const released = `${REPOSITORY}:0.5.0`;

  it("builds the version's image, logs in with the packages token on stdin, pushes it by its exact version and hands on its reference and digest", async () => {
    const f = fixture("refs/tags/v0.5.0");
    expect((await image(f, "publish", { PACKAGES_TOKEN: TOKEN })).code).toBe(0);
    expect(f.calls()).toEqual([
      buildOf(released, "0.5.0", "org.opencontainers.image.version=0.5.0"),
      inspectOf(released),
      `docker run --rm ${released} --version`,
      `docker run --rm --entrypoint node ${released} /opt/agent-harness/scripts/image-web-smoke.mjs`,
      "docker login git.systemtech.dev:5526 -u david --password-stdin",
      `docker push ${released}`,
      "docker logout git.systemtech.dev:5526",
      `docker image rm ${released}`,
    ]);
    expect(f.loginStdin()).toBe(`${TOKEN}\n`);
    expect(f.calls().join("\n")).not.toContain(TOKEN);
    expect(f.outputs()).toBe(`reference=${released}\ndigest=${DIGEST}\n`);
    expect(f.downloadToken()).toBe(TOKEN);
  });

  it("refuses to publish when the image reports the checkout version instead of the release version", async () => {
    const f = fixture("refs/tags/v0.5.0");
    const result = await image(f, "publish", { PACKAGES_TOKEN: TOKEN, FAKE_VERSION: "0.0.0" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("reports agent-harness 0.0.0, expected agent-harness 0.5.0");
    expect(f.calls().some((call) => /^docker (login|push) /.test(call))).toBe(false);
    expect(f.outputs()).toBe("");
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
    expect(f.calls()).toEqual([buildOf(released, "0.5.0", "org.opencontainers.image.version=0.5.0"), inspectOf(released), `docker image rm ${released}`]);
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
  it("retains manual Forgejo recovery on the build runner, handing on the pushed reference and digest", () => {
    const lines = workflow("release.yml");
    expect(triggers(lines)).toEqual(["  workflow_dispatch:"]);
    expect(lines).toContain("  image:");
    expect(lines).toContain("    runs-on: build");
    expect(lines).toContain("      reference: ${{ steps.publish.outputs.reference }}");
    expect(lines).toContain("      digest: ${{ steps.publish.outputs.digest }}");
    expect(lines).toContain("        id: publish");
    expect(lines).toContain("          PACKAGES_TOKEN: ${{ secrets.PACKAGES_TOKEN }}");
    expect(lines).toContain("        run: bash .forgejo/scripts/image.sh publish");
  });

  it("keeps image / image green on a skip and guards only the expensive build step", () => {
    const lines = workflow("image.yml");
    const text = lines.join("\n");
    expect(lines).toContain("name: image");
    expect(lines).toContain("  image:");
    expect(lines).toContain("          fetch-depth: 0");
    expect(lines).toContain("          ref: ${{ github.event.pull_request.head.sha }}");
    expect(lines).toContain("        run: node .forgejo/scripts/image-inputs.mjs");
    expect(lines).toContain("        if: steps.inputs.outputs.build == 'true'");
    expect(text.indexOf("id: inputs")).toBeLessThan(text.indexOf("if: steps.inputs.outputs.build"));
    expect(text).not.toMatch(/paths(-ignore)?:|if:.*outputs.*\n.*runs-on:/);
  });

  it("gives unrelated label events their own check so a skipped job cannot replace image / image", () => {
    const lines = workflow("image.yml");
    expect(lines).toContain("    name: ${{ (github.event.label && github.event.label.name != 'image') && 'other-label' || 'image' }}");
    expect(lines).toContain("    if: ${{ !github.event.label || github.event.label.name == 'image' }}");
    expect(lines).toContain("  group: image-${{ github.event.pull_request.number }}-${{ (github.event.label && github.event.label.name != 'image') && 'other-label' || 'build' }}");
  });

  it("builds a pull request's image on the build runner with no secret, and nothing on a push to main", () => {
    const lines = workflow("image.yml");
    expect(triggers(lines)).toEqual(["  pull_request:", "    types: [opened, synchronize, reopened, labeled]"]);
    expect(lines).toContain("    runs-on: build");
    expect(lines).toContain("        run: bash .forgejo/scripts/image.sh build");
    expect(lines).toContain("          FORGEJO_TOKEN: ${{ github.token }}");
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


describe("the image's web smoke", () => {
  it("checks the production health route and compares its version with the served bundle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "image-web-check-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const folder of ["scripts", "packages/environment/dist", "packages/contracts/dist"]) mkdirSync(join(dir, folder), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(dir, "scripts/image-web-smoke.mjs"), readFileSync(join(root, "scripts/image-web-smoke.mjs")));
    writeFileSync(join(dir, "packages/contracts/dist/index.js"), 'export const HEALTH_PATH = "/health";');
    writeFileSync(join(dir, "packages/environment/dist/index.js"), `
      globalThis.fetch = async url => {
        const path = new URL(url).pathname;
        if (path === "/" || path === "/pair") return new Response('<script src="/assets/app.js"></script>', { headers: { "cache-control": "no-store", "content-security-policy": "default-src 'self'" } });
        if (path === "/assets/app.js") return new Response("app");
        if (path === "/version.json" || path === "/health") return Response.json({ version: "0.0.0-test" });
        return Response.json({ error: "not_found" }, { status: 404 });
      };
      export const startEnvironment = async () => ({ address: { host: "127.0.0.1", port: 7433 }, close: async () => {} });
    `);
    const result = await run(process.execPath, [join(dir, "scripts/image-web-smoke.mjs")]);
    expect(result.stdout).toContain("Image web routes and version matched.");
  });
});
