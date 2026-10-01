import { expect, it } from "vitest";
import { z } from "zod";
import { EnvironmentNotice, MemoryDraftInput, MemoryRetireInput, eventTypeEntry, methods, registry } from "./index.js";

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
