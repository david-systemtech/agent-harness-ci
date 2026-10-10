import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SCOPES, STAGING_DIRECTORY, registry, type ParamsOf } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { unpackedServerArtefact } from "../../test/artefacts.js";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { testLauncher } from "../../test/launcher.js";
import { sha256Of, startFakeReleaseSource, type FakeDesktopBuild, type FakeRelease, type FakeReleaseSource } from "../../test/release-source.js";
import { refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * The desktop's build staged by its local environment (launcher-update spec,
 * "The desktop moves with its local environment"; #354) through the primary
 * seam: the in-process environment, its release source the fake one on the
 * fake forge, reached through the forge account for its origin, driven over
 * the wire by a local client session as the desktop's is; and the server
 * artefact the desktop carries, handed to that environment by its path.
 */

// The file system's removal, passed through unless a test makes it fail, as a folder in use would.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const { onCleanup, tempDir } = useCleanups();

/** The version the tests' environments run as. */
const RUNNING = "0.4.1";

/** Bytes standing in for a desktop build of `version` in `format`. */
const buildBytes = (version: string, format: string): Uint8Array => new TextEncoder().encode(`the ${format} desktop build of ${version}\n`);

/** The Arch package and the Windows setup of `version`, as a release publishes its desktop builds. */
const desktopBuilds = (version: string): FakeDesktopBuild[] => [
  { name: `agent-harness-${version}.pacman`, platform: "linux-x64", format: "pacman", bytes: buildBytes(version, "pacman") },
  { name: "agent-harness-setup.exe", platform: "win32-x64", format: "nsis", bytes: buildBytes(version, "nsis") },
];

/** A release of `version` publishing its desktop builds. */
const release = (version: string, fields: Omit<FakeRelease, "version"> = {}): FakeRelease => ({ version, desktop: desktopBuilds(version), ...fields });

/** An environment running RUNNING on a fake release source it has the forge account for, with a local client session. */
const withReleases = async (options: TestEnvironmentOptions = {}) => {
  const fake = await startFakeReleaseSource();
  onCleanup(() => fake.forge.close());
  const t = await startTestEnvironment({ harnessVersion: RUNNING, releaseSource: fake.source, forgeFetch: fake.forge.fetch, ...options });
  onCleanup(() => t.close());
  const client = await t.client();
  await fake.grantAccess(client);
  return { fake, t, client };
};

const stage = (client: WireClient, params: ParamsOf<"updates.desktop.stage">) => client.request("updates.desktop.stage", params);

/** Sets update settings through the one method that writes them. */
const setUpdates = (client: WireClient, values: ParamsOf<"updates.settings.set">["values"]) => client.request("updates.settings.set", { commandId: randomUUID(), values });

/** The paths of the desktop builds the release source served. */
const buildReads = (fake: FakeReleaseSource) => fake.reads().filter((request) => /\.(pacman|exe)$/.test(request.path));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("updates.desktop.stage", () => {
  it.each(["done", "refused"] as const)("finishes an anonymous download (%s) after the environment closes without reading the closed log or reporting a handler failure, and stages again after restart", async (outcome) => {
    const fake = await startFakeReleaseSource("github");
    onCleanup(() => fake.forge.close());
    fake.publish(release("0.5.0"));
    const held = deferred();
    const released = deferred();
    const finished = deferred();
    const dataDir = tempDir();
    const t = await startTestEnvironment({
      dataDir,
      harnessVersion: RUNNING,
      releaseSource: fake.source,
      forgeFetch: async (url, init) => {
        const response = await fake.forge.fetch(url, init);
        if (url.includes("/assets/") && await response.clone().text() === new TextDecoder().decode(buildBytes("0.5.0", "pacman"))) {
          held.resolve();
          await released.promise;
          if (outcome === "refused") return new Response("Forbidden", { status: 403 });
        }
        return response;
      },
    });
    onCleanup(() => t.close());
    const served = t.env.methods.get("updates.desktop.stage");
    if (served?.kind !== "query" || served.handler === undefined) throw new Error("Desktop staging has no handler.");
    const { handler } = served;
    t.env.methods.register(registry["updates.desktop.stage"], async (params, context) => {
      try {
        return registry["updates.desktop.stage"].result.parse(await handler(params, context));
      } finally {
        finished.resolve();
      }
    });
    onCleanup(async () => {
      released.resolve();
      await finished.promise;
    });
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => said.mockRestore());
    const asked = stage(await t.client(), { platform: "linux-x64", format: "pacman" }).catch(() => undefined);
    await held.promise;

    await t.env.close();
    const read = vi.spyOn(t.env.log, "read");
    onCleanup(() => read.mockRestore());
    released.resolve();
    await finished.promise;
    // Let dispatch report the completed handler before checking its diagnostics.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await asked;

    expect(said).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();

    const restarted = await startTestEnvironment({ dataDir, harnessVersion: RUNNING, releaseSource: fake.source, forgeFetch: fake.forge.fetch });
    onCleanup(() => restarted.close());
    const staged = await stage(await restarted.client(), { platform: "linux-x64", format: "pacman" });
    expect(staged).toEqual({ path: join(dataDir, "desktop-builds", "0.5.0", "agent-harness-0.5.0.pacman"), version: "0.5.0", sha256: sha256Of(buildBytes("0.5.0", "pacman")) });
    expect(new Uint8Array(readFileSync(staged.path))).toEqual(buildBytes("0.5.0", "pacman"));
  });

  it("from a local client session, downloads the channel's newest build for the platform and format named into the data directory, verified, and answers its path, version and SHA-256", async () => {
    const { fake, t, client } = await withReleases();
    fake.publish(release("0.5.0"));

    const staged = await stage(client, { platform: "linux-x64", format: "pacman" });

    const bytes = buildBytes("0.5.0", "pacman");
    expect(staged).toEqual({ path: join(t.dataDir, "desktop-builds", "0.5.0", "agent-harness-0.5.0.pacman"), version: "0.5.0", sha256: sha256Of(bytes) });
    expect(new Uint8Array(readFileSync(staged.path))).toEqual(bytes);
    expect(buildReads(fake)).toEqual([{ method: "GET", path: "/david/agent-harness/releases/download/v0.5.0/agent-harness-0.5.0.pacman", scheme: "token" }]);
  });

  it("answers a build already staged without a second download, and downloads again one that no longer matches its manifest", async () => {
    const { fake, client } = await withReleases();
    fake.publish(release("0.5.0"));
    const first = await stage(client, { platform: "win32-x64", format: "nsis" });

    expect(await stage(client, { platform: "win32-x64", format: "nsis" })).toEqual(first);
    expect(buildReads(fake)).toHaveLength(1);

    writeFileSync(first.path, "damaged\n");
    expect(await stage(client, { platform: "win32-x64", format: "nsis" })).toEqual(first);
    expect(new Uint8Array(readFileSync(first.path))).toEqual(buildBytes("0.5.0", "nsis"));
    expect(buildReads(fake)).toHaveLength(2);
  });

  it("is forbidden to any but a local client session, which reads nothing of the release", async () => {
    const { fake, t } = await withReleases();
    fake.publish(release("0.5.0"));
    const reads = fake.reads().length;
    const paired = await t.client({ token: (await t.pair({ scopes: SCOPES })).token });

    expect(await refusal(stage(paired, { platform: "linux-x64", format: "pacman" }))).toMatchObject({ code: "forbidden", data: { scope: "admin", reason: "local" } });
    expect(fake.reads()).toHaveLength(reads);
  });

  it("is not_found when the release has no build for the platform and format, or no release is published, and downloads nothing", async () => {
    const { fake, t, client } = await withReleases();
    expect(await refusal(stage(client, { platform: "linux-x64", format: "pacman" }))).toMatchObject({ code: "not_found" });

    fake.publish(release("0.5.0"));
    expect(await refusal(stage(client, { platform: "darwin-arm64", format: "zip" }))).toMatchObject({ code: "not_found" });
    expect(await refusal(stage(client, { platform: "linux-x64", format: "deb" }))).toMatchObject({ code: "not_found" });
    expect(buildReads(fake)).toEqual([]);
    expect(existsSync(join(t.dataDir, "desktop-builds", "0.5.0"))).toBe(false);
  });

  it("takes the pinned version's build when a version is pinned, and on the stable channel passes over a prerelease", async () => {
    const { fake, client } = await withReleases();
    fake.publish(release("0.5.0"), release("0.6.0"), release("0.7.0-beta.1"));
    expect((await stage(client, { platform: "linux-x64", format: "pacman" })).version).toBe("0.6.0");

    await setUpdates(client, { "updates.pinnedVersion": "0.5.0" });
    expect((await stage(client, { platform: "linux-x64", format: "pacman" })).version).toBe("0.5.0");

    await setUpdates(client, { "updates.pinnedVersion": null, "updates.channel": "beta" });
    expect((await stage(client, { platform: "linux-x64", format: "pacman" })).version).toBe("0.7.0-beta.1");
  });

  it("on the beta channel, stages each of the three builds a published prerelease lists as the release workflow names them (#359), by the platform and format each shell reports", async () => {
    const { fake, t, client } = await withReleases();
    const builds: FakeDesktopBuild[] = [
      { name: "agent-harness-desktop-darwin-arm64.zip", platform: "darwin-arm64", format: "zip", bytes: buildBytes("0.5.0-beta.1", "zip") },
      { name: "agent-harness-desktop-win32-x64-setup.exe", platform: "win32-x64", format: "nsis", bytes: buildBytes("0.5.0-beta.1", "nsis") },
      { name: "agent-harness-desktop-linux-x64.pacman", platform: "linux-x64", format: "pacman", bytes: buildBytes("0.5.0-beta.1", "pacman") },
    ];
    fake.publish({ version: "0.5.0-beta.1", desktop: builds });
    await setUpdates(client, { "updates.channel": "beta" });

    for (const { name, platform, format, bytes } of builds) {
      expect(await stage(client, { platform, format }), name).toEqual({ path: join(t.dataDir, "desktop-builds", "0.5.0-beta.1", name), version: "0.5.0-beta.1", sha256: sha256Of(bytes) });
    }
    const downloads = fake.reads().map((request) => request.path.split("/releases/download/v0.5.0-beta.1/")[1]);
    expect(downloads.filter((name) => name !== undefined && name !== "release.json")).toEqual(builds.map((build) => build.name));
  });

  it("refuses a download that does not match the manifest, conflict artefact, and keeps nothing of it", async () => {
    const { fake, t, client } = await withReleases();
    const [pacman] = desktopBuilds("0.5.0") as [FakeDesktopBuild];
    fake.publish({ version: "0.5.0", desktop: [{ ...pacman, listed: { sha256: "c".repeat(64) } }] });

    expect(await refusal(stage(client, { platform: "linux-x64", format: "pacman" }))).toMatchObject({ code: "conflict", data: { reason: "artefact" } });
    expect(readdirSync(join(t.dataDir, "desktop-builds"))).toEqual([]);
  });

  it("refuses with the channel's reason when the release cannot be read: conflict no_release_access with no forge account for its origin", async () => {
    const fake = await startFakeReleaseSource();
    onCleanup(() => fake.forge.close());
    const t = await startTestEnvironment({ harnessVersion: RUNNING, releaseSource: fake.source, forgeFetch: fake.forge.fetch });
    onCleanup(() => t.close());
    fake.publish(release("0.5.0"));

    expect(await refusal(stage(await t.client(), { platform: "linux-x64", format: "pacman" }))).toMatchObject({ code: "conflict", data: { reason: "no_release_access" } });
  });

  it("removes the builds staged before once a newer one is staged", async () => {
    const { fake, t, client } = await withReleases();
    fake.publish(release("0.5.0"));
    await stage(client, { platform: "linux-x64", format: "pacman" });
    fake.publish(release("0.6.0"));

    const staged = await stage(client, { platform: "linux-x64", format: "pacman" });

    expect(staged.version).toBe("0.6.0");
    expect(readdirSync(join(t.dataDir, "desktop-builds"), { recursive: true })).toEqual(["0.6.0", join("0.6.0", "agent-harness-0.6.0.pacman")]);
  });

  it("leaves the desktop's own data directory as it was, its profile, client session tokens and log, through a stage and the removal of the build staged before", async () => {
    const { fake, t, client } = await withReleases();
    // The desktop's data directory is `desktop` in the environment's (#394).
    const own = join(t.dataDir, "desktop");
    const files = {
      "Local State": "{}\n",
      [join("IndexedDB", "agent-harness_app_0.indexeddb.leveldb", "CURRENT")]: "MANIFEST-000001\n",
      [join("secrets", "tokens.json")]: '{"token":"token-for-tests"}\n',
      [join("logs", "desktop.log")]: "started\n",
    };
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(own, name)), { recursive: true });
      writeFileSync(join(own, name), content);
    }
    fake.publish(release("0.5.0"));
    await stage(client, { platform: "linux-x64", format: "pacman" });
    fake.publish(release("0.6.0"));

    await stage(client, { platform: "linux-x64", format: "pacman" });

    for (const [name, content] of Object.entries(files)) expect(readFileSync(join(own, name), "utf8")).toBe(content);
    expect(readdirSync(own).sort()).toEqual(["IndexedDB", "Local State", "logs", "secrets"]);
    expect(readdirSync(join(t.dataDir, "desktop-builds"))).toEqual(["0.6.0"]);
  });

  it("answers the build staged when a folder staged before cannot be removed, saying so as a cleanup failure and never as a release that could not be read", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const { fake, t, client } = await withReleases();
    fake.publish(release("0.5.0"));
    await stage(client, { platform: "linux-x64", format: "pacman" });
    fake.publish(release("0.6.0"));
    const older = join(t.dataDir, "desktop-builds", "0.5.0");
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (path === older) throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${older}'`), { code: "EBUSY" });
      return actual.rm(path, options);
    });
    onTestFinished(() => void vi.mocked(rm).mockImplementation(actual.rm));
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => said.mockRestore());

    const staged = await stage(client, { platform: "linux-x64", format: "pacman" });

    expect(staged).toMatchObject({ version: "0.6.0", path: join(t.dataDir, "desktop-builds", "0.6.0", "agent-harness-0.6.0.pacman") });
    expect(said).toHaveBeenCalledWith(expect.stringContaining(`Cleaning up the staged desktop build ${older} failed`), expect.any(Error));
    expect(readdirSync(join(t.dataDir, "desktop-builds")).sort()).toEqual(["0.5.0", "0.6.0"]);
  });
});

describe("the server artefact the desktop carries", () => {
  it("is trusted by its path from the desktop's local client session, as the bootstrap grant is: the folder it is unpacked in copied into the staging area and preflighted through the launcher's install, with nothing downloaded (#789)", async () => {
    let stagedVersion: string | undefined;
    const { fake, t } = await withReleases({
      launcher: testLauncher({
        present: true,
        install: (request) => {
          stagedVersion = readFileSync(join(request.staged, "VERSION"), "utf8");
          return { type: "installed" };
        },
      }),
    });
    fake.publish(release("0.5.0"));
    const reads = fake.reads().length;
    const desktop = await t.client({ token: (await t.bootstrap("desktop")).token });
    // Where the desktop carries it: unpacked, in its resources (`installer.bundledServer()`'s path).
    const bundled = unpackedServerArtefact(join(tempDir("agent-harness-desktop-"), "resources", "server"), "0.5.0");

    const answer = await desktop.request("updates.apply", { commandId: randomUUID(), version: "0.5.0", artefactPath: bundled, when: "idle" });

    expect(answer.receipt).toMatchObject({ status: "accepted" });
    expect(t.launcher.received.flatMap((message) => (message.type === "install?" ? [{ version: message.version, staged: message.staged }] : []))).toEqual([
      { version: "0.5.0", staged: join(t.dataDir, STAGING_DIRECTORY, "0.5.0") },
    ]);
    expect(stagedVersion).toBe("0.5.0\n");
    // The desktop's own copy stays where it runs its service verbs from.
    expect(readFileSync(join(bundled, "VERSION"), "utf8")).toBe("0.5.0\n");
    expect(fake.reads()).toHaveLength(reads);
  });
});
