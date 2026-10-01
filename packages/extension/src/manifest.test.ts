import { EXTENSION_MANIFEST_KEY } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { extensionManifest } from "./manifest.js";

/** The manifest's content policy for its own pages, as directive name to its sources. */
const policyOf = (manifest: ReturnType<typeof extensionManifest>): Map<string, string[]> =>
  new Map(
    manifest.content_security_policy.extension_pages
      .split(";")
      .map((directive) => directive.trim().split(/\s+/))
      .filter((parts) => parts[0] !== "")
      .map(([name, ...sources]) => [name ?? "", sources]),
  );

describe("the manifest", () => {
  it("carries the fixed id's key, so Chrome gives the folder the id the listener admits on every machine", () => {
    expect(extensionManifest("1.2.3").key).toBe(EXTENSION_MANIFEST_KEY);
  });

  it("asks for no host permission: the worker reaches its environment on loopback through its content policy alone", () => {
    const manifest: Record<string, unknown> = extensionManifest("1.2.3");
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
    expect(manifest.permissions).toEqual(["alarms", "storage"]);
  });

  it("admits only the extension itself and loopback in its content policy", () => {
    const policy = policyOf(extensionManifest("1.2.3"));
    expect(policy.get("default-src")).toEqual(["'self'"]);
    expect(policy.get("script-src")).toEqual(["'self'"]);
    expect(policy.get("object-src")).toEqual(["'self'"]);
    expect(policy.get("connect-src")).toEqual(["'self'", "ws://127.0.0.1:*"]);
    expect([...policy.values()].flat().every((source) => source === "'self'" || source === "ws://127.0.0.1:*")).toBe(true);
  });

  it("names the harness version as its version name, and Chrome's version as that version's numbers", () => {
    expect(extensionManifest("1.2.3")).toMatchObject({ version: "1.2.3", version_name: "1.2.3" });
    expect(extensionManifest("0.4.0-rc.2")).toMatchObject({ version: "0.4.0", version_name: "0.4.0-rc.2" });
    expect(extensionManifest("2.0.1+build.7")).toMatchObject({ version: "2.0.1", version_name: "2.0.1+build.7" });
  });

  it("refuses a harness version Chrome's version field cannot take", () => {
    expect(() => extensionManifest("1.2")).toThrow(/1\.2 is not a harness version/);
    expect(() => extensionManifest("v1.2.3")).toThrow(/v1\.2\.3 is not a harness version/);
    expect(() => extensionManifest("1.70000.0")).toThrow(/65535/);
  });

  it("runs its worker as a module and opens its options page in a tab", () => {
    expect(extensionManifest("1.2.3")).toMatchObject({
      manifest_version: 3,
      name: "agent-harness",
      background: { service_worker: "worker.js", type: "module" },
      options_ui: { page: "options.html", open_in_tab: true },
    });
  });
});
