import type { EnvironmentReadiness } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { serviceVerdict, type ServiceFacts } from "./status.js";

const at = "http://127.0.0.1:7433";

type Row = [installed: boolean, running: boolean, readiness: EnvironmentReadiness | undefined, ready: boolean, summary: string];

const notInstalledButAnswering =
  "No service is installed, but an environment answers at http://127.0.0.1:7433: it was started another way, such as `agent-harness serve` in a terminal.";
const definitionGone = "The service is running, but its definition is gone. `agent-harness service install` puts it back.";
const stoppedButAnswering =
  "The service is installed but not running; the environment answering at http://127.0.0.1:7433 was started another way and holds the port the service would use.";

/** Every combination of installed, running and what the discovery URL answers. */
const table: Row[] = [
  [false, false, undefined, false, "No service is installed. `agent-harness service install` installs it."],
  [false, false, "starting", false, notInstalledButAnswering],
  [false, false, "ready", false, notInstalledButAnswering],
  [false, false, "draining", false, notInstalledButAnswering],
  [false, true, undefined, false, definitionGone],
  [false, true, "starting", false, definitionGone],
  [false, true, "ready", false, definitionGone],
  [false, true, "draining", false, definitionGone],
  [true, false, undefined, false, "The service is installed but not running. `agent-harness service start` starts it."],
  [true, false, "starting", false, stoppedButAnswering],
  [true, false, "ready", false, stoppedButAnswering],
  [true, false, "draining", false, stoppedButAnswering],
  [
    true,
    true,
    undefined,
    false,
    "The service is running, but nothing answers at http://127.0.0.1:7433: it is still starting, or it could not bind that port.",
  ],
  [true, true, "starting", false, "The service is running and the environment at http://127.0.0.1:7433 is starting."],
  [true, true, "ready", true, "The service is running and the environment at http://127.0.0.1:7433 is ready."],
  [
    true,
    true,
    "draining",
    false,
    "The service is running and the environment at http://127.0.0.1:7433 is draining before a restart.",
  ],
];

describe("the service status verdict", () => {
  it("covers every combination of installed, running and readiness exactly once", () => {
    const keys = table.map(([installed, running, readiness]) => `${installed}/${running}/${readiness}`);
    expect(new Set(keys).size).toBe(2 * 2 * 4);
  });

  it.each(table)("installed %s, running %s, readiness %s: ready %s", (installed, running, readiness, ready, summary) => {
    const facts: ServiceFacts = { installed, running, readiness };
    expect(serviceVerdict(facts, at)).toEqual({ ready, summary });
  });
});
