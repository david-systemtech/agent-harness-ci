import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

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
  });

  it("reads the preference key schema: a key named after a session field fails it", async () => {
    const file = "packages/client-runtime/src/connections/records.ts";
    const source = readFileSync(join(root, file), "utf8");
    expect(source).toContain('"environments.sequence"');
    expect(await ruleIds(file, source)).not.toContain(HOLDS[0]);
    expect(await ruleIds(file, source.replaceAll('"environments.sequence"', '"environments.order"'))).toContain(HOLDS[0]);
  });

  it("holds the shell interface to no session types: importing one fails it", async () => {
    const file = "packages/client-runtime/src/shell.ts";
    const source = readFileSync(join(root, file), "utf8");
    expect(await ruleIds(file, source)).not.toContain(HOLDS[1]);
    expect(await ruleIds(file, `import type { SessionSummary } from "@agent-harness/contracts";\n${source}`)).toContain(HOLDS[1]);
  });
});
