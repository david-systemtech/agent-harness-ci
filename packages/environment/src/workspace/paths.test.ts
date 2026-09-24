import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInWorkspace } from "./paths.js";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A workspace with `src/a.ts`, a sibling directory outside it holding `secret.txt`, and links both ways. */
const workspace = () => {
  const base = mkdtempSync(join(tmpdir(), "agent-harness-paths-"));
  made.push(base);
  const root = join(base, "workspace");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export {};\n");
  mkdirSync(join(base, "outside"));
  writeFileSync(join(base, "outside", "secret.txt"), "secret\n");
  symlinkSync(join(base, "outside"), join(root, "escape"));
  symlinkSync(join(base, "outside", "secret.txt"), join(root, "secret-link"));
  symlinkSync(join(root, "src", "a.ts"), join(root, "inside-link"));
  return { base, root };
};

/** The error `promise` rejects with. */
const refusal = async (promise: Promise<unknown>): Promise<ContractError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw error;
  }
  throw new Error("It resolved.");
};

describe("a path inside a session's workspace", () => {
  it("resolves a relative path to the file inside, with forward slashes", async () => {
    const { root } = workspace();
    const resolved = await resolveInWorkspace(root, "src/a.ts");
    expect(resolved.relative).toBe("src/a.ts");
    expect(resolved.absolute.endsWith(join("workspace", "src", "a.ts"))).toBe(true);
    expect((await resolveInWorkspace(root, "./src//a.ts")).relative).toBe("src/a.ts");
  });

  it("follows a symlink that stays inside the workspace", async () => {
    const { root } = workspace();
    const resolved = await resolveInWorkspace(root, "inside-link");
    expect(resolved.absolute.endsWith(join("src", "a.ts"))).toBe(true);
  });

  it.each([
    ["a .. segment", "../outside/secret.txt"],
    ["a .. segment in the middle", "src/../../outside/secret.txt"],
    ["a backslashed .. segment", "src\\..\\..\\outside\\secret.txt"],
    ["an absolute path", "/etc/passwd"],
    ["a Windows drive path", "C:\\Windows\\win.ini"],
    ["a NUL byte", "src/a.ts\0.png"],
  ])("refuses %s invalid_params, reason escapes_workspace", async (_what, path) => {
    const { root } = workspace();
    const error = await refusal(resolveInWorkspace(root, path));
    expect(error.code).toBe("invalid_params");
    expect(error.data).toMatchObject({ reason: "escapes_workspace", issues: [{ path: ["path"] }] });
  });

  it("refuses a symlink that leads outside the workspace, to a directory or a file", async () => {
    const { root } = workspace();
    for (const path of ["escape/secret.txt", "secret-link"]) {
      const error = await refusal(resolveInWorkspace(root, path));
      expect(error.code, path).toBe("invalid_params");
      expect(error.data, path).toMatchObject({ reason: "escapes_workspace" });
    }
  });

  it("answers a path with nothing there not_found, kind file", async () => {
    const { root } = workspace();
    const error = await refusal(resolveInWorkspace(root, "src/missing.ts"));
    expect(error.code).toBe("not_found");
    expect(error.data).toEqual({ kind: "file", path: "src/missing.ts" });
  });
});
