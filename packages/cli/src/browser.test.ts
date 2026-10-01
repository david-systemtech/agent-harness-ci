import { createServer, type AddressInfo, type Server } from "node:net";
import { join } from "node:path";
import { CHROME_PAIRING_CODE_LENGTH, PAIRING_CODE_ALPHABET } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../environment/test/cleanups.js";
import { fakeChrome, type FakeChrome, type FakeConnection } from "../../environment/test/fake-extension.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../environment/test/helper.js";
import type { ManualClock } from "../../environment/test/clock.js";
import { WAIT_MS, type WireClient } from "../../environment/test/wire-client.js";
import { runCli, type CliContext } from "./cli.js";

/**
 * `agent-harness browser pair` (browser spec, "The extension, its folder and
 * its listener"; #560) against the in-process environment through its
 * bootstrap grant, with the fake extension loading and pairing by the code
 * the verb printed, the verb's countdown on the environment's manual clock,
 * and its output and exit code captured.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

const folderOf = (t: Pick<TestEnvironment, "dataDir">): string => join(t.dataDir, "extension", "current");

/** A client of `t`, closed after the test. */
const clientOf = async (t: TestEnvironment): Promise<WireClient> => {
  const client = await t.client();
  onCleanup(() => client.close());
  return client;
};

/** A loopback port held until the test ends, so the listener cannot take it. */
const holdPort = async (): Promise<number> => {
  const server: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => resolve());
  });
  onCleanup(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
};

/** A loopback port free a moment ago, where nothing answers. */
const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

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

/** `clock` as the verb's countdown sees it, counting the timers it has set and neither run nor cancelled. */
const countingTimers = (clock: ManualClock) => {
  let live = 0;
  const counted: NonNullable<CliContext["clock"]> = {
    now: () => clock.now(),
    setTimeout: (callback, ms) => {
      let done = false;
      const settle = () => {
        if (!done) live -= 1;
        done = true;
      };
      live += 1;
      const timer = clock.setTimeout(() => {
        settle();
        callback();
      }, ms);
      return {
        cancel: () => {
          settle();
          timer.cancel();
        },
      };
    },
  };
  return { clock: counted, live: () => live };
};

/**
 * `browser pair` running in-process with `args`: its output captured, its
 * countdown on `clock`, the timers it leaves, and an interrupt the test
 * sends. Interrupted and awaited after the test, so none outlives it.
 */
const browserPair = (args: readonly string[], clock?: ManualClock) => {
  let out = "";
  let err = "";
  const timers = clock === undefined ? undefined : countingTimers(clock);
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
    ...(timers !== undefined && { clock: timers.clock }),
  };
  const exit = runCli(["browser", "pair", ...args], context);
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
  return { exit, out: () => out, err: () => err, said, interrupt, timers: () => timers?.live() ?? 0 };
};

/** `browser pair` on `t` through its data directory's grant, its countdown on `t`'s clock. */
const pairing = (t: TestEnvironment, args: readonly string[] = []) => browserPair(["--data-dir", t.dataDir, ...args], t.clock);

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
    expect(cli.timers()).toBe(0);
  });

  it("counts the code down a line a minute and prints a fresh code when it expires, which the fake extension pairs by while the expired one is refused", async () => {
    const t = await start();
    const cli = pairing(t);
    const [, first] = await cli.said(CODE_LINE);
    const told = cli.out().length;

    t.clock.advance(60_000);
    expect(cli.out().slice(told)).toBe("4:00 left on the code.\n");
    t.clock.advance(3 * 60_000 - 1);
    expect(cli.out().slice(told)).toBe("4:00 left on the code.\n3:00 left on the code.\n2:00 left on the code.\n");
    t.clock.advance(1);
    expect(cli.out().slice(told)).toBe("4:00 left on the code.\n3:00 left on the code.\n2:00 left on the code.\n1:00 left on the code.\n");

    t.clock.advance(60_000);
    const [, fresh] = await cli.said(CODE_LINE, told);
    expect(fresh).not.toBe(first);
    expect(cli.out().slice(told)).toBe(
      [
        "4:00 left on the code.",
        "3:00 left on the code.",
        "2:00 left on the code.",
        "1:00 left on the code.",
        "That code expired. Type this one instead:",
        "",
        `  ${fresh}`,
        "",
        "It is good for 5:00.",
        "",
      ].join("\n"),
    );

    const chrome = chromeOf(t);
    expect((await chrome.pair(first ?? "", "Old code")).answer.type).toBe("refused");
    expect((await chrome.pair(fresh ?? "", "Fresh code")).answer.type).toBe("paired");
    expect(await cli.exit).toBe(0);
    expect(cli.out()).toMatch(/Paired the Chrome named "Fresh code"\.\n$/);
  });

  it("counts down the live code a client minted earlier from the time it has left, to the next whole minute", async () => {
    const t = await start();
    const admin = await clientOf(t);
    const minted = await admin.apply("browser.pairing.code", {});
    t.clock.advance(2 * 60_000 + 23_000);

    const cli = pairing(t);
    const [, code] = await cli.said(CODE_LINE);
    expect(code).toBe(minted.code);
    expect(cli.out()).toMatch(/\nIt is good for 2:37\.\n$/);
    const told = cli.out().length;
    t.clock.advance(36_999);
    expect(cli.out().slice(told)).toBe("");
    t.clock.advance(1);
    expect(cli.out().slice(told)).toBe("2:00 left on the code.\n");
  });

  it("says the extension has loaded at once when an unpaired one holds a socket already", async () => {
    const t = await start();
    expect((await chromeOf(t).connect()).answer.type).toBe("announced");
    const cli = pairing(t);
    await cli.said(CODE_LINE);
    expect(cli.out()).toContain("  3. Click Load unpacked and choose this folder.\n\nThe extension has loaded in Chrome and waits for the code.\nThen type this code");
  });

  it("stops when interrupted, saying so and exiting 1, with its client session revoked, no Chrome paired and no countdown left running", async () => {
    const t = await start();
    const cli = pairing(t);
    await cli.said(CODE_LINE);

    cli.interrupt();
    expect(await cli.exit).toBe(1);
    expect(cli.err()).toBe("Stopped before a Chrome paired.\n");
    expect(cli.timers()).toBe(0);
    const said = cli.out();
    t.clock.advance(5 * 60_000);
    expect(cli.out()).toBe(said);

    const admin = await clientOf(t);
    expect((await admin.apply("browser.chromes.list", {})).chromes).toEqual([]);
    const own = (await admin.request("access.sessions.list", {})).sessions.filter((session) => session.label === "agent-harness browser pair");
    expect(own).toHaveLength(1);
    expect(own[0]?.revokedAt).not.toBeNull();
  });

  it("prints the port-in-use error and exits 1 when the listener is not listening, with no code minted", async () => {
    const held = await holdPort();
    const t = await start({ browser: { ports: { preferred: held, last: held } } });
    const cli = pairing(t);
    expect(await cli.exit).toBe(1);
    expect(cli.err()).toMatch(new RegExp(`^Port ${held} on loopback is in use or reserved, so no Chrome can reach this environment\\.`));
    expect(cli.out()).toBe("");
  });

  it("says what is wrong with the extension's folder and exits 1 when it does not hold the extension", async () => {
    const t = await start({ browser: { extensionSource: join(tempDir(), "no-extension-here") } });
    const cli = pairing(t);
    expect(await cli.exit).toBe(1);
    expect(cli.err()).toMatch(/^This environment carries no built extension: /);
    expect(cli.out()).toBe("");
  });

  it("says so and exits 1 when no environment runs on the data directory", async () => {
    const cli = browserPair(["--data-dir", tempDir()]);
    expect(await cli.exit).toBe(1);
    expect(cli.err()).toMatch(/^No environment is running on .*: it has no bootstrap grant file\.\n$/);
    expect(cli.out()).toBe("");
  });

  it("connects on the port --port names rather than the grant's", async () => {
    const t = await start();
    const free = await freePort();
    const cli = pairing(t, ["--port", String(free)]);
    expect(await cli.exit).toBe(1);
    expect(cli.err()).toContain(`The environment at http://127.0.0.1:${free} did not answer`);
  });

  it("prints its usage and exits 2 on arguments it cannot parse", async () => {
    for (const args of [["browser"], ["browser", "unpair"], ["browser", "pair", "extra"], ["browser", "pair", "--port", "0"], ["browser", "pair", "--code", "x"]]) {
      let err = "";
      expect(await runCli(args, { stdout: () => undefined, stderr: (text) => void (err += text) }), args.join(" ")).toBe(2);
      expect(err).toContain("agent-harness browser pair [--data-dir <path>] [--port <n>]");
    }
  });
});
