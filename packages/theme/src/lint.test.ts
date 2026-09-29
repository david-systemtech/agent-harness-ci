import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { WHOLE_PACKAGE_LINT_MS } from "../../../eslint-rules/package-lint.js";

// The repository's own lint configuration, run on this package: the dependency rule holds it to contracts alone.
const root = join(import.meta.dirname, "../../..");
const eslint = new ESLint({ cwd: root });
const file = "packages/theme/src/derive.ts";

const ruleIds = async (code: string): Promise<(string | null)[]> => {
  const [result] = await eslint.lintText(code, { filePath: join(root, file) });
  return (result?.messages ?? []).map((m) => m.ruleId);
};

describe("the theme package under the repository's lint", () => {
  it("passes every rule on every source file", async () => {
    const results = await eslint.lintFiles(["packages/theme/src/**/*.ts"]);
    const problems = results.flatMap((r) => r.messages.map((m) => `${r.filePath}:${m.line} ${m.ruleId}: ${m.message}`));
    expect(problems).toEqual([]);
    expect(results.length).toBeGreaterThan(1);
  }, WHOLE_PACKAGE_LINT_MS);

  it("imports contracts and its own modules, and nothing else: no UI, no runtime, no Node built-in", async () => {
    expect(await ruleIds('import { DEFAULT_THEME } from "@agent-harness/contracts";\nimport { contrastRatio } from "./oklch.js";\nexport { DEFAULT_THEME, contrastRatio };\n')).toEqual([]);
    for (const specifier of ["@agent-harness/client-runtime", "@agent-harness/environment", "react", "ink", "node:fs", "agent-harness"]) {
      expect(await ruleIds(`import * as x from "${specifier}";\nexport { x };\n`), specifier).toContain("no-restricted-imports");
    }
  });
});
