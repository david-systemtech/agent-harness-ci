import { join } from "node:path";
import { SCOPES, type BridgeCall, type ParamsOf, type ResultOf } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter } from "../../test/fake-adapter.js";
import { answeringFrom, fakeChrome, type ExtensionScript, type FakeChrome, type FakeExtension } from "../../test/fake-extension.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { scriptedPageDriver, type ScriptedPageDriver } from "../../test/scripted-page-driver.js";
import { refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * Driving a paired Chrome (browser spec, "The browser relay", "The browser
 * as a session field" and "Testing Decisions"; ADR 0014; #552) through the
 * primary seam: the in-process environment with the fake extension paired
 * over the real socket and answering verbs from a script (a scripted page
 * driver), the typed client for `browser.chromes.perform`, and the scripted
 * fake adapter calling the `browser` server's tools on the direct path.
 * What is asserted is what the extension was asked, what the client and the
 * model read, and what the session records.
 */

const { onCleanup } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ adapter: fakeAdapter(), ...options });
  onCleanup(() => t.close());
  return t;
};

const folderOf = (t: Pick<TestEnvironment, "dataDir">): string => join(t.dataDir, "extension", "current");

/** A client of `t`, closed after the test. */
const clientOf = async (t: TestEnvironment, options?: Parameters<TestEnvironment["client"]>[0]): Promise<WireClient> => {
  const client = await t.client(options);
  onCleanup(() => client.close());
  return client;
};

/** A paired Chrome: the fake extension's profile, its id, the scripted driver its extension answers from, and its live socket. */
interface Paired {
  readonly chrome: FakeChrome;
  readonly id: string;
  readonly driver: ScriptedPageDriver;
  extension: FakeExtension;
}

/** Pairs a fake Chrome as `name` whose extension answers every verb from a scripted page driver, and keeps its socket open. */
const pair = async (t: TestEnvironment, name: string, script?: ExtensionScript): Promise<Paired> => {
  const driver = scriptedPageDriver("chrome");
  const chrome = fakeChrome(folderOf(t), { script: script ?? answeringFrom(driver) });
  const { code } = await (await clientOf(t)).apply("browser.pairing.code", {});
  const { extension, answer } = await chrome.pair(code, name);
  onCleanup(() => extension.close());
  if (answer.type !== "paired") throw new Error(`The pairing was refused: ${JSON.stringify(answer)}`);
  return { chrome, id: answer.chromeId, driver, extension };
};

/** Opens a paired Chrome's socket again, proving its pairing, as the extension does when Chrome starts. */
const reconnect = async (paired: Paired, options?: Parameters<FakeChrome["connect"]>[0]): Promise<void> => {
  const { extension, answer } = await paired.chrome.connect(options);
  onCleanup(() => extension.close());
  if (answer.type !== "ready") throw new Error(`The Chrome was refused: ${JSON.stringify(answer)}`);
  paired.extension = extension;
};

type PerformParams = ParamsOf<"browser.chromes.perform">;

const PAGE_KEY = "0f8fad5b-d9cb-469f-a165-70867728950e/7c9e6679-7425-40de-944b-e07fc1f90ae7";

/** `browser.chromes.perform` on the Chrome `chromeId` (null for the plain My Chrome) from `client`. */
const perform = (client: WireClient, chromeId: string | null, command: PerformParams["command"], extra: Partial<PerformParams> = {}): Promise<ResultOf<"browser.chromes.perform">> =>
  client.apply("browser.chromes.perform", { chromeId, pageKey: PAGE_KEY, command, ...extra });

/** What the extension was called with, the id aside: the page key, the verb with its arguments, and the allowance. */
const asked = (call: BridgeCall) => ({ pageKey: call.pageKey, command: call.command, ...(call.allowance !== undefined && { allowance: call.allowance }) });

describe("browser.chromes.perform", () => {
  it("sends the verb with the page key and the allowance over the named Chrome's proved socket, and answers the extension's value", async () => {
    const t = await start();
    const work = await pair(t, "Work");
    const client = await clientOf(t);

    const answer = await perform(client, work.id, { verb: "navigate", args: { url: "https://example.com/" } }, { allowance: { host: "example.com" } });

    expect(answer).toEqual({ outcome: { ok: true, value: { url: "https://example.com/", title: "A fixture page" } } });
    expect(work.extension.calls.map(asked)).toEqual([{ pageKey: PAGE_KEY, command: { verb: "navigate", args: { url: "https://example.com/" } }, allowance: { host: "example.com" } }]);
  });

  it("answers the extension's refusal as it is, its denylist match included", async () => {
    const t = await start();
    const work = await pair(t, "Work");
    const refused = {
      ok: false as const,
      reason: "www.paypal.com is on the denylist.",
      denylist: {
        frame: "top-level" as const,
        match: { section: "browserDomains" as const, entry: { id: "preset:*.paypal.com", pattern: "*.paypal.com", note: "Payments.", preset: true, enabled: true }, matched: "https://www.paypal.com/" },
      },
    };
    work.driver.next("navigate", refused);

    expect(await perform(await clientOf(t), work.id, { verb: "navigate", args: { url: "https://www.paypal.com/" } })).toEqual({ outcome: refused });
  });

  it("is forbidden, with reason local, to a client session that is not local, and the extension is asked nothing", async () => {
    const t = await start();
    const work = await pair(t, "Work");
    const paired = await clientOf(t, { token: (await t.pair({ scopes: SCOPES })).token });

    expect(await refusal(perform(paired, work.id, { verb: "snapshot", args: {} }))).toMatchObject({ code: "forbidden", data: { scope: "runs:drive", reason: "local" } });
    expect(work.extension.calls).toEqual([]);
  });
});
