import { createHash } from "node:crypto";
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
const stampWebVersion = (): Plugin => {
  let stampedVersion = version;
  return {
    name: "agent-harness:web-version",
    configResolved(config) { const defined = config.define?.["__HARNESS_VERSION__"]; if (defined !== undefined) stampedVersion = JSON.parse(String(defined)) as string; },
    generateBundle(_options, bundle) {
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ version: stampedVersion }) });
      const workerChunk = bundle["service-worker.js"];
      if (workerChunk?.type === "chunk") {
        const paths = ["/", "/manifest.webmanifest", "/phone-icons/icon-192.png", "/phone-icons/icon-512.png", ...Object.keys(bundle).filter(path => path.startsWith("assets/")).map(path => `/${path}`)];
        const fingerprint = createHash("sha256").update(Object.values(bundle).map(part => part.type === "chunk" ? part.code : String(part.source)).join("\n")).digest("hex").slice(0, 16);
        workerChunk.code = workerChunk.code.replace(/(["'`])__PUBLIC_ASSET_PATHS__\1/, JSON.stringify(paths)).replace("__PUBLIC_CACHE_VERSION__", fingerprint);
      }
    },
  };
};

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
