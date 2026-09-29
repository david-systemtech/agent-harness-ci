import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * The preload bundle, `dist/preload.cjs`: the window's sandbox runs a preload
 * as one CommonJS script whose `require` knows `electron` and little else, so
 * the preload and what it imports are bundled into it, `electron` left to
 * that `require`. The main process is tsc's output (`dist/main.js`), which
 * this build leaves in place.
 */
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    minify: false,
    lib: { entry: fileURLToPath(new URL("src/preload/preload.ts", import.meta.url)), formats: ["cjs"], fileName: () => "preload.cjs" },
    rolldownOptions: { external: ["electron"] },
  },
});
