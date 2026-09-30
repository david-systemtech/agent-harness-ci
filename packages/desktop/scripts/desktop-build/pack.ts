import { createRequire } from "node:module";
import type { Arch, build, Platform } from "electron-builder";
import type { PackRequest } from "./build.js";

/** The parts of electron-builder's API the packer uses. */
interface ElectronBuilder {
  readonly build: typeof build;
  readonly Platform: typeof Platform;
  readonly Arch: typeof Arch;
}

/**
 * electron-builder, asked to pack one platform's target and to publish
 * nothing: the desktop build's preset packer. Required when it is called, so
 * the build's tests, which fake it, never load it.
 */
export const electronBuilderPack = async ({ projectDir, config, target }: PackRequest): Promise<void> => {
  const { build, Platform, Arch } = createRequire(import.meta.url)("electron-builder") as ElectronBuilder;
  const platform = { darwin: Platform.MAC, win32: Platform.WINDOWS, linux: Platform.LINUX }[target.os];
  await build({ projectDir, config, targets: platform.createTarget(target.format, Arch[target.arch]), publish: "never" });
};
