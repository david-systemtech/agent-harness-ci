import { describe, expect, it } from "vitest";
import { isElevatedToken, processUserCheck, ROOT_REFUSAL } from "./user.js";

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

describe("the privileged-user check", () => {
  it("is one sentence", () => {
    expect(ROOT_REFUSAL).toMatch(/^[A-Za-z][^.\n]*\.$/);
  });

  it("finds root by the effective uid, and by the real uid, on POSIX", () => {
    expect(processUserCheck({ platform: "linux", geteuid: () => 0, getuid: () => 0 }).isPrivileged()).toBe(true);
    expect(processUserCheck({ platform: "darwin", geteuid: () => 0, getuid: () => 501 }).isPrivileged()).toBe(true);
    expect(processUserCheck({ platform: "linux", geteuid: () => 1000, getuid: () => 0 }).isPrivileged()).toBe(true);
    expect(processUserCheck({ platform: "linux", geteuid: () => 1000, getuid: () => 1000 }).isPrivileged()).toBe(false);
  });

  it("finds an elevated Windows token by its High or System mandatory level", () => {
    expect(isElevatedToken(WHOAMI_MEDIUM)).toBe(false);
    expect(isElevatedToken(WHOAMI_HIGH)).toBe(true);
    expect(isElevatedToken(WHOAMI_SYSTEM)).toBe(true);
    expect(isElevatedToken("S-1-16-122880")).toBe(false);
    expect(processUserCheck({ platform: "win32", whoamiGroups: () => WHOAMI_HIGH }).isPrivileged()).toBe(true);
    expect(processUserCheck({ platform: "win32", whoamiGroups: () => WHOAMI_MEDIUM }).isPrivileged()).toBe(false);
  });

  it("counts a whoami that cannot run as not privileged", () => {
    const failing = () => {
      throw new Error("spawn whoami ENOENT");
    };
    expect(processUserCheck({ platform: "win32", whoamiGroups: failing }).isPrivileged()).toBe(false);
  });
});
