import { describe, expect, it } from "vitest";
import {
  CAPABILITY_FLAG_LIST,
  ENVIRONMENT_NOTICE_TYPES,
  EnvironmentNotice,
  GH_MINIMUM_VERSION,
  MANAGED_TOOLS,
  MANAGED_TOOL_INSTALL_METHODS,
  ManagedTool,
  ManagedToolRow,
  ManagedToolVersion,
  compareToolVersions,
  eventTypeEntry,
  managedTool,
  methods,
  registry,
} from "./index.js";

/**
 * The Managed tools table and its registry's vocabulary (key-managers spec,
 * "Managed tools"; ADR 0011, ADR 0026): the tools as data, each with its
 * minimum and verify command, the rows `tools.list` answers, the notice a
 * changed row raises and the capability flag.
 */

describe("the Managed tools table", () => {
  it("holds claude, bao, vault, doppler, op, bws and gh, in that order, each an entry of the tool schema", () => {
    expect(MANAGED_TOOLS.map((tool) => tool.name)).toEqual(["claude", "bao", "vault", "doppler", "op", "bws", "gh"]);
    for (const tool of MANAGED_TOOLS) expect(ManagedTool.parse(tool), tool.name).toEqual(tool);
  });

  it("declares the minimums: bao 2.1.1, vault 1.14.0, doppler 3.76.0, op 2.18.0, bws 0.3.0 and gh 2.40", () => {
    expect(Object.fromEntries(MANAGED_TOOLS.map((tool) => [tool.name, tool.minimum]))).toEqual({
      claude: null,
      bao: "2.1.1",
      vault: "1.14.0",
      doppler: "3.76.0",
      op: "2.18.0",
      bws: "0.3.0",
      gh: "2.40.0",
    });
    expect(managedTool("gh").minimum).toBe(GH_MINIMUM_VERSION);
  });

  it("declares each verify command as the fixed arguments after the tool's name", () => {
    expect(Object.fromEntries(MANAGED_TOOLS.map((tool) => [tool.name, tool.verify]))).toEqual({
      claude: null,
      bao: ["token", "lookup"],
      vault: ["token", "lookup"],
      doppler: ["secrets", "--only-names", "--json"],
      op: ["whoami"],
      bws: ["project", "list"],
      gh: ["auth", "status"],
    });
  });

  it("labels claude claude in your terminal and never requires it, since the harness runs the bundled binary", () => {
    expect(managedTool("claude")).toMatchObject({ label: "claude in your terminal", requiredFor: { kind: "never" } });
  });

  it("requires a key-manager CLI for its provider's injecting connection, bao or vault for OpenBao, and gh for a forge account reading gh", () => {
    expect(Object.fromEntries(MANAGED_TOOLS.map((tool) => [tool.name, tool.requiredFor]))).toEqual({
      claude: { kind: "never" },
      bao: { kind: "key-manager", provider: "openbao" },
      vault: { kind: "key-manager", provider: "openbao" },
      doppler: { kind: "key-manager", provider: "doppler" },
      op: { kind: "key-manager", provider: "onepassword" },
      bws: { kind: "key-manager", provider: "bitwarden" },
      gh: { kind: "forge-gh" },
    });
  });

  it("gives every tool that can be required a minimum and a verify command", () => {
    const requirable = MANAGED_TOOLS.filter((tool) => tool.requiredFor.kind !== "never");
    expect(requirable.length).toBeGreaterThan(0);
    for (const tool of requirable) {
      expect(tool.minimum, tool.name).not.toBeNull();
      expect(tool.verify, tool.name).not.toBeNull();
    }
    // A table entry that could be required without them is refused.
    expect(ManagedTool.safeParse({ ...managedTool("bao"), minimum: null }).success).toBe(false);
    expect(ManagedTool.safeParse({ ...managedTool("bao"), verify: null }).success).toBe(false);
    expect(ManagedTool.safeParse({ ...managedTool("bao"), verify: [] }).success).toBe(false);
    expect(ManagedTool.safeParse({ ...managedTool("bao"), verify: ["token lookup; rm -rf /"] }).success).toBe(false);
  });
});

describe("a tool's version", () => {
  it("is major, minor and an optional patch, with any prerelease or build part, and no leading v", () => {
    for (const version of ["2.40.0", "2.40", "0.3.0", "2.1.283", "2.1.0-beta.1", "1.14.0+ent"]) expect(ManagedToolVersion.safeParse(version).success, version).toBe(true);
    for (const version of ["v2.40.0", "2", "", "2.40.0 (2024-12-05)", "latest"]) expect(ManagedToolVersion.safeParse(version).success, version).toBe(false);
  });

  it("compares by its numbers, a missing patch reading as 0 and a prerelease before its release", () => {
    expect(compareToolVersions("2.40", "2.40.0")).toBe(0);
    expect(compareToolVersions("2.39.2", "2.40.0")).toBeLessThan(0);
    expect(compareToolVersions("2.100.0", "2.40.0")).toBeGreaterThan(0);
    expect(compareToolVersions("3.0.0", "2.99.99")).toBeGreaterThan(0);
    expect(compareToolVersions("2.1.1-beta.1", "2.1.1")).toBeLessThan(0);
    expect(compareToolVersions("2.1.1+build.7", "2.1.1")).toBe(0);
  });
});

describe("a Managed tools row", () => {
  const row = {
    tool: "gh",
    label: "GitHub CLI",
    path: "/usr/local/bin/gh",
    realpath: "/opt/homebrew/Cellar/gh/2.63.2/bin/gh",
    version: "2.63.2",
    minimum: "2.40.0",
    method: "homebrew",
    status: "current",
    action: "update",
  } as const;

  it("carries the tool, where it was found, its version against its minimum, its install method, one status and one action", () => {
    expect(ManagedToolRow.parse(row)).toEqual(row);
    const missing = { ...row, path: null, realpath: null, version: null, method: null, status: "not-installed", action: "install" } as const;
    expect(ManagedToolRow.parse(missing)).toEqual(missing);
    expect(ManagedToolRow.safeParse({ ...row, status: "outdated" }).success).toBe(false);
    expect(ManagedToolRow.safeParse({ ...row, action: "ignore" }).success).toBe(false);
  });

  it("reads its install method from the path's shape, the system package owner, claude's native versions directory, else manual or unknown", () => {
    expect(MANAGED_TOOL_INSTALL_METHODS).toEqual(["homebrew", "winget", "scoop", "mise", "asdf", "npm", "native", "apt", "dnf", "manual", "unknown"]);
  });
});

describe("tools.list", () => {
  it("is a read query taking an optional refresh, answering the rows in the table's order and when they were probed", () => {
    const owned = methods.filter((m) => m.name.startsWith("tools."));
    expect(Object.fromEntries(owned.map((m) => [m.name, [m.kind, m.scope]]))).toEqual({ "tools.list": ["query", "read"] });
    const list = registry["tools.list"];
    expect(list.params.safeParse({}).success).toBe(true);
    expect(list.params.safeParse({ refresh: true }).success).toBe(true);
    expect(list.params.safeParse({ refresh: "yes" }).success).toBe(false);
    expect(Object.keys(list.result.shape)).toEqual(["tools", "probedAt"]);
  });
});

describe("the tools.updated notice", () => {
  it("is on the environment stream, never in the session list, carrying the rows a probe changed", () => {
    expect(ENVIRONMENT_NOTICE_TYPES).toContain("tools.updated");
    expect(eventTypeEntry("environment", "tools.updated")?.list).toBe(false);
    const notice = {
      type: "tools.updated",
      payload: { tools: [{ tool: "op", label: "1Password CLI", path: null, realpath: null, version: null, minimum: "2.18.0", method: null, status: "not-installed", action: "install" }] },
    };
    expect(EnvironmentNotice.parse(notice)).toEqual(notice);
    expect(EnvironmentNotice.safeParse({ type: "tools.updated", payload: { tools: [] } }).success).toBe(false);
  });
});

describe("the managedTools capability flag", () => {
  it("is on the flag list, for hello and the discovery document", () => {
    expect(CAPABILITY_FLAG_LIST).toContain("managedTools");
  });
});
