import { describe, expect, it } from "vitest";
import { inWorkspace } from "./paths.js";

/** A path a tool call or a person gave, placed in the session's workspace or refused as outside it. */

describe("a path in the workspace", () => {
  it("is relative to it: an absolute path under it made relative, one outside it none", () => {
    expect(inWorkspace("/home/milo/code/src/a.ts", "/home/milo/code")).toBe("src/a.ts");
    expect(inWorkspace("src/a.ts", "/home/milo/code")).toBe("src/a.ts");
    expect(inWorkspace("/etc/hosts", "/home/milo/code")).toBeNull();
    expect(inWorkspace("../x", "/home/milo/code")).toBeNull();
  });

  it("places no absolute path in a workspace not known yet, where /etc/x would read as etc/x", () => {
    expect(inWorkspace("/etc/x", "")).toBeNull();
    expect(inWorkspace("src/a.ts", "")).toBe("src/a.ts");
  });

  it("reads a Windows environment's paths, backslashes and a drive, as the same paths with forward slashes", () => {
    expect(inWorkspace("C:\\repo\\src\\a.ts", "C:\\repo")).toBe("src/a.ts");
    expect(inWorkspace("c:/repo/src/a.ts", "C:\\repo\\")).toBe("src/a.ts");
    expect(inWorkspace("src\\a.ts", "C:\\repo")).toBe("src/a.ts");
    expect(inWorkspace("D:\\other\\a.ts", "C:\\repo")).toBeNull();
    expect(inWorkspace("C:\\repository\\a.ts", "C:\\repo")).toBeNull();
    expect(inWorkspace("..\\..\\x", "C:\\repo")).toBeNull();
    expect(inWorkspace("src\\..\\..\\x", "C:\\repo")).toBeNull();
    expect(inWorkspace("\\\\server\\share\\a.ts", "C:\\repo")).toBeNull();
    expect(inWorkspace("C:\\x", "")).toBeNull();
  });

  it("leaves a backslash in a POSIX name as the name's own", () => {
    expect(inWorkspace("/home/milo/code/a\\b.ts", "/home/milo/code")).toBe("a\\b.ts");
  });
});
