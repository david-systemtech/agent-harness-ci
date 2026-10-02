import { describe, expect, it } from "vitest";
import { browse, directoryOf, typedPath } from "./browse.js";

/**
 * `/files`' picker over `files.list` (docs/specs/tui.md, "The composer"): the
 * listing is flat, so a directory is every path under it; the picker shows
 * one directory at a time, its directories first with how many files each
 * holds, then its files, and a filter typed at it finds files anywhere
 * under it.
 */

const FILES = ["README.md", "package.json", "src/app.tsx", "src/files/browse.ts", "src/files/pages.ts", "test/harness.ts"];

describe("browsing the listing", () => {
  it("shows the root's directories first, each with its file count, then its files, by name", () => {
    expect(browse(FILES, "", "")).toEqual([
      { kind: "dir", path: "src", name: "src/", files: 3 },
      { kind: "dir", path: "test", name: "test/", files: 1 },
      { kind: "file", path: "README.md", name: "README.md" },
      { kind: "file", path: "package.json", name: "package.json" },
    ]);
  });

  it("leads a directory below the root with the way up", () => {
    expect(browse(FILES, "src", "")).toEqual([
      { kind: "up", path: "", name: "../" },
      { kind: "dir", path: "src/files", name: "files/", files: 2 },
      { kind: "file", path: "src/app.tsx", name: "app.tsx" },
    ]);
    expect(browse(FILES, "src/files", "")[0]).toEqual({ kind: "up", path: "src", name: "../" });
  });

  it("finds a typed filter in the paths anywhere under the directory, ignoring case", () => {
    expect(browse(FILES, "", "PAGES")).toEqual([{ kind: "file", path: "src/files/pages.ts", name: "src/files/pages.ts" }]);
    expect(browse(FILES, "src", "ts")).toEqual([
      { kind: "file", path: "src/app.tsx", name: "app.tsx" },
      { kind: "file", path: "src/files/browse.ts", name: "files/browse.ts" },
      { kind: "file", path: "src/files/pages.ts", name: "files/pages.ts" },
    ]);
  });
});

describe("a path typed after /files", () => {
  it("is the path as the listing writes it, relative to the workspace: no leading ./, no trailing /, . the root", () => {
    expect(typedPath("src/app.tsx", "/home/milo/code")).toBe("src/app.tsx");
    expect(typedPath(" ./src/files/ ", "/home/milo/code")).toBe("src/files");
    expect(typedPath(".", "/home/milo/code")).toBe("");
  });

  it("takes an absolute path inside the workspace as the path under it, and refuses one outside it", () => {
    expect(typedPath("/home/milo/code/src/app.tsx", "/home/milo/code")).toBe("src/app.tsx");
    expect(typedPath("/home/milo/code/src/", "/home/milo/code/")).toBe("src");
    expect(typedPath("/home/milo/code", "/home/milo/code")).toBe("");
    expect(typedPath("/etc/hosts", "/home/milo/code")).toBeNull();
    expect(typedPath("/", "/home/milo/code")).toBeNull();
  });

  it("refuses a relative path that climbs out of the workspace, as it refuses an absolute one outside it", () => {
    expect(typedPath("../secrets", "/home/milo/code")).toBeNull();
    expect(typedPath("..", "/home/milo/code")).toBeNull();
    expect(typedPath("src/../../x", "/home/milo/code")).toBeNull();
    expect(typedPath("src/..", "/home/milo/code")).toBe("");
    expect(typedPath("src/../app.tsx", "/home/milo/code")).toBe("app.tsx");
  });

  it("resolves an absolute path's dot segments before it is placed in the workspace", () => {
    expect(typedPath("/home/milo/code/src/../app.tsx", "/home/milo/code")).toBe("app.tsx");
    expect(typedPath("/home/milo/code/./src/app.tsx", "/home/milo/code")).toBe("src/app.tsx");
    expect(typedPath("/home/milo/code/src/..", "/home/milo/code")).toBe("");
    expect(typedPath("/home/milo/other/../code/app.tsx", "/home/milo/code")).toBe("app.tsx");
    expect(typedPath("/home/milo/code/../secrets", "/home/milo/code")).toBeNull();
    expect(typedPath("/..", "/home/milo/code")).toBeNull();
    expect(typedPath("C:\\code\\src\\..\\app.tsx", "C:\\code")).toBe("app.tsx");
  });

  it("reads a path typed for a Windows environment's workspace with forward slashes, a drive's absolute path under it as the path under it", () => {
    expect(typedPath("src\\files\\", "C:\\code")).toBe("src/files");
    expect(typedPath("C:\\code\\src\\app.tsx", "C:\\code")).toBe("src/app.tsx");
    expect(typedPath("c:\\code\\", "C:\\code")).toBe("");
    expect(typedPath("D:\\elsewhere\\x", "C:\\code")).toBeNull();
  });

  it("names a file's directory", () => {
    expect(directoryOf("src/files/pages.ts")).toBe("src/files");
    expect(directoryOf("README.md")).toBe("");
  });
});
