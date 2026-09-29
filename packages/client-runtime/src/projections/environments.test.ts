import { describe, expect, it } from "vitest";
import { homeEnvironment, type EnvironmentView } from "./environments.js";

/**
 * The home environment (docs/specs/gui.md, "Theme": painting; "Settings":
 * scopes): the local one on the desktop, else the primary one. It presets
 * an `environment` row's picker and gives the window its theme.
 */

const view = (environmentId: string, kind: EnvironmentView["kind"], primary = false) => ({ environmentId, kind, primary }) as EnvironmentView;

describe("the home environment", () => {
  it("is the local environment wherever it stands in the sequence", () => {
    expect(homeEnvironment([view("lab", "paired", true), view("desk", "local")])?.environmentId).toBe("desk");
  });

  it("is the primary environment where there is no local one, and none where there is no environment", () => {
    expect(homeEnvironment([view("mnl", "paired"), view("lab", "paired", true)])?.environmentId).toBe("lab");
    expect(homeEnvironment([])).toBeUndefined();
  });
});
