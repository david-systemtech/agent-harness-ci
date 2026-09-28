import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  LAUNCHER_PROTOCOL,
  PROTOCOL_VERSION,
  RELEASE_ASSET_KINDS,
  RELEASE_MANIFEST_FILE,
  RELEASE_PLATFORMS,
  ReleaseManifest,
  exportedSchemas,
} from "./index.js";
import { LAUNCHER_PROTOCOL as LAUNCHER_PROTOCOL_ALONE } from "./launcher.js";

/**
 * The release manifest (launcher-update spec, "The release"; #335): what
 * every release publishes as `release.json`, read by an environment before
 * it downloads anything of the release, and by a client in another language
 * from the JSON Schema export.
 */

const sha = (digit: string) => digit.repeat(64);

/** A whole release's manifest: this platform's three artefacts, a desktop build, the scripts and the image. */
const manifest = {
  version: "0.5.0",
  protocolVersion: PROTOCOL_VERSION,
  launcherProtocol: LAUNCHER_PROTOCOL,
  databaseSchemaVersion: 14,
  bundledClaudeCodeVersion: "2.3.1",
  assets: [
    { name: "agent-harness-linux-x64.tar.gz", kind: "environment", platform: "linux-x64", format: "tar.gz", size: 61_234_567, sha256: sha("a") },
    { name: "agent-harness-darwin-arm64.tar.gz", kind: "environment", platform: "darwin-arm64", format: "tar.gz", size: 58_000_000, sha256: sha("b") },
    { name: "agent-harness-win32-x64.zip", kind: "environment", platform: "win32-x64", format: "zip", size: 64_000_000, sha256: sha("c") },
    { name: "agent-harness-desktop-darwin-arm64.zip", kind: "desktop", platform: "darwin-arm64", format: "zip", size: 120_000_000, sha256: sha("d") },
    { name: "install.sh", kind: "install-script", platform: null, format: null, size: 9_120, sha256: sha("e") },
    { name: "compose.yaml", kind: "compose", platform: null, format: null, size: 1_024, sha256: sha("f") },
  ],
  image: { reference: "git.systemtech.dev:5526/david/agent-harness:0.5.0", digest: `sha256:${sha("0")}` },
};

const exported = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(import.meta.dirname, "..", "schema", path), "utf8")) as Record<string, unknown>;

describe("the release manifest", () => {
  it("is release.json among every release's assets", () => {
    expect(RELEASE_MANIFEST_FILE).toBe("release.json");
  });

  it("holds the version, protocol version, launcher protocol, database schema version and bundled Claude Code version, every asset's name, kind, platform, size and SHA-256, and the image's reference and digest", () => {
    expect(ReleaseManifest.parse(manifest)).toEqual(manifest);
    for (const field of ["version", "protocolVersion", "launcherProtocol", "databaseSchemaVersion", "bundledClaudeCodeVersion", "assets", "image"]) {
      const { [field]: _left, ...without } = manifest as Record<string, unknown>;
      expect(ReleaseManifest.safeParse(without).success, field).toBe(false);
    }
    const [artefact] = manifest.assets as [Record<string, unknown>];
    for (const field of ["name", "kind", "platform", "format", "size", "sha256"]) {
      const { [field]: _left, ...without } = artefact;
      expect(ReleaseManifest.safeParse({ ...manifest, assets: [without] }).success, field).toBe(false);
    }
    expect(ReleaseManifest.safeParse({ ...manifest, version: "v0.5.0" }).success).toBe(false);
    expect(ReleaseManifest.safeParse({ ...manifest, assets: [{ ...artefact, sha256: sha("A") }] }).success).toBe(false);
    expect(ReleaseManifest.safeParse({ ...manifest, image: { ...manifest.image, digest: sha("0") } }).success).toBe(false);
  });

  it("round-trips through the JSON Schema export: what it writes validates against the published document and reads back the same", () => {
    const entry = exportedSchemas().find((schema) => schema.path === "release/manifest.json");
    expect(entry?.schema).toBe(ReleaseManifest);
    const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
    addFormats.default(ajv);
    const validate = ajv.compile(exported("release/manifest.json"));
    const written = JSON.parse(JSON.stringify(ReleaseManifest.parse(manifest))) as unknown;
    expect(validate(written), ajv.errorsText(validate.errors)).toBe(true);
    expect(ReleaseManifest.parse(written)).toEqual(manifest);
  });

  it("is read by an older environment when a newer release adds a field, an asset kind or a platform, which it passes over", () => {
    const newer = {
      ...manifest,
      notes: "What changed",
      assets: [...manifest.assets, { name: "agent-harness-linux-arm64.tar.gz", kind: "environment", platform: "linux-arm64", format: "tar.gz", size: 1, sha256: sha("1"), signature: "x" }, { name: "sbom.json", kind: "sbom", platform: null, format: null, size: 2, sha256: sha("2") }],
    };
    const read = ReleaseManifest.parse(newer);
    expect(read).not.toHaveProperty("notes");
    expect(read.assets.map((asset) => [asset.kind, asset.platform])).toContainEqual(["sbom", null]);
    expect(read.assets.map((asset) => asset.platform)).toContain("linux-arm64");
  });

  it("names the kinds and platforms this version publishes: M1's three platforms", () => {
    expect(RELEASE_ASSET_KINDS).toEqual(["environment", "desktop", "install-script", "compose", "host-updater", "schema"]);
    expect(RELEASE_PLATFORMS).toEqual(["linux-x64", "darwin-arm64", "win32-x64"]);
  });
});

describe("the launcher protocol", () => {
  it("is one integer, 1, beside the protocol version, the same from the launcher's own entry point", () => {
    expect(LAUNCHER_PROTOCOL).toBe(1);
    expect(LAUNCHER_PROTOCOL_ALONE).toBe(LAUNCHER_PROTOCOL);
    expect(ReleaseManifest.safeParse({ ...manifest, launcherProtocol: 0 }).success).toBe(false);
    expect(ReleaseManifest.safeParse({ ...manifest, launcherProtocol: 1.5 }).success).toBe(false);
  });
});
