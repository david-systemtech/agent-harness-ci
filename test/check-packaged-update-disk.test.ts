import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("removes its scratch directory with retries, since Windows holds the data directory's exited node.exe a moment (#1940)", async () => {
  const check = await import(pathToFileURL(join(import.meta.dirname, "../scripts/check-packaged-update-disk.mjs")).href);
  const calls: unknown[][] = [];
  check.removeScratch("scratch", (...args: unknown[]) => { calls.push(args); });
  expect(calls).toEqual([["scratch", { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }]]);
});
