const sessionId = "5b1c6f3e-2a4d-4e8f-9b0a-1c2d3e4f5a6b";
const bankId = "6f1c2c1e-8a8f-4b5e-9a65-1d7c5b0f2a10";
const change = { kind: "draft", name: "fact", path: "projects/personal/homelab/memories/fact.md", content: "A fact." };
const input = { scope: { org: "personal", project: "homelab" }, name: "fact", description: "When reading the homelab facts, follow these verified steps and measurements.", body: "A fact.", type: "project" };
export const memoryDraftSchemaFixtures = {
  "sessions/events/session.bank-used.json": { valid: [{ bankId, pointers: ["maya-memory:personal/homelab/"] }], invalid: [{ bankId, pointers: [] }, { bankId, pointers: ["/etc/passwd"] }] },
  "banks/scope-segment.json": { valid: ["personal"], invalid: ["../secret", ""] },
  "banks/draft-scope.json": { valid: [input.scope, { ...input.scope, area: "deploy" }], invalid: [{ org: "personal" }, { ...input.scope, area: "../secret" }] },
  "banks/tools/search.json": { valid: [{ query: "backup" }, { query: "backup", bank: "maya-memory", scope: { org: "personal" }, limit: 10 }, { query: "backup", scope: input.scope }], invalid: [{ query: "" }, { query: "fact", bank: "../secret" }, { query: "fact", scope: { org: "personal", area: "nas" } }] },
  "banks/tools/read.json": { valid: [{}, { pointer: "maya-memory:personal/homelab/" }, { pointer: "maya-memory:fact" }], invalid: [{ pointer: "" }, { pointer: 1 }] },
  "banks/tools/promote.json": { valid: [{}, { bank: "maya-memory" }], invalid: [{ bank: "../secret" }, { bank: 2 }] },
  "banks/promote-result.json": { valid: [{ state: "landed", bank: "maya-memory", pullRequest: null, files: [{ path: change.path, state: "present" }] }, { state: "awaiting-review", bank: "maya-memory", pullRequest: "https://git.example.test/maya/memory/pulls/1", files: [{ path: change.path, state: "pending" }] }, { state: "failed", bank: "maya-memory", step: "validate-check", reason: "Failed." }], invalid: [{ state: "landed", bank: "maya-memory", pullRequest: null, files: [{ path: change.path, state: "pending" }] }, { state: "failed", bank: "maya-memory" }] },
  "banks/events/bank.review-held.json": { valid: [{ bankId, sessionId: null, pullRequest: "https://git.example.test/maya/memory/pulls/7", number: 7, head: "0".repeat(40), writes: { "README.md": "Updated.", "old.md": null }, drafts: [] }, { bankId, sessionId, pullRequest: "https://git.example.test/maya/memory/pulls/7", number: 7, head: "0".repeat(40), writes: { [change.path]: change.content }, drafts: [change] }], invalid: [{ bankId, sessionId, number: 7 }, { bankId, sessionId, pullRequest: "review", number: 0, head: "short", writes: {}, drafts: [] }] },
  "banks/events/bank.drafts-consumed.json": { valid: [{ sessionId, bankId, changes: [change] }], invalid: [{ bankId, changes: [] }, { sessionId, bankId, changes: [{}] }] },
  "banks/tools/draft.json": { valid: [input, { ...input, bank: "maya-memory", topic: "deploy", appliesTo: ["https://git.example.test/maya/homelab"] }], invalid: [{ ...input, type: "status" }, { ...input, scope: {} }] },
  "banks/tools/retire.json": { valid: [{ bank: "maya-memory", name: "fact", reason: "Replaced." }], invalid: [{ name: "fact", reason: "Replaced." }, { bank: "maya-memory", name: "fact", reason: "" }] },
  "banks/draft.json": { valid: [change, { kind: "retire", name: "fact", path: change.path, reason: "Replaced." }], invalid: [{ ...change, kind: "promote" }, { ...change, content: 1 }] },
  "banks/events/bank.draft-queued.json": { valid: [{ sessionId, bankId, change }], invalid: [{ bankId, change }, { sessionId, bankId: "bank", change }] },
};
export const memoryDraftMethodFixtures = {
  "banks.drafts.list": { params: { valid: [{ sessionId }, { sessionId, bankId }], invalid: [{}, { sessionId: "session" }] }, result: { valid: [{ queues: [] }, { queues: [{ bankId, drafts: [change] }] }], invalid: [{ drafts: [] }, { queues: [{ bankId, drafts: [{ kind: "promote" }] }] }] } },
};
