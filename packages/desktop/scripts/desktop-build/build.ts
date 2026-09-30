import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseVersionOfTag } from "@agent-harness/contracts";
import type { Configuration } from "electron-builder";
import { APP_SCHEME } from "../../src/schemes.js";
import { bundleApp } from "./bundle.js";
import { appManifest, builderConfig, nsisSchemeInclude } from "./config.js";
import { electronBuilderPack } from "./pack.js";
import { stageServer } from "./server.js";
import { desktopTarget, DesktopBuildError, type DesktopTarget } from "./targets.js";

/**
 * The desktop build (#423): one platform's desktop, built on that platform
 * (the Windows setup on an x86_64 Linux too, #359) for a release's version,
 * as the file the desktop's `update` installs. The
 * main process and the preload are bundled and the `gui` build copied into a
 * staged app whose `package.json` carries the version; the platform's server
 * artefact of the same version is unpacked beside it; electron-builder packs
 * both, the artefact into the app's resources, and the one file it makes is
 * written to the out folder under the platform's name.
 */

/** What a desktop is built from. */
export interface DesktopBuildOptions {
  /** The release's tag, `v<version>`. */
  readonly tag: string;
  /** The platform, `<os>-<arch>`: `darwin-arm64`, `win32-x64` or `linux-x64`. */
  readonly platform: string;
  /** The release build's server artefact of that platform and version (#356): `agent-harness-linux-x64.tar.gz`. */
  readonly server: string;
  /** The folder the build is written to, which must be empty or not exist. */
  readonly out: string;
}

/** What electron-builder is asked: to pack `target` from `config`, in `projectDir`. */
export interface PackRequest {
  readonly projectDir: string;
  readonly config: Configuration;
  readonly target: DesktopTarget;
}

/** What the build does that a test replaces; each has a preset, the real one. */
export interface DesktopBuildSeams {
  /** The platform the build runs on; preset: this process's. */
  readonly host?: string;
  /** Where the build stages what it packs; preset: a fresh folder in the system's temporary folder, outside any workspace. It is removed at the end. */
  readonly work?: string;
  /** Writes the app's code into the staged app `app`: the bundled main process and preload, and the `gui` build stamped with `version`. Preset: `bundleApp`. */
  readonly compile?: (app: string, version: string) => Promise<void>;
  /** Packs it; preset: electron-builder. */
  readonly pack?: (request: PackRequest) => Promise<void>;
  /** Where the build says what it is doing; preset: standard output. */
  readonly log?: (line: string) => void;
}

/** The Electron the desktop runs on: the version its `electron` dev dependency installed. */
const electronVersion = (): string => (createRequire(import.meta.url)("electron/package.json") as { readonly version: string }).version;

/** Builds the desktop (see the module's comment), answering nothing; any failure is a `DesktopBuildError` or the error that stopped it. */
export const buildDesktop = async (options: DesktopBuildOptions, seams: DesktopBuildSeams = {}): Promise<void> => {
  const version = releaseVersionOfTag(options.tag);
  if (version === null) throw new DesktopBuildError(`The tag ${JSON.stringify(options.tag)} is not v and a semantic version (v0.5.0, v1.0.0-beta.2): a desktop is built only for a release's version.`);
  const target = desktopTarget(options.platform);
  const host = seams.host ?? `${process.platform}-${process.arch}`;
  if (!target.hosts.includes(host)) {
    throw new DesktopBuildError(`The ${target.platform} desktop is built on ${target.hosts.join(" or ")}, not ${host}: run it on CI's \`${target.runner}\` runner.`);
  }
  if (existsSync(options.out) && readdirSync(options.out).length > 0) throw new DesktopBuildError(`${options.out} is not empty: the build writes a desktop into an empty folder.`);
  const log = seams.log ?? ((line: string) => console.log(line));
  mkdirSync(options.out, { recursive: true });
  const work = seams.work ?? mkdtempSync(join(tmpdir(), "agent-harness-desktop-build-"));
  const folders = { app: join(work, "app"), server: join(work, "server"), output: join(work, "dist"), nsisInclude: join(work, "installer.nsh") };
  try {
    log(`${target.platform}: unpacking the server artefact ${options.server}`);
    await stageServer(options.server, folders.server, target, version, host);
    mkdirSync(folders.app, { recursive: true });
    log(`${target.platform}: bundling the app`);
    await (seams.compile ?? bundleApp)(folders.app, version);
    writeFileSync(join(folders.app, "package.json"), `${JSON.stringify(appManifest(version), null, 2)}\n`);
    if (target.os === "win32") writeFileSync(folders.nsisInclude, nsisSchemeInclude(APP_SCHEME));
    log(`${target.platform}: packing ${target.name}`);
    await (seams.pack ?? electronBuilderPack)({ projectDir: folders.app, config: builderConfig(target, folders, electronVersion()), target });
    const built = join(folders.output, target.name);
    if (!existsSync(built)) {
      const wrote = existsSync(folders.output) ? readdirSync(folders.output) : [];
      throw new DesktopBuildError(`electron-builder wrote no ${target.name} (it wrote ${wrote.join(", ") || "nothing"}).`);
    }
    copyFileSync(built, join(options.out, target.name));
    log(`${target.platform}: wrote ${target.name}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};
