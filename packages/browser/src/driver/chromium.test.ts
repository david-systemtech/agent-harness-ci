import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { PageArgs, PageDriverKind, PagePolicy, PageResult, PageVerb } from "@agent-harness/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listed, plainPolicy, targetPerKeyHost, PAGE } from "../../test/driven.js";
import { cdpConnection, type CdpConnection } from "../cdp/connection.js";
import { pipeTransport } from "../cdp/pipe.js";
import { webSocketTransport } from "../cdp/web-socket.js";
import type { CdpTransport } from "../cdp/session.js";
import { cdpPageDriver } from "./driver.js";

/**
 * The fixture-page suite (browser spec, "Testing Decisions"): the driver and
 * its in-page functions against a real Chromium, launched headless over a
 * pipe, on pages served from loopback: open shadow roots, same-site and
 * cross-site frames, password and card fields, a long article and a canvas,
 * each read through the vendored aria snapshot and acted on by its refs;
 * one case drives a second Chromium over a WebSocket to its DevTools address
 * instead. It runs only where a browser may run, named by
 * AGENT_HARNESS_CHROMIUM (docs/agents/browser-checklist.md), and skips with
 * that reason elsewhere: the shared agent box must never launch one.
 */

const chromium = process.env.AGENT_HARNESS_CHROMIUM;
const SKIPPED =
  "No Chromium may run here: set AGENT_HARNESS_CHROMIUM to a Chromium or Chrome executable, on a machine that allows browsers (never the shared agent box), to run the fixture-page suite.";

const FIXTURES = new URL("../../test/fixtures/chromium/", import.meta.url);

/** The fixture pages' names resolve to this machine: `.test` names, which no address class claims, so they stand as ordinary sites. */
const SITE = "shop.fixture.test";
const RESOLVE_TEST_NAMES = "--host-resolver-rules=MAP *.test 127.0.0.1";

let server: Server | undefined;
let port = 0;
let browser: ChildProcess | undefined;
let profile: string | undefined;
let connection: CdpConnection | undefined;
/** Every command the driver sent the browser, in order. */
const sent: string[] = [];

/** Ends a browser and waits for it to exit, so its profile is no longer written to when it is removed. */
const ended = async (child: ChildProcess | undefined): Promise<void> => {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await exited;
};

/** A transport that records the method of every command it carries. */
const recording = (transport: CdpTransport): CdpTransport => ({
  ...transport,
  send(message) {
    sent.push((JSON.parse(message) as { method: string }).method);
    transport.send(message);
  },
});

beforeAll(async () => {
  if (chromium === undefined) return;
  server = createServer((request, response) => {
    const name = (request.url ?? "/").replace(/^\/+/, "").replace(/[?#].*$/, "");
    // A fixture page by its own name, and nothing else: no path climbs out of the fixtures' folder.
    if (!/^[\w-]+\.html$/.test(name)) {
      response.statusCode = 404;
      response.end();
      return;
    }
    try {
      const page = readFileSync(new URL(name, FIXTURES), "utf8").replaceAll("{{PORT}}", String(port));
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(page);
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  profile = mkdtempSync(join(tmpdir(), "agent-harness-chromium-"));
  const launched = spawn(
    chromium,
    [
      "--headless=new",
      "--remote-debugging-pipe",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--site-per-process",
      RESOLVE_TEST_NAMES,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  browser = launched;
  const pipe = {
    writable: Writable.toWeb(launched.stdio[3] as Writable) as unknown as WritableStream<Uint8Array>,
    readable: Readable.toWeb(launched.stdio[4] as Readable) as unknown as ReadableStream<Uint8Array>,
  };
  connection = cdpConnection(recording(pipeTransport(pipe)));
  await connection.send("Browser.getVersion");
}, 60_000);

afterAll(async () => {
  connection?.close();
  await ended(browser);
  if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

beforeEach(({ skip }) => {
  skip(chromium === undefined, SKIPPED);
  sent.length = 0;
});

let nextPage = 0;

/** A driver of `kind` on a page of its own in the real browser. */
const drive = (kind: PageDriverKind = "headless", policy: PagePolicy = plainPolicy) => {
  const driver = cdpPageDriver({ kind, host: targetPerKeyHost(connection as CdpConnection), policy: () => policy });
  const pageKey = `${PAGE}-${++nextPage}`;
  return <V extends PageVerb>(verb: V, args: PageArgs<V>): Promise<PageResult<V>> => driver.perform({ pageKey, command: { verb, args } } as never) as Promise<PageResult<V>>;
};

const at = (page: string, host = SITE) => `http://${host}:${port}/${page}`;

describe("the page driver in a real Chromium", () => {
  it("reads every frame: text a same-site frame and a cross-site frame's child target show is found", async () => {
    const perform = drive();
    expect(await perform("open", { url: at("frames.html") })).toMatchObject({ ok: true, value: { url: at("frames.html"), title: "Checkout" } });
    expect(await perform("waitFor", { until: { text: "Five stars from every buyer" } })).toMatchObject({ ok: true });
    expect(await perform("waitFor", { until: { text: "Card accepted" } })).toMatchObject({ ok: true });
    const { targetInfos } = await (connection as CdpConnection).send("Target.getTargets");
    expect(targetInfos).toEqual(expect.arrayContaining([expect.objectContaining({ type: "iframe", url: at("embed.html", `pay.other.test`) })]));
  });

  it("reads inside open shadow roots and their slotted nodes", async () => {
    const perform = drive();
    await perform("open", { url: at("shadow.html") });
    expect(await perform("waitFor", { until: { text: "21.5 °C" } })).toMatchObject({ ok: true });
    expect(await perform("waitFor", { until: { text: "Living room" } })).toMatchObject({ ok: true });
  });

  it("clicks by selector with real input from an isolated world, which the page's own scripts never see, and enables no Runtime to do it", async () => {
    const perform = drive();
    await perform("open", { url: at("fields.html") });
    expect(await perform("click", { target: { selector: "#buy" } })).toMatchObject({ ok: true });
    expect(sent).not.toContain("Runtime.enable");
    expect(sent).not.toContain("Log.enable");
    expect(sent).not.toContain("Network.enable");
    expect(await perform("evaluate", { expression: "[window.clicks, window.mainWorldQueries]" })).toEqual({ ok: true, value: { result: [1, 0] } });
    expect(sent).toContain("Runtime.enable");
  });

  it("types into password and card fields, replacing what they held", async () => {
    const perform = drive();
    await perform("open", { url: at("fields.html") });
    expect(await perform("type", { target: { selector: "#password" }, text: "new-password-for-tests" })).toMatchObject({ ok: true });
    expect(await perform("type", { target: { selector: "#card" }, text: "" })).toMatchObject({ ok: true });
    expect(await perform("evaluate", { expression: "[password.value, card.value]" })).toEqual({ ok: true, value: { result: ["new-password-for-tests", ""] } });
  });

  it("scrolls a long article by viewports and waits for its last sentence", async () => {
    const perform = drive();
    await perform("open", { url: at("article.html") });
    await perform("scroll", { to: { direction: "down", amount: 2 } });
    await expect.poll(async () => perform("evaluate", { expression: "scrollY" }), { timeout: 10_000 }).toEqual({ ok: true, value: { result: 1_600 } });
    expect(await perform("waitFor", { until: { text: "The end of the article." } })).toMatchObject({ ok: true });
  });

  it("clicks a canvas at a point in screenshot pixels, and screenshots the 1280 by 800 viewport as a JPEG", async () => {
    const perform = drive();
    await perform("open", { url: at("canvas.html") });
    expect(await perform("clickAt", { x: 300, y: 200 })).toMatchObject({ ok: true });
    expect(await perform("evaluate", { expression: "window.lastClick" })).toEqual({ ok: true, value: { result: [300, 200] } });
    const shot = await perform("screenshot", {});
    if (!shot.ok) throw new Error(shot.reason);
    expect(shot.value.mimeType).toBe("image/jpeg");
    const bytes = Buffer.from(shot.value.data, "base64");
    // A baseline JPEG's frame header (SOF0, FF C0) holds its height, then its width.
    const header = bytes.indexOf(Buffer.from([0xff, 0xc0]));
    expect([bytes.readUInt16BE(header + 7), bytes.readUInt16BE(header + 5)]).toEqual([1_280, 800]);
  });

  it("drives a Chromium over a WebSocket to its DevTools address too", async () => {
    const other = mkdtempSync(join(tmpdir(), "agent-harness-chromium-"));
    const launched = spawn(chromium as string, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${other}`, "--no-first-run", "--no-default-browser-check", RESOLVE_TEST_NAMES, "about:blank"], {
      stdio: "ignore",
    });
    try {
      // Chromium writes the port it took, and its browser target's path, to its profile once it listens.
      const activePort = join(other, "DevToolsActivePort");
      await expect.poll(() => existsSync(activePort) && readFileSync(activePort, "utf8").includes("\n"), { timeout: 30_000 }).toBe(true);
      const [devtoolsPort, path] = readFileSync(activePort, "utf8").split("\n");
      const overSocket = cdpConnection(await webSocketTransport(`ws://127.0.0.1:${devtoolsPort}${path}`));
      const driver = cdpPageDriver({ kind: "headless", host: targetPerKeyHost(overSocket), policy: () => plainPolicy });
      expect(await driver.perform({ pageKey: PAGE, command: { verb: "open", args: { url: at("frames.html") } } })).toMatchObject({ ok: true, value: { title: "Checkout" } });
      overSocket.close();
    } finally {
      await ended(launched);
      rmSync(other, { recursive: true, force: true });
    }
    // A second browser's cold start is given longer than the preset 30 seconds.
  }, 60_000);

  it("snapshots a same-site frame and a cross-site frame's child target into one tree in document order, the frames' refs prefixed", async () => {
    const perform = drive();
    await perform("open", { url: at("frames.html") });
    const snapshot = await perform("snapshot", { filter: "all" });
    if (!snapshot.ok) throw new Error(snapshot.reason);
    const { text } = snapshot.value;
    expect(text).toMatch(/- heading "Checkout" \[level=1\] \[ref=e\d+\]/);
    expect(text).toMatch(/\[ref=f1e\d+\]: Five stars from every buyer\./);
    expect(text).toMatch(/\[ref=f2e\d+\]: Card accepted\./);
    expect(text.indexOf("Checkout")).toBeLessThan(text.indexOf("Five stars"));
    expect(text.indexOf("Five stars")).toBeLessThan(text.indexOf("Card accepted"));
    // Each frame's lines sit under its iframe's line, indented below it.
    expect(text).toMatch(/- iframe \[ref=e\d+\]:\n {4,}- .*\[ref=f1e\d+\]/);
    expect(text).toMatch(/- iframe \[ref=e\d+\]:\n {4,}- .*\[ref=f2e\d+\]/);
  });

  it("clicks by ref inside a cross-site frame, where its frame sits on the page, and refuses the ref once the page has moved on", async () => {
    const perform = drive();
    await perform("open", { url: at("frames.html") });
    const snapshot = await perform("snapshot", {});
    if (!snapshot.ok) throw new Error(snapshot.reason);
    const pay = /button "Pay" \[ref=(f\d+e\d+)\]/.exec(snapshot.value.text)?.[1];
    expect(pay).toMatch(/^f\d+e/);
    expect(await perform("click", { target: { ref: pay as string } })).toMatchObject({ ok: true });
    expect(await perform("waitFor", { until: { text: "Paid in full" } })).toMatchObject({ ok: true });
    await perform("navigate", { url: at("article.html") });
    expect(await perform("click", { target: { ref: pay as string } })).toMatchObject({ ok: false, reason: expect.stringContaining("Take a new snapshot") });
  });

  it("snapshots a Lit-style card through its open shadow root, its slotted title in place", async () => {
    const perform = drive();
    await perform("open", { url: at("shadow.html") });
    const snapshot = await perform("snapshot", { filter: "all" });
    if (!snapshot.ok) throw new Error(snapshot.reason);
    expect(snapshot.value.text).toMatch(/- heading "Living room" \[level=2\]/);
    expect(snapshot.value.text).toContain("21.5 °C");
  });

  it("never shows a password's or a card number's value in a snapshot, and acts on the fields by their refs", async () => {
    const perform = drive();
    await perform("open", { url: at("fields.html") });
    const snapshot = await perform("snapshot", {});
    if (!snapshot.ok) throw new Error(snapshot.reason);
    const { text } = snapshot.value;
    expect(text).not.toContain("old-password-for-tests");
    expect(text).not.toContain("0000 0000 0000 0000");
    expect(text).toMatch(/- textbox "Password" \[ref=e\d+\]: "\[redacted: a password\]"/);
    expect(text).toMatch(/- textbox "Card number" \[ref=e\d+\]: "\[redacted: a payment card detail\]"/);
    const ref = (name: string): string => new RegExp(`"${name}" (?:\\[\\w=-]+\\] )*\\[ref=(e\\d+)\\]`).exec(text)?.[1] as string;
    expect(await perform("click", { target: { ref: ref("Buy") } })).toMatchObject({ ok: true });
    expect(await perform("type", { target: { ref: ref("Password") }, text: "typed-by-ref-for-tests" })).toMatchObject({ ok: true });
    expect(await perform("evaluate", { expression: "[window.clicks, password.value]" })).toEqual({ ok: true, value: { result: [1, "typed-by-ref-for-tests"] } });
  });

  it("refuses a page whose cross-site frame the denylist lists, and leaves it at about:blank", async () => {
    const perform = drive("chrome", { ...plainPolicy, browserDomains: [listed("pay.other.test")] });
    expect(await perform("open", { url: at("frames.html") })).toMatchObject({
      ok: false,
      denylist: { frame: "sub-frame", match: { matched: at("embed.html", "pay.other.test") } },
    });
    expect(await perform("open", {})).toMatchObject({ ok: true, value: { url: "about:blank" } });
  });
});
