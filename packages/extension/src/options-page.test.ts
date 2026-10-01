import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { WAIT_MS } from "../test/scripted-environment.js";
import { workerHarness, type Setup } from "../test/worker-harness.js";
import { startOptionsPage } from "./options-page.js";

/**
 * The options page (#549) as the person sees it, in a jsdom window over the
 * page's own markup, beside the worker on the same fake Chrome and a scripted
 * environment: what it says, and what a code typed into it does on the
 * environment's socket.
 */

const { POLICY, environmentOf, setUp, setUpPaired, statusOnce, announced } = workerHarness();

const MARKUP = readFileSync(new URL("./options.html", import.meta.url), "utf8");

interface Page {
  readonly document: Document;
  text(id: string): string;
  /** Types into the input `id`, as a person does. */
  type(id: string, value: string): void;
  submit(id: string): void;
  click(id: string): void;
  /** Waits until the element `id` says what `predicate` takes. */
  says(id: string, predicate: (text: string) => boolean): Promise<string>;
}

const openPage = async (setup: Setup): Promise<Page> => {
  const { window } = new JSDOM(MARKUP);
  const document = window.document;
  await startOptionsPage(document, { chrome: setup.chrome, readOwnFile: setup.folder.readOwnFile });
  const element = (id: string): HTMLElement => {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`No #${id}.`);
    return found;
  };
  const text = (id: string) => element(id).textContent;
  return {
    document,
    text,
    type(id, value) {
      (element(id) as HTMLInputElement).value = value;
      element(id).dispatchEvent(new window.Event("input", { bubbles: true }));
    },
    submit: (id) => (element(id) as HTMLFormElement).requestSubmit(),
    click: (id) => element(id).click(),
    async says(id, predicate) {
      const until = Date.now() + WAIT_MS;
      while (!predicate(text(id))) {
        if (Date.now() > until) throw new Error(`#${id} never said it; it says ${JSON.stringify(text(id))}.`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return text(id);
    },
  };
};

describe("the options page", () => {
  it("says what the worker is connected to, and shows the pair form while the Chrome holds no pairing", async () => {
    const setup = await setUp();
    await announced(setup, await setup.environment.nextSocket());

    const page = await openPage(setup);

    expect(page.text("status")).toBe("Connected to Laptop, and not paired. Type the code Laptop shows to pair this Chrome.");
    expect(page.document.getElementById("pair-form")?.hidden).toBe(false);
  });

  it("shows the port from the port file, and keeps an override, which wins while it is set", async () => {
    const setup = await setUp();
    const fromFile = await setup.environment.nextSocket();
    await announced(setup, fromFile);
    const page = await openPage(setup);
    expect(page.text("port-file")).toBe(`The port file names port ${setup.environment.port}, where Laptop listens.`);
    expect(page.text("override-line")).toBe("No override is set, so the port file's port is used.");
    const elsewhere = await environmentOf({ name: "Desktop" });

    page.type("override", String(elsewhere.port));
    page.submit("override-form");

    await page.says("override-line", (text) => text === `The override, port ${elsewhere.port}, is used while it is set, whatever the port file names.`);
    await announced({ chrome: setup.chrome, environment: elsewhere }, await elsewhere.nextSocket());
    await page.says("status", (text) => text.startsWith("Connected to Desktop"));
    expect(page.text("port-file")).toBe(`The port file names port ${setup.environment.port}, where Laptop listens.`);

    page.click("override-clear");

    await page.says("override-line", (text) => text === "No override is set, so the port file's port is used.");
    await announced(setup, await setup.environment.nextSocket());
    await page.says("status", (text) => text.startsWith("Connected to Laptop"));
  });

  it("refuses an override that is not a port, and keeps what was set", async () => {
    const setup = await setUp();
    const page = await openPage(setup);

    page.type("override", "70000");
    page.submit("override-form");
    page.type("override", "");
    page.submit("override-form");

    expect(page.text("override-problem")).toBe("A port is a whole number from 1 to 65535.");
    expect(setup.chrome.storage.local.peek("portOverride")).toBeUndefined();
    expect(page.text("override-line")).toBe("No override is set, so the port file's port is used.");
  });

  it("sends a typed code as pair on the announced socket, keeps the credential it gets, and says it is paired", async () => {
    const setup = await setUp();
    const socket = await setup.environment.nextSocket();
    await announced(setup, socket);
    const page = await openPage(setup);

    page.type("pair-name", "Work");
    page.type("pair-code", "ABCD-EFGH");
    page.submit("pair-form");

    expect(await socket.next((message) => message.type === "pair")).toEqual({ type: "pair", code: "ABCD-EFGH", name: "Work" });
    const secret = "a".repeat(64);
    socket.send({ type: "paired", chromeId: "6b0d6a3e-7c4f-4d0e-9f6a-2b1c3d4e5f60", secret, policy: POLICY });

    await page.says("pair-result", (text) => text === "Paired.");
    expect(setup.chrome.storage.local.peek("pairing")).toEqual({
      chromeId: "6b0d6a3e-7c4f-4d0e-9f6a-2b1c3d4e5f60",
      secret,
      environmentId: setup.environment.environmentId,
      environmentName: "Laptop",
      name: "Work",
    });
    await page.says("status", (text) => text === "Paired with Laptop as Work, and connected.");
    expect(page.document.getElementById("pair-form")?.hidden).toBe(true);
    // The paired socket is the Chrome's from then on: no second socket opens.
    setup.clock.advance(20_000);
    expect(await socket.next((message) => message.type === "ping")).toEqual({ type: "ping" });
    expect(setup.environment.socketCount()).toBe(1);
  });

  it("shows a refused code's sentence, and the socket stays for the next code", async () => {
    const setup = await setUp();
    const socket = await setup.environment.nextSocket();
    await announced(setup, socket);
    const page = await openPage(setup);
    page.type("pair-code", "WRONG");
    page.submit("pair-form");
    expect(await socket.next((message) => message.type === "pair")).toMatchObject({ code: "WRONG" });

    socket.send({ type: "refused", reason: "That code is not the one Laptop shows. Check it and type it again." });

    await page.says("pair-result", (text) => text === "That code is not the one Laptop shows. Check it and type it again.");
    expect(setup.chrome.storage.local.peek("pairing")).toBeUndefined();
    page.type("pair-code", "ABCD-EFGH");
    page.submit("pair-form");
    expect(await socket.next((message) => message.type === "pair")).toEqual({ type: "pair", code: "ABCD-EFGH", name: "" });
    expect(setup.environment.socketCount()).toBe(1);
  });

  it("says another environment holds the port when the one there is not the one this Chrome paired with", async () => {
    const setup = await setUpPaired();
    const socket = await setup.environment.nextSocket();
    expect(await socket.next()).toMatchObject({ type: "hello" });
    socket.send({ type: "challenge", environmentId: "0f8fad5b-d9cb-469f-a165-70867728950e", nonce: "b".repeat(64) });
    await statusOnce(setup.chrome, (status) => status.state === "other-environment");

    const page = await openPage(setup);

    expect(page.text("status")).toBe(
      `Another environment holds port ${setup.environment.port}. This Chrome is paired with Laptop, so it does not prove itself to this one. Start Laptop, or set the port it listens on below.`,
    );
    expect(page.document.getElementById("pair-form")?.hidden).toBe(true);
  });

  it("wakes a worker waiting to dial again, which dials at once", async () => {
    const setup = await setUp({ started: false });
    const port = setup.environment.port;
    await setup.environment.close();
    setup.start();
    await statusOnce(setup.chrome, (status) => status.state === "unreachable");
    const back = await environmentOf();
    setup.folder.writePortFile(back.portFile);

    const page = await openPage(setup);

    // No time passed on the worker's clock: the page's opening made it dial.
    await announced({ chrome: setup.chrome, environment: back }, await back.nextSocket());
    await page.says("status", (text) => text.startsWith("Connected to Laptop"));
    expect(port).not.toBe(back.port);
  });
});
