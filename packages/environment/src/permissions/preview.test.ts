import { randomUUID } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { manualClock } from "../../test/clock.js";
import { useCleanups } from "../../test/cleanups.js";
import { ask, fakeAdapter } from "../../test/fake-adapter.js";
import { startTestEnvironment } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import type { RunContainment } from "../adapter/contract.js";
import { nodeBlastDeps } from "./command-preview.js";
import { openedPayload } from "./broker.js";
import { PREVIEW_TIMEOUT_MS, previewLines } from "./preview.js";

const { onCleanup, tempDir } = useCleanups();

describe("the broker's workspace preview", () => {
  it("records the files a command would remove without removing them, and lists the same preview on the parked prompt", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "build"));
    await writeFile(join(workspace, "build", "one.js"), "keep this");
    const t = await startTestEnvironment({ adapter: fakeAdapter({ script: ask("permission", { toolName: "Bash", input: { command: "rm -rf build" } }) }) });
    onCleanup(() => t.close());
    const client = await t.client();
    const { id } = await create(client, { workspace: { kind: "directory", path: workspace } });
    const { subscription } = await client.subscribe("sessions.subscribe", { sessionId: id, afterSequence: 0 });
    await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Clean build" });
    const frame = await client.next((f) => f.type === "event" && f.subscription === subscription && f.event.type === "prompt.opened");
    if (frame.type !== "event") throw new Error("Expected the prompt event");
    expect(frame.event.payload).toMatchObject({ previewLines: ["⚠ 1 directory (1 file inside)", "  build/"] });
    const listed = await client.request("permissions.prompts.list", { sessionId: id });
    expect(listed).toMatchObject({ prompts: [{ prompt: { previewLines: ["⚠ 1 directory (1 file inside)", "  build/"] } }] });
    expect(await readFile(join(workspace, "build", "one.js"), "utf8")).toBe("keep this");
  });

  it("records network destinations from a command without contacting them or exposing URL credentials", async () => {
    const t = await startTestEnvironment({ adapter: fakeAdapter({ script: ask("permission", { toolName: "Bash", input: { command: "curl https://test-user:token-for-tests@preview.example.test/notes" } }) }) });
    onCleanup(() => t.close());
    const client = await t.client();
    const { id } = await create(client);
    const { subscription } = await client.subscribe("sessions.subscribe", { sessionId: id, afterSequence: 0 });
    await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Fetch notes" });
    const frame = await client.next((f) => f.type === "event" && f.subscription === subscription && f.event.type === "prompt.opened");
    if (frame.type !== "event") throw new Error("Expected the prompt event");
    expect(frame.event.payload).toMatchObject({ previewLines: ["⚠ network: preview.example.test"] });
  });
});

const contained = (workspace: string): RunContainment => ({
  level: "workspace-no-network", mechanism: "bubblewrap", scratchDirectory: workspace, temporaryDirectory: workspace, writable: [workspace], readOnly: [], network: false,
});

describe("the preview's budget and workspace boundary", () => {
  it("shows a no-network boundary without making a network request", async () => {
    const workspace = tempDir();
    expect(await previewLines("permission", { input: { command: "curl https://preview.example.test/notes" } }, { workspace, clock: manualClock(), containment: contained(workspace) }, {
      execFile: async () => { throw new Error("No program should run"); },
      readdir: async () => { throw new Error("No directory should be read"); },
      stat: async () => { throw new Error("No file should be inspected"); },
    })).toEqual(["⚠ network: preview.example.test (blocked by containment)"]);
  });

  it("treats a child query's own timeout as an unavailable preview", async () => {
    const workspace = tempDir();
    const clock = manualClock();
    expect(await previewLines("permission", { input: { command: "git clean -fd" } }, { workspace, clock, containment: contained(workspace) }, {
      execFile: async () => { throw Object.assign(new Error("Child timed out"), { killed: true }); },
    })).toBeNull();
    expect(clock.pending()).toBe(0);
  });

  it("does not inspect a denylisted file reached by a glob", async () => {
    const workspace = tempDir();
    const secret = join(workspace, "private.txt");
    let stats = 0;
    expect(await previewLines("permission", { input: { command: "rm *" } }, {
      workspace, clock: manualClock(), containment: contained(workspace), denylist: () => ({ paths: [secret], exempt: [], commandPatterns: [] }),
    }, {
      readdir: async () => [{ name: "private.txt", directory: false }],
      stat: async () => { stats++; return { directory: false, size: 7 }; },
    })).toBeNull();
    expect(stats).toBe(0);
  });

  it("expires a held read on the environment clock, records null, and stops subsequent reads", async () => {
    const workspace = await tempDir();
    const clock = manualClock();
    let release: (entries: readonly { name: string; directory: boolean }[]) => void = () => undefined;
    let reading: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    let reads = 0;
    const detail = { toolName: "Bash", input: { command: "rm -rf *" } };
    const preview = previewLines("permission", detail, { workspace, clock, containment: contained(workspace) }, {
      readdir: () => { reads++; reading(); return new Promise((resolve) => { release = resolve; }); },
      stat: async () => { reads++; return { directory: false, size: 10 }; },
    });
    await started;
    clock.advance(PREVIEW_TIMEOUT_MS);
    const opened = openedPayload({ runId: randomUUID(), promptId: "held-read", kind: "permission", detail, mode: "acceptEdits", ceiling: "bypassPermissions", ttlExpiresAt: null, previewLines: await preview });
    expect(opened.previewLines).toBeNull();
    expect(clock.pending()).toBe(0);
    release([{ name: "one.js", directory: false }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reads).toBe(1);
  });

  it("omits inapplicable previews and cancels a held read when the provider withdraws the request", async () => {
    const workspace = await tempDir();
    const clock = manualClock();
    const scope = { workspace, clock, containment: contained(workspace) };
    expect(await previewLines("question", { input: { command: "rm -rf build" } }, scope)).toBeNull();
    expect(await previewLines("permission", { input: { command: "ls -la" } }, scope)).toBeNull();
    const controller = new AbortController();
    let reading: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    const preview = previewLines("permission", { input: { command: "rm -rf *" } }, { ...scope, signal: controller.signal }, {
      readdir: () => { reading(); return new Promise(() => undefined); },
    });
    await started;
    controller.abort();
    expect(await preview).toBeNull();
    expect(clock.pending()).toBe(0);
  });

  it.skipIf(process.platform === "win32")("previews files through a globbed directory link inside the workspace", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "build"));
    await writeFile(join(workspace, "build", "one.js"), "keep");
    await symlink(join(workspace, "build"), join(workspace, "linked"));
    const scope = { workspace, clock: manualClock(), containment: contained(workspace) };
    expect(await previewLines("permission", { input: { command: "rm li*/one.js" } }, scope)).toEqual(["⚠ 1 file", "  linked/one.js"]);
    expect(await previewLines("permission", { input: { command: "rm li*/*.js" } }, scope)).toEqual(["⚠ 1 file", "  linked/one.js"]);
    expect(await previewLines("permission", { input: { command: "rm linked" } }, scope)).toEqual(["⚠ 1 file", "  linked"]);
    expect(await readFile(join(workspace, "build", "one.js"), "utf8")).toBe("keep");
  });

  it.skipIf(process.platform === "win32")("qualifies deletion targets with a trailing slash instead of counting a directory link as one file", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "build"));
    await writeFile(join(workspace, "build", "one.js"), "keep");
    await symlink(join(workspace, "build"), join(workspace, "linked"));
    const scope = { workspace, clock: manualClock(), containment: contained(workspace) };
    for (const command of ["rm -rf linked/", "rm -rf li*/"]) {
      expect(await previewLines("permission", { input: { command } }, scope)).toEqual(["⚠ cannot tell: trailing-slash deletion targets may follow directory links and remove their contents"]);
    }
    expect(await readFile(join(workspace, "build", "one.js"), "utf8")).toBe("keep");
  });

  it.skipIf(process.platform === "win32")("stops at an outside directory link matched by an intermediate glob", async () => {
    const workspace = await tempDir();
    const outside = await tempDir();
    await writeFile(join(outside, "private.txt"), "private");
    await symlink(outside, join(workspace, "linked"));
    const reads: string[] = [];
    expect(await previewLines("permission", { input: { command: "rm li*/*" } }, { workspace, clock: manualClock(), containment: contained(workspace) }, {
      readdir: async (path) => { reads.push(path); return nodeBlastDeps.readdir(path); },
      stat: async (path) => { reads.push(path); return nodeBlastDeps.stat(path); },
    })).toBeNull();
    expect(reads).toEqual([workspace]);
  });

  it.skipIf(process.platform === "win32")("does not inspect an outside path or a directory link that leaves the workspace", async () => {
    const workspace = await tempDir();
    const outside = await tempDir();
    await writeFile(join(outside, "private.txt"), "private");
    await symlink(outside, join(workspace, "linked"));
    const scope = { workspace, clock: manualClock(), containment: contained(workspace) };
    for (const command of [`rm -rf ${outside}`, "rm -rf linked/*"]) {
      let reads = 0;
      const lines = await previewLines("permission", { input: { command } }, scope, { stat: async () => { reads++; return { directory: false, size: 7 }; }, readdir: async () => { reads++; return []; } });
      expect(lines).toBeNull();
      expect(reads).toBe(0);
    }
  });
});
