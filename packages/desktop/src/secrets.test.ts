import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeElectron } from "../test/fake-electron.js";
import { cleanUp, platformOn, start } from "../test/harness.js";

afterEach(cleanUp);

/**
 * The shell's `secrets` (docs/specs/gui.md, "The desktop shell"): the client
 * session tokens the runtime keeps by environment id, one file each in the
 * desktop's data directory, encrypted by Electron's `safeStorage` under the
 * key the OS keeps for the app.
 */

const DESK = "0199aa00-0000-7000-8000-00000000d35c";
const LAPTOP = "0199aa00-0000-7000-8000-0000000019a7";

describe("secrets", () => {
  it("keeps each token in a file of its own, encrypted, which a later launch reads back", async () => {
    const platform = platformOn("linux");
    const first = await start({ platform });
    await first.shell().secrets.set(DESK, "token-for-tests-desk");
    await first.shell().secrets.set(LAPTOP, "token-for-tests-laptop");

    const folder = join(platform.paths.data, "secrets");
    expect(readdirSync(folder).sort()).toEqual([`${LAPTOP}.secret`, `${DESK}.secret`].sort());
    const kept = readFileSync(join(folder, `${DESK}.secret`));
    expect(kept.toString("latin1")).toMatch(/^v11/);
    expect(kept.toString("utf8")).not.toContain("token-for-tests");
    expect(statSync(join(folder, `${DESK}.secret`)).mode & 0o777).toBe(0o600);
    expect(statSync(folder).mode & 0o777).toBe(0o700);

    const next = await start({ platform });
    expect(await next.shell().secrets.get(DESK)).toBe("token-for-tests-desk");
    expect(await next.shell().secrets.get(LAPTOP)).toBe("token-for-tests-laptop");
  });

  it("replaces a token, forgets one without touching another, and answers none for one it never kept", async () => {
    const { shell } = await start();
    await shell().secrets.set(DESK, "token-for-tests-1");
    await shell().secrets.set(DESK, "token-for-tests-2");
    await shell().secrets.set(LAPTOP, "token-for-tests-laptop");
    await shell().secrets.delete(DESK);
    await shell().secrets.delete(DESK);

    expect(await shell().secrets.get(DESK)).toBeUndefined();
    expect(await shell().secrets.get(LAPTOP)).toBe("token-for-tests-laptop");
    expect(await shell().secrets.get("0199aa00-0000-7000-8000-000000000000")).toBeUndefined();
  });

  it("keeps a name that is not a plain file name inside its folder", async () => {
    const platform = platformOn("linux");
    const { shell } = await start({ platform });
    await shell().secrets.set("../escaped", "token-for-tests");
    expect(readdirSync(platform.paths.data)).not.toContain("escaped.secret");
    expect(await shell().secrets.get("../escaped")).toBe("token-for-tests");
  });

  it("on Linux with no secret service, keeps tokens under Chromium's fixed key, and says once that they are stored unprotected", async () => {
    const electron = fakeElectron({ os: "linux" });
    electron.safeStorage.backend = "basic_text";
    const reported: unknown[] = [];
    const platform = platformOn("linux");
    const { shell } = await start({ electron, platform, reportError: (error) => reported.push(error) });

    await shell().secrets.set(DESK, "token-for-tests-desk");
    await shell().secrets.set(LAPTOP, "token-for-tests-laptop");
    expect(await shell().secrets.get(DESK)).toBe("token-for-tests-desk");
    expect(electron.safeStorage.plainText).toBe(true);
    expect(readFileSync(join(platform.paths.data, "secrets", `${DESK}.secret`)).toString("latin1")).toMatch(/^v10/);
    expect(reported.map(String)).toEqual([expect.stringMatching(/no secret service.*unprotected/i)]);
  });

  it("refuses to keep a token where the OS keeps no key for the app, keeping nothing, and takes one it cannot read as none, saying why", async () => {
    const electron = fakeElectron({ os: "darwin" });
    const reported: unknown[] = [];
    const platform = platformOn("darwin");
    const { shell } = await start({ electron, platform, reportError: (error) => reported.push(error) });
    await shell().secrets.set(DESK, "token-for-tests-desk");

    electron.safeStorage.keychain = false;
    await expect(shell().secrets.set(LAPTOP, "token-for-tests-laptop")).rejects.toThrow(/cannot keep a client session token/);
    expect(readdirSync(join(platform.paths.data, "secrets"))).toEqual([`${DESK}.secret`]);
    expect(await shell().secrets.get(DESK)).toBeUndefined();

    electron.safeStorage.keychain = true;
    electron.safeStorage.changeKey();
    expect(await shell().secrets.get(DESK)).toBeUndefined();
    expect(reported.map(String)).toEqual([expect.stringMatching(/cannot read the token kept for 0199aa00/), expect.stringMatching(/cannot read the token kept for 0199aa00/)]);
  });

  it("answers none for a token file it cannot read at all, saying why", async () => {
    const reported: unknown[] = [];
    const platform = platformOn("linux");
    const { shell } = await start({ platform, reportError: (error) => reported.push(error) });
    mkdirSync(join(platform.paths.data, "secrets", `${DESK}.secret`), { recursive: true });
    expect(await shell().secrets.get(DESK)).toBeUndefined();
    expect(reported.map(String)).toEqual([expect.stringMatching(/cannot read the token kept for 0199aa00.*EISDIR/)]);
  });

  it("refuses a name or a token that is not text", async () => {
    const { shell } = await start();
    const secrets = shell().secrets as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    await expect(secrets["set"]?.(7, "token-for-tests")).rejects.toThrow(/name must be text/);
    await expect(secrets["set"]?.(DESK, { token: 1 })).rejects.toThrow(/secret must be text/);
    await expect(secrets["get"]?.("")).rejects.toThrow(/name must not be empty/);
  });
});
