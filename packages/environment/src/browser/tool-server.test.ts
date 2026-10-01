import type { JsonObject, SessionBrowser } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { scriptedPageDriver } from "../../test/scripted-page-driver.js";
import type { HostToolResult } from "../adapter/contract.js";
import { CHOICES_KEPT, createBrowserToolServers } from "./tool-server.js";

const MY_CHROME: SessionBrowser = { kind: "chrome", environmentId: "environment-for-tests", chromeId: null };

/** Browser servers whose every session has a live run of the plain My Chrome and chooses whichever Chrome it names, with the Chrome each verb was driven on. */
const myChromeServers = () => {
  const drivenOn: (string | null)[] = [];
  const driver = scriptedPageDriver("chrome");
  const serverFor = createBrowserToolServers({
    reader: { read: () => Promise.resolve({ text: "", isError: false }) },
    environmentId: MY_CHROME.environmentId,
    live: (sessionId) => ({ runId: `run-of-${sessionId}`, browser: { requested: MY_CHROME, browser: MY_CHROME, reason: "chosen", message: "The session's field names it." } }),
    drivers: {
      chrome: (request) => {
        drivenOn.push(request.browser.chromeId);
        return driver;
      },
    },
    chooseChrome: ({ name }) => ({ ok: true, chrome: { id: `chrome-${name}`, name } }),
  });
  const call = (sessionId: string, name: string, input: JsonObject): Promise<HostToolResult> => {
    const tool = serverFor({ sessionId, browser: MY_CHROME }).tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.call(input, { toolCallId: null });
  };
  /** Takes a snapshot in the session's run, answering the Chrome it was driven on: null for the plain My Chrome. */
  const chromeOf = async (sessionId: string): Promise<string | null | undefined> => {
    await call(sessionId, "browser_snapshot", {});
    return drivenOn.at(-1);
  };
  return { call, chromeOf };
};

describe("the Chrome the agent chose with browser_open's browser", () => {
  it("is kept for the sessions that chose most recently: past the bound, the least recently chosen goes, and its run's next verb is the plain My Chrome's again", async () => {
    const { call, chromeOf } = myChromeServers();
    const choose = (index: number) => call(`session-${index}`, "browser_open", { address: "example.com", snapshot: false, browser: `Chrome ${index}` });

    await choose(0);
    expect(await chromeOf("session-0")).toBe("chrome-Chrome 0");

    for (let index = 1; index <= CHOICES_KEPT; index += 1) await choose(index);

    expect(await chromeOf("session-1")).toBe("chrome-Chrome 1");
    expect(await chromeOf(`session-${CHOICES_KEPT}`)).toBe(`chrome-Chrome ${CHOICES_KEPT}`);
    expect(await chromeOf("session-0")).toBeNull();
  });

  it("choosing again in a session makes its choice the most recent, so another's goes first", async () => {
    const { call, chromeOf } = myChromeServers();
    const choose = (index: number, chrome = `Chrome ${index}`) => call(`session-${index}`, "browser_open", { address: "example.com", snapshot: false, browser: chrome });

    for (let index = 0; index < CHOICES_KEPT; index += 1) await choose(index);
    await choose(0, "Personal");
    await choose(CHOICES_KEPT);

    expect(await chromeOf("session-0")).toBe("chrome-Personal");
    expect(await chromeOf("session-1")).toBeNull();
  });
});
