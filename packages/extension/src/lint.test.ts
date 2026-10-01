import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { WHOLE_PACKAGE_LINT_MS } from "../../../eslint-rules/package-lint.js";

// The repository's lint configuration, run on this package: the dependency rule holds the extension to contracts and the
// browser package (the browser spec's contract test), and its source to what runs in Chrome.
const root = join(import.meta.dirname, "../../..");
const eslint = new ESLint({ cwd: root });

const ruleIds = async (file: string, code: string): Promise<(string | null)[]> => {
  const [result] = await eslint.lintText(code, { filePath: join(root, file) });
  return (result?.messages ?? []).map((m) => m.ruleId);
};

const importing = (specifier: string): string => `import * as x from "${specifier}";\nexport { x };\n`;

describe("the extension package under the repository's lint", () => {
  it("passes every rule on every file", async () => {
    const results = await eslint.lintFiles(["packages/extension/**/*.ts"]);
    const problems = results.flatMap((r) => r.messages.map((m) => `${r.filePath}:${m.line} ${m.ruleId}: ${m.message}`));
    expect(problems).toEqual([]);
    expect(results.length).toBeGreaterThan(1);
  }, WHOLE_PACKAGE_LINT_MS);

  it("imports contracts, the browser package and its own modules, and nothing else of the workspace", async () => {
    const file = "packages/extension/src/service-worker.ts";
    for (const specifier of ["@agent-harness/contracts", "@agent-harness/browser", "./port.js"]) expect(await ruleIds(file, importing(specifier)), specifier).toEqual([]);
    for (const specifier of ["@agent-harness/environment", "@agent-harness/client-runtime", "@agent-harness/theme", "@agent-harness/gui", "agent-harness"]) {
      expect(await ruleIds(file, importing(specifier)), specifier).toContain("no-restricted-imports");
      expect(await ruleIds("packages/extension/scripts/build.ts", importing(specifier)), specifier).toContain("no-restricted-imports");
      expect(await ruleIds("packages/extension/src/worker.test.ts", importing(specifier)), specifier).toContain("no-restricted-imports");
    }
  });

  it("refuses a relative climb into the environment's folder, however it is spelled", async () => {
    const relative = "agent-harness/no-relative-import-into";
    expect(await ruleIds("packages/extension/src/worker.ts", importing("../../environment/src/browser/listener.js"))).toContain(relative);
    expect(await ruleIds("packages/extension/test/fake-chrome.ts", importing(".//../../environment/test/fake-extension.js"))).toContain(relative);
    expect(await ruleIds("packages/extension/src/worker.ts", importing("../../contracts/src/index.js"))).not.toContain(relative);
  });

  it("keeps Node and the browser package's testing exports out of what runs in Chrome, and lets the tests and the build use Node", async () => {
    for (const specifier of ["node:fs", "fs", "node:crypto", "@agent-harness/browser/testing"]) {
      expect(await ruleIds("packages/extension/src/service-worker.ts", importing(specifier)), specifier).toContain("no-restricted-imports");
    }
    for (const file of ["packages/extension/src/worker.test.ts", "packages/extension/test/scripted-environment.ts", "packages/extension/scripts/build.ts"]) {
      expect(await ruleIds(file, importing("node:fs")), file).not.toContain("no-restricted-imports");
    }
  });
});
