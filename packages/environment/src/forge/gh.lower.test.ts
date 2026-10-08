import { GH_MINIMUM_VERSION, type ManagedToolRow } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { managedGh } from "./gh.js";

/**
 * The forge's `gh` below the wire (#373): what it answers from the Managed
 * tools registry's row alone, before anything is run. The runs themselves
 * are the credential sources' tests, through the in-process environment.
 */

const missing: ManagedToolRow = {
  tool: "gh",
  label: "GitHub CLI",
  path: null,
  realpath: null,
  version: null,
  latest: null,
  minimum: GH_MINIMUM_VERSION,
  method: null,
  status: "not-installed",
  action: "install",
  command: null,
};

describe("the environment's gh over the registry's row", () => {
  it("is not installed when the row found none, running nothing", async () => {
    const gh = managedGh({ row: async () => missing, hostEnv: { PATH: "/nonexistent" } });
    expect(await gh.probe()).toEqual({ installed: false, version: null, minimum: GH_MINIMUM_VERSION, meetsMinimum: false, accounts: [] });
    expect(await gh.token("github.com", "david")).toEqual({
      outcome: "unavailable",
      message: "The gh tool is not installed. Install it to use your GitHub sign-in.",
      details: ["Needs gh 2.40.0 or later, then gh auth login --hostname github.com (as david)"],
    });
  });

  it("gives no token, and says so, when the registry has no row to give, as when the environment closes before its first probe", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const gh = managedGh({ row: () => Promise.reject(new Error("The managed tools have not been probed.")), hostEnv: { PATH: "/nonexistent" } });
    expect(await gh.token("github.com", "david")).toEqual({
      outcome: "unavailable",
      message: "agent-harness has not looked for the gh tool yet. Choose Check again.",
      details: ["The Managed tools registry has not probed gh."],
    });
    expect(await gh.probe()).toMatchObject({ installed: false, accounts: [] });
    quiet.mockRestore();
  });
});
