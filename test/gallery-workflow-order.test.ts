import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const workflow = readFileSync(join(import.meta.dirname, "../.forgejo/workflows/gallery.yml"), "utf8");

it("queues captures for the same head instead of racing cancellation statuses", () => {
  // Forgejo itself posts job statuses, including cancellation, after the script exits.
  // Its queued concurrency mode orders those jobs; a script-side status guard cannot.
  expect(workflow).toMatch(/^ {2}cancel-in-progress: false$/m);
  expect(workflow).toContain("group: gallery-${{ github.event.pull_request.number }}-${{ github.event.pull_request.head.sha }}");
  expect(workflow).toContain("types: [opened, synchronize, reopened, labeled]");
});

it("isolates the hosted captures by head too so a queued old head cannot cancel a newer capture", () => {
  expect(workflow).toContain("GROUP: gallery-${{ github.event.pull_request.number }}-${{ github.event.pull_request.head.sha }}");
});

// These workflow expressions use only the boolean/property operators shared by
// Actions and JavaScript. Execute the checked-in expressions against event payloads.
function labelJob(action: string, changedLabel?: string, labels: string[] = []) {
  const types = /types: \[([^\]]+)\]/.exec(workflow)?.[1]?.split(", ").map(value => value.trim());
  const condition = /^ {4}if: \$\{\{ (.+) \}\}$/m.exec(workflow)?.[1] ?? "true";
  const name = /^ {4}name: \$\{\{ (.+) \}\}$/m.exec(workflow)?.[1];
  const github = { event: { action, label: changedLabel ? { name: changedLabel } : undefined, pull_request: { labels: labels.map(name => ({ name })) } } };
  const evaluate = (expression: string): unknown => Function("github", `return (${expression})`)(github);
  return { runs: Boolean(types?.includes(action) && evaluate(condition)), name: name ? evaluate(name) : "gallery" };
}

it.each(["bot-1", "ready-for-agent", "review-request"])("ignores %s additions even on a GUI head carrying the force label", (label) => {
  for (const labels of [[label], ["gallery", label]]) {
    const job = labelJob("labeled", label, labels);
    expect(job.runs).toBe(false);
    // Forgejo posts a skipped job's name as its commit-status context. It must
    // differ even if the canonical geometry/pixel verdict is pending or failed.
    expect(job.name).toBe("other-label");
  }
});

it.each(["gallery", "bot-1", "review-request"])("ignores removal of %s without creating a replacement verdict", (label) => {
  expect(labelJob("unlabeled", label).runs).toBe(false);
});

it.each(["opened", "synchronize", "reopened"])("checks the current head on %s with or without a force label", (action) => {
  for (const labels of [[], ["gallery"]]) expect(labelJob(action, undefined, labels)).toEqual({ runs: true, name: "gallery" });
});

it("adding gallery still runs the canonical capture check", () => {
  expect(labelJob("labeled", "gallery", ["gallery"])).toEqual({ runs: true, name: "gallery" });
});
