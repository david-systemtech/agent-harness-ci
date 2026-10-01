const sessionId = "5b1c6f3e-2a4d-4e8f-9b0a-1c2d3e4f5a6b";
const bankId = "6f1c2c1e-8a8f-4b5e-9a65-1d7c5b0f2a10";
const change = { kind: "draft", name: "fact", path: "projects/personal/homelab/memories/fact.md", content: "A fact." };
const input = { scope: { org: "personal", project: "homelab" }, name: "fact", description: "When reading the homelab facts, follow these verified steps and measurements.", body: "A fact.", type: "project" };
export const memoryDraftSchemaFixtures = {
  "banks/scope-segment.json": { valid: ["personal"], invalid: ["../secret", ""] },
  "banks/draft-scope.json": { valid: [input.scope, { ...input.scope, area: "deploy" }], invalid: [{ org: "personal" }, { ...input.scope, area: "../secret" }] },
  "banks/tools/draft.json": { valid: [input, { ...input, bank: "maya-memory", topic: "deploy", appliesTo: ["https://git.example.test/maya/homelab"] }], invalid: [{ ...input, type: "status" }, { ...input, scope: {} }] },
  "banks/tools/retire.json": { valid: [{ bank: "maya-memory", name: "fact", reason: "Replaced." }], invalid: [{ name: "fact", reason: "Replaced." }, { bank: "maya-memory", name: "fact", reason: "" }] },
  "banks/draft.json": { valid: [change, { kind: "retire", name: "fact", path: change.path, reason: "Replaced." }], invalid: [{ ...change, kind: "promote" }, { ...change, content: 1 }] },
  "banks/events/bank.draft-queued.json": { valid: [{ sessionId, bankId, change }], invalid: [{ bankId, change }, { sessionId, bankId: "bank", change }] },
};
export const memoryDraftMethodFixtures = {
  "banks.drafts.list": { params: { valid: [{ sessionId }, { sessionId, bankId }], invalid: [{}, { sessionId: "session" }] }, result: { valid: [{ queues: [] }, { queues: [{ bankId, drafts: [change] }] }], invalid: [{ drafts: [] }, { queues: [{ bankId, drafts: [{ kind: "promote" }] }] }] } },
};
