import { describe, expect, it } from "vitest";
import { serviceVerdict, type DiscoveryAnswer } from "./status.js";

const at = "http://127.0.0.1:7433";

type Row = [installed: boolean, running: boolean, answer: DiscoveryAnswer, ready: boolean, readyLine: string, summary: string];

const nothing = `no (nothing answers at ${at})`;
const foreign = `no (something other than an environment answers at ${at})`;
const notInstalledButAnswering = `No service is installed, but an environment answers at ${at}: it was started another way, such as \`agent-harness serve\` in a terminal.`;
const definitionGone = "The service is running, but its definition is gone. `agent-harness service install` puts it back.";
const stoppedButAnswering = `The service is installed but not running; the environment answering at ${at} was started another way and holds the port the service would use.`;

/** Every combination of installed, running and what the discovery URL answered. */
const table: Row[] = [
  [false, false, "nothing", false, nothing, "No service is installed. `agent-harness service install` installs it."],
  [false, false, "not-an-environment", false, foreign, `No service is installed, and something other than an environment answers at ${at}.`],
  [false, false, "starting", false, "no (starting)", notInstalledButAnswering],
  [false, false, "ready", false, "no (the service is not installed)", notInstalledButAnswering],
  [false, false, "draining", false, "no (draining)", notInstalledButAnswering],
  [false, true, "nothing", false, nothing, definitionGone],
  [false, true, "not-an-environment", false, foreign, definitionGone],
  [false, true, "starting", false, "no (starting)", definitionGone],
  [false, true, "ready", false, "no (the service is not installed)", definitionGone],
  [false, true, "draining", false, "no (draining)", definitionGone],
  [true, false, "nothing", false, nothing, "The service is installed but not running. `agent-harness service start` starts it."],
  [
    true,
    false,
    "not-an-environment",
    false,
    foreign,
    `The service is installed but not running, and something other than an environment answers at ${at}, on the port the service would use.`,
  ],
  [true, false, "starting", false, "no (starting)", stoppedButAnswering],
  [true, false, "ready", false, "no (the service is not running)", stoppedButAnswering],
  [true, false, "draining", false, "no (draining)", stoppedButAnswering],
  [true, true, "nothing", false, nothing, `The service is running, but nothing answers at ${at}: it is still starting, or it could not bind that port.`],
  [
    true,
    true,
    "not-an-environment",
    false,
    foreign,
    `The service is running, but something other than an environment answers at ${at}: another program holds that port.`,
  ],
  [true, true, "starting", false, "no (starting)", `The service is running and the environment at ${at} is starting.`],
  [true, true, "ready", true, "yes", `The service is running and the environment at ${at} is ready.`],
  [true, true, "draining", false, "no (draining)", `The service is running and the environment at ${at} is draining before a restart.`],
];

describe("the service status verdict", () => {
  it("covers every combination of installed, running and discovery answer exactly once", () => {
    const keys = table.map(([installed, running, answer]) => `${installed}/${running}/${answer}`);
    expect(new Set(keys).size).toBe(2 * 2 * 5);
  });

  it.each(table)("installed %s, running %s, answer %s: ready %s", (installed, running, answer, ready, readyLine, summary) => {
    expect(serviceVerdict({ installed, running, answer }, at)).toEqual({ ready, readyLine, summary });
  });
});
