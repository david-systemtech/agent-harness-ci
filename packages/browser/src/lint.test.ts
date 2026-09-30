import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { WHOLE_PACKAGE_LINT_MS } from "../../../eslint-rules/package-lint.js";

// The repository's own lint configuration, run on this package: the dependency rule holds it to what runs in every browser.
const root = join(import.meta.dirname, "../../..");
const eslint = new ESLint({ cwd: root });

const ruleIds = async (file: string, code: string): Promise<(string | null)[]> => {
  const [result] = await eslint.lintText(code, { filePath: join(root, file) });
  return (result?.messages ?? []).map((m) => m.ruleId);
};

const importing = (specifier: string): string => `import * as x from "${specifier}";\nexport { x };\n`;

describe("the browser package under the repository's lint", () => {
  it("passes every rule on every source file", async () => {
    const results = await eslint.lintFiles(["packages/browser/src/**/*.ts"]);
    const problems = results.flatMap((r) => r.messages.map((m) => `${r.filePath}:${m.line} ${m.ruleId}: ${m.message}`));
    expect(problems).toEqual([]);
    expect(results.length).toBeGreaterThan(1);
  }, WHOLE_PACKAGE_LINT_MS);

  it("imports contracts and its own modules, and no Node built-in, environment code or other workspace package", async () => {
    const file = "packages/browser/src/frame.ts";
    for (const specifier of ["@agent-harness/contracts", "./redaction.js"]) expect(await ruleIds(file, importing(specifier)), specifier).toEqual([]);
    for (const specifier of [
      "node:fs",
      "fs",
      "path",
      "node:crypto",
      "crypto",
      "@agent-harness/environment",
      "@agent-harness/client-runtime",
      "@agent-harness/theme",
      "agent-harness",
    ]) {
      expect(await ruleIds(file, importing(specifier)), specifier).toContain("no-restricted-imports");
    }
  });

  it("refuses a relative climb into the environment's folder, however it is spelled", async () => {
    const relative = "agent-harness/no-relative-import-into";
    expect(await ruleIds("packages/browser/src/frame.ts", importing("../../environment/src/scrub/registry.js"))).toContain(relative);
    expect(await ruleIds("packages/browser/src/frame.ts", importing(".//../../cli/src/main.js"))).toContain(relative);
    expect(await ruleIds("packages/browser/src/frame.ts", importing("../../contracts/src/index.js"))).not.toContain(relative);
  });

  it("lets its testing exports serve the scripted CDP peer over Node's sockets, and still keeps the environment out", async () => {
    const peer = "packages/browser/src/testing/scripted-cdp-peer.ts";
    for (const specifier of ["node:http", "node:crypto", "ws"]) expect(await ruleIds(peer, importing(specifier)), specifier).not.toContain("no-restricted-imports");
    expect(await ruleIds(peer, importing("@agent-harness/environment"))).toContain("no-restricted-imports");
    expect(await ruleIds("packages/browser/src/driver/driver.ts", importing("node:http"))).toContain("no-restricted-imports");
  });

  it("lets a test read its fixture pages with Node, and still keeps the environment out", async () => {
    expect(await ruleIds("packages/browser/src/challenge.test.ts", importing("node:fs"))).not.toContain("no-restricted-imports");
    expect(await ruleIds("packages/browser/src/challenge.test.ts", importing("@agent-harness/environment"))).toContain("no-restricted-imports");
  });
});
