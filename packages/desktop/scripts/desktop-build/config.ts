import { PRODUCT_NAME } from "@agent-harness/contracts";
import { artefactNode } from "@agent-harness/contracts/launcher";
import type { Configuration } from "electron-builder";
import { APP_ID } from "../../src/app-id.js";
import { PACKAGED_SERVER } from "../../src/packaged.js";
import { APP_SCHEME } from "../../src/schemes.js";
import type { DesktopTarget } from "./targets.js";

/**
 * electron-builder's configuration for one platform's desktop build (#423):
 * the staged app (the main process and preload bundled, the `gui` build) as
 * the whole app, the platform's server artefact in its resources, the
 * `agent-harness://` scheme registered with the OS, and the file the
 * desktop's `update` installs (#355).
 */

/**
 * The Linux executable, the Arch package's name and its desktop entry's:
 * `/usr/bin/agent-harness` stays the CLI's name, which the package's link
 * would otherwise shadow on the `PATH`.
 */
const LINUX_EXECUTABLE = `${PRODUCT_NAME}-desktop`;

/** Where the releases are published, which the packages name as the project's home page. */
const HOMEPAGE = "https://git.systemtech.dev:5526/david/agent-harness";

const DESCRIPTION = "The agent-harness desktop: the window, and the environment on this machine.";

/**
 * What the Arch package depends on: the system libraries Electron's own
 * build loads, by Arch's names (electron-builder's deb list, mapped), with
 * sound and GBM added. electron-builder's own pacman list names the libraries
 * Arch's system Electron links (`http-parser`, `libappindicator-gtk3`, ...),
 * some no longer in Arch's repositories, which `pacman -U` would then refuse.
 * And polkit, for `pkexec`, which the desktop's own update installs through.
 */
const PACMAN_DEPENDS: readonly string[] = [
  "gtk3",
  "nss",
  "alsa-lib",
  "mesa",
  "libxss",
  "libxtst",
  "libnotify",
  "libsecret",
  "at-spi2-core",
  "util-linux-libs",
  "xdg-utils",
  "polkit",
];

/**
 * The NSIS include that registers the app's scheme for the user installing
 * it, as `app.setAsDefaultProtocolClient` does at each launch, so a link
 * opens the app before its first launch. The uninstaller first stops and
 * unregisters the environment through the bundled CLI, retaining personal data. An update keeps both registrations.
 */
export const nsisSchemeInclude = (scheme: string): string =>
  [
    "; The desktop build's NSIS include: the setup registers the app's scheme for this user.",
    "!macro customInstall",
    `  WriteRegStr SHELL_CONTEXT "Software\\Classes\\${scheme}" "" "URL:${scheme}"`,
    `  WriteRegStr SHELL_CONTEXT "Software\\Classes\\${scheme}" "URL Protocol" ""`,
    `  WriteRegStr SHELL_CONTEXT "Software\\Classes\\${scheme}\\shell\\open\\command" "" '"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" "%1"'`,
    "!macroend",
    "",
    "!macro customUnInstall",
    "  ${ifNot} ${isUpdated}",
    "    ClearErrors",
    `    ExecWait '"$INSTDIR\\resources\\${PACKAGED_SERVER}\\node\\node.exe" "$INSTDIR\\resources\\${PACKAGED_SERVER}\\packages\\cli\\dist\\main.js" service uninstall' $0`,
    "    ${if} ${Errors}",
    "      SetErrorLevel 1",
    '      Abort "Could not run environment service cleanup. The app has been kept."',
    "    ${endIf}",
    "    ${if} $0 != 0",
    "      SetErrorLevel 1",
    '      Abort "Could not uninstall the environment service. The app has been kept."',
    "    ${endIf}",
    `    DeleteRegKey SHELL_CONTEXT "Software\\Classes\\${scheme}"`,
    "  ${endIf}",
    "!macroend",
    "",
  ].join("\n");

/** The folders a build's configuration names. */
export interface BuildFolders {
  /** The staged app: its `package.json`, the bundles and the `gui` build. */
  readonly app: string;
  /** The resource root, with the unpacked artefact under `PACKAGED_SERVER`. */
  readonly resources: string;
  /** Where electron-builder writes. */
  readonly output: string;
  /** The NSIS include `nsisSchemeInclude` wrote, for the Windows setup. */
  readonly nsisInclude: string;
}

/**
 * The bundled server's Node, as electron-builder's `signIgnore` matches the
 * absolute path of each file it would sign. electron-builder re-signs every
 * Mach-O in the bundle with the app's identity, ad hoc here, which would put
 * the app's signer on this Node in place of Node's own: an environment the
 * desktop installs then writes its keychain item with another Node than the
 * release tarball's, and its first update from the tarball raises a macOS
 * prompt (#1724). Left alone, it is the tarball's Node, byte for byte.
 */
const BUNDLED_NODE_SIGN_IGNORE = `/Contents/Resources/${[PACKAGED_SERVER, ...artefactNode("darwin")].join("/")}$`;

/** The section of the configuration for `target`'s platform and format alone. */
const platformSection = (target: DesktopTarget, folders: BuildFolders): Configuration => {
  const targets = [{ target: target.format, arch: [target.arch] }];
  switch (target.os) {
    case "darwin":
      return {
        mac: {
          target: targets,
          artifactName: target.name,
          category: "public.app-category.developer-tools",
          extendInfo: { NSCameraUsageDescription: "Scan a pairing QR from another machine to add it." },
          // Milestone 1 ships unsigned builds (#359): signed ad hoc, which Apple silicon needs to run it and
          // `codesign --verify` passes, with no hardened runtime, which only notarisation needs.
          identity: "-",
          hardenedRuntime: false,
          gatekeeperAssess: false,
          notarize: false,
          signIgnore: [BUNDLED_NODE_SIGN_IGNORE],
        },
      };
    case "win32":
      return {
        win: { target: targets },
        // Per user with no window: `<setup> /S` is silent, and electron-builder's setup takes `--updated` (wait for the
        // app to exit) and `--force-run` (start it once installed), the hand-over #355 makes.
        nsis: { oneClick: true, perMachine: false, artifactName: target.name, differentialPackage: false, include: folders.nsisInclude },
      };
    case "linux":
      return {
        linux: { target: targets, executableName: LINUX_EXECUTABLE, category: "Development", maintainer: PRODUCT_NAME, synopsis: DESCRIPTION, description: DESCRIPTION },
        // One package name for every version, installed in /opt/agent-harness, so `pacman -U` of a later build replaces it.
        pacman: { artifactName: target.name, packageName: LINUX_EXECUTABLE, depends: [...PACMAN_DEPENDS] },
      };
  }
};

/** electron-builder's configuration for `target`, built from `folders` with Electron `electronVersion`. */
export const builderConfig = (target: DesktopTarget, folders: BuildFolders, electronVersion: string): Configuration => ({
  appId: APP_ID,
  productName: PRODUCT_NAME,
  electronVersion,
  directories: { app: folders.app, output: folders.output },
  // The staged app is the whole app: nothing to install, rebuild or collect into node_modules.
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  // A file set drops a root node_modules even with **/*; nesting the server keeps its whole tree.
  // Copy during normal packing, before the macOS bundle is signed.
  extraResources: [{ from: folders.resources, to: ".", filter: [`${PACKAGED_SERVER}/**/*`] }],
  // The macOS bundle's CFBundleURLTypes and the Linux desktop entry's MimeType; the Windows setup's is its include.
  protocols: [{ name: PRODUCT_NAME, schemes: [APP_SCHEME] }],
  publish: null,
  ...platformSection(target, folders),
});

/** The staged app's `package.json`: its version is the build's, which `app.getVersion()` answers. */
export const appManifest = (version: string): Record<string, unknown> => ({
  name: LINUX_EXECUTABLE,
  productName: PRODUCT_NAME,
  version,
  description: DESCRIPTION,
  homepage: HOMEPAGE,
  author: { name: PRODUCT_NAME },
  // Electron takes the window's app id (WM_CLASS) and the launcher entry the Linux badge follows from it: the Arch
  // package's desktop entry, named for the executable, whose StartupWMClass electron-builder derives from it too.
  desktopName: `${LINUX_EXECUTABLE}.desktop`,
  type: "module",
  main: "main.js",
});
