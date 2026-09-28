import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fileVault } from "./vault.js";

const posix = process.platform !== "win32";

const { tempDir } = useCleanups();

describe("the file vault", () => {
  it("keeps a value across instances on the same file", async () => {
    const path = join(tempDir(), "vault.json");
    await fileVault(path).set("k", "v1");
    await fileVault(path).set("other", "v2");
    const reopened = fileVault(path);
    expect(await reopened.get("k")).toBe("v1");
    expect(await reopened.get("other")).toBe("v2");
    expect(await reopened.get("missing")).toBeUndefined();
  });

  it("answers undefined without creating the file when nothing was stored", async () => {
    const path = join(tempDir(), "vault.json");
    expect(await fileVault(path).get("k")).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  it("writes by rename, leaving no temporary file behind", async () => {
    const dir = tempDir();
    await fileVault(join(dir, "vault.json")).set("k", "v");
    expect(readdirSync(dir)).toEqual(["vault.json"]);
  });

  it.runIf(posix)("is a file only its owner can read or write", async () => {
    const path = join(tempDir(), "vault.json");
    await fileVault(path).set("k", "v");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.runIf(posix)("tightens a vault file someone loosened when it is opened", async () => {
    const path = join(tempDir(), "vault.json");
    await fileVault(path).set("k", "v");
    chmodSync(path, 0o644);
    const reopened = fileVault(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await reopened.get("k")).toBe("v");
  });

  it("deletes an entry, keeping the others", async () => {
    const path = join(tempDir(), "vault.json");
    const vault = fileVault(path);
    await vault.set("k", "v1");
    await vault.set("other", "v2");
    await vault.delete("k");
    const reopened = fileVault(path);
    expect(await reopened.get("k")).toBeUndefined();
    expect(await reopened.get("other")).toBe("v2");
    expect(await reopened.keys()).toEqual(["other"]);
  });

  it("deletes an absent entry as no error, without creating the file", async () => {
    const path = join(tempDir(), "vault.json");
    await fileVault(path).delete("missing");
    expect(existsSync(path)).toBe(false);
    await fileVault(path).set("k", "v");
    await fileVault(path).delete("missing");
    expect(await fileVault(path).get("k")).toBe("v");
  });

  it.runIf(posix)("keeps its 0600 mode through a delete", async () => {
    const path = join(tempDir(), "vault.json");
    const vault = fileVault(path);
    await vault.set("k", "v");
    await vault.set("other", "v");
    await vault.delete("k");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("lists the keys it holds, none before anything was stored", async () => {
    const path = join(tempDir(), "vault.json");
    expect(await fileVault(path).keys()).toEqual([]);
    await fileVault(path).set("k", "v1");
    await fileVault(path).set("other", "v2");
    expect(await fileVault(path).keys()).toEqual(["k", "other"]);
  });

  it("refuses a vault file that is not a JSON object of strings, and leaves it as it was", async () => {
    const path = join(tempDir(), "vault.json");
    for (const content of ["not json", "[1]", '{"k": 1}']) {
      writeFileSync(path, content);
      await expect(fileVault(path).get("k")).rejects.toThrow(/vault/);
      await expect(fileVault(path).set("k", "v")).rejects.toThrow(/vault/);
      expect(readFileSync(path, "utf8")).toBe(content);
    }
  });
});
