import { registry } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment } from "../../test/helper.js";

/**
 * The environment for a uid with no passwd entry (a container started with
 * an arbitrary `--user`), where `os.userInfo()` throws on POSIX: it still
 * starts, and its denylist reads `~` as the home directory. `userInfo` is
 * made to throw for this whole file.
 */

vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  const userInfo = (): never => {
    throw Object.assign(new Error("A system error occurred: uv_os_get_passwd returned ENOENT (no such file or directory)"), { code: "ERR_SYSTEM_ERROR" });
  };
  return { ...os, default: { ...os, userInfo }, userInfo };
});

const { onCleanup } = useCleanups();

describe("an environment whose uid has no passwd entry", () => {
  it("starts, and its denylist still reads ~ as the home directory", async () => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const client = await t.client();
    const { matches } = registry["permissions.denylist.test"].result.parse(await client.request("permissions.denylist.test", { kind: "path", value: "~/.ssh/id_rsa" }));
    expect(matches.map((match) => match.entry.pattern)).toEqual(["~/.ssh"]);
  });
});
