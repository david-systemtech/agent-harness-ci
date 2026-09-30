import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArgumentsError, desktopBuildOptionsOf } from "./arguments.js";

/** The desktop build's command line (#423): one platform, the tag, the server artefact and the out folder, each needed. */

const cwd = join("/", "work", "checkout");

describe("the desktop build's command line", () => {
  it("takes the platform, the tag, the server artefact and the out folder, a relative path read from where pnpm was run", () => {
    expect(
      desktopBuildOptionsOf(["--platform", "linux-x64", "--tag", "v0.5.0", "--server", "release-assets/agent-harness-linux-x64.tar.gz", "--out", "desktop-assets"], cwd),
    ).toEqual({
      platform: "linux-x64",
      tag: "v0.5.0",
      server: join(cwd, "release-assets", "agent-harness-linux-x64.tar.gz"),
      out: join(cwd, "desktop-assets"),
    });
  });

  it("refuses a command line missing any of the four, or with an option it does not take", () => {
    const whole = ["--platform", "linux-x64", "--tag", "v0.5.0", "--server", "a.tar.gz", "--out", "out"];
    for (const missing of ["--platform", "--tag", "--server", "--out"]) {
      const at = whole.indexOf(missing);
      const args = [...whole.slice(0, at), ...whole.slice(at + 2)];
      expect(() => desktopBuildOptionsOf(args, cwd), missing).toThrow(new ArgumentsError("--platform, --tag, --server and --out are each needed: the platform, the release's tag, its server artefact for that platform, and the folder the desktop is written to."));
    }
    expect(() => desktopBuildOptionsOf([...whole, "--sign"], cwd)).toThrow(ArgumentsError);
    expect(() => desktopBuildOptionsOf([...whole, "extra"], cwd)).toThrow(ArgumentsError);
  });
});
