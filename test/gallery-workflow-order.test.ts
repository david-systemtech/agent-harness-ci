import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const workflow = readFileSync(join(import.meta.dirname, "../.forgejo/workflows/gallery.yml"), "utf8");

it("queues push and label events for the same head instead of racing cancellation statuses", () => {
  // Forgejo itself posts job statuses, including cancellation, after the script exits.
  // Its queued concurrency mode orders those jobs; a script-side status guard cannot.
  expect(workflow).toMatch(/^ {2}cancel-in-progress: false$/m);
  expect(workflow).toContain("group: gallery-${{ github.event.pull_request.number }}-${{ github.event.pull_request.head.sha }}");
  expect(workflow).toContain("types: [opened, synchronize, reopened, labeled, unlabeled]");
});

it("isolates the hosted captures by head too so a queued old head cannot cancel a newer capture", () => {
  expect(workflow).toContain("GROUP: gallery-${{ github.event.pull_request.number }}-${{ github.event.pull_request.head.sha }}");
});
