import type { ReleaseSource } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { installLines } from "./install-lines.js";

/**
 * Add a device's Install agent-harness on another computer (setup-copy.md
 * §5.5; launcher-update spec; #577, #1847): a line per platform fetching the
 * install script from the environment's own release, with the token handed
 * to curl on its standard input, run with the environment's channel and the
 * name given; and the container's compose snippet with the host-side
 * updater's documentation.
 */

const FORGEJO: ReleaseSource = { origin: "https://git.example.test", kind: "forgejo", repository: "david/agent-harness" };
const RELEASE = "https://git.example.test/david/agent-harness/releases/download/v0.4.2";
const TOKEN_TO_CURL = `printf 'header = "Authorization: token %s"\\n' "$AGENT_HARNESS_TOKEN" | curl -K - -fsSL`;

describe("the install lines", () => {
  it("downloads public GitHub installers anonymously, even when a private forge token is set in the user's shell", () => {
    const lines = installLines({ releaseSource: { origin: "https://github.com", kind: "github", repository: "owner/name" }, version: "0.4.2", channel: "beta", name: "Build box" });
    expect(lines.unix).toBe("curl -fsSL https://github.com/owner/name/releases/download/v0.4.2/install.sh | sh -s -- --channel beta --name 'Build box'");
    expect(lines.windows).toBe("& ([scriptblock]::Create((curl.exe -fsSL https://github.com/owner/name/releases/download/v0.4.2/install.ps1) -join \"`n\")) -Channel beta -Name 'Build box'");
    expect([lines.unix, lines.windows].join("\n")).not.toMatch(/AGENT_HARNESS_TOKEN|Authorization/);
  });

  it("fetches the versioned public compose file and updater together, makes the updater executable and starts without a registry login", () => {
    const lines = installLines({ releaseSource: { origin: "https://github.com", kind: "github", repository: "owner/name" }, version: "0.4.2", channel: "beta", name: "box" });
    expect(lines.compose).toEqual([
      "curl -fsSL -o compose.yaml https://github.com/owner/name/releases/download/v0.4.2/compose.yaml",
      "curl -fsSL -o host-updater.sh https://github.com/owner/name/releases/download/v0.4.2/host-updater.sh",
      "chmod +x host-updater.sh",
      "AGENT_HARNESS_CHANNEL=beta AGENT_HARNESS_NAME=box docker compose up -d",
      "docker compose logs environment",
    ]);
  });

  it("pipe install.sh into sh and make a script block of install.ps1, with the channel and no name when none is given", () => {
    const lines = installLines({ releaseSource: FORGEJO, version: "0.4.2", channel: "stable", name: "" });
    expect(lines.unix).toBe(`${TOKEN_TO_CURL} ${RELEASE}/install.sh | sh -s -- --channel stable`);
    expect(lines.windows).toBe(
      `& ([scriptblock]::Create((('header = "Authorization: token ' + $env:AGENT_HARNESS_TOKEN + '"') | curl.exe -K - -fsSL ${RELEASE}/install.ps1) -join "\`n")) -Channel stable`,
    );
  });

  it("pass the name, quoted for each shell, and the beta channel", () => {
    const lines = installLines({ releaseSource: FORGEJO, version: "0.4.2", channel: "beta", name: "  Milo's box " });
    expect(lines.unix).toBe(`${TOKEN_TO_CURL} ${RELEASE}/install.sh | sh -s -- --channel beta --name 'Milo'\\''s box'`);
    expect(lines.windows.endsWith(" -Channel beta -Name 'Milo''s box'")).toBe(true);
    expect(installLines({ releaseSource: FORGEJO, version: "0.4.2", channel: "stable", name: "build-box" }).unix.endsWith(" --channel stable --name build-box")).toBe(true);
  });

  it("fetch the release's compose file, log in to its registry, start it with the channel and the name for its first start, read its log, and link the host-side updater's documentation at that release", () => {
    const lines = installLines({ releaseSource: FORGEJO, version: "0.4.2", channel: "beta", name: "box" });
    expect(lines.compose).toEqual([
      `${TOKEN_TO_CURL} -o compose.yaml ${RELEASE}/compose.yaml`,
      `${TOKEN_TO_CURL} -o host-updater.sh ${RELEASE}/host-updater.sh`,
      "chmod +x host-updater.sh",
      "docker login git.example.test",
      "AGENT_HARNESS_CHANNEL=beta AGENT_HARNESS_NAME=box docker compose up -d",
      "docker compose logs environment",
    ]);
    expect(lines.updaterDocs).toBe("https://git.example.test/david/agent-harness/src/tag/v0.4.2/docs/host-updater.md");
    expect(installLines({ releaseSource: { origin: "https://github.com", kind: "github", repository: "owner/name" }, version: "1.0.0", channel: "stable", name: "" }).updaterDocs).toBe(
      "https://github.com/owner/name/blob/v1.0.0/docs/host-updater.md",
    );
  });

  it("start the container with the channel alone when no name is given, and the name quoted for sh when one is", () => {
    expect(installLines({ releaseSource: FORGEJO, version: "0.4.2", channel: "stable", name: "  " }).compose[4]).toBe("AGENT_HARNESS_CHANNEL=stable docker compose up -d");
    expect(installLines({ releaseSource: FORGEJO, version: "0.4.2", channel: "beta", name: "  Milo's box " }).compose[4]).toBe(
      "AGENT_HARNESS_CHANNEL=beta AGENT_HARNESS_NAME='Milo'\\''s box' docker compose up -d",
    );
  });
});
