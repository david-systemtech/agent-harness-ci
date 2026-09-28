import { describe, expect, it } from "vitest";
import { FORGE_KINDS, ForgeKind } from "./index.js";

/**
 * Forge origins, slugs and variable names (forge spec, "The forge account
 * record"; ADR 0020): the pure rules every client and the environment derive
 * the same names with, as tables of remote forms, hosts and URLs.
 */

describe("the forge kind", () => {
  it("is github, forgejo or gitea, with gitlab reserved beside them", () => {
    expect(FORGE_KINDS).toEqual(["github", "forgejo", "gitea", "gitlab"]);
    for (const kind of FORGE_KINDS) expect(ForgeKind.safeParse(kind).success, kind).toBe(true);
    for (const other of ["GitHub", "bitbucket", "", "gitlab.com"]) expect(ForgeKind.safeParse(other).success, other).toBe(false);
  });
});
