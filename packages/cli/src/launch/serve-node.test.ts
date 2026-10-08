import * as nodeFs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MOVE_RETRY_FIRST_WAIT_MS, MOVE_RETRY_LONGEST_WAIT_MS, MOVE_RETRY_MS } from "./install.js";
import { SERVE_NODE_DIRECTORY, SERVE_NODE_SOURCE_FILE, serveNode, waitForHeldCopy } from "./serve-node.js";
import { versionDirectory } from "./versions.js";

/**
 * Where the launcher runs a version's `serve` from (#1910): on Windows one
 * copy of the version's Node at a path no update changes, so Windows
 * Defender Firewall, which keys its decision on the program's path, asks
 * once and not again at every update; elsewhere the version's own Node.
 */

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A data directory holding `versions`, each with a Windows Node whose bytes name it. */
const dataDirectory = (...versions: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "agent-harness-serve-node-"));
  dirs.push(dir);
  for (const version of versions) {
    mkdirSync(join(versionDirectory(dir, version), "node"), { recursive: true });
    writeFileSync(join(versionDirectory(dir, version), "node", "node.exe"), `node of ${version}`);
  }
  return dir;
};

const stable = (dataDir: string): string => join(dataDir, SERVE_NODE_DIRECTORY, "node.exe");

describe("the Node a version's serve runs from", () => {
  it("is on Windows one path through every update, holding the Node of the version it runs", () => {
    const dataDir = dataDirectory("0.1.8", "0.1.9");
    expect(serveNode(dataDir, "0.1.8", "win32")).toEqual({ node: stable(dataDir) });
    expect(readFileSync(stable(dataDir), "utf8")).toBe("node of 0.1.8");
    expect(serveNode(dataDir, "0.1.9", "win32")).toEqual({ node: stable(dataDir) });
    expect(readFileSync(stable(dataDir), "utf8")).toBe("node of 0.1.9");
    // A rollback puts the version it goes back to in place again.
    expect(serveNode(dataDir, "0.1.8", "win32")).toEqual({ node: stable(dataDir) });
    expect(readFileSync(stable(dataDir), "utf8")).toBe("node of 0.1.8");
    expect(readdirSync(join(dataDir, SERVE_NODE_DIRECTORY)).sort()).toEqual(["node.exe", SERVE_NODE_SOURCE_FILE]);
  });

  it("is not copied again while it already holds the version's Node", () => {
    const dataDir = dataDirectory("0.1.9");
    serveNode(dataDir, "0.1.9", "win32");
    const copies: string[] = [];
    const counting = { ...nodeFs, renameSync: (from: string, to: string) => (copies.push(to), nodeFs.renameSync(from, to)) };
    expect(serveNode(dataDir, "0.1.9", "win32", counting)).toEqual({ node: stable(dataDir) });
    expect(copies).toEqual([]);
  });

  it("is copied again when a copy cut short left it naming no version, and clears what the cut-short copy staged", () => {
    const dataDir = dataDirectory("0.1.8", "0.1.9");
    serveNode(dataDir, "0.1.8", "win32");
    // Cut short after the new Node was renamed in and before its version was written.
    rmSync(join(dataDir, SERVE_NODE_DIRECTORY, SERVE_NODE_SOURCE_FILE));
    writeFileSync(stable(dataDir), "node of 0.1.9");
    writeFileSync(join(dataDir, SERVE_NODE_DIRECTORY, ".node.exe.0b1c.partial"), "half a node");
    expect(serveNode(dataDir, "0.1.8", "win32")).toEqual({ node: stable(dataDir) });
    expect(readFileSync(stable(dataDir), "utf8")).toBe("node of 0.1.8");
    expect(readdirSync(join(dataDir, SERVE_NODE_DIRECTORY)).sort()).toEqual(["node.exe", SERVE_NODE_SOURCE_FILE]);
  });

  it("is the version's own Node, with why, when the copy cannot be replaced, so the version still runs", () => {
    const dataDir = dataDirectory("0.1.8", "0.1.9");
    serveNode(dataDir, "0.1.8", "win32");
    const busy = {
      ...nodeFs,
      renameSync: () => {
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
      },
    };
    const own = join(versionDirectory(dataDir, "0.1.9"), "node", "node.exe");
    expect(serveNode(dataDir, "0.1.9", "win32", busy)).toEqual({ node: own, problem: expect.stringContaining("EPERM"), held: true });
    // Nothing staged is left, and the copy no longer claims a version, so the next start copies again.
    expect(readdirSync(join(dataDir, SERVE_NODE_DIRECTORY))).toEqual(["node.exe"]);
    expect(serveNode(dataDir, "0.1.8", "win32")).toEqual({ node: stable(dataDir) });
  });

  it("says the copy was not held when it failed for another reason, which waiting does not end", () => {
    const dataDir = dataDirectory("0.1.9");
    // A folder where the copy goes: it cannot be renamed over.
    mkdirSync(stable(dataDir), { recursive: true });
    const result = serveNode(dataDir, "0.1.9", "win32");
    expect(result).toEqual({ node: join(versionDirectory(dataDir, "0.1.9"), "node", "node.exe"), problem: expect.any(String) });
    expect(result).not.toHaveProperty("held");
  });

  it("is tried again after a hold with waits doubling to the longest, for as long as an install's move is, then not", () => {
    const waits: number[] = [];
    let waited = 0;
    for (let wait = waitForHeldCopy(waited); wait !== undefined; wait = waitForHeldCopy(waited)) {
      waits.push(wait);
      waited += wait;
    }
    expect(waits.slice(0, 6)).toEqual([MOVE_RETRY_FIRST_WAIT_MS, 200, 400, 800, 1600, MOVE_RETRY_LONGEST_WAIT_MS]);
    expect(waited).toBeLessThanOrEqual(MOVE_RETRY_MS);
    expect(waited + MOVE_RETRY_LONGEST_WAIT_MS).toBeGreaterThan(MOVE_RETRY_MS);
  });

  it("is the version's own Node on Linux and macOS, which key no firewall decision on the path, and nothing is copied", () => {
    const dataDir = dataDirectory();
    for (const platform of ["linux", "darwin"] as const) {
      expect(serveNode(dataDir, "0.1.9", platform)).toEqual({ node: join(versionDirectory(dataDir, "0.1.9"), "node", "bin", "node") });
    }
    expect(existsSync(join(dataDir, SERVE_NODE_DIRECTORY))).toBe(false);
  });
});
