import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
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
  it("holds the contracts, filesystem, environment, client runtime, theme, browser, extension, terminal UI, GUI and desktop packages and the CLI", () => {
    expect(manifests.map((m) => m.name).sort()).toEqual([
      "@agent-harness/browser",
      "@agent-harness/client-runtime",
      "@agent-harness/contracts",
      "@agent-harness/desktop",
      "@agent-harness/environment",
      "@agent-harness/extension",
      "@agent-harness/filesystem",
      "@agent-harness/gui",
      "@agent-harness/theme",
      "@agent-harness/tui",
      "agent-harness",
    ]);
  });

  it("gives filesystem cleanup no runtime dependency, so a launcher can use it without the environment", () => {
    expect(runtimeDependencies(manifest("@agent-harness/filesystem"))).toEqual([]);
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

  it("gives the theme package one runtime dependency, contracts: it holds no UI and no session state (ADR 0023)", () => {
    expect(runtimeDependencies(manifest("@agent-harness/theme"))).toEqual(["@agent-harness/contracts"]);
  });

  it("gives the browser package one runtime dependency, contracts, with Mozilla Readability vendored for the reader to send into a page: it runs in every browser, the extension's included, so it takes no environment code (browser spec; #546, #545)", () => {
    expect(runtimeDependencies(manifest("@agent-harness/browser"))).toEqual(["@agent-harness/contracts"]);
  });

  it("gives the extension no workspace dependency but contracts and the browser package: it runs in Chrome and finds its environment by itself (browser spec; #549)", () => {
    const workspace = new Set(manifests.map((m) => m.name));
    const deps = runtimeDependencies(manifest("@agent-harness/extension")).filter((d) => workspace.has(d));
    expect(deps.filter((d) => d !== "@agent-harness/contracts" && d !== "@agent-harness/browser")).toEqual([]);
    expect(deps).toContain("@agent-harness/contracts");
  });

  it("gives the environment no runtime dependency on a client package or the CLI", () => {
    const deps = runtimeDependencies(manifest("@agent-harness/environment"));
    expect(deps.filter((d) => /^(@agent-harness\/(client-runtime|tui|gui|web|desktop)|agent-harness)$/.test(d))).toEqual([]);
  });

  it("gives the environment four workspace dependencies: filesystem cleanup, contracts, the theme package, whose derivation the Appearance step's contrast check runs (ADR 0023; #391), and the browser package, whose reader web_read runs (#546)", () => {
    const workspace = new Set(manifests.map((m) => m.name));
    const deps = runtimeDependencies(manifest("@agent-harness/environment"));
    expect(deps.filter((d) => workspace.has(d)).sort()).toEqual(["@agent-harness/browser", "@agent-harness/contracts", "@agent-harness/filesystem", "@agent-harness/theme"]);
  });

  it("gives the terminal UI no runtime dependency on the environment or the CLI", () => {
    const deps = runtimeDependencies(manifest("@agent-harness/tui"));
    expect(deps.filter((d) => d === "@agent-harness/environment" || d === "agent-harness")).toEqual([]);
  });

  it("gives the GUI four workspace dependencies, the browser, client runtime, contracts and theme, and neither Electron nor the environment nor the CLI: its bundle runs in a browser tab", () => {
    const workspace = new Set(manifests.map((m) => m.name));
    const deps = runtimeDependencies(manifest("@agent-harness/gui"));
    expect(deps.filter((d) => workspace.has(d)).sort()).toEqual(["@agent-harness/browser", "@agent-harness/client-runtime", "@agent-harness/contracts", "@agent-harness/theme"]);
    expect(deps.filter((d) => d === "electron" || d.startsWith("@electron/"))).toEqual([]);
  });

  it("gives the desktop the GUI's build to carry and the runtime's shell interface to implement, and neither the environment nor the CLI to import", () => {
    const workspace = new Set(manifests.map((m) => m.name));
    const deps = runtimeDependencies(manifest("@agent-harness/desktop"));
    expect(deps.filter((d) => workspace.has(d)).sort()).toEqual([
      "@agent-harness/client-runtime",
      "@agent-harness/contracts",
      "@agent-harness/filesystem",
      "@agent-harness/gui",
      "@agent-harness/theme",
    ]);
  });

  it("keeps the desktop a leaf: no package depends on it, so nothing of Electron reaches the GUI, the runtime or the environment", () => {
    const dependents = manifests.filter((m) => [...runtimeDependencies(m), ...Object.keys(m.devDependencies ?? {})].includes("@agent-harness/desktop"));
    expect(dependents.map((m) => m.name)).toEqual([]);
    for (const name of ["@agent-harness/client-runtime", "@agent-harness/contracts", "@agent-harness/theme", "@agent-harness/environment"]) {
      expect(runtimeDependencies(manifest(name)).filter((d) => d === "electron" || d.startsWith("@electron/"))).toEqual([]);
    }
  });

  it("takes Electron as tooling, a devDependency as Electron's packagers expect, whose install scripts never run, so no install downloads its binary", () => {
    const desktop = manifest("@agent-harness/desktop");
    expect(Object.keys(desktop.devDependencies ?? {})).toContain("electron");
    expect(runtimeDependencies(desktop)).not.toContain("electron");
    const built = /^onlyBuiltDependencies:\n((?:[ \t]+- .*\n?)*)/m.exec(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"))?.[1] ?? "";
    expect(built).toContain("node-pty");
    expect(built).not.toMatch(/\belectron\b/);
  });

  it("ships the terminal UI in the CLI's artefact, so one install gives serve and tui (ADR 0004)", () => {
    expect(runtimeDependencies(manifest("agent-harness"))).toContain("@agent-harness/tui");
  });

  it("requires Node 24 or later: the LTS line with node:sqlite's busy timeout and isTransaction, Node 22 ending its life in April 2027", () => {
    const engines = (dir: string) =>
      (JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as { engines?: { node?: string } }).engines
        ?.node;
    expect(engines(".")).toBe(">=24.0.0");
    expect(engines("packages/environment")).toBe(">=24.0.0");
  });

  it("runs the environment's and the client runtime's test files in parallel, since every listener takes port 0", async () => {
    const { default: environment } = await import("../packages/environment/vitest.config.js");
    const { default: clientRuntime } = await import("../packages/client-runtime/vitest.config.js");
    expect(environment.test?.fileParallelism).not.toBe(false);
    expect(clientRuntime.test?.fileParallelism).not.toBe(false);
  });
});
