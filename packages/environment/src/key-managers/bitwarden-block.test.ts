import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { BITWARDEN_TEST_TOKEN } from "../../test/fake-bitwarden.js";
import { type FakeBwsVersion, installFakeBws } from "../../test/fake-bws.js";
import { composeRunEnvironment } from "../adapters/claude/credentials.js";
import { BWS_INVOCATION, bitwardenHolderBlock } from "./bitwarden-block.js";

/**
 * The Bitwarden block against bws's own option parsing (#1123) and state
 * file (#1141): the fake bws resolves its configuration file, profile, server
 * and state file as each release does, so what it records is where the real
 * CLI would read and write. A host with its own `~/.bws/config` and stray
 * `BWS_` variables stands beside the block, laid over it as a Claude
 * process's environment is, and run through a shell as a run's commands are.
 */

const { tempDir } = useCleanups();

/** The fake is a `#!/bin/sh` script on a colon-joined PATH: POSIX only, as the Managed tools suites are. */
const posix = describe.runIf(process.platform !== "win32");

const SECRET_ID = "00000000-0000-4000-8000-000000000000";
const ADDRESS = "https://bitwarden.test";
const HOST_CONFIG = '[profiles.stray-profile-for-tests]\nserver_base = "https://stray.test"\n';
/** Every release the fake models, from the 0.3 floor. */
const RELEASES: FakeBwsVersion[] = ["0.3.0", "0.4.0", "0.5.0", "1.0.0", "2.0.0", "2.1.0"];
/** The access token id the fake names a state file after for the suites' plain token. */
const TOKEN_ID = "access-token-id-for-tests";

/** A host with its own bws configuration and stray variables, and a holder's folder with the block the supplier gives it. */
const hostWithBlock = async (version: FakeBwsVersion) => {
  const cli = installFakeBws(join(tempDir(), "bin"), version);
  const home = tempDir();
  mkdirSync(join(home, ".bws"));
  writeFileSync(join(home, ".bws", "config"), HOST_CONFIG);
  const holder = tempDir();
  const block = await bitwardenHolderBlock(holder, ADDRESS, BITWARDEN_TEST_TOKEN);
  const host = {
    PATH: `${cli.directory}${delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    BWS_PROFILE: "stray-profile-for-tests",
    BWS_SERVER_URL: "https://stray.test",
    BWS_CONFIG_FILE: join(home, ".bws", "config"),
  };
  const env = composeRunEnvironment(host, tempDir(), {}, block);
  const shell = (line: string, overrides: Record<string, string> = {}) => execFileSync("/bin/sh", ["-c", line], { env: { ...env, ...overrides }, encoding: "utf8" });
  return { cli, home, holder, block, shell };
};

posix("the documented bws invocation", () => {
  it.each(RELEASES)(
    "at bws %s reads the holder's configuration and profile for each command shape, reaches the connection's server, and keeps its state, if any, in the holder's folder, never under the host's ~/.bws",
    async (version) => {
      const { cli, home, holder, block, shell } = await hostWithBlock(version);

      for (const words of ["project list", "secret list", `secret get ${SECRET_ID}`]) shell(`${BWS_INVOCATION} ${words}`);

      // bws keeps no state at 0.3, and before 1.0.0 only where the profile names a state_file_dir.
      const stateFile = version === "0.3.0" ? null : join(holder, "state", TOKEN_ID);
      expect(cli.calls()).toMatchObject(
        [["project", "list"], ["secret", "list"], ["secret", "get", SECRET_ID]].map((command) => ({
          command,
          configFile: join(holder, "config"),
          mode: 0o600,
          profile: "default",
          serverUrl: null,
          server: ADDRESS,
          stateFile,
        })),
      );
      expect(block).toEqual({ BWS_ACCESS_TOKEN: BITWARDEN_TEST_TOKEN, BWS_CONFIG_FILE: join(holder, "config"), BWS_PROFILE: "default" });
      for (const call of cli.calls()) expect(call.argv.join(" ")).not.toContain(BITWARDEN_TEST_TOKEN);
      expect(existsSync(join(home, ".bws", "state"))).toBe(false);
      expect(readFileSync(join(home, ".bws", "config"), "utf8")).toBe(HOST_CONFIG);
    },
  );

  it("is needed: bws 0.3.0 binds no variable to its configuration file, so without the option it reads the host's ~/.bws/config", async () => {
    const { cli, home, shell } = await hostWithBlock("0.3.0");

    shell("bws project list");

    expect(cli.calls()).toMatchObject([{ command: ["project", "list"], configFile: join(home, ".bws", "config"), config: HOST_CONFIG, profile: "default" }]);
  });

  it("is needed: from 1.0.0 a server URL makes the profile from itself alone, reading no configuration, so bws keeps its state under the host's ~/.bws/state", async () => {
    for (const version of ["0.5.0", "1.0.0", "2.1.0"] as const) {
      const { cli, home, shell } = await hostWithBlock(version);

      shell(`${BWS_INVOCATION} project list`, { BWS_SERVER_URL: ADDRESS });

      const [call] = cli.calls();
      expect(call).toMatchObject({ serverUrl: ADDRESS, server: ADDRESS, stateFile: version === "0.5.0" ? null : join(home, ".bws", "state", TOKEN_ID) });
      expect(existsSync(join(home, ".bws", "state", TOKEN_ID))).toBe(version !== "0.5.0");
    }
  });
});
