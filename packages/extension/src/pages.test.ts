import type { OneTimeAllowance, PageCommand, PageKey, PageOutcome, PagePolicy } from "@agent-harness/contracts";
import { scriptedCdpPeer, type ScriptedCdpPeer } from "@agent-harness/browser/testing";
import { describe, expect, it } from "vitest";
import { workerHarness, type Setup } from "../test/worker-harness.js";
import type { PeerSocket } from "../test/scripted-environment.js";

/**
 * The extension driving pages (browser spec, "The extension, its folder and
 * its listener"; #553): the worker against the fake `chrome` API, whose tabs
 * and debugger are the scripted CDP peer's, on a socket a scripted
 * environment holds live. A test sends `call` and reads the `result`, and
 * asserts what the browser was sent and what Chrome's tabs and groups are.
 */

const { POLICY, setUp, statusOnce, challenged, pairingWith, onCleanup } = workerHarness();

/** The tests' session's page, and another session's. */
const PAGE: PageKey = "0f8fad5b-d9cb-469f-a165-70867728950e/7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OTHER_PAGE: PageKey = "0f8fad5b-d9cb-469f-a165-70867728950e/16fd2706-8baf-433b-82eb-8c7fada847da";

interface Live extends Setup {
  readonly peer: ScriptedCdpPeer;
  /** The live socket, the latest worker's. */
  readonly socket: PeerSocket;
  /** Sends one verb as the environment calls it, and answers the extension's result. */
  perform(command: PageCommand, options?: { readonly pageKey?: PageKey; readonly allowance?: OneTimeAllowance }): Promise<PageOutcome>;
  /** Chrome stops the worker and starts another, as its idle shutdown and the next wake do; the new one proves itself on a new socket. */
  restart(): Promise<void>;
}

/** A paired worker whose socket is live under `policy`, in a Chrome whose browser is a scripted CDP peer. */
const live = async (options: { readonly policy?: PagePolicy; readonly debuggerBlocked?: boolean } = {}): Promise<Live> => {
  const peer = scriptedCdpPeer();
  const browser = await peer.listen();
  onCleanup(() => peer.close());
  const setup = await setUp({ started: false, chrome: { browser, ...(options.debuggerBlocked === true && { debuggerBlocked: true }) } });
  await setup.chrome.storage.local.set({ pairing: pairingWith(setup.environment) });
  const prove = async (): Promise<PeerSocket> => {
    const proving = await setup.environment.nextSocket();
    await challenged(setup, proving);
    proving.send({ type: "ready", policy: options.policy ?? POLICY });
    await statusOnce(setup.chrome, (status) => status.state === "connected");
    return proving;
  };
  let worker = setup.start();
  let socket = await prove();
  let calls = 0;
  return {
    ...setup,
    peer,
    get socket() {
      return socket;
    },
    async perform(command, extra = {}) {
      const id = `call-${++calls}`;
      const on = socket;
      on.send({ type: "call", id, pageKey: extra.pageKey ?? PAGE, command, ...(extra.allowance && { allowance: extra.allowance }) });
      const answer = await on.next((message) => message.type === "result" && message.id === id);
      if (answer.type !== "result") throw new Error(`The extension answered ${answer.type}.`);
      return answer.result;
    },
    async restart() {
      worker.stop();
      worker = setup.start();
      socket = await prove();
    },
  };
};

/** The domains enabled on every session of the browser, in the order the peer was asked. */
const enabledDomains = (peer: ScriptedCdpPeer): string[] => peer.sent.filter((command) => /\.enable$/.test(command.method)).map((command) => command.method);

describe("the worker's pages", () => {
  it("opens a session's page in a tab of its own, in a tab group titled with the product name, attached with Page alone, and answers where the page is", async () => {
    const { chrome, peer, perform } = await live();
    peer.document("https://example.com/", { title: "Example Domain" });

    expect(await perform({ verb: "open", args: { url: "https://example.com/" } })).toEqual({ ok: true, value: { url: "https://example.com/", title: "Example Domain" } });

    const tabs = chrome.tabsOpen();
    expect(tabs).toHaveLength(1);
    expect(chrome.groupTitle(tabs[0]?.groupId ?? -1)).toBe("agent-harness");
    expect(chrome.attachedTabs()).toEqual([tabs[0]?.id]);
    expect(enabledDomains(peer)).toEqual(["Page.enable"]);
  });

  it("gives each page key one tab in the one group, attaches to no tab it did not make, and lets go of a page on close without closing its tab", async () => {
    const { chrome, peer, perform } = await live();
    const persons = peer.createPage("https://mail.example/");
    await perform({ verb: "open", args: { url: "https://example.com/" } });
    await perform({ verb: "open", args: { url: "https://example.org/" } }, { pageKey: OTHER_PAGE });
    expect(await perform({ verb: "open", args: {} })).toEqual({ ok: true, value: { url: "https://example.com/", title: "" } });

    const [first, second] = chrome.tabsOpen();
    expect(chrome.tabsOpen()).toHaveLength(2);
    expect(second?.groupId).toBe(first?.groupId);
    const attachedTo = peer.sentOf("Target.attachToTarget").map(({ params }) => params.targetId);
    expect(attachedTo).toEqual([first?.targetId, second?.targetId]);
    expect(attachedTo).not.toContain(persons.targetId);

    expect(await perform({ verb: "close", args: {} })).toEqual({ ok: true, value: null });
    expect(chrome.attachedTabs()).toEqual([second?.id]);
    expect(chrome.tabsOpen().map((tab) => tab.id)).toEqual([first?.id, second?.id]);
    // The tab is the person's now: the page key reaches it no more, and open makes another.
    expect(await perform({ verb: "screenshot", args: {} })).toEqual({ ok: false, reason: "No page is open for this session. Open one with browser_open first." });
    expect(await perform({ verb: "open", args: {} })).toEqual({ ok: true, value: { url: "about:blank", title: "" } });
    expect(chrome.tabsOpen()).toHaveLength(3);
  });

  it("reaches no tab the person took out of the group or closed: the next verb says the page is gone, and open makes a new tab in a group titled with the product name", async () => {
    const { chrome, perform } = await live();
    await perform({ verb: "open", args: { url: "https://example.com/" } });
    const [taken] = chrome.tabsOpen();
    chrome.ungroup(taken?.id ?? -1);

    expect(await perform({ verb: "screenshot", args: {} })).toEqual({
      ok: false,
      reason: "The page this session had is gone (the person took its tab out of the agent-harness tab group). Open it again with browser_open.",
    });
    expect(chrome.attachedTabs()).toEqual([]);
    expect(await perform({ verb: "open", args: {} })).toEqual({ ok: true, value: { url: "about:blank", title: "" } });
    const made = chrome.tabsOpen().at(-1);
    expect(made?.id).not.toBe(taken?.id);
    expect(chrome.groupTitle(made?.groupId ?? -1)).toBe("agent-harness");

    await chrome.tabs.remove(made?.id ?? -1);
    expect(await perform({ verb: "screenshot", args: {} })).toEqual({ ok: false, reason: "The page this session had is gone (its tab was closed). Open it again with browser_open." });
  });
});

describe("the debugger's domains and child targets", () => {
  /** The domains enabled on the tab's own target and on its cross-site frame's, in the order the peer was asked. */
  const enabledOn = (peer: ScriptedCdpPeer, tabTarget: string | undefined) =>
    peer.sent.filter((command) => /\.enable$/.test(command.method)).map((command) => `${command.targetId === tabTarget ? "tab" : "frame"} ${command.method}`);

  it("reads a cross-site frame through the debugger's child session, in an isolated world of its own, and the first deep verb turns Runtime, Log and Network on for the tab and the frame", async () => {
    const { chrome, peer, perform } = await live();
    peer.document("https://shop.example/", { frames: [{ url: "https://pay.example/embed", crossSite: true }] });
    peer.inPage("showsText", ({ frame, args }) => frame.url === "https://pay.example/embed" && args[0] === "Card accepted");
    await perform({ verb: "open", args: { url: "https://shop.example/" } });
    const tab = chrome.tabsOpen()[0]?.targetId;

    expect(await perform({ verb: "waitFor", args: { until: { text: "Card accepted" } } })).toEqual({ ok: true, value: { url: "https://shop.example/", title: "" } });
    const worlds = peer.sentOf("Page.createIsolatedWorld").filter((command) => command.targetId !== tab);
    expect(worlds).toHaveLength(1);
    expect(worlds[0]?.sessionId).toEqual(expect.any(String));
    expect(enabledOn(peer, tab)).toEqual(["tab Page.enable", "frame Page.enable"]);

    expect(await perform({ verb: "console", args: {} })).toEqual({ ok: true, value: [] });
    expect(enabledOn(peer, tab)).toEqual([
      "tab Page.enable",
      "frame Page.enable",
      "tab Runtime.enable",
      "tab Log.enable",
      "tab Network.enable",
      "frame Runtime.enable",
      "frame Log.enable",
      "frame Network.enable",
    ]);
  });

  it("finds its tab again after Chrome stopped the worker, takes the debugger back from its earlier session, and turns the deep domains on at attach on a dev site", async () => {
    const { chrome, peer, perform, restart } = await live();
    await perform({ verb: "open", args: { url: "http://localhost:5173/" } });
    const tab = chrome.tabsOpen()[0]?.targetId;
    expect(enabledOn(peer, tab)).toEqual(["tab Page.enable", "tab Runtime.enable", "tab Log.enable", "tab Network.enable"]);

    await restart();

    expect(await perform({ verb: "screenshot", args: {} })).toMatchObject({ ok: true, value: { mimeType: "image/jpeg" } });
    expect(chrome.tabsOpen()).toHaveLength(1);
    expect(peer.sentOf("Target.attachToTarget").map(({ params }) => params.targetId)).toEqual([tab, tab]);
    expect(enabledOn(peer, tab).slice(4)).toEqual(["tab Page.enable", "tab Runtime.enable", "tab Log.enable", "tab Network.enable"]);
  });
});

describe("the page policy in the browser", () => {
  /** A denylist browser-section entry, enabled, as the policy carries it. */
  const listed = (pattern: string) => ({ id: `test:${pattern}`, pattern, note: "", preset: false, enabled: true });

  it("judges the tab's address by the policy the environment sent last, before every verb and after every load, and a verb on a listed page answers the address and the entry", async () => {
    const { peer, socket, perform } = await live();
    peer.document("https://shop.example/pay", { redirect: "https://www.paypal.com/checkout" });
    await perform({ verb: "open", args: { url: "https://shop.example/" } });

    socket.send({ type: "policy", policy: { ...POLICY, browserDomains: [listed("shop.example")] } });
    expect(await perform({ verb: "screenshot", args: {} })).toEqual({
      ok: false,
      reason: "The page is at https://shop.example/, which the denylist's browser section lists (shop.example), so it was stopped at about:blank. Only the person can allow it.",
      denylist: { frame: "top-level", match: { section: "browserDomains", entry: listed("shop.example"), matched: "https://shop.example/" } },
    });

    socket.send({ type: "policy", policy: { ...POLICY, browserDomains: [listed("*.paypal.com")] } });
    expect(await perform({ verb: "navigate", args: { url: "https://shop.example/pay" } })).toEqual({
      ok: false,
      reason: "The page went to https://www.paypal.com/checkout, which the denylist's browser section lists (*.paypal.com), so it was stopped at about:blank. Only the person can allow it.",
      denylist: { frame: "top-level", match: { section: "browserDomains", entry: listed("*.paypal.com"), matched: "https://www.paypal.com/checkout" } },
    });
    expect(await perform({ verb: "open", args: {} })).toEqual({ ok: true, value: { url: "about:blank", title: "" } });
  });

  it("refuses the page whole for a sub-frame into a listed domain, and opens a listed host once with the allowance a call carries", async () => {
    const { peer, perform } = await live({ policy: { ...POLICY, browserDomains: [listed("*.paypal.com")] } });
    peer.document("https://shop.example/checkout", { frames: [{ url: "https://www.paypal.com/sdk", crossSite: true }] });
    expect(await perform({ verb: "open", args: { url: "https://shop.example/checkout" } })).toEqual({
      ok: false,
      reason: "A frame of the page loaded https://www.paypal.com/sdk, which the denylist's browser section lists (*.paypal.com), so the whole page was stopped at about:blank.",
      denylist: { frame: "sub-frame", match: { section: "browserDomains", entry: listed("*.paypal.com"), matched: "https://www.paypal.com/sdk" } },
    });

    peer.document("https://www.paypal.com/signin", { title: "Log in" });
    const allowance = { host: "www.paypal.com" };
    expect(await perform({ verb: "navigate", args: { url: "https://www.paypal.com/signin" } }, { allowance })).toEqual({
      ok: true,
      value: { url: "https://www.paypal.com/signin", title: "Log in" },
    });
    expect(await perform({ verb: "navigate", args: { url: "https://www.paypal.com/signin" } })).toMatchObject({ ok: false, denylist: { frame: "top-level" } });
  });

  it("counts loopback and private addresses as dev sites without listing them, where storage and evaluate answer, and names the setting that would allow them elsewhere", async () => {
    const { peer, perform } = await live();
    peer.inPage("readStorage", () => ({ origin: "http://192.168.1.20", local: { theme: "dark" }, session: {} }));
    peer.answer("Runtime.evaluate", () => ({ result: { type: "number", value: 2 } }));
    peer.document("https://example.com/", { cookies: [{ name: "sid", value: "token-for-tests" }] });

    await perform({ verb: "open", args: { url: "http://192.168.1.20/" } });
    expect(await perform({ verb: "evaluate", args: { expression: "1 + 1" } })).toEqual({ ok: true, value: { result: 2 } });
    expect(await perform({ verb: "storage", args: {} })).toEqual({ ok: true, value: { origin: "http://192.168.1.20", local: { theme: "dark" }, session: {} } });

    await perform({ verb: "navigate", args: { url: "https://example.com/" } });
    expect(await perform({ verb: "evaluate", args: { expression: "1 + 1" } })).toEqual({
      ok: false,
      reason: "evaluate runs only on dev sites, and example.com is not one. Add it to browser.devSites, or turn on browser.evaluateEverywhere, to run it.",
    });
    expect(await perform({ verb: "storage", args: {} })).toEqual({
      ok: false,
      reason: "Storage is read only on dev sites, and example.com is not one. Add it to browser.devSites, or turn on browser.deepReadEverywhere, to read it.",
    });
    const cookies = await perform({ verb: "cookies", args: {} });
    expect(cookies).toMatchObject({
      ok: true,
      value: [{ name: "sid", domain: "example.com" }],
      notice: "Cookie values are left out: example.com is not a dev site. Add it to browser.devSites, or turn on browser.deepReadEverywhere, to read them.",
    });
    expect(JSON.stringify(cookies)).not.toContain("token-for-tests");
  });

  it("refuses the Chrome Web Store under every policy, a policy that lists it as a dev site too", async () => {
    const { perform } = await live({ policy: { ...POLICY, devSites: ["chromewebstore.google.com"], evaluateEverywhere: true, deepReadEverywhere: true } });
    await perform({ verb: "open", args: {} });
    expect(await perform({ verb: "navigate", args: { url: "https://chromewebstore.google.com/" } })).toEqual({
      ok: false,
      reason: "https://chromewebstore.google.com/ is on the Chrome Web Store, where Chrome lets no extension read or act, so the browser did not open it.",
    });
  });
});

describe("a managed profile whose policy blocks the debugger", () => {
  it("answers every verb with its sentence, and makes no tab after the first", async () => {
    const { chrome, perform } = await live({ debuggerBlocked: true });
    const blocked = {
      ok: false,
      reason:
        "This Chrome does not let extensions use its debugger, which is how the agent-harness extension drives pages: a policy of the organisation that manages this Chrome profile (DeveloperToolsAvailability) turns it off. Use the headless browser for this session, or a Chrome profile the policy does not cover.",
    };
    expect(await perform({ verb: "open", args: { url: "https://example.com/" } })).toEqual(blocked);
    for (const command of [
      { verb: "open", args: {} },
      { verb: "snapshot", args: {} },
      { verb: "screenshot", args: {} },
      { verb: "close", args: {} },
    ] as const) {
      expect(await perform(command), command.verb).toEqual(blocked);
    }
    expect(chrome.tabsOpen()).toHaveLength(1);
    expect(chrome.attachedTabs()).toEqual([]);
  });
});
