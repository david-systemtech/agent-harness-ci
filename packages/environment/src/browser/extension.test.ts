import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PORT_FILE_NAME, PortFile, type ResultOf } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { TEST_EXTENSION, TEST_EXTENSION_VERSION, writeExtensionBuild } from "../../test/fake-extension.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { WAIT_MS } from "../../test/wire-client.js";

/**
 * The extension's folder, its port file and its listener through the primary
 * seam (browser spec, "The extension, its folder and its listener" and
 * "Testing Decisions"; ADR 0024; #547): the in-process environment with the
 * listener's preferred port set to 0 and a fixture extension folder as the
 * built extension it carries, the fake extension dialling it over a real
 * WebSocket, and a typed client reading `browser.status` and
 * `environment.subscribe`. What is asserted is what Chrome and the
 * extension find (the folder's files, the port file, the socket's answers)
 * and what a client sees.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

const folderOf = (t: Pick<TestEnvironment, "dataDir">): string => join(t.dataDir, "extension", "current");

const status = async (t: TestEnvironment): Promise<ResultOf<"browser.status">> => {
  const client = await t.client();
  try {
    return (await client.request("browser.status", {})) as ResultOf<"browser.status">;
  } finally {
    await client.close();
  }
};

const portFileIn = (folder: string): PortFile => PortFile.parse(JSON.parse(readFileSync(join(folder, PORT_FILE_NAME), "utf8")));

describe("the extension's folder", () => {
  it("is the built extension copied to extension/current at startup, with the port file written into it once the listener is bound", async () => {
    const t = await start({ name: "Laptop", harnessVersion: "1.0.0-test" });
    const folder = folderOf(t);

    expect(readdirSync(folder).sort()).toEqual(["manifest.json", PORT_FILE_NAME, "worker.js"]);
    expect(readFileSync(join(folder, "manifest.json"), "utf8")).toBe(readFileSync(join(TEST_EXTENSION, "manifest.json"), "utf8"));
    const answer = await status(t);
    expect(answer).toEqual({
      listener: { state: "listening", port: expect.any(Number) as number },
      folder: { path: folder, problem: null },
      shippedVersion: TEST_EXTENSION_VERSION,
      unpairedConnected: false,
    });
    const port = answer.listener.state === "listening" ? answer.listener.port : 0;
    expect(portFileIn(folder)).toEqual({ port, environmentId: t.env.id, environmentName: "Laptop", harnessVersion: "1.0.0-test" });
    // No staging folder is left beside it.
    expect(readdirSync(join(t.dataDir, "extension"))).toEqual(["current"]);
    expect(existsSync(join(folder, `${PORT_FILE_NAME}.tmp`))).toBe(false);
  });

  it("is left as it is by a start of the same version, which writes only the port file again", async () => {
    const dataDir = join(tempDir("agent-harness-extension-"), "data");
    const first = await start({ dataDir });
    const folder = folderOf(first);
    await first.close();
    // Something the copy would never make: a folder copied again would lose it.
    writeFileSync(join(folder, "left-by-chrome.txt"), "kept");

    const second = await start({ dataDir });
    const answer = await status(second);

    expect(readFileSync(join(folder, "left-by-chrome.txt"), "utf8")).toBe("kept");
    expect(answer).toMatchObject({ folder: { path: folder, problem: null }, shippedVersion: TEST_EXTENSION_VERSION });
    expect(portFileIn(folder).port).toBe(answer.listener.state === "listening" ? answer.listener.port : undefined);
  });

  it("is replaced whole by a start of another harness version over the same data directory: the new manifest, and no file of the old", async () => {
    const dataDir = join(tempDir("agent-harness-extension-"), "data");
    const older = writeExtensionBuild(tempDir("agent-harness-build-"), "0.9.0", { "old-worker.js": "// 0.9.0" });
    const newer = writeExtensionBuild(tempDir("agent-harness-build-"), "1.1.0", { "new-worker.js": "// 1.1.0" });
    const first = await start({ dataDir, harnessVersion: "0.9.0", browser: { extensionSource: older } });
    const folder = folderOf(first);
    expect(readdirSync(folder).sort()).toEqual(["manifest.json", "old-worker.js", PORT_FILE_NAME]);
    await first.close();

    const second = await start({ dataDir, harnessVersion: "1.1.0", browser: { extensionSource: newer } });

    expect(readdirSync(folder).sort()).toEqual(["manifest.json", "new-worker.js", PORT_FILE_NAME]);
    expect(readFileSync(join(folder, "manifest.json"), "utf8")).toBe(readFileSync(join(newer, "manifest.json"), "utf8"));
    expect(portFileIn(folder)).toMatchObject({ environmentId: second.env.id, harnessVersion: "1.1.0" });
    expect(await status(second)).toMatchObject({ folder: { path: folder, problem: null }, shippedVersion: "1.1.0" });
    // The staging folder was renamed into place and the old folder removed: nothing is left beside it.
    expect(readdirSync(join(dataDir, "extension"))).toEqual(["current"]);
  });

  it("is made again, with its port file, when browser.status finds it missing", async () => {
    const t = await start();
    const folder = folderOf(t);
    const before = portFileIn(folder);
    rmSync(folder, { recursive: true, force: true });

    const answer = await status(t);

    expect(answer).toMatchObject({ folder: { path: folder, problem: null }, shippedVersion: TEST_EXTENSION_VERSION });
    expect(readdirSync(folder).sort()).toEqual(["manifest.json", PORT_FILE_NAME, "worker.js"]);
    expect(portFileIn(folder)).toEqual(before);
  });

  it("is not made when the environment carries no built extension, and browser.status says so, with no shipped version", async () => {
    const t = await start({ browser: { extensionSource: join(tempDir("agent-harness-build-"), "absent") } });

    const answer = await status(t);

    expect(answer.shippedVersion).toBeNull();
    expect(answer.folder.problem).toMatch(/^This environment carries no built extension/);
    expect(existsSync(folderOf(t))).toBe(false);
  });
});

describe("the port file", () => {
  it("follows a rename of the environment, so the extension's options page names it as it is now", async () => {
    const t = await start({ name: "Laptop" });
    const admin = await t.client();

    await admin.apply("environment.rename", { commandId: randomUUID(), name: "Work laptop" });

    await expect.poll(() => portFileIn(folderOf(t)).environmentName, { timeout: WAIT_MS }).toBe("Work laptop");
    expect(portFileIn(folderOf(t))).toMatchObject({ environmentId: t.env.id });
  });
});
