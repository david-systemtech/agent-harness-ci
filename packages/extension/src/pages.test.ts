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

const { POLICY, setUpPaired, statusOnce, challenged, onCleanup } = workerHarness();

/** The tests' session's page. */
const PAGE: PageKey = "0f8fad5b-d9cb-469f-a165-70867728950e/7c9e6679-7425-40de-944b-e07fc1f90ae7";

interface Live extends Setup {
  readonly peer: ScriptedCdpPeer;
  readonly socket: PeerSocket;
  /** Sends one verb as the environment calls it, and answers the extension's result. */
  perform(command: PageCommand, options?: { readonly pageKey?: PageKey; readonly allowance?: OneTimeAllowance }): Promise<PageOutcome>;
}

/** A paired worker whose socket is live under `policy`, in a Chrome whose browser is a scripted CDP peer. */
const live = async (options: { readonly policy?: PagePolicy; readonly debuggerBlocked?: boolean } = {}): Promise<Live> => {
  const peer = scriptedCdpPeer();
  const browser = await peer.listen();
  onCleanup(() => peer.close());
  const setup = await setUpPaired({ browser, ...(options.debuggerBlocked === true && { debuggerBlocked: true }) });
  const socket = await setup.environment.nextSocket();
  await challenged(setup, socket);
  socket.send({ type: "ready", policy: options.policy ?? POLICY });
  await statusOnce(setup.chrome, (status) => status.state === "connected");
  let calls = 0;
  return {
    ...setup,
    peer,
    socket,
    async perform(command, extra = {}) {
      const id = `call-${++calls}`;
      socket.send({ type: "call", id, pageKey: extra.pageKey ?? PAGE, command, ...(extra.allowance && { allowance: extra.allowance }) });
      const answer = await socket.next((message) => message.type === "result" && message.id === id);
      if (answer.type !== "result") throw new Error(`The extension answered ${answer.type}.`);
      return answer.result;
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
});
