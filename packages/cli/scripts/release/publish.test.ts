import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCHER_PROTOCOL, PROTOCOL_VERSION, type ReleaseManifest } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeForgejo, type FakeForgejo, type FakeForgejoQuirks } from "../../test/fake-forgejo-releases.js";
import { publishOptionsOf } from "./arguments.js";
import { checkUnpublished, publishRelease, type ReleaseRepository } from "./publish.js";

/**
 * The release publisher (launcher-update spec, "The release"; #358), run
 * against a fake Forgejo on the loopback address over a folder as the build
 * leaves it: observed through the requests the forge receives and the
 * release it holds after. What only the real forge shows is the first
 * prerelease tag's run, the service-install checklist's Release section.
 */

const REPOSITORY = "david/agent-harness";
const TOKEN = "token-for-tests";

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

const forgejo = async (quirks: FakeForgejoQuirks = {}): Promise<{ fake: FakeForgejo; forge: ReleaseRepository }> => {
  const fake = await startFakeForgejo(REPOSITORY, TOKEN, quirks);
  cleanups.push(() => fake.close());
  return { fake, forge: { server: fake.server, repository: REPOSITORY, token: TOKEN } };
};

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

/** An asset of a release folder: its manifest entry's name, kind, platform and format, and its content. */
interface FolderAsset {
  readonly name: string;
  readonly kind: string;
  readonly platform: string | null;
  readonly format: string | null;
  readonly content: string;
}

/** What a release folder holds besides release.json: each asset's name, kind and content. */
const ASSETS: readonly FolderAsset[] = [
  { name: "agent-harness-linux-x64.tar.gz", kind: "environment", platform: "linux-x64", format: "tar.gz", content: "the linux artefact\n" },
  { name: "install.sh", kind: "install-script", platform: null, format: null, content: "#!/bin/sh\necho install\n" },
];

/** The three desktop builds a release publishes (#359), as the build lists them. */
const DESKTOP_BUILDS: readonly FolderAsset[] = [
  { name: "agent-harness-desktop-darwin-arm64.zip", kind: "desktop", platform: "darwin-arm64", format: "zip", content: "the macOS zip\n" },
  { name: "agent-harness-desktop-win32-x64-setup.exe", kind: "desktop", platform: "win32-x64", format: "nsis", content: "the Windows setup\n" },
  { name: "agent-harness-desktop-linux-x64.pacman", kind: "desktop", platform: "linux-x64", format: "pacman", content: "the Arch package\n" },
];

/**
 * A release folder as the build leaves it for `version`: each of `assets`
 * and `release.json` listing them, with a sidecar each; `manifest` replaces
 * fields of the manifest written.
 */
const releaseFolder = (version: string, manifest: Partial<ReleaseManifest> = {}, assets: readonly FolderAsset[] = ASSETS): string => {
  const folder = mkdtempSync(join(tmpdir(), "release-publish-"));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  const write = (name: string, content: string) => {
    writeFileSync(join(folder, name), content);
    writeFileSync(join(folder, `${name}.sha256`), `${sha256(content)}  ${name}\n`);
  };
  for (const asset of assets) write(asset.name, asset.content);
  const listed: ReleaseManifest = {
    version,
    protocolVersion: PROTOCOL_VERSION,
    launcherProtocol: LAUNCHER_PROTOCOL,
    databaseSchemaVersion: 17,
    bundledClaudeCodeVersion: "2.1.283 (Claude Code)",
    assets: assets.map(({ content, ...asset }) => ({ ...asset, size: Buffer.byteLength(content), sha256: sha256(content) })),
    image: { reference: `git.example.test:5526/david/agent-harness:${version}`, digest: `sha256:${"0".repeat(64)}` },
    ...manifest,
  };
  write("release.json", `${JSON.stringify(listed, null, 2)}\n`);
  return folder;
};

/** Every file of `folder` with its size, as the forge should hold them. */
const filesOf = (folder: string) =>
  readdirSync(folder)
    .sort()
    .map((name) => ({ name, size: statSync(join(folder, name)).size }));

const quiet = { log: () => undefined };

describe("publishing a tag's release", () => {
  it("uploads every asset, its sidecar and release.json to a new draft, checks the draft holds them all, and publishes it last", async () => {
    const { fake, forge } = await forgejo();
    const folder = releaseFolder("0.5.0");
    await publishRelease({ tag: "v0.5.0", folder }, forge, quiet);
    const release = fake.release("v0.5.0");
    expect(release).toMatchObject({ name: "v0.5.0", draft: false, prerelease: false });
    expect(release?.assets.map(({ name, size }) => ({ name, size })).sort((a, b) => a.name.localeCompare(b.name))).toEqual(filesOf(folder));
    const uploads = fake.calls.filter((call) => call.startsWith("POST /releases/1/assets"));
    expect(fake.calls).toEqual([
      "GET /releases/tags/v0.5.0",
      "POST /releases",
      ...uploads,
      "GET /releases/1",
      "PATCH /releases/1",
    ]);
    expect(uploads.map((call) => new URL(call.split(" ")[1] ?? "", "http://x").searchParams.get("name"))).toEqual([
      "agent-harness-linux-x64.tar.gz",
      "agent-harness-linux-x64.tar.gz.sha256",
      "install.sh",
      "install.sh.sha256",
      "release.json",
      "release.json.sha256",
    ]);
    expect(fake.bodies).toEqual([
      { tag_name: "v0.5.0", name: "v0.5.0", body: "", draft: true, prerelease: false },
      { draft: false },
    ]);
    expect(release?.assets.find((asset) => asset.name === "install.sh")?.sha256).toBe(sha256("#!/bin/sh\necho install\n"));
  });

  it("writes notes on a release with desktop builds: they are unsigned, and how to open each the first time on macOS, Windows and Arch", async () => {
    const { fake, forge } = await forgejo();
    await publishRelease({ tag: "v0.5.0-beta.1", folder: releaseFolder("0.5.0-beta.1", {}, [...ASSETS, ...DESKTOP_BUILDS]) }, forge, quiet);
    const release = fake.release("v0.5.0-beta.1");
    expect(release?.assets.map((asset) => asset.name)).toEqual(expect.arrayContaining(DESKTOP_BUILDS.flatMap(({ name }) => [name, `${name}.sha256`])));
    const notes = String((fake.bodies[0] as { body?: unknown }).body).split("\n\n");
    expect(notes[0]).toBe("## The desktop builds are not signed");
    expect(notes[1]).toMatch(/^macOS and Windows warn the first time one downloaded by a browser is opened\. Once it is open, the desktop updates itself without a warning:/);
    const macOS = notes.find((paragraph) => paragraph.startsWith("**macOS**")) ?? "";
    expect(macOS).toContain("`agent-harness-desktop-darwin-arm64.zip`");
    expect(macOS).toContain("move `agent-harness.app` into Applications");
    expect(macOS).toContain("System Settings > Privacy & Security");
    expect(macOS).toContain("Open Anyway");
    expect(macOS).toContain("`xattr -dr com.apple.quarantine /Applications/agent-harness.app`");
    const windows = notes.find((paragraph) => paragraph.startsWith("**Windows**")) ?? "";
    expect(windows).toContain("`agent-harness-desktop-win32-x64-setup.exe`");
    expect(windows).toContain("Windows protected your PC");
    expect(windows).toContain("More info, then Run anyway");
    const arch = notes.find((paragraph) => paragraph.startsWith("**Arch Linux**")) ?? "";
    expect(arch).toContain("`sudo pacman -U agent-harness-desktop-linux-x64.pacman`");
    expect(notes.map((paragraph) => paragraph.split(" ", 2).join(" "))).toEqual(["## The", "macOS and", "**macOS** (Apple", "**Windows** (x64),", "**Arch Linux**"]);
  });

  it("flags the release a prerelease exactly when the version has a prerelease part", async () => {
    for (const [version, prerelease] of [
      ["1.0.0-beta.2", true],
      ["0.0.1-test.1", true],
      ["1.0.0", false],
    ] as const) {
      const { fake, forge } = await forgejo();
      await publishRelease({ tag: `v${version}`, folder: releaseFolder(version) }, forge, quiet);
      expect(fake.release(`v${version}`), version).toMatchObject({ draft: false, prerelease });
      expect(fake.bodies[0], version).toMatchObject({ draft: true, prerelease });
    }
  });

  it("replaces the draft an earlier run of the tag left, instead of adding a second release", async () => {
    const { fake, forge } = await forgejo();
    fake.add({ tag_name: "v0.5.0", name: "v0.5.0", draft: true, prerelease: false, assets: [{ id: 99, name: "stale.tar.gz", size: 3, sha256: sha256("old") }] });
    const folder = releaseFolder("0.5.0");
    await publishRelease({ tag: "v0.5.0", folder }, forge, quiet);
    expect(fake.calls.slice(0, 3)).toEqual(["GET /releases/tags/v0.5.0", "DELETE /releases/1", "POST /releases"]);
    const release = fake.release("v0.5.0");
    expect(release).toMatchObject({ id: 2, draft: false });
    expect(release?.assets.map((asset) => asset.name).sort()).toEqual(filesOf(folder).map((file) => file.name));
  });

  it("refuses a tag whose release is published, and changes nothing", async () => {
    const { fake, forge } = await forgejo();
    fake.add({ tag_name: "v0.5.0", name: "v0.5.0", draft: false, prerelease: false, assets: [] });
    await expect(publishRelease({ tag: "v0.5.0", folder: releaseFolder("0.5.0") }, forge, quiet)).rejects.toThrow(/v0\.5\.0 is already published/);
    expect(fake.calls).toEqual(["GET /releases/tags/v0.5.0"]);
  });

  it("leaves the draft and publishes nothing when an upload fails", async () => {
    const { fake, forge } = await forgejo({ failUpload: "install.sh" });
    await expect(publishRelease({ tag: "v0.5.0", folder: releaseFolder("0.5.0") }, forge, quiet)).rejects.toThrow(/install\.sh.*answered 500/);
    expect(fake.release("v0.5.0")).toMatchObject({ draft: true });
    expect(fake.calls.some((call) => call.startsWith("PATCH"))).toBe(false);
  });

  it("publishes no draft that lacks a file it uploaded, or holds one it did not", async () => {
    const { fake, forge } = await forgejo({ loseUpload: "release.json" });
    await expect(publishRelease({ tag: "v0.5.0", folder: releaseFolder("0.5.0") }, forge, quiet)).rejects.toThrow(/draft of v0\.5\.0 holds .* not .*release\.json/s);
    expect(fake.release("v0.5.0")).toMatchObject({ draft: true });
    expect(fake.calls.some((call) => call.startsWith("PATCH"))).toBe(false);
  });

  it("checks the folder against its release.json before it asks the forge anything", async () => {
    const { fake, forge } = await forgejo();
    const cases: [string, () => string, RegExp][] = [
      ["a manifest the schema refuses", () => releaseFolder("0.5.0", { image: { reference: "", digest: "sha256:abc" } }), /release\.json is not a release manifest/],
      ["another version", () => releaseFolder("0.4.9"), /release\.json names the version 0\.4\.9, not v0\.5\.0's 0\.5\.0/],
      [
        "a listed asset missing",
        () => {
          const folder = releaseFolder("0.5.0");
          rmSync(join(folder, "install.sh"));
          return folder;
        },
        /install\.sh, which release\.json lists, is not in/,
      ],
      [
        "a sidecar missing",
        () => {
          const folder = releaseFolder("0.5.0");
          rmSync(join(folder, "install.sh.sha256"));
          return folder;
        },
        /install\.sh\.sha256 is not in/,
      ],
      [
        "a file it does not list",
        () => {
          const folder = releaseFolder("0.5.0");
          writeFileSync(join(folder, "stray.txt"), "left over\n");
          return folder;
        },
        /stray\.txt, which release\.json does not list/,
      ],
      [
        "an asset changed after the manifest listed it",
        () => {
          const folder = releaseFolder("0.5.0");
          writeFileSync(join(folder, "install.sh"), "#!/bin/sh\necho changed\n");
          return folder;
        },
        /install\.sh is not the file release\.json lists/,
      ],
      [
        "a sidecar that does not name its asset's digest",
        () => {
          const folder = releaseFolder("0.5.0");
          writeFileSync(join(folder, "install.sh.sha256"), `${"1".repeat(64)}  install.sh\n`);
          return folder;
        },
        /install\.sh\.sha256 does not hold/,
      ],
      [
        "a manifest whose sidecar does not match it",
        () => {
          const folder = releaseFolder("0.5.0");
          writeFileSync(join(folder, "release.json.sha256"), `${"1".repeat(64)}  release.json\n`);
          return folder;
        },
        /release\.json\.sha256 does not hold/,
      ],
    ];
    for (const [what, folder, message] of cases) {
      await expect(publishRelease({ tag: "v0.5.0", folder: folder() }, forge, quiet), what).rejects.toThrow(message);
    }
    await expect(publishRelease({ tag: "0.5.0", folder: releaseFolder("0.5.0") }, forge, quiet)).rejects.toThrow(/is not v and a semantic version/);
    expect(fake.calls).toEqual([]);
  });

  it("names the forge's answer when it refuses the token, and never the token", async () => {
    const { forge } = await forgejo();
    const refused = publishRelease({ tag: "v0.5.0", folder: releaseFolder("0.5.0") }, { ...forge, token: "another-token-for-tests" }, quiet);
    await expect(refused).rejects.toThrow(/GET .*\/releases\/tags\/v0\.5\.0 answered 401/);
    await expect(refused).rejects.not.toThrow(/another-token-for-tests/);
  });
});

describe("checking a tag's release is not yet published", () => {
  it("passes when the tag has no release, or a draft a later step replaces", async () => {
    const { fake, forge } = await forgejo();
    await expect(checkUnpublished("v0.5.0", forge, quiet)).resolves.toBeUndefined();
    fake.add({ tag_name: "v0.5.0", name: "v0.5.0", draft: true, prerelease: false, assets: [] });
    await expect(checkUnpublished("v0.5.0", forge, quiet)).resolves.toBeUndefined();
    expect(fake.calls).toEqual(["GET /releases/tags/v0.5.0", "GET /releases/tags/v0.5.0"]);
  });

  it("fails when the tag's release is published, so a re-run pushes no image over it", async () => {
    const { fake, forge } = await forgejo();
    fake.add({ tag_name: "v1.0.0-beta.2", name: "v1.0.0-beta.2", draft: false, prerelease: true, assets: [] });
    await expect(checkUnpublished("v1.0.0-beta.2", forge, quiet)).rejects.toThrow(/v1\.0\.0-beta\.2 is already published/);
  });
});

describe("the publisher's command line", () => {
  const env = { GITHUB_SERVER_URL: "https://git.example.test:5526", GITHUB_REPOSITORY: REPOSITORY, RELEASE_TOKEN: TOKEN };
  const forge = { server: "https://git.example.test:5526", repository: REPOSITORY, token: TOKEN };

  it("publishes the folder --from names, read from where pnpm was run, or with --check only checks, on the job's forge and repository with RELEASE_TOKEN", () => {
    expect(publishOptionsOf(["--tag", "v0.5.0", "--from", "release-assets"], env, "/work/checkout")).toEqual({ tag: "v0.5.0", folder: "/work/checkout/release-assets", forge });
    expect(publishOptionsOf(["--tag", "v0.5.0", "--check"], env, "/work")).toEqual({ tag: "v0.5.0", folder: null, forge });
  });

  it("refuses arguments missing one it needs or one it does not know, and a job without a token", () => {
    expect(() => publishOptionsOf(["--from", "r"], env, "/work")).toThrow(/--tag/);
    expect(() => publishOptionsOf(["--tag", "v0.5.0"], env, "/work")).toThrow(/--from <folder> or --check/);
    expect(() => publishOptionsOf(["--tag", "v0.5.0", "--from", "r", "--check"], env, "/work")).toThrow(/--from <folder> or --check/);
    expect(() => publishOptionsOf(["--tag", "v0.5.0", "--check", "--draft"], env, "/work")).toThrow(/--draft/);
    expect(() => publishOptionsOf(["--tag", "v0.5.0", "--check"], { ...env, RELEASE_TOKEN: "" }, "/work")).toThrow(/RELEASE_TOKEN/);
    expect(() => publishOptionsOf(["--tag", "v0.5.0", "--check"], { RELEASE_TOKEN: TOKEN }, "/work")).toThrow(/GITHUB_SERVER_URL and GITHUB_REPOSITORY/);
  });
});
