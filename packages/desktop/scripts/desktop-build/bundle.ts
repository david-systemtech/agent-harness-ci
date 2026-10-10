import { join } from "node:path";
import { build, type InlineConfig } from "vite";
import { PACKAGED_RENDERER } from "../../src/packaged.js";

/**
 * The staged app's code (#423): the main process and the preload each one
 * bundle, and the `gui` build stamped with the version, so the packaged app
 * needs no `node_modules`. Workspace packages are bundled from their
 * TypeScript source, as the tests read them.
 */

const PACKAGE_DIR = join(import.meta.dirname, "..", "..");
const GUI_DIR = join(PACKAGE_DIR, "..", "gui");

/**
 * The packaged main process: `src/main.ts` and everything it imports but
 * Electron and Node's built-ins, as one ES module, `main.js`, in `outDir`.
 */
export const mainBundleConfig = (outDir: string): InlineConfig => ({
  root: PACKAGE_DIR,
  configFile: false,
  logLevel: "warn",
  ssr: { noExternal: true, resolve: { conditions: ["@agent-harness/source", "module", "node", "development|production"] } },
  build: {
    ssr: join(PACKAGE_DIR, "src", "main.ts"),
    outDir,
    emptyOutDir: false,
    minify: false,
    rolldownOptions: { external: ["electron", "original-fs"], output: { format: "es", entryFileNames: "main.js" } },
  },
});

/** The `gui` build as its own configuration makes it, stamped with `version`, the client version the window reports, in `outDir`. */
export const rendererBuildConfig = (outDir: string, version: string): InlineConfig => ({
  root: GUI_DIR,
  configFile: join(GUI_DIR, "vite.config.ts"),
  logLevel: "warn",
  define: { __HARNESS_VERSION__: JSON.stringify(version) },
  build: { outDir, emptyOutDir: true },
});

/** Writes the app's code into the staged app `app` for `version`: `main.js`, `preload.cjs` and the `gui` build in `renderer/`. */
export const bundleApp = async (app: string, version: string): Promise<void> => {
  await build(mainBundleConfig(app));
  // The preload as the package's own build makes it (vite.config.ts), written beside the main process.
  await build({ root: PACKAGE_DIR, configFile: join(PACKAGE_DIR, "vite.config.ts"), logLevel: "warn", build: { outDir: app, emptyOutDir: false } });
  await build(rendererBuildConfig(join(app, PACKAGED_RENDERER), version));
};
