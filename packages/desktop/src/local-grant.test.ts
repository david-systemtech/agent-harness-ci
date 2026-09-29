import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOOTSTRAP_GRANT_FILE } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { cleanUp, platformOn, start } from "../test/harness.js";

afterEach(cleanUp);

/**
 * The shell's `localGrant` (docs/specs/gui.md, "The desktop shell"): the
 * bootstrap grant this machine's environment writes in its data directory,
 * read for the runtime, which exchanges it over loopback.
 */

const GRANT = { secret: "grant-secret-for-tests", address: { host: "127.0.0.1", port: 7433 } };

describe("localGrant", () => {
  it("reads the grant file in this machine's environment's data directory", async () => {
    const platform = platformOn("linux");
    writeFileSync(join(platform.paths.environment, BOOTSTRAP_GRANT_FILE), JSON.stringify(GRANT));
    const { shell } = await start({ platform });
    expect(await shell().localGrant.read()).toEqual(GRANT);
  });

  it("answers none while there is no grant file, and reads the one the environment writes once its service runs", async () => {
    const platform = platformOn("linux");
    const { shell } = await start({ platform });
    expect(await shell().localGrant.read()).toBeUndefined();
    writeFileSync(join(platform.paths.environment, BOOTSTRAP_GRANT_FILE), JSON.stringify(GRANT));
    expect(await shell().localGrant.read()).toEqual(GRANT);
  });

  it("answers none for a file no environment wrote", async () => {
    const platform = platformOn("linux");
    const { shell } = await start({ platform });
    for (const text of ["{", "null", JSON.stringify({ secret: "", address: GRANT.address }), JSON.stringify({ secret: "s", address: { host: "127.0.0.1", port: 0 } })]) {
      writeFileSync(join(platform.paths.environment, BOOTSTRAP_GRANT_FILE), text);
      expect(await shell().localGrant.read()).toBeUndefined();
    }
  });

  it("answers none for a file it cannot read, and says so once until a read succeeds again", async () => {
    const platform = platformOn("linux");
    const reported: unknown[] = [];
    const { shell } = await start({ platform, reportError: (error) => reported.push(error) });
    const path = join(platform.paths.environment, BOOTSTRAP_GRANT_FILE);
    mkdirSync(path);
    expect(await shell().localGrant.read()).toBeUndefined();
    expect(await shell().localGrant.read()).toBeUndefined();
    expect(reported.map(String)).toEqual([expect.stringContaining(`The grant file ${path} cannot be read`)]);

    rmSync(path, { recursive: true });
    writeFileSync(path, JSON.stringify(GRANT));
    expect(await shell().localGrant.read()).toEqual(GRANT);
    rmSync(path);
    mkdirSync(path);
    await shell().localGrant.read();
    expect(reported).toHaveLength(2);
  });
});
