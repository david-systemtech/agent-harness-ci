#!/usr/bin/env node
/**
 * The `agent-harness` binary. `launch` goes to the launcher before anything
 * else is loaded: the launcher runs on Node's built-ins and the contracts'
 * launcher module alone, and every other verb loads the environment package.
 */
import { processContext } from "./process-context.js";

const args = process.argv.slice(2);
if (args[0] === "launch") {
  const { launch } = await import("./launch/verb.js");
  process.exitCode = await launch(args.slice(1), processContext);
} else {
  const { runCli } = await import("./cli.js");
  process.exitCode = await runCli(args);
}
