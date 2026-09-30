/**
 * Where a packaged desktop carries what a run from a checkout finds in the
 * workspace (#423): the desktop build puts them there, and `main.ts` reads
 * them there when `app.isPackaged`.
 */

/** The `gui` build, in the app's own folder (`app.getAppPath()`), beside the main process and the preload. */
export const PACKAGED_RENDERER = "renderer";

/**
 * The server artefact of the desktop's platform and version, unpacked, in
 * the app's resources (`process.resourcesPath`): the shell's `service` runs
 * its verbs from there, and `installer.bundledServer()` reads its version
 * there.
 */
export const PACKAGED_SERVER = "server";
