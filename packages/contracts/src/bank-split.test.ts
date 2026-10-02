import { expect, it } from "vitest";
import { BankSplitTopics, exportedSchemas, methods } from "./index.js";

it("publishes split proposals as reads and authored acceptance as an admin command", () => {
  const propose = methods.find((method) => method.name === "banks.split.propose");
  const apply = methods.find((method) => method.name === "banks.split.apply");
  expect(methods.filter((method) => method.name === "banks.split.propose")).toHaveLength(1);
  expect(methods.filter((method) => method.name === "banks.split.apply")).toHaveLength(1);
  expect(propose).toMatchObject({ scope: "read", kind: "query" });
  expect(apply).toMatchObject({ scope: "admin", kind: "command" });
  expect(propose?.params.safeParse({ pointer: "maya-memory:personal/homelab/" }).success).toBe(true);
  expect(apply?.params.safeParse({ pointer: "maya-memory:personal/homelab/", topics: {} }).success).toBe(false);
});

it("exports authored topics and proposals alongside the memory tool and review-event schemas", () => {
  const paths = exportedSchemas().map((entry) => entry.path);
  expect(paths).toEqual(expect.arrayContaining(["banks/split-pointer.json", "banks/split-topics.json", "banks/split-proposal.json", "banks/events/bank.awaiting-review.json", "banks/events/bank.landed.json", "banks/events/bank.landing-failed.json", "banks/events/bank.review-held.json", "banks/tools/read.json"]));
  expect(BankSplitTopics.safeParse({ backup: { line: "Backup facts", memories: ["backup-schedule"] } }).success).toBe(true);
  expect(BankSplitTopics.safeParse({ "../escape": { line: "Bad path", memories: ["backup-schedule"] } }).success).toBe(false);
});
