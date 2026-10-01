import { join } from "node:path";
import { CHROME_PAIRING_CODE_LENGTH, PAIRING_CODE_ALPHABET } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../environment/test/cleanups.js";
import { fakeChrome, type FakeChrome, type FakeConnection } from "../../environment/test/fake-extension.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../environment/test/helper.js";
import { WAIT_MS } from "../../environment/test/wire-client.js";
import { runCli, type CliContext } from "./cli.js";

/**
 * `agent-harness browser pair` (browser spec, "The extension, its folder and
 * its listener"; #560) against the in-process environment through its
 * bootstrap grant, with the fake extension loading and pairing by the code
 * the verb printed, the verb's countdown on the environment's manual clock,
 * and its output and exit code captured.
 */

const { onCleanup } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

const folderOf = (t: Pick<TestEnvironment, "dataDir">): string => join(t.dataDir, "extension", "current");

/** The fake extension in one Chrome profile, whose sockets close after the test. */
const chromeOf = (t: Pick<TestEnvironment, "dataDir">): FakeChrome => {
  const chrome = fakeChrome(folderOf(t));
  const closing = (connection: FakeConnection): FakeConnection => {
    onCleanup(() => connection.extension.close());
    return connection;
  };
  return {
    credential: () => chrome.credential(),
    connect: async (options) => closing(await chrome.connect(options)),
    pair: async (code, name) => closing(await chrome.pair(code, name)),
  };
};

/**
 * `browser pair` running in-process on `t`: its output captured, its
 * countdown on `t`'s clock, and an interrupt the test sends. Interrupted
 * and awaited after the test, so none outlives it.
 */
const pairing = (t: TestEnvironment, args: readonly string[] = []) => {
  let out = "";
  let err = "";
  const listeners = new Set<() => unknown>();
  let interrupt!: () => void;
  const interrupted = new Promise<void>((resolve) => (interrupt = resolve));
  const context: Partial<CliContext> = {
    stdout: (text) => {
      out += text;
      for (const listener of listeners) listener();
    },
    stderr: (text) => {
      err += text;
      for (const listener of listeners) listener();
    },
    stopRequested: () => interrupted,
    clock: t.clock,
  };
  const exit = runCli(["browser", "pair", "--data-dir", t.dataDir, ...args], context);
  onCleanup(async () => {
    interrupt();
    await exit.catch(() => undefined);
  });
  /** The first match of `pattern` in the output from `from` on, once the verb has printed it. */
  const said = (pattern: RegExp, from = 0): Promise<RegExpExecArray> =>
    new Promise((resolve, reject) => {
      const look = () => {
        const found = pattern.exec(out.slice(from));
        if (found === null) return false;
        listeners.delete(look);
        clearTimeout(timer);
        resolve(found);
        return true;
      };
      const timer = setTimeout(() => {
        listeners.delete(look);
        reject(new Error(`The verb never said ${String(pattern)}; it said:\n${out}\n${err}`));
      }, WAIT_MS);
      if (!look()) listeners.add(look);
    });
  return { exit, out: () => out, err: () => err, said, interrupt };
};

/** A code line the verb printed: the code alone, indented. */
const CODE_LINE = new RegExp(`\\n {2}([${PAIRING_CODE_ALPHABET}]{${CHROME_PAIRING_CODE_LENGTH}})\\n`);

describe("agent-harness browser pair", () => {
  it("prints the folder and the Chrome lines, says when the extension loads, and exits 0 once the fake extension pairs by the printed code, naming the Chrome", async () => {
    const t = await start();
    const cli = pairing(t);

    const [, code] = await cli.said(CODE_LINE);
    expect(cli.out()).toContain(
      [
        "Load the extension in Chrome from this folder:",
        "",
        `  ${folderOf(t)}`,
        "",
        "  1. Open chrome://extensions.",
        "  2. Turn on Developer mode.",
        "  3. Click Load unpacked and choose this folder.",
        "",
        "Then type this code on the extension's options page:",
        "",
        `  ${code}`,
        "",
        "It is good for 5:00.",
        "",
      ].join("\n"),
    );

    const chrome = chromeOf(t);
    expect((await chrome.connect()).answer.type).toBe("announced");
    await cli.said(/The extension has loaded/);

    expect((await chrome.pair(code ?? "", "Work")).answer.type).toBe("paired");
    expect(await cli.exit).toBe(0);
    expect(cli.out()).toMatch(/Paired the Chrome named "Work"\.\n$/);
    expect(cli.err()).toBe("");
  });
});
