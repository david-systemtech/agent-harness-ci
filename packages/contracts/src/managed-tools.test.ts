import { describe, expect, it } from "vitest";
import {
  CAPABILITY_FLAG_LIST,
  DoctorToolName,
  ENVIRONMENT_NOTICE_TYPES,
  EnvironmentNotice,
  GH_MINIMUM_VERSION,
  MANAGED_TOOLS,
  MANAGED_TOOL_INSTALL_METHODS,
  ManagedTool,
  ManagedToolDetail,
  ManagedToolRow,
  ManagedToolVerification,
  ManagedToolVersion,
  compareToolVersions,
  eventTypeEntry,
  keyManagerCliRow,
  keyManagerClis,
  managedTool,
  methods,
  registry,
} from "./index.js";

/**
 * The Managed tools table and its registry's vocabulary (key-managers spec,
 * "Managed tools"; ADR 0011, ADR 0026): the tools as data, each with its
 * minimum and verify command, the rows `tools.list` answers with the latest
 * version known (#374), a key-manager connection's CLI row, what
 * `tools.verify` answers (#375), what `tools.detail` answers (#374), the
 * notice a changed row raises and the capability flag.
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
    latest: "2.63.2",
    minimum: "2.40.0",
    method: "homebrew",
    status: "current",
    action: "update",
    command: null,
  } as const;

  it("carries the tool, where it was found, its version against its minimum and the latest known, its install method, one status and one action", () => {
    expect(ManagedToolRow.parse(row)).toEqual(row);
    const behind = { ...row, latest: "2.101.0", status: "update-available" } as const;
    expect(ManagedToolRow.parse(behind)).toEqual(behind);
    const missing = { ...row, path: null, realpath: null, version: null, latest: null, method: null, status: "not-installed", action: "install", command: null } as const;
    expect(ManagedToolRow.parse(missing)).toEqual(missing);
    expect(ManagedToolRow.safeParse({ ...row, status: "outdated" }).success).toBe(false);
    expect(ManagedToolRow.safeParse({ ...row, action: "ignore" }).success).toBe(false);
    expect(ManagedToolRow.safeParse({ ...row, latest: "v2.101.0" }).success).toBe(false);
    expect(ManagedToolRow.safeParse(Object.fromEntries(Object.entries(row).filter(([key]) => key !== "latest"))).success).toBe(false);
  });

  it("carries, on a Copy row, the vendor's documented command to copy, one line, and none on a row whose action runs (#426)", () => {
    const copy = { ...row, realpath: "/home/david/.local/share/mise/installs/gh/2.63.2/bin/gh", method: "mise", action: "copy", command: "brew install gh" } as const;
    expect(ManagedToolRow.parse(copy)).toEqual(copy);
    expect(ManagedToolRow.safeParse({ ...copy, command: "brew install gh\nbrew install doppler" }).success).toBe(false);
    expect(ManagedToolRow.safeParse({ ...copy, command: "" }).success).toBe(false);
    expect(ManagedToolRow.safeParse(Object.fromEntries(Object.entries(row).filter(([key]) => key !== "command"))).success).toBe(false);
  });

  it("reads its install method from the path's shape, the system package owner, claude's native versions directory, else manual or unknown", () => {
    expect(MANAGED_TOOL_INSTALL_METHODS).toEqual(["homebrew", "winget", "scoop", "mise", "asdf", "npm", "native", "apt", "dnf", "manual", "unknown"]);
  });
});

describe("a key-manager connection's CLI", () => {
  const row = (tool: "bao" | "vault" | "doppler", version: string | null): ManagedToolRow => {
    const { label, minimum } = managedTool(tool);
    return version === null
      ? { tool, label, path: null, realpath: null, version: null, latest: null, minimum, method: null, status: "not-installed", action: "install", command: null }
      : { tool, label, path: `/usr/bin/${tool}`, realpath: `/usr/bin/${tool}`, version, latest: null, minimum, method: "apt", status: "current", action: "update", command: null };
  };

  it("is served by the tools the table requires for its provider: bao or vault for OpenBao, doppler, op and bws for the others", () => {
    expect(keyManagerClis("openbao")).toEqual(["bao", "vault"]);
    expect(keyManagerClis("doppler")).toEqual(["doppler"]);
    expect(keyManagerClis("onepassword")).toEqual(["op"]);
    expect(keyManagerClis("bitwarden")).toEqual(["bws"]);
  });

  it("is bao's row when bao is installed, else vault's when vault is, else bao's, not installed", () => {
    expect(keyManagerCliRow("openbao", [row("bao", "2.6.3"), row("vault", "1.15.0")])).toEqual(row("bao", "2.6.3"));
    expect(keyManagerCliRow("openbao", [row("bao", null), row("vault", "1.15.0")])).toEqual(row("vault", "1.15.0"));
    expect(keyManagerCliRow("openbao", [row("vault", null), row("bao", null)])).toEqual(row("bao", null));
    expect(keyManagerCliRow("doppler", [row("bao", "2.6.3"), row("doppler", null)])).toEqual(row("doppler", null));
  });
});

describe("tools.verify", () => {
  it("is an admin query naming a tool with a verify command, claude having none", () => {
    const verify = registry["tools.verify"];
    for (const tool of ["bao", "vault", "doppler", "op", "bws", "gh"]) expect(verify.params.safeParse({ tool }).success, tool).toBe(true);
    for (const params of [{ tool: "claude" }, { tool: "codex" }, {}]) expect(verify.params.safeParse(params).success, JSON.stringify(params)).toBe(false);
    expect(MANAGED_TOOLS.filter((tool) => tool.verify !== null).map((tool) => tool.name)).toEqual(["bao", "vault", "doppler", "op", "bws", "gh"]);
  });

  it("answers the tool, passed, failed or not installed, and one line saying why", () => {
    const passed = { tool: "bao", outcome: "passed", reason: "bao looked up its run token at https://bao.example.com:8200: policies default, reader." } as const;
    expect(registry["tools.verify"].result.parse(passed)).toEqual(passed);
    expect(ManagedToolVerification.parse({ ...passed, outcome: "failed", reason: "OpenBao at https://bao.example.com:8200 is sealed: unseal it, then verify again." })).toMatchObject({ outcome: "failed" });
    expect(ManagedToolVerification.parse({ tool: "gh", outcome: "not-installed", reason: "gh is not installed on this environment." })).toMatchObject({ outcome: "not-installed" });
    expect(ManagedToolVerification.safeParse({ ...passed, outcome: "unknown" }).success).toBe(false);
    expect(ManagedToolVerification.safeParse({ ...passed, reason: "two\nlines" }).success).toBe(false);
    expect(ManagedToolVerification.safeParse({ ...passed, reason: "" }).success).toBe(false);
  });
});

describe("tools.detail", () => {
  const claude = {
    tool: "claude",
    label: "claude in your terminal",
    path: "/home/david/.local/bin/claude",
    realpath: "/home/david/.local/share/claude/versions/2.1.283",
    version: "2.1.283",
    latest: "2.1.285",
    minimum: null,
    method: "native",
    status: "update-available",
    action: "update",
    command: null,
  } as const;
  const read = {
    outcome: "read",
    method: "npm",
    fields: [
      { name: "Running", value: "npm-global (2.1.283)" },
      { name: "Config install method", value: "unknown" },
    ],
    warnings: [{ issue: "Running native installation but config install method is 'unknown'", fix: "Run claude install to update configuration" }],
  } as const;

  it("is a read query naming a tool with a doctor command, which only claude has", () => {
    const detail = registry["tools.detail"];
    expect(detail.params.safeParse({ tool: "claude" }).success).toBe(true);
    for (const params of [{ tool: "gh" }, { tool: "bao" }, { tool: "codex" }, {}]) expect(detail.params.safeParse(params).success, JSON.stringify(params)).toBe(false);
    expect(DoctorToolName.options).toEqual(["claude"]);
  });

  it("answers the row, whose method is the one detected, beside the fields doctor printed and the method it reports, so a difference shows", () => {
    const answer = { tool: "claude", row: claude, doctor: read };
    expect(registry["tools.detail"].result.parse(answer)).toEqual(answer);
    expect(ManagedToolDetail.parse({ ...answer, doctor: { ...read, method: null, warnings: [{ issue: "Multiple installations found", fix: null }] } })).toMatchObject({ doctor: { method: null } });
    expect(ManagedToolDetail.parse({ ...answer, doctor: { outcome: "failed", reason: "claude doctor gave no answer within 30 s." } })).toMatchObject({ doctor: { outcome: "failed" } });
    expect(ManagedToolDetail.parse({ ...answer, doctor: { outcome: "not-installed" } })).toMatchObject({ doctor: { outcome: "not-installed" } });
    expect(ManagedToolDetail.safeParse({ ...answer, doctor: { ...read, method: "npm-global" } }).success).toBe(false);
    expect(ManagedToolDetail.safeParse({ ...answer, doctor: { outcome: "failed", reason: "two\nlines" } }).success).toBe(false);
    expect(ManagedToolDetail.safeParse({ ...answer, doctor: { ...read, fields: [{ name: "", value: "x" }] } }).success).toBe(false);
    expect(ManagedToolDetail.safeParse({ ...answer, tool: "gh" }).success).toBe(false);
  });
});

describe("tools.list", () => {
  it("is a read query taking an optional refresh, answering the rows in the table's order and when they were probed; tools.detail a read query, tools.verify an admin one and tools.run an admin command", () => {
    const owned = methods.filter((m) => m.name.startsWith("tools."));
    expect(Object.fromEntries(owned.map((m) => [m.name, [m.kind, m.scope]]))).toEqual({
      "tools.list": ["query", "read"],
      "tools.detail": ["query", "read"],
      "tools.verify": ["query", "admin"],
      "tools.run": ["command", "admin"],
    });
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
      payload: { tools: [{ tool: "op", label: "1Password CLI", path: null, realpath: null, version: null, latest: null, minimum: "2.18.0", method: null, status: "not-installed", action: "install", command: null }] },
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
