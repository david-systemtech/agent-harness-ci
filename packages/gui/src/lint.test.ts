// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The repository's own lint configuration, run on this package from its
 * first commit: ADR 0003's organisation-state rule, ADR 0023's literal-colour
 * rule over its scripts and its stylesheet, and the import rule that keeps
 * its bundle to what a browser tab runs.
 */
const root = join(import.meta.dirname, "../../..");
const eslint = new ESLint({ cwd: root });
const ORGANISATION = "agent-harness/no-client-organisation-state";
const COLOUR = "agent-harness/no-literal-colour";

const ruleIds = async (file: string, code: string): Promise<(string | null)[]> => {
  const [result] = await eslint.lintText(code, { filePath: join(root, file) });
  return (result?.messages ?? []).map((m) => m.ruleId);
};

/** A literal colour and a class of Tailwind's palette, each written from its parts so this file holds neither. */
const hex = ["#", "fff"].join("");
const paletteClass = ["bg", "red", "500"].join("-");

describe("the GUI under the repository's lint", () => {
  it("passes every rule on every source, test, harness and stylesheet file", async () => {
    const results = await eslint.lintFiles(["packages/gui/src/**/*.{ts,tsx,css}", "packages/gui/test/**/*.{ts,tsx}", "packages/gui/*.ts"]);
    const problems = results.flatMap((r) => r.messages.map((m) => `${r.filePath}:${m.line} ${m.ruleId}: ${m.message}`));
    expect(problems).toEqual([]);
    expect(results.some((r) => r.filePath.endsWith("styles.css"))).toBe(true);
    expect(results.length).toBeGreaterThan(20);
  });

  it("refuses a store named after session state in a component, and one the presentation module does not list", async () => {
    expect(await ruleIds("packages/gui/src/frame/sidebar-region.tsx", "export const SidebarRegion = () => { const [groups, setGroups] = useState([]); return null; };\n")).toContain(ORGANISATION);
    const file = "packages/gui/src/presentation.ts";
    const source = readFileSync(join(root, file), "utf8");
    expect(await ruleIds(file, source)).not.toContain(ORGANISATION);
    expect(await ruleIds(file, `${source}\nexport const pinnedSessions = writable([]);\n`)).toContain(ORGANISATION);
  });

  it("refuses a literal colour in a primitive and in the stylesheet", async () => {
    const button = "packages/gui/src/ui/button.tsx";
    expect(await ruleIds(button, readFileSync(join(root, button), "utf8"))).not.toContain(COLOUR);
    expect(await ruleIds(button, `export const edge = "1px solid ${hex}";\n`)).toContain(COLOUR);
    expect(await ruleIds(button, `export const tone = "${paletteClass}";\n`)).toContain(COLOUR);
    expect(await ruleIds("packages/gui/src/styles.css", `.edge { border: 1px solid ${hex}; }\n`)).toContain(COLOUR);
  });
});
