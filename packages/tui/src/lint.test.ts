import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { WHOLE_PACKAGE_LINT_MS } from "../../../eslint-rules/package-lint.js";

// ADR 0003's lint on the terminal UI: no client store, preference or storage key named after session
// organisation state, so the state directory can hold no pins, groups, archive or drafts. The repository's
// own configuration, run on this package.
const root = join(import.meta.dirname, "../../..");
const eslint = new ESLint({ cwd: root });
const RULE = "agent-harness/no-client-organisation-state";

const ruleIds = async (file: string, code: string): Promise<(string | null)[]> => {
  const [result] = await eslint.lintText(code, { filePath: join(root, file) });
  return (result?.messages ?? []).map((m) => m.ruleId);
};

describe("the terminal UI under the repository's lint", () => {
  it("passes every rule on every source and harness file", async () => {
    const results = await eslint.lintFiles(["packages/tui/src/**/*.{ts,tsx}", "packages/tui/test/**/*.ts"]);
    const problems = results.flatMap((r) => r.messages.map((m) => `${r.filePath}:${m.line} ${m.ruleId}: ${m.message}`));
    expect(problems).toEqual([]);
    expect(results.length).toBeGreaterThan(15);
  }, WHOLE_PACKAGE_LINT_MS);

  it("fires on a store named after session state in a component", async () => {
    expect(await ruleIds("packages/tui/src/screens/rail.tsx", "export const pinnedSessions = createStore([]);\n")).toContain(RULE);
    expect(await ruleIds("packages/tui/src/screens/rail.tsx", "const Rail = () => { const [groups, setGroups] = useState([]); return null; };\nexport { Rail };\n")).toContain(RULE);
  });

  it("fires on a document the terminal UI would keep in its state directory under a session-state name", async () => {
    const file = "packages/tui/src/platform/node-platform.ts";
    const source = readFileSync(join(root, file), "utf8");
    expect(await ruleIds(file, source)).not.toContain(RULE);
    expect(await ruleIds(file, `${source}\nexport const keep = (platform: { documents: { set(k: string, v: unknown): Promise<void> } }) => platform.documents.set("rail.archive", []);\n`)).toContain(RULE);
  });

  it("lets collapsedHeadings, the one enumerated presentation key, through in the presentation module and elsewhere, and fires on another session-state name in either", async () => {
    const file = "packages/tui/src/presentation.ts";
    const source = readFileSync(join(root, file), "utf8");
    expect(await ruleIds(file, source)).not.toContain(RULE);
    expect(await ruleIds(file, `${source}\nexport const pinnedHeadings = writable({});\n`)).toContain(RULE);
    expect(await ruleIds("packages/tui/src/rail/use-rail.ts", "export const collapsedHeadings = writable({});\n")).not.toContain(RULE);
    expect(await ruleIds("packages/tui/src/rail/use-rail.ts", "export const collapsedGroups = writable({});\n")).toContain(RULE);
  });

  it("fires on a colour named in the source, by name or in hex, and passes a role or an environment colour from the theme package (ADR 0023, #392)", async () => {
    const fires = async (code: string) => (await ruleIds("packages/tui/src/screens/rail.tsx", code)).includes("no-restricted-syntax");
    expect(await fires('export const tone = { color: "yellow" };\n')).toBe(true);
    expect(await fires('export const edge = "cyanBright";\n')).toBe(true);
    expect(await fires('export const tone = "#e5c07b";\n')).toBe(true);
    expect(await fires('import { TERMINAL_ROLES } from "@agent-harness/theme";\nexport const tone = { color: TERMINAL_ROLES.warning };\n')).toBe(false);
    expect(await fires('import { ENVIRONMENT_ANSI } from "@agent-harness/theme";\nexport const tone = ENVIRONMENT_ANSI.teal;\n')).toBe(false);
    expect(await ruleIds("packages/tui/src/screens/rail.test.ts", 'export const tone = { color: "yellow" };\n')).not.toContain("no-restricted-syntax");
  });

  it("fires on a draft kept by the composer", async () => {
    expect(await ruleIds("packages/tui/src/app.tsx", "export const Composer = () => { const [draft, setDraft] = useState(''); return draft; };\n")).toContain(RULE);
  });
});
