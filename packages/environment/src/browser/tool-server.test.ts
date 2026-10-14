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
    await call(sessionId, "read_page", {});
    return drivenOn.at(-1);
  };
  return { call, chromeOf };
};

describe("the Chrome the agent chose with select_browser", () => {
  it("is kept for the sessions that chose most recently: past the bound, the least recently chosen goes, and its run's next verb is the plain My Chrome's again", async () => {
    const { call, chromeOf } = myChromeServers();
    const choose = (index: number) => call(`session-${index}`, "select_browser", { snapshot: false, browser: `Chrome ${index}` });

    await choose(0);
    expect(await chromeOf("session-0")).toBe("chrome-Chrome 0");

    for (let index = 1; index <= CHOICES_KEPT; index += 1) await choose(index);

    expect(await chromeOf("session-1")).toBe("chrome-Chrome 1");
    expect(await chromeOf(`session-${CHOICES_KEPT}`)).toBe(`chrome-Chrome ${CHOICES_KEPT}`);
    expect(await chromeOf("session-0")).toBeNull();
  });

  it("choosing again in a session makes its choice the most recent, so another's goes first", async () => {
    const { call, chromeOf } = myChromeServers();
    const choose = (index: number, chrome = `Chrome ${index}`) => call(`session-${index}`, "select_browser", { snapshot: false, browser: chrome });

    for (let index = 0; index < CHOICES_KEPT; index += 1) await choose(index);
    await choose(0, "Personal");
    await choose(CHOICES_KEPT);

    expect(await chromeOf("session-0")).toBe("chrome-Personal");
    expect(await chromeOf("session-1")).toBeNull();
  });
});


describe("an asynchronous Chrome choice", () => {
  it("does not drive a Chrome when the session's live run changes while the choice is pending", async () => {
    let runId = "first-run";
    let answerChoice!: (choice: { ok: true; chrome: { id: string; name: string } }) => void;
    let choiceAsked!: () => void;
    const asked = new Promise<void>((resolve) => { choiceAsked = resolve; });
    const choice = new Promise<{ ok: true; chrome: { id: string; name: string } }>((resolve) => { answerChoice = resolve; });
    const driver = scriptedPageDriver("chrome");
    const serverFor = createBrowserToolServers({
      reader: { read: async () => ({ text: "", isError: false }) },
      environmentId: "run-environment",
      live: () => ({ runId, browser: { requested: MY_CHROME, browser: MY_CHROME, reason: "chosen", message: "Chosen" } }),
      drivers: { chrome: () => driver },
      chooseChrome: () => { choiceAsked(); return choice; },
    });
    const open = serverFor({ sessionId: "session", browser: MY_CHROME }).tools.find((tool) => tool.name === "select_browser");
    if (open === undefined) throw new Error("No select_browser");
    const opening = open.call({ browser: "Work" }, { toolCallId: null });
    await asked;
    runId = "next-run";
    answerChoice({ ok: true, chrome: { id: "chosen-chrome", name: "Work" } });
    expect((await opening).isError).toBe(true);
    expect(driver.calls).toEqual([]);
  });
});

describe("the browser server's tools", () => {
  const serverFor = createBrowserToolServers({
    reader: { read: () => Promise.resolve({ text: "", isError: false }) },
    environmentId: "environment-for-tests",
    live: () => null,
    drivers: {},
    chooseChrome: () => ({ ok: false, reason: "No Chrome." }),
  });
  const names = (browser: SessionBrowser): string[] => serverFor({ sessionId: "session", browser }).tools.map((tool) => tool.name);

  it("are the browser toolset's members beside web_read, with no tool taking a CSS selector", () => {
    const tools = serverFor({ sessionId: "session", browser: { kind: "headless" } }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "web_read", "navigate", "read_page", "get_page_text", "screenshot", "zoom", "left_click", "right_click", "middle_click", "double_click", "triple_click",
      "hover", "left_click_drag", "left_mouse_down", "left_mouse_up", "mouse_move", "scroll", "scroll_to", "type", "form_input", "key", "hold_key", "wait",
      "close_tab", "read_console", "read_network", "read_cookies", "read_storage", "javascript_exec",
    ]);
    expect(tools.filter((tool) => tool.name.startsWith("browser_"))).toEqual([]);
    for (const tool of tools) expect(Object.keys((tool.inputSchema["properties"] ?? {}) as JsonObject)).not.toContain("selector");
  });

  it("offer select_browser only where the run's browser is the plain My Chrome", () => {
    expect(names(MY_CHROME)).toContain("select_browser");
    expect(names({ ...MY_CHROME, chromeId: "chrome-work" })).not.toContain("select_browser");
    expect(names({ kind: "headless" })).not.toContain("select_browser");
  });

  it("are only web_read where the run has no browser", () => {
    expect(names({ kind: "none" })).toEqual(["web_read"]);
  });
});
