import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// The rules' own suites prove what they report; this proves the repository's
// lint configuration runs them where ADR 0003 says, so `pnpm lint` enforces them.
const eslint = new ESLint({ cwd: join(import.meta.dirname, "..") });

const ruleIds = async (filePath: string, code: string): Promise<(string | null)[]> => {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId);
};

const store = `export const pinnedSessions = createStore([]);\n`;
const shellImport = `import type { SessionSummary } from "@agent-harness/contracts";\nexport type Shell = { open(s: SessionSummary): void };\n`;

describe("the lint configuration", () => {
  it.each([
    "packages/client-runtime/src/sessions.ts",
    "packages/tui/src/sidebar.ts",
    "packages/gui/src/sidebar.tsx",
    "packages/web/src/sidebar.ts",
  ])("runs the organisation-state rule in the client package file %s", async (file) => {
    expect(await ruleIds(file, store)).toContain("agent-harness/no-client-organisation-state");
  });

  it.each(["packages/environment/src/sessions.ts", "packages/contracts/src/sessions.ts"])(
    "leaves the non-client package file %s alone",
    async (file) => {
      expect(await ruleIds(file, store)).not.toContain("agent-harness/no-client-organisation-state");
    },
  );

  it("leaves a client package's test files alone, whose fixtures model the environment's data", async () => {
    expect(
      await ruleIds("packages/tui/src/sidebar.test.ts", `export const summary = { title: "t", pinnedAt: 1 };\n`),
    ).not.toContain("agent-harness/no-client-organisation-state");
  });

  it("runs the shell rule on the desktop shell interface module", async () => {
    expect(await ruleIds("packages/client-runtime/src/shell.ts", shellImport)).toContain(
      "agent-harness/no-session-types-in-shell",
    );
  });

  it("keeps contracts free of imports from the environment", async () => {
    expect(
      await ruleIds("packages/contracts/src/x.ts", `import { x } from "@agent-harness/environment";\nexport { x };\n`),
    ).toContain("no-restricted-imports");
  });

  it("keeps the client runtime's imports to contracts", async () => {
    const ids = async (source: string) =>
      ruleIds("packages/client-runtime/src/x.ts", `import { x } from "${source}";\nexport { x };\n`);
    expect(await ids("@agent-harness/environment")).toContain("no-restricted-imports");
    expect(await ids("react")).toContain("no-restricted-imports");
    expect(await ids("node:fs")).toContain("no-restricted-imports");
    expect(await ids("@agent-harness/contracts")).not.toContain("no-restricted-imports");
    expect(await ids("./projection-cache.js")).not.toContain("no-restricted-imports");
  });
});
