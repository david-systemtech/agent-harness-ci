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

  it("keeps the environment, its tests included, free of imports from a client or the CLI, by name or by relative path", async () => {
    const ids = async (file: string, source: string) => ruleIds(file, `import { x } from "${source}";\nexport { x };\n`);
    const relative = "agent-harness/no-relative-import-into";
    expect(await ids("packages/environment/src/x.ts", "@agent-harness/tui")).toContain("no-restricted-imports");
    expect(await ids("packages/environment/src/terminals/x.test.ts", "../../../tui/src/terminal/one-off.js")).toContain(relative);
    expect(await ids("packages/environment/test/x.ts", "../../cli/src/main.js")).toContain(relative);
    // The same climbs spelled with a leading `./`, a `./` between them, or back down through `packages/`.
    expect(await ids("packages/environment/src/x.ts", "./../../tui/src/x.js")).toContain(relative);
    expect(await ids("packages/environment/src/x.ts", ".././../client-runtime/src/x.js")).toContain(relative);
    expect(await ids("packages/environment/src/x.ts", "../../../packages/cli/src/main.js")).toContain(relative);
    // A doubled slash anywhere in the climb, which vitest and tsc read as one (path.resolve collapses it).
    expect(await ids("packages/environment/src/x.ts", ".//../../tui/src/x.js")).toContain(relative);
    expect(await ids("packages/environment/src/x.ts", "..//../cli/src/main.js")).toContain(relative);
    expect(await ids("packages/environment/src/x.ts", "../..//..//packages//tui/src/x.js")).toContain(relative);
    // An interior `.` or `..` after the climb, which resolves into a client or the CLI all the same.
    expect(await ids("packages/environment/src/x.ts", "../../contracts/../cli/src/main.js")).toContain(relative);
    expect(await ids("packages/environment/src/x.ts", "../../../packages/contracts/../cli/src/main.js")).toContain(relative);
    expect(await ids("packages/environment/src/x.ts", "../.././tui/src/x.js")).toContain(relative);
    expect(await ids("packages/environment/src/x.ts", "./terminals/x.js")).not.toContain(relative);
    expect(await ids("packages/environment/src/terminals/x.test.ts", "../../test/helper.js")).not.toContain(relative);
    // A folder of the environment's own named like a client is not that client.
    expect(await ids("packages/environment/src/terminals/x.ts", "../web/x.js")).not.toContain(relative);
    expect(await ids("packages/environment/src/x.ts", "@agent-harness/contracts")).not.toContain("no-restricted-imports");
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
