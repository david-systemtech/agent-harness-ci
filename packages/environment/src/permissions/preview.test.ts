import { randomUUID } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { manualClock } from "../../test/clock.js";
import { useCleanups } from "../../test/cleanups.js";
import { ask, fakeAdapter, gate } from "../../test/fake-adapter.js";
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
  it.each(["EACCES", "EIO"])("reports unavailable reads (%s) through the broker preview boundary", async (code) => {
    const workspace = await tempDir();
    await mkdir(join(workspace, "build", "nested"), { recursive: true });
    await writeFile(join(workspace, "build", "one.js"), "keep");
    await writeFile(join(workspace, "build", "nested", "two.js"), "keep");
    await writeFile(join(workspace, "protected.txt"), "keep");
    const scope = { workspace, clock: manualClock(), containment: contained(workspace) };
    const cannotRead = async (): Promise<never> => { throw { code }; };
    const programs: string[] = [];
    const noExec = async (file: string): Promise<never> => { programs.push(file); throw new Error("No program should run"); };
    for (const command of ["rm *", "rm protected.txt", "echo hi > protected.txt", "shred protected.txt"]) {
      const lines = await previewLines("permission", { input: { command } }, scope, {
        readdir: cannotRead, stat: cannotRead, execFile: noExec,
      });
      expect(lines).toEqual([expect.stringContaining("⚠ could not preview:")]);
    }
    for (const command of ["rm -rf build", "rm build/**/*.js"]) {
      const lines = await previewLines("permission", { input: { command } }, scope, {
        readdir: async (path) => {
          if (path === join(workspace, "build", "nested")) throw { code };
          return nodeBlastDeps.readdir(path);
        },
        execFile: noExec,
      });
      expect(lines).toEqual([expect.stringContaining("⚠ could not preview:")]);
    }
    expect(await readFile(join(workspace, "protected.txt"), "utf8")).toBe("keep");
    expect(programs).toEqual([]);
  });

  it("keeps genuinely absent targets and non-directory components empty through the broker preview boundary", async () => {
    const workspace = await tempDir();
    await writeFile(join(workspace, "file.txt"), "keep");
    const scope = { workspace, clock: manualClock(), containment: contained(workspace) };
    for (const command of ["rm missing.txt", "rm missing/*.txt", "rm file.txt/child", "rm file.txt/*.txt"]) {
      expect(await previewLines("permission", { input: { command } }, scope)).toEqual([
        "⚠ nothing matching is there, so nothing would be deleted",
      ]);
    }
  });

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

  it("withholds a Git cleanup preview before inspecting a denylisted file", async () => {
    const workspace = tempDir();
    const secret = join(workspace, "private.txt");
    await writeFile(secret, "keep this");
    const stats: string[] = [];
    expect(await previewLines("permission", { input: { command: "git clean -fdx" } }, {
      workspace, clock: manualClock(), containment: contained(workspace), denylist: () => ({ paths: [secret], exempt: [], commandPatterns: [] }),
    }, {
      execFile: async () => "Would remove private.txt\n",
      stat: async (path) => { stats.push(path); return nodeBlastDeps.stat(path); },
    })).toBeNull();
    expect(stats).toEqual([]);
  });

  it("withholds reset's tracked changes when Git reports a denylisted path", async () => {
    const workspace = tempDir();
    const secret = join(workspace, "private.txt");
    await writeFile(secret, "keep this");
    expect(await previewLines("permission", { input: { command: "git reset --hard" } }, {
      workspace, clock: manualClock(), containment: contained(workspace), denylist: () => ({ paths: [secret], exempt: [], commandPatterns: [] }),
    }, {
      execFile: async (_file, args) => args[0] === "status" ? " M private.txt\n" : "example current commit\n",
    })).toBeNull();
  });

  it("withholds a cleanup directory before inspecting it, and honours an exemption", async () => {
    const workspace = tempDir();
    const directory = join(workspace, "private");
    await mkdir(directory);
    await writeFile(join(directory, "keep.txt"), "keep this");
    const scope = { workspace, clock: manualClock(), containment: contained(workspace) };
    const stats: string[] = [];
    const deps = {
      execFile: async () => "Would remove private/\n",
      stat: async (path: string) => { stats.push(path); return nodeBlastDeps.stat(path); },
    };
    const detail = { input: { command: "git clean -fdx" } };
    expect(await previewLines("permission", detail, { ...scope, denylist: () => ({ paths: [directory], exempt: [], commandPatterns: [] }) }, deps)).toBeNull();
    expect(stats).toEqual([]);
    expect(await previewLines("permission", detail, { ...scope, denylist: () => ({ paths: [directory], exempt: [directory], commandPatterns: [] }) }, deps))
      .toEqual(["⚠ git clean would remove 1 path", "  private/"]);
    expect(stats).toEqual([directory]);
    expect(await readFile(join(directory, "keep.txt"), "utf8")).toBe("keep this");
  });

  it("honours a permitted file in an exempt directory without forwarding destructive Git flags", async () => {
    const workspace = tempDir();
    const directory = join(workspace, "private");
    await mkdir(directory);
    await writeFile(join(directory, "keep.txt"), "keep this");
    expect(await previewLines("permission", { input: { command: "git clean -fdx -e node_modules" } }, {
      workspace, clock: manualClock(), containment: contained(workspace), denylist: () => ({ paths: [directory], exempt: [directory], commandPatterns: [] }),
    }, {
      execFile: async (file, args, options) => {
        expect(file).toBe("git");
        expect(args).toEqual(["clean", "-n", "-d", "-x", "--exclude=node_modules"]);
        expect(options.timeout).toBe(PREVIEW_TIMEOUT_MS);
        expect(options.signal).toBeInstanceOf(AbortSignal);
        return "Would remove private/keep.txt\n";
      },
    })).toEqual(["⚠ git clean would remove 1 path", "  private/keep.txt"]);
  });

  it.skipIf(process.platform === "win32")("checks the canonical workspace boundary and denylist for Git's paths", async () => {
    const workspace = tempDir();
    const outside = tempDir();
    await writeFile(join(outside, "keep.txt"), "keep this");
    await symlink(outside, join(workspace, "outside"));
    const privateDirectory = join(workspace, "private");
    await mkdir(privateDirectory);
    await writeFile(join(privateDirectory, "keep.txt"), "keep this");
    await symlink(privateDirectory, join(workspace, "alias"));
    for (const path of ["outside/keep.txt", "alias/keep.txt"]) {
      const stats: string[] = [];
      expect(await previewLines("permission", { input: { command: "git clean -fdx" } }, {
        workspace, clock: manualClock(), containment: contained(workspace), denylist: () => ({ paths: [privateDirectory], exempt: [], commandPatterns: [] }),
      }, {
        execFile: async () => `Would remove ${path}\n`,
        stat: async (target) => { stats.push(target); return nodeBlastDeps.stat(target); },
      })).toBeNull();
      expect(stats).toEqual([]);
    }
  });

  it.each(["missing.txt", '"private\\tname.txt"', '"\\377.txt"'])("withholds unavailable or encoded Git target %s", async (path) => {
    const workspace = tempDir();
    const secret = join(workspace, "private\tname.txt");
    await writeFile(secret, "keep this");
    const stats: string[] = [];
    expect(await previewLines("permission", { input: { command: "git clean -fdx" } }, {
      workspace, clock: manualClock(), containment: contained(workspace), denylist: () => ({ paths: [secret], exempt: [], commandPatterns: [] }),
    }, {
      execFile: async () => `Would remove ${path}\n`,
      stat: async (target) => { stats.push(target); return nodeBlastDeps.stat(target); },
    })).toBeNull();
    expect(stats).toEqual(path === "missing.txt" ? [join(workspace, "missing.txt")] : []);
  });

  it("checks cleanup paths beyond the card's listed-path cap", async () => {
    const workspace = tempDir();
    const secret = join(workspace, "private.txt");
    await writeFile(join(workspace, "public.txt"), "keep this");
    await writeFile(secret, "keep this");
    expect(await previewLines("permission", { input: { command: "git clean -fdx" } }, {
      workspace, clock: manualClock(), containment: contained(workspace), denylist: () => ({ paths: [secret], exempt: [], commandPatterns: [] }),
    }, {
      execFile: async () => `${"Would remove public.txt\n".repeat(30)}Would remove private.txt\n`,
    })).toBeNull();
  });

  it("checks checkout's changed paths against the denylist", async () => {
    const workspace = tempDir();
    const secret = join(workspace, "private.txt");
    await writeFile(secret, "keep this");
    expect(await previewLines("permission", { input: { command: "git checkout -- private.txt" } }, {
      workspace, clock: manualClock(), containment: contained(workspace), denylist: () => ({ paths: [secret], exempt: [], commandPatterns: [] }),
    }, {
      execFile: async () => "private.txt\n",
    })).toBeNull();
  });

  it("keeps Git target inspection inside the shared total budget", async () => {
    const workspace = tempDir();
    const clock = manualClock();
    const started = gate();
    const released = gate();
    const stats: string[] = [];
    const preview = previewLines("permission", { input: { command: "git clean -fdx" } }, {
      workspace, clock, containment: contained(workspace),
    }, {
      execFile: async () => "Would remove one.txt\nWould remove two.txt\n",
      stat: async (path) => { stats.push(path); started.open(); await released.opened; return { directory: false, size: 7 }; },
    });
    await started.opened;
    clock.advance(PREVIEW_TIMEOUT_MS);
    expect(await preview).toBeNull();
    expect(clock.pending()).toBe(0);
    released.open();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stats).toEqual([join(workspace, "one.txt")]);
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
