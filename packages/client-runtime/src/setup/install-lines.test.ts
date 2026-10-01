import type { ReleaseSource } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { installLines } from "./install-lines.js";

/**
 * Add a machine's Install on another machine (the Set up spec, "Add a
 * machine"; launcher-update spec; #577): a line per platform fetching the
 * install script from the environment's own release, with the token handed
 * to curl on its standard input, run with the environment's channel and the
 * name given; and the container's compose snippet with the host-side
 * updater's documentation.
 */

const FORGEJO: ReleaseSource = { origin: "https://git.systemtech.dev:5526", kind: "forgejo", repository: "david/agent-harness" };
const RELEASE = "https://git.systemtech.dev:5526/david/agent-harness/releases/download/v0.4.2";
const TOKEN_TO_CURL = `printf 'header = "Authorization: token %s"\\n' "$AGENT_HARNESS_TOKEN" | curl -K - -fsSL`;

describe("the install lines", () => {
  it("pipe install.sh into sh and make a script block of install.ps1, with the channel and no name when none is given", () => {
    const lines = installLines({ releaseSource: FORGEJO, version: "0.4.2", channel: "stable", name: "" });
    expect(lines.unix).toBe(`${TOKEN_TO_CURL} ${RELEASE}/install.sh | sh -s -- --channel stable`);
    expect(lines.windows).toBe(
      `& ([scriptblock]::Create((('header = "Authorization: token ' + $env:AGENT_HARNESS_TOKEN + '"') | curl.exe -K - -fsSL ${RELEASE}/install.ps1) -join "\`n")) -Channel stable`,
    );
  });

  it("pass the name, quoted for each shell, and the beta channel", () => {
    const lines = installLines({ releaseSource: FORGEJO, version: "0.4.2", channel: "beta", name: "  Seth's box " });
    expect(lines.unix).toBe(`${TOKEN_TO_CURL} ${RELEASE}/install.sh | sh -s -- --channel beta --name 'Seth'\\''s box'`);
    expect(lines.windows.endsWith(" -Channel beta -Name 'Seth''s box'")).toBe(true);
    expect(installLines({ releaseSource: FORGEJO, version: "0.4.2", channel: "stable", name: "build-box" }).unix.endsWith(" --channel stable --name build-box")).toBe(true);
  });

  it("fetch the release's compose file, log in to its registry, start it and read its log, and link the host-side updater's documentation at that release", () => {
    const lines = installLines({ releaseSource: FORGEJO, version: "0.4.2", channel: "beta", name: "box" });
    expect(lines.compose).toEqual([
      `${TOKEN_TO_CURL} -o compose.yaml ${RELEASE}/compose.yaml`,
      "docker login git.systemtech.dev:5526",
      "docker compose up -d",
      "docker compose logs environment",
    ]);
    expect(lines.updaterDocs).toBe("https://git.systemtech.dev:5526/david/agent-harness/src/tag/v0.4.2/docs/host-updater.md");
    expect(installLines({ releaseSource: { origin: "https://github.com", kind: "github", repository: "owner/name" }, version: "1.0.0", channel: "stable", name: "" }).updaterDocs).toBe(
      "https://github.com/owner/name/blob/v1.0.0/docs/host-updater.md",
    );
  });
});
