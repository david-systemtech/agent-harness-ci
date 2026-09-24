import { describe, expect, it } from "vitest";
import { mandatoryLevel, PrivilegeCheckError, processUserCheck, ROOT_REFUSAL, rootRefusal } from "./user.js";

const WHOAMI_MEDIUM = `
GROUP INFORMATION
-----------------

Group Name                             Type             SID          Attributes
====================================== ================ ============ ==================================================
Everyone                               Well-known group S-1-1-0      Mandatory group, Enabled by default, Enabled group
BUILTIN\\Users                          Alias            S-1-5-32-545 Mandatory group, Enabled by default, Enabled group
Mandatory Label\\Medium Mandatory Level Label            S-1-16-8192
`;

const WHOAMI_HIGH = WHOAMI_MEDIUM.replace(
  "Mandatory Label\\Medium Mandatory Level Label            S-1-16-8192",
  "Mandatory Label\\High Mandatory Level   Label            S-1-16-12288",
);
const WHOAMI_SYSTEM = WHOAMI_MEDIUM.replace("S-1-16-8192", "S-1-16-16384");

/** A stubbed spawn that records what it was asked to run and answers `output`, or throws it. */
const stubRun = (output: string | Error) => {
  const calls: { file: string; args: readonly string[] }[] = [];
  const run = (file: string, args: readonly string[]): string => {
    calls.push({ file, args });
    if (output instanceof Error) throw output;
    return output;
  };
  return { run, calls };
};

describe("the refusal sentence", () => {
  it("is one sentence, and stays one with the clause for a check that could not run", () => {
    const oneSentence = /^[A-Za-z][^.\n]*\.$/;
    expect(ROOT_REFUSAL).toMatch(oneSentence);
    expect(rootRefusal()).toBe(ROOT_REFUSAL);
    const withClause = rootRefusal("whoami.exe could not run: spawn ENOENT");
    expect(withClause).toMatch(/^[A-Za-z][^\n]*\.$/);
    expect(withClause.startsWith(ROOT_REFUSAL.slice(0, -1))).toBe(true);
    expect(withClause).toContain("could not run");
  });
});

describe("the privileged-user check on POSIX", () => {
  it("finds root by the effective uid, and by the real uid", () => {
    expect(processUserCheck({ platform: "linux", geteuid: () => 0, getuid: () => 0 }).isPrivileged()).toBe(true);
    expect(processUserCheck({ platform: "darwin", geteuid: () => 0, getuid: () => 501 }).isPrivileged()).toBe(true);
    expect(processUserCheck({ platform: "linux", geteuid: () => 1000, getuid: () => 0 }).isPrivileged()).toBe(true);
    expect(processUserCheck({ platform: "linux", geteuid: () => 1000, getuid: () => 1000 }).isPrivileged()).toBe(false);
  });
});

describe("the privileged-user check on Windows", () => {
  it("reads the mandatory level from whoami /groups", () => {
    expect(mandatoryLevel(WHOAMI_MEDIUM)).toBe(8192);
    expect(mandatoryLevel(WHOAMI_HIGH)).toBe(12288);
    expect(mandatoryLevel(WHOAMI_SYSTEM)).toBe(16384);
    expect(mandatoryLevel("")).toBeUndefined();
    expect(mandatoryLevel("S-1-16-8192x")).toBeUndefined();
  });

  it("runs whoami.exe by its absolute path under SystemRoot, never through PATH", () => {
    const stub = stubRun(WHOAMI_MEDIUM);
    const check = processUserCheck({ platform: "win32", env: { SystemRoot: "D:\\Windows", PATH: "C:\\evil" }, run: stub.run });
    expect(check.isPrivileged()).toBe(false);
    expect(stub.calls).toEqual([{ file: "D:\\Windows\\System32\\whoami.exe", args: ["/groups"] }]);
  });

  it("falls back to C:\\Windows when SystemRoot is unset", () => {
    const stub = stubRun(WHOAMI_MEDIUM);
    processUserCheck({ platform: "win32", env: {}, run: stub.run }).isPrivileged();
    expect(stub.calls[0]?.file).toBe("C:\\Windows\\System32\\whoami.exe");
  });

  it("finds an elevated token by its High or System mandatory level", () => {
    for (const [output, privileged] of [
      [WHOAMI_MEDIUM, false],
      [WHOAMI_HIGH, true],
      [WHOAMI_SYSTEM, true],
    ] as const) {
      expect(processUserCheck({ platform: "win32", env: {}, run: stubRun(output).run }).isPrivileged()).toBe(privileged);
    }
  });

  it("fails closed when whoami cannot run", () => {
    const check = processUserCheck({ platform: "win32", env: {}, run: stubRun(new Error("spawn ENOENT")).run });
    expect(() => check.isPrivileged()).toThrow(PrivilegeCheckError);
    expect(() => check.isPrivileged()).toThrow(/could not run.*spawn ENOENT/);
  });

  it("fails closed when whoami's output names no mandatory level", () => {
    const check = processUserCheck({ platform: "win32", env: {}, run: stubRun("Access is denied.").run });
    expect(() => check.isPrivileged()).toThrow(PrivilegeCheckError);
  });
});
