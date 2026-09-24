import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const manifests: Manifest[] = readdirSync(join(root, "packages")).map(
  (dir) => JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8")) as Manifest,
);

const manifest = (name: string): Manifest => {
  const found = manifests.find((m) => m.name === name);
  if (!found) throw new Error(`no package named ${name}`);
  return found;
};

/** What a package needs at run time: devDependencies are tooling and do not count. */
const runtimeDependencies = (m: Manifest): string[] => [
  ...Object.keys(m.dependencies ?? {}),
  ...Object.keys(m.peerDependencies ?? {}),
  ...Object.keys(m.optionalDependencies ?? {}),
];

describe("the workspace", () => {
  it("holds the contracts, environment, client runtime and terminal UI packages and the CLI", () => {
    expect(manifests.map((m) => m.name).sort()).toEqual([
      "@agent-harness/client-runtime",
      "@agent-harness/contracts",
      "@agent-harness/environment",
      "@agent-harness/tui",
      "agent-harness",
    ]);
  });

  it("gives contracts no runtime dependency on the environment, or on any other workspace package", () => {
    const workspace = new Set(manifests.map((m) => m.name));
    const deps = runtimeDependencies(manifest("@agent-harness/contracts"));
    expect(deps).not.toContain("@agent-harness/environment");
    expect(deps.filter((d) => workspace.has(d))).toEqual([]);
  });

  it("gives the client runtime one runtime dependency, contracts", () => {
    expect(runtimeDependencies(manifest("@agent-harness/client-runtime"))).toEqual(["@agent-harness/contracts"]);
  });

  it("gives the environment no runtime dependency on a client package or the CLI", () => {
    const deps = runtimeDependencies(manifest("@agent-harness/environment"));
    expect(deps.filter((d) => /^(@agent-harness\/(client-runtime|tui|gui|web)|agent-harness)$/.test(d))).toEqual([]);
  });

  it("gives the terminal UI no runtime dependency on the environment or the CLI", () => {
    const deps = runtimeDependencies(manifest("@agent-harness/tui"));
    expect(deps.filter((d) => d === "@agent-harness/environment" || d === "agent-harness")).toEqual([]);
  });

  it("runs the environment's test files one at a time, since each starts a listener", async () => {
    const { default: config } = await import("../packages/environment/vitest.config.js");
    expect(config.test?.fileParallelism).toBe(false);
  });
});
