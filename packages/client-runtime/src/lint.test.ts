import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { PRESENTATION_KEYS } from "../../../eslint-rules/no-client-organisation-state.js";
import { WHOLE_PACKAGE_LINT_MS } from "../../../eslint-rules/package-lint.js";
import { PREFERENCE_KEYS } from "./connections/records.js";

// The repository's own lint configuration, run on this package: ADR 0003's
// organisation-state rule, ADR 0004's shell rule, and the dependency rule.
const root = join(import.meta.dirname, "../../..");
const eslint = new ESLint({ cwd: root });
const HOLDS = ["agent-harness/no-client-organisation-state", "agent-harness/no-session-types-in-shell", "no-restricted-imports"];

const ruleIds = async (file: string, code: string): Promise<(string | null)[]> => {
  const [result] = await eslint.lintText(code, { filePath: join(root, file) });
  return (result?.messages ?? []).map((m) => m.ruleId);
};

describe("the client runtime under the repository's lint", () => {
  it("passes every rule on every source file", async () => {
    const results = await eslint.lintFiles(["packages/client-runtime/src/**/*.ts", "packages/client-runtime/test/**/*.ts"]);
    const problems = results.flatMap((r) => r.messages.map((m) => `${r.filePath}:${m.line} ${m.ruleId}: ${m.message}`));
    expect(problems).toEqual([]);
    expect(results.length).toBeGreaterThan(10);
  }, WHOLE_PACKAGE_LINT_MS);

  it("reads the preference key schema: a key named after a session field fails it", async () => {
    const file = "packages/client-runtime/src/connections/records.ts";
    const source = readFileSync(join(root, file), "utf8");
    expect(source).toContain('"environments.sequence"');
    expect(await ruleIds(file, source)).not.toContain(HOLDS[0]);
    expect(await ruleIds(file, source.replaceAll('"environments.sequence"', '"environments.order"'))).toContain(HOLDS[0]);
  });

  it("enumerates the runtime's one presentation preference, hiddenDirectories, among the lint's presentation keys: every key but an environment's connection settings", () => {
    const presentation = PREFERENCE_KEYS.filter((key) => !key.startsWith("environments."));
    expect(presentation).toEqual(["hiddenDirectories"]);
    for (const key of presentation) expect(PRESENTATION_KEYS).toContain(key);
  });

  it("holds the testing exports to contracts alone, so a renderer's tests run them in a DOM: the scripted environment importing a Node built-in fails it", async () => {
    const file = "packages/client-runtime/src/testing/scripted-environment.ts";
    const source = readFileSync(join(root, file), "utf8");
    expect(await ruleIds(file, source)).not.toContain(HOLDS[2]);
    expect(await ruleIds(file, `import { randomUUID } from "node:crypto";\n${source}`)).toContain(HOLDS[2]);
  });

  it("holds the shell interface to no session types: importing one fails it", async () => {
    const file = "packages/client-runtime/src/shell.ts";
    const source = readFileSync(join(root, file), "utf8");
    expect(await ruleIds(file, source)).not.toContain(HOLDS[1]);
    expect(await ruleIds(file, `import type { SessionSummary } from "@agent-harness/contracts";\n${source}`)).toContain(HOLDS[1]);
  });
});
