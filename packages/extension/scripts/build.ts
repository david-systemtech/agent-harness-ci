import { copyFileSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import { build, type Plugin } from "vite";
import { extensionManifest, OPTIONS_PAGE } from "../src/manifest.js";

/**
 * The extension's build (#549): one folder Chrome loads unpacked. Vite
 * bundles the worker and the options page's script, each with what it
 * imports of contracts from TypeScript source, as the tests read it; the
 * manifest for the harness version and the options page's markup go beside
 * them. The workspace build writes it to the package's `dist`, beside the
 * environment package, where the environment finds the extension it
 * carries and unpacks it for Chrome (#547).
 */

const PACKAGE_DIR = join(import.meta.dirname, "..");
const SOURCE = join(PACKAGE_DIR, "src");

/** Where the workspace build puts the extension: the folder the environment's unpack reads. */
export const EXTENSION_DIST = join(PACKAGE_DIR, "dist");

/** Fails the build on any import of a Node built-in, whoever imports it: nothing of Node runs in Chrome. */
const refuseNodeBuiltins = (): Plugin => ({
  name: "agent-harness:refuse-node-builtins",
  enforce: "pre",
  resolveId(source, importer) {
    if (isBuiltin(source)) this.error(`${importer ?? "The entry"} imports ${source}, a Node built-in: the extension runs in Chrome.`);
    return null;
  },
});

/** Builds the extension of `version`, the harness version it ships with, into `outDir`, replacing what was there. */
export const buildExtension = async ({ outDir, version }: { readonly outDir: string; readonly version: string }): Promise<void> => {
  // A version the manifest cannot take fails before anything is written.
  const manifest = extensionManifest(version);
  await build({
    root: PACKAGE_DIR,
    configFile: false,
    logLevel: "warn",
    publicDir: false,
    plugins: [refuseNodeBuiltins()],
    resolve: { conditions: ["@agent-harness/source", "module", "browser", "development|production"] },
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      // The scripts are modules Chrome loads from the folder: no preload polyfill.
      modulePreload: false,
      rolldownOptions: {
        // Named for the files the manifest and the options page load: `worker.js` and `options.js`.
        input: { worker: join(SOURCE, "worker.ts"), options: join(SOURCE, "options.ts") },
        output: { format: "es", entryFileNames: "[name].js", chunkFileNames: "[name].js" },
        // A contracts module's top level only defines: its schemas' descriptions register for the JSON Schema export,
        // which nothing here reads. Read as having no side effect, the modules the scripts take nothing from are left
        // out, and the shared module is about a fifth of the whole package's size.
        treeshake: { moduleSideEffects: (id: string) => !id.includes("/packages/contracts/") },
      },
    },
  });
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(join(SOURCE, OPTIONS_PAGE), join(outDir, OPTIONS_PAGE));
};
