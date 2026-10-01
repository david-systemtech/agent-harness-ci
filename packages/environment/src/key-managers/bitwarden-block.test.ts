import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { BITWARDEN_TEST_TOKEN } from "../../test/fake-bitwarden.js";
import { installFakeBws } from "../../test/fake-bws.js";
import { BWS_INVOCATION, bitwardenBlock } from "./bitwarden-block.js";

/**
 * The Bitwarden block against bws's own option parsing (#1123): the fake bws
 * resolves its configuration file and profile as bws 0.3.0, the floor, does,
 * so what it records is where the real CLI would read and write. A host with
 * its own `~/.bws/config` and `BWS_PROFILE` stands beside the block, run
 * through a shell as a run's commands are.
 */

const { tempDir } = useCleanups();

/** The fake is a `#!/bin/sh` script on a colon-joined PATH: POSIX only, as the Managed tools suites are. */
const posix = describe.runIf(process.platform !== "win32");

const SECRET_ID = "00000000-0000-4000-8000-000000000000";

/** A host with its own bws configuration and profile, the block laid over its environment as the process environment lays it. */
const hostWithBlock = () => {
  const cli = installFakeBws(join(tempDir(), "bin"));
  const home = tempDir();
  mkdirSync(join(home, ".bws"));
  writeFileSync(join(home, ".bws", "config"), '[profiles.stray-profile-for-tests]\nserver_base = "https://stray.test"\n');
  const configPath = join(tempDir(), "bitwarden.config");
  writeFileSync(configPath, "", { mode: 0o600 });
  const env = {
    PATH: `${cli.directory}${delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    BWS_PROFILE: "stray-profile-for-tests",
    ...bitwardenBlock("https://bitwarden.test", BITWARDEN_TEST_TOKEN, configPath),
  };
  const shell = (line: string) => execFileSync("/bin/sh", ["-c", line], { env, encoding: "utf8" });
  return { cli, home, configPath, shell };
};

posix("the documented bws invocation", () => {
  it("reads the block's empty configuration and profile for each command shape, never the host's, the token in the environment alone", () => {
    const { cli, configPath, shell } = hostWithBlock();

    for (const words of ["project list", "secret list", `secret get ${SECRET_ID}`]) shell(`${BWS_INVOCATION} ${words}`);

    expect(cli.calls()).toMatchObject(
      [["project", "list"], ["secret", "list"], ["secret", "get", SECRET_ID]].map((command) => ({
        command,
        configFile: configPath,
        config: "",
        mode: 0o600,
        profile: "",
        serverUrl: "https://bitwarden.test",
      })),
    );
    for (const call of cli.calls()) expect(call.argv.join(" ")).not.toContain(BITWARDEN_TEST_TOKEN);
  });

  it("is needed: bws 0.3.0 binds no variable to its configuration file, so without the option it reads the host's ~/.bws/config", () => {
    const { cli, home, shell } = hostWithBlock();

    shell("bws project list");

    expect(cli.calls()).toMatchObject([{ command: ["project", "list"], configFile: join(home, ".bws", "config"), config: expect.stringContaining("stray-profile-for-tests"), profile: "" }]);
  });
});
