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
