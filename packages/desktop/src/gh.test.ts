import { afterEach, describe, expect, it } from "vitest";
import { fakeElectron } from "../test/fake-electron.js";
import { cleanUp, platformOn, start } from "../test/harness.js";
import type { GhProcess, GhRan } from "./gh.js";

afterEach(cleanUp);

/**
 * The shell's `gh` (forge spec, "Credentials": the attending client's
 * `gh`; ADR 0032; #419): the token this computer's `gh` holds for a host,
 * as `gh auth token --hostname <host>` prints it, which the renderer hands
 * over once. Driven with `gh`'s process faked: no `gh` runs.
 */

/** A fake `gh`: answers each run as `answer` says, and records what it was run with. */
const fakeGh = (answer: (args: readonly string[]) => GhRan | "not-installed" | Error) => {
  const runs: { readonly args: readonly string[]; readonly env: Readonly<Record<string, string | undefined>> }[] = [];
  const process: GhProcess = {
    run: async (args, env) => {
      runs.push({ args, env });
      const answered = answer(args);
      if (answered === "not-installed") throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
      if (answered instanceof Error) throw answered;
      return answered;
    },
  };
  return { process, runs };
};

describe("gh", () => {
  it("answers the token gh prints for the host, run without the token variables so it reports the account gh stores", async () => {
    const gh = fakeGh(() => ({ code: 0, stdout: "token-for-tests\n" }));
    const { shell } = await start({ gh: gh.process, environment: { PATH: "/usr/bin", GH_TOKEN: "env-token-for-tests", GITHUB_TOKEN: "env-token-for-tests", HOME: "/home/milo" } });

    expect(await shell().gh.token("github.com")).toBe("token-for-tests");
    expect(await shell().gh.token("git.example.test:8443")).toBe("token-for-tests");
    expect(gh.runs.map((run) => run.args)).toEqual([
      ["auth", "token", "--hostname", "github.com"],
      ["auth", "token", "--hostname", "git.example.test:8443"],
    ]);
    const [{ env } = { env: {} }] = gh.runs;
    expect(env).toMatchObject({ HOME: "/home/milo" });
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) expect(env).not.toHaveProperty(name);
  });

  it("answers no token where gh is not installed, or is not signed in to the host", async () => {
    const missing = fakeGh(() => "not-installed");
    const { shell } = await start({ gh: missing.process });
    expect(await shell().gh.token("github.com")).toBeUndefined();

    const signedOut = fakeGh(() => ({ code: 1, stdout: "" }));
    const again = await start({ gh: signedOut.process });
    expect(await again.shell().gh.token("github.com")).toBeUndefined();
  });

  it("fails, saying why, where gh could not be run for another reason", async () => {
    const gh = fakeGh(() => new Error("gh did not answer within 10 seconds"));
    const { shell } = await start({ gh: gh.process });
    await expect(shell().gh.token("github.com")).rejects.toThrow("gh did not answer within 10 seconds");
  });

  it("refuses a host that is no host, running nothing", async () => {
    const gh = fakeGh(() => ({ code: 0, stdout: "token-for-tests\n" }));
    const { shell } = await start({ gh: gh.process });
    for (const host of ["--help", "github.com/david", "https://github.com", "", 42]) await expect(shell().gh.token(host as string)).rejects.toThrow();
    expect(gh.runs).toEqual([]);
  });

  it("looks where a package manager puts gh as well as on the PATH a desktop launch is given, on macOS", async () => {
    const gh = fakeGh(() => ({ code: 0, stdout: "token-for-tests\n" }));
    const { shell } = await start({ electron: fakeElectron({ os: "darwin" }), platform: platformOn("darwin"), gh: gh.process, environment: { PATH: "/usr/bin:/bin" } });
    await shell().gh.token("github.com");
    expect(gh.runs[0]?.env["PATH"]?.split(":")).toEqual(["/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin"]);
  });

  it("runs without the token variables in any casing on Windows, whose variable names are case-insensitive, and leaves its Path as it is", async () => {
    const gh = fakeGh(() => ({ code: 0, stdout: "token-for-tests\n" }));
    const environment = { Path: "C:\\Program Files\\GitHub CLI", gh_token: "env-token-for-tests", Github_Token: "env-token-for-tests", USERPROFILE: "C:\\Users\\milo" };
    const { shell } = await start({ electron: fakeElectron({ os: "win32" }), platform: platformOn("win32"), gh: gh.process, environment });
    expect(await shell().gh.token("github.com")).toBe("token-for-tests");
    expect(gh.runs[0]?.env).toEqual({ Path: "C:\\Program Files\\GitHub CLI", USERPROFILE: "C:\\Users\\milo" });
  });
});
