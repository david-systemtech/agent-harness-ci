/**
 * A child process standing in for `serve` on the launcher's channel, for the
 * tests of the preset channel over a real IPC channel: it says `prepared`
 * with the version in its first argument, and once committed asks
 * `versions?` and answers the launcher's queries. It prints what happened on
 * stdout, one JSON line each, and exits 1 when the start fails.
 */
import { processLauncherChannel } from "../src/serve/launcher.js";

const report = (line: Record<string, unknown>) => void process.stdout.write(`${JSON.stringify(line)}\n`);

const channel = processLauncherChannel();
try {
  await channel.prepared(process.argv[2] ?? "0.0.0");
  report({ committed: true });
  channel.onQuery(() => ({ type: "idle", readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false }));
  report({ versions: await channel.request({ type: "versions?" }) });
} catch (error) {
  report({ failed: error instanceof Error ? error.message : String(error) });
  // Not process.exit: the report line must reach a pipe that flushes asynchronously (macOS) before the process ends.
  process.exitCode = 1;
}
