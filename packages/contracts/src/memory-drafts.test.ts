import { expect, it } from "vitest";
import { z } from "zod";
import { EnvironmentNotice, MemoryDraftInput, MemoryRetireInput, MemoryPromoteInput, MemoryPromoteResult, MemorySearchInput, MemoryReadInput, eventTypeEntry, methods, registry } from "./index.js";

it("publishes the draft and retirement inputs and gives banks.drafts.list only read scope", () => {
  const schema = z.toJSONSchema(MemoryDraftInput);
  expect(schema.required).toEqual(["scope", "name", "description", "body", "type"]);
  expect(Object.keys(schema.properties ?? {})).toEqual(["bank", "scope", "topic", "name", "description", "body", "type", "appliesTo"]);
  expect(z.toJSONSchema(MemoryRetireInput).required).toEqual(["bank", "name", "reason"]);
  expect(methods.filter((method) => method.name === "banks.drafts.list").map((method) => method.scope)).toEqual(["read"]);
  expect(registry["banks.drafts.list"].kind).toBe("query");
  const notice = { type: "bank.draft-queued", payload: { sessionId: "5b1c6f3e-2a4d-4e8f-9b0a-1c2d3e4f5a6b", bankId: "6f1c2c1e-8a8f-4b5e-9a65-1d7c5b0f2a10", change: { kind: "retire", name: "fact", path: "projects/personal/homelab/memories/fact.md", reason: "Replaced." } } };
  expect(EnvironmentNotice.parse(notice)).toEqual(notice);
  expect(eventTypeEntry("environment", notice.type)?.list).toBe(false);
});

it("publishes promotion's optional bank and distinguishes main files from pending review files", () => {
  expect(z.toJSONSchema(MemoryPromoteInput).required ?? []).toEqual([]);
  expect(MemoryPromoteInput.parse({ bank: "maya-memory" })).toEqual({ bank: "maya-memory" });
  expect(MemoryPromoteResult.safeParse({ state: "landed", bank: "maya-memory", pullRequest: null, files: [{ path: "projects/personal/homelab/memories/fact.md", state: "pending" }] }).success).toBe(false);
  const consumed = { type: "bank.drafts-consumed", payload: { sessionId: "5b1c6f3e-2a4d-4e8f-9b0a-1c2d3e4f5a6b", bankId: "6f1c2c1e-8a8f-4b5e-9a65-1d7c5b0f2a10", changes: [] } };
  expect(EnvironmentNotice.parse(consumed)).toEqual(consumed);
});

it("uses the same bank, scope and pointer vocabulary in all five published tool inputs", () => {
  expect(MemorySearchInput.parse({ query: "backups", bank: "maya-memory", scope: { org: "personal", project: "homelab" }, limit: 10 })).toMatchObject({ bank: "maya-memory", scope: { org: "personal", project: "homelab" } });
  expect(MemoryReadInput.parse({ pointer: "maya-memory:personal/homelab/" })).toEqual({ pointer: "maya-memory:personal/homelab/" });
  expect(MemoryReadInput.parse({})).toEqual({});
  expect(MemorySearchInput.safeParse({ query: "fact", bank: "../secret" }).success).toBe(false);
});

it("publishes the durable reviewed change snapshot, including non-draft files and no session", () => {
  const held = { type: "bank.review-held", payload: { bankId: "6f1c2c1e-8a8f-4b5e-9a65-1d7c5b0f2a10", sessionId: null, pullRequest: "https://git.example.test/maya/memory/pulls/7", number: 7, head: "0".repeat(40), writes: { ".agent-harness/validate.mjs": "A validator update." }, drafts: [] } };
  expect(EnvironmentNotice.safeParse(held).success).toBe(true);
  expect(eventTypeEntry("environment", held.type)?.list).toBe(false);
});
