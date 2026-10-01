import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { registry, type ResultOf } from "@agent-harness/contracts";
import { scriptedCdpPeer, type InPageCall } from "@agent-harness/browser/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HARNESS_VERSION } from "../serve/start.js";
import { useCleanups } from "../../test/cleanups.js";
import { callHostTool, end, fakeAdapter, type FakeAdapter, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import type { HostToolResult } from "../adapter/contract.js";
import type { EventEnvelope as LogEvent } from "../event-log/event-log.js";

/**
 * The extension's loop end to end (browser spec, "Testing Decisions"; #553):
 * the extension package built as this harness version and unpacked by the
 * in-process environment into its folder, its worker run from that folder on
 * a thread of its own as Chrome runs it, under the fake `chrome` whose tabs
 * and debugger are the scripted CDP peer's. It finds the environment through
 * the port file, announces, pairs with a code from `browser.pairing.code`,
 * proves itself when Chrome starts it again, and answers the tools a fake
 * provider calls on the direct path with the page driver over its debugger.
 * The reader's in-page functions run from the declarations the built worker
 * sent, in a jsdom window of the page, so the bundle is shown to send code
 * that runs alone in a page.
 */

const { onCleanup } = useCleanups();

/** Spawning tsx and bundling the extension with Vite on a loaded runner: a cap for a hang, not a budget. */
const BUILD_MS = 120_000;

const extensionPackage = fileURLToPath(new URL("../../../extension/", import.meta.url));
/** The extension built for this file, in a folder of its own: the package's `dist` is another test's to build. */
const scratch = mkdtempSync(join(tmpdir(), "agent-harness-extension-pages-"));
const built = join(scratch, "extension");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

beforeAll(async () => {
  const tsx = createRequire(import.meta.url).resolve("tsx");
  const script = join(extensionPackage, "scripts", "build-extension.ts");
  await promisify(execFile)(process.execPath, ["--conditions=@agent-harness/source", "--import", tsx, script, "--out", built, "--version", HARNESS_VERSION], {
    cwd: extensionPackage,
  });
}, BUILD_MS);

/** A worker of the built extension running on a thread, as Chrome runs it, which the test asks what the options page asks. */
interface BuiltWorker {
  /** Sends what the options page sends the worker, and answers its reply. */
  page(request: unknown): Promise<unknown>;
  /** The profile's local storage, for the next start. */
  local(): Promise<Record<string, unknown>>;
  /** Ends the worker, its socket and timers with it, as Chrome stops one. */
  stop(): Promise<void>;
}

/** Runs the `worker.js` of `folder` on a thread, through the extension package's thread entry (`test/built-worker-thread.ts`). */
const runBuiltWorker = (folder: string, profile: { readonly browser: string; readonly local?: Record<string, unknown> }): BuiltWorker => {
  const workerData = {
    tsxApi: pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href,
    entry: pathToFileURL(join(extensionPackage, "test", "built-worker-thread.ts")).href,
    folder,
    ...profile,
  };
  const thread = new Worker(
    `const { workerData } = require("node:worker_threads");
    import(workerData.tsxApi).then(({ tsImport }) => tsImport(workerData.entry, workerData.entry));`,
    { eval: true, workerData, execArgv: [...process.execArgv, "--conditions=@agent-harness/source"] },
  );
  thread.on("error", () => undefined);
  onCleanup(async () => void (await thread.terminate()));
  const ask = <T>(message: { readonly type: string; readonly request?: unknown }, answer: (reply: Record<string, unknown>) => T): Promise<T> =>
    new Promise((resolve) => {
      const listener = (reply: Record<string, unknown>) => {
        if (reply["type"] !== message.type) return;
        thread.off("message", listener);
        resolve(answer(reply));
      };
      thread.on("message", listener);
      thread.postMessage(message);
    });
  return {
    page: (request) => ask({ type: "page", request }, (reply) => reply["answer"]),
    local: () => ask({ type: "local" }, (reply) => reply["local"] as Record<string, unknown>),
    stop: async () => void (await thread.terminate()),
  };
};

const folderOf = (t: Pick<TestEnvironment, "dataDir">): string => join(t.dataDir, "extension", "current");

/** An article long enough for Readability to judge the page readerable, written for this test. */
const ARTICLE = `<!doctype html><html><head><title>Example Domain</title></head><body><nav><a href="/">Home</a></nav><article><h1>Example Domain</h1>${`<p>${"This domain is for use in documentation examples without needing permission. ".repeat(4)}</p>`.repeat(4)}</article></body></html>`;

/** A jsdom window that runs a script it is handed: the part of jsdom this file uses, which the tests' project has no types for. */
interface PageWindow {
  eval(source: string): (...args: unknown[]) => unknown;
}
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: { readonly url: string; readonly runScripts: "outside-only" }) => { readonly window: PageWindow };
};

/** Answers an in-page call as the page would: its declaration, as the worker sent it, run in a jsdom window kept per document. */
const inPageWindows = (html: string): ((call: InPageCall) => unknown) => {
  const windows = new Map<string, PageWindow>();
  return (call) => {
    let window = windows.get(call.frame.loaderId);
    if (window === undefined) {
      window = new JSDOM(html, { url: call.frame.url, runScripts: "outside-only" }).window;
      // tsx, which runs the built worker on the thread, names the bundle's functions with a helper of its own; Chrome runs
      // the file as built, which calls none, so the page gets a stand-in for tsx's helper and nothing else (#966).
      window.eval("var __name = (target) => target;");
      windows.set(call.frame.loaderId, window);
    }
    return window.eval(`(${call.declaration})`)(...call.args);
  };
};

const eventsOf = (t: TestEnvironment, sessionId: string): LogEvent[] => t.env.log.readStream({ kind: "session", id: sessionId });

/** Runs `calls` of the `browser` server's tools in an attended run of the session, as a fake provider makes them; answers what the model read of each. */
const run = async (t: TestEnvironment, client: WireClient, sessionId: string, ...calls: (readonly [string, Record<string, unknown>])[]): Promise<HostToolResult[]> => {
  const answers: HostToolResult[] = [];
  const script: Script = async function* (controls) {
    yield { type: "session.provider-linked", payload: { providerSessionId: `provider-${controls.input.sessionId}` } };
    for (const [name, input] of calls) answers.push(yield* callHostTool(controls, { server: "browser", name, input: input as never }));
    yield end();
  };
  (t.adapter as FakeAdapter).nextScripts.push(script);
  const started = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Use the browser" })).result;
  if (started === undefined) throw new Error("runs.start was not applied.");
  await vi.waitFor(() => expect(eventsOf(t, sessionId).some((event) => event.type === "run.ended" && event.payload["runId"] === started.runId)).toBe(true), {
    timeout: WAIT_MS,
  });
  return answers;
};

describe("the extension end to end", () => {
  it("loads from the folder the environment unpacked, announces, pairs with a code, proves itself when Chrome starts it again, and answers a fake provider's browser tools through its debugger", async () => {
    const peer = scriptedCdpPeer();
    const browser = await peer.listen();
    onCleanup(() => peer.close());
    peer.document("https://example.com/", { title: "Example Domain" });
    peer.inPage("snapshotFrame", () => ({ nodes: [{ role: "heading", name: "Example Domain", level: 1, ref: "e1" }], lastRef: 1 }));
    const page = inPageWindows(ARTICLE);
    for (const name of ["installReader", "readPage", "pageChallenge"]) peer.inPage(name, page);
    const t = await startTestEnvironment({ name: "Laptop", adapter: fakeAdapter(), browser: { extensionSource: built } });
    onCleanup(() => t.close());
    const client = await t.client();
    onCleanup(() => client.close());
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
    const notice = (type: string, change?: string) =>
      client.next((frame) => frame.type === "event" && frame.subscription === subscription && frame.event.type === type && (change === undefined || frame.event.payload["change"] === change));

    const first = runBuiltWorker(folderOf(t), { browser });
    expect(await notice("extension.seen")).toMatchObject({ event: { payload: { protocolVersion: 2, extensionVersion: HARNESS_VERSION } } });

    const { code } = (await client.apply("browser.pairing.code", {})) as ResultOf<"browser.pairing.code">;
    expect(await first.page({ type: "pair", code, name: "Work" })).toEqual({ ok: true });
    const { chromes } = (await client.request("browser.chromes.list", {})) as ResultOf<"browser.chromes.list">;
    expect(chromes).toMatchObject([{ name: "Work", connected: true, lastReportedVersion: HARNESS_VERSION }]);

    // Chrome stops the worker and, at the next wake, starts it again on the profile it left: it proves its pairing.
    const local = await first.local();
    await first.stop();
    await notice("chrome.updated", "disconnected");
    runBuiltWorker(folderOf(t), { browser, local });
    await notice("chrome.updated", "connected");

    const session = await create(client, { browser: { value: { kind: "chrome", environmentId: t.env.id, chromeId: chromes[0]?.id ?? null }, chosenBy: "person" } });
    const [opened, snapshot, read] = await run(
      t,
      client,
      session.id,
      ["browser_open", { address: "https://example.com/", snapshot: false }],
      ["browser_snapshot", { filter: "all" }],
      ["browser_read", {}],
    );

    expect(opened?.isError).toBe(false);
    expect(opened?.text.split("\n")[0]).toBe("Opened https://example.com/. The page is at https://example.com/.");
    expect(opened?.text).toContain("Title: Example Domain");
    expect(snapshot?.isError).toBe(false);
    expect(snapshot?.text).toContain('- heading "Example Domain" [level=1] [ref=e1]');
    expect(read?.isError).toBe(false);
    expect(read?.text.split("\n")[0]).toBe("Read https://example.com/ through a reader: its article as Markdown.");
    expect(read?.text).toContain("# Example Domain\n\nThis domain is for use in documentation examples without needing permission.");
    expect(read?.text).not.toContain("Home");
    expect(peer.sentOf("Target.attachToTarget")).toHaveLength(1);
    expect(peer.sentOf("Page.navigate").map(({ params }) => params.url)).toEqual(["https://example.com/"]);
  });
});
