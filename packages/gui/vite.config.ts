import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

/**
 * The GUI's static browser bundle (docs/specs/gui.md, "Packages and the
 * platform"): `index.html`, its script and its stylesheet in `dist/`, at
 * paths relative to the page, so the desktop window loads it from its app
 * scheme and a browser tab from its environment. Workspace packages are
 * built from their TypeScript source, as the tests read them.
 */

/** Fails the build on any import of a Node built-in, whoever imports it: nothing of Node reaches a browser tab. */
const refuseNodeBuiltins = (): Plugin => ({
  name: "agent-harness:refuse-node-builtins",
  enforce: "pre",
  resolveId(source, importer) {
    if (isBuiltin(source)) this.error(`${importer ?? "The entry"} imports ${source}, a Node built-in: the GUI's bundle runs in a browser tab.`);
    return null;
  },
});

const { version: packageVersion } = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as { readonly version: string };

const version = process.env["HARNESS_VERSION"] ?? packageVersion;
const stampWebVersion = (): Plugin => ({
  name: "agent-harness:web-version",
  generateBundle() { this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ version }) }); },
});

const worker = new URL("src/web/service-worker.ts", import.meta.url).pathname;

export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [refuseNodeBuiltins(), tailwindcss(), stampWebVersion()],
  resolve: { conditions: ["@agent-harness/source", "module", "browser", "development|production"] },
  define: { __HARNESS_VERSION__: JSON.stringify(version) },
  build: { outDir: mode === "gallery" ? "gallery-dist" : "dist", emptyOutDir: true,
    ...(mode !== "gallery" && existsSync(worker) && { rolldownOptions: {
      input: { app: new URL("index.html", import.meta.url).pathname, "service-worker": worker },
      output: { entryFileNames: chunk => chunk.name === "service-worker" ? "service-worker.js" : "assets/[name]-[hash].js" },
    } }),
    ...(mode === "gallery" && { rolldownOptions: { input: new URL("gallery.html", import.meta.url).pathname } }),
  },
}));
