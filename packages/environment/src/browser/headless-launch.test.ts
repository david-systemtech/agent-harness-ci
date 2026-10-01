import { cdpConnection, pipeTransport } from "@agent-harness/browser";
import { describe, expect, it } from "vitest";
import { spawnBrowser } from "./headless-launch.js";

/**
 * The preset launcher (browser spec, "The headless Chromium"; #555): a child
 * process spoken to over file descriptors 3 and 4, as Chromium's
 * `--remote-debugging-pipe` reads and writes them. The child here is a few
 * lines of Node standing in for the browser, never a browser: it answers
 * `Browser.getVersion` with its arguments, and exits on `Browser.close`
 * saying so on its error output.
 */

const STAND_IN = `
const fs = require("node:fs");
const input = fs.createReadStream(null, { fd: 3 });
const output = fs.createWriteStream(null, { fd: 4 });
let buffered = "";
input.on("data", (chunk) => {
  buffered += chunk;
  for (let end = buffered.indexOf("\\0"); end !== -1; end = buffered.indexOf("\\0")) {
    const message = JSON.parse(buffered.slice(0, end));
    buffered = buffered.slice(end + 1);
    if (message.method === "Browser.getVersion") output.write(JSON.stringify({ id: message.id, result: { product: process.argv.slice(1).join(" ") } }) + "\\0");
    if (message.method === "Browser.close") {
      process.stderr.write("[0930/080000.000000:WARNING] starting\\nclosing at the driver's word\\n\\n");
      process.exit(3);
    }
  }
});
`;

describe("the preset launcher", () => {
  it("passes the arguments, speaks over the pipe, and says how the process ended with the last line it wrote to its error output", async () => {
    const launched = spawnBrowser(process.execPath, ["-e", STAND_IN, "--", "--headless=new", "--remote-debugging-pipe"]);
    const connection = cdpConnection(pipeTransport(launched.pipe));
    expect(await connection.send("Browser.getVersion")).toEqual({ product: "--headless=new --remote-debugging-pipe" });
    void connection.send("Browser.close").catch(() => undefined);
    expect(await launched.exited).toBe('it exited with code 3, saying "closing at the driver\'s word"');
    connection.close();
  });

  it("ends a running process when killed", async () => {
    const launched = spawnBrowser(process.execPath, ["-e", STAND_IN]);
    const connection = cdpConnection(pipeTransport(launched.pipe));
    await connection.send("Browser.getVersion");
    launched.kill();
    expect(await launched.exited).toBe("it exited with SIGTERM");
    connection.close();
  });

  it("says an executable that is not there could not be started", async () => {
    const launched = spawnBrowser("/nonexistent/agent-harness-test/chromium", []);
    expect(await launched.exited).toMatch(/^it could not be started \(spawn \/nonexistent\/agent-harness-test\/chromium ENOENT\)$/);
  });
});
