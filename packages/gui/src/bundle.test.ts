// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The static browser bundle (docs/specs/gui.md, "Packages and the platform"):
 * the page, script and stylesheet the desktop window loads and, in
 * milestone 2, a browser tab, built by Vite from this package with nothing
 * of Node in it.
 */
const packageDir = join(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "agent-harness-gui-bundle-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const buildInto = async (outDir: string, input?: string) =>
  build({
    root: packageDir,
    configFile: join(packageDir, "vite.config.ts"),
    logLevel: "silent",
    build: { outDir, emptyOutDir: true, ...(input !== undefined && { rolldownOptions: { input } }) },
  });

describe("the static browser bundle", () => {
  const outDir = join(scratch, "bundle");
  const built = buildInto(outDir);

  it("is a page loading one script and one stylesheet, at paths relative to it, so it loads from any origin", async () => {
    await built;
    const page = readFileSync(join(outDir, "index.html"), "utf8");
    const scripts = [...page.matchAll(/<script[^>]*src="([^"]+)"/g)].map((match) => match[1] as string);
    const stylesheets = [...page.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((match) => match[1] as string);
    expect(scripts).toHaveLength(1);
    expect(stylesheets).toHaveLength(1);
    for (const path of [...scripts, ...stylesheets]) {
      expect(path.startsWith("./")).toBe(true);
      expect(existsSync(join(outDir, path))).toBe(true);
    }
  });

  it("draws its colours from the root's token variables, and carries none of Tailwind's palette", async () => {
    await built;
    const page = readFileSync(join(outDir, "index.html"), "utf8");
    const href = /<link[^>]*rel="stylesheet"[^>]*href="\.\/([^"]+)"/.exec(page)?.[1] as string;
    const stylesheet = readFileSync(join(outDir, href), "utf8");
    // The frame's ground (`bg-abyss`) and a primitive's accent (`bg-beam`), each read straight from the root's variable.
    expect(stylesheet).toMatch(/background-color:\s*var\(--abyss\)/);
    expect(stylesheet).toMatch(/background-color:\s*var\(--beam\)/);
    expect(stylesheet).not.toMatch(/--color-(red|blue|gray|neutral|white|black)\b/);
  });

  it("refuses to build when anything in it imports a Node built-in", async () => {
    const entry = join(scratch, "reads-a-file.ts");
    writeFileSync(entry, 'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n');
    await expect(buildInto(join(scratch, "refused"), entry)).rejects.toThrow(/node:fs.*Node built-in/);
  });
});
