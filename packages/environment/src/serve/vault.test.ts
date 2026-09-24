import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileVault } from "./vault.js";

const posix = process.platform !== "win32";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agent-harness-vault-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

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

  it.runIf(posix)("tightens a vault file someone loosened", async () => {
    const path = join(tempDir(), "vault.json");
    await fileVault(path).set("k", "v");
    chmodSync(path, 0o644);
    expect(await fileVault(path).get("k")).toBe("v");
    expect(statSync(path).mode & 0o777).toBe(0o600);
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
